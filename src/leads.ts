import { Router } from 'express'
import { randomUUID } from 'crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Request, Response, NextFunction } from 'express'
import { pickAllowed } from './security'
import { emitNotification } from './routes/notifications'
import { loadMapping, applyMappingToPayload } from './lib/apply-mapping'

type AuthMiddleware = (req: Request, res: Response, next: NextFunction) => void

// ── Helpers ───────────────────────────────────────────────────────────────────

function toKey(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'field'
}

// pickAllowed lives in src/security.ts — imported above so other route
// modules can share the exact same prototype-safe implementation.

// ── Module-level rate limiter for /api/ingest/:token ──────────────────────
// Was previously inside createLeadsRouter, which would have leaked timers
// + duplicated state if the factory was ever called twice (tests, multi-
// process forks). Module scope = single source of truth, single timer.
//
// In-memory token bucket keyed by `${ip}:${token}`. 30-burst, 1 req/s
// sustained. Hard cap at 50k entries to bound memory; full bucket Map
// returns false (= 429) for NEW keys so existing buckets keep refilling.
const RATE_BURST = 30
const RATE_REFILL_PER_SEC = 1
const RATE_BUCKETS_MAX = 50_000
const ingestBuckets = new Map<string, { tokens: number; ts: number }>()
function takeIngestToken(key: string): boolean {
  const now = Date.now()
  let b = ingestBuckets.get(key)
  if (!b) {
    if (ingestBuckets.size >= RATE_BUCKETS_MAX) return false
    b = { tokens: RATE_BURST, ts: now }
  }
  const elapsed = (now - b.ts) / 1000
  b.tokens = Math.min(RATE_BURST, b.tokens + elapsed * RATE_REFILL_PER_SEC)
  b.ts = now
  if (b.tokens < 1) { ingestBuckets.set(key, b); return false }
  b.tokens -= 1
  ingestBuckets.set(key, b)
  return true
}
// Periodically prune idle buckets — once per minute, drops anything not
// touched in 5+ minutes. unref() so the timer doesn't keep the process alive.
//
// Hot-reload guard: tsx watch / ts-node-dev re-execute this module on file
// change, which would otherwise leak a new interval each save (closure on
// the OLD ingestBuckets Map). Stash the timer id on globalThis so we clear
// the previous one before scheduling a fresh one.
{
  const G = globalThis as { __ingestPruneTimer?: ReturnType<typeof setInterval> }
  if (G.__ingestPruneTimer) clearInterval(G.__ingestPruneTimer)
  G.__ingestPruneTimer = setInterval(() => {
    const cutoff = Date.now() - 5 * 60_000
    for (const [k, v] of ingestBuckets) if (v.ts < cutoff) ingestBuckets.delete(k)
  }, 60_000)
  G.__ingestPruneTimer.unref()
}

// ── Webhook capture (debugging aid for the Mapping panel) ─────────────────
// When a user clicks "Listen for next inbound payload" on the Mapping tab,
// we open a 60-second capture window for that table. The next POST to
// /api/ingest/:token belonging to this table snapshot's its payload here so
// the FE can pull it via /capture-status and auto-fill the mapping editor.
//
// In-memory only — single-process so concurrent server instances would each
// have their own state. For production scale this is a Redis key; for now
// the table is one user's debugging session, single-tab, single-shot, so a
// per-process Map is fine.
interface CaptureEntry { capturing_until: number; captured?: Record<string, unknown> }
const captureBuffer = new Map<string, CaptureEntry>()
{
  const G = globalThis as { __capturePruneTimer?: ReturnType<typeof setInterval> }
  if (G.__capturePruneTimer) clearInterval(G.__capturePruneTimer)
  G.__capturePruneTimer = setInterval(() => {
    const now = Date.now()
    for (const [k, v] of captureBuffer) if (v.capturing_until < now && !v.captured) captureBuffer.delete(k)
  }, 30_000)
  G.__capturePruneTimer.unref()
}

function matchesConditions(data: Record<string, unknown>, conditions: Condition[]): boolean {
  if (!conditions || conditions.length === 0) return true
  return conditions.every(c => {
    const val = String(data[c.field] ?? '').toLowerCase()
    const cval = String(c.value ?? '').toLowerCase()
    switch (c.operator) {
      case 'equals':       return val === cval
      case 'not_equals':   return val !== cval
      case 'contains':     return val.includes(cval)
      case 'not_contains': return !val.includes(cval)
      case 'starts_with':  return val.startsWith(cval)
      case 'greater_than': return Number(val) > Number(cval)
      case 'less_than':    return Number(val) < Number(cval)
      case 'is_empty':     return !val
      case 'is_not_empty': return !!val
      default:             return false
    }
  })
}

/**
 * Run the table's active assignment rules against a single row's data.
 * Returns the patch to apply (or null if no rule matched), so callers can
 * fold it into their insert/update — avoids a second round trip.
 *
 * Used by:
 *   • POST  /lead-tables/:id/rows         — new rows (manual + webhook)
 *   • POST  /lead-tables/:id/import       — CSV import
 *   • PATCH /lead-tables/:id/rows/:rowId  — re-evaluate when data changes
 *   • POST  /apply-assignments            — bulk apply via UI button
 *
 * Previously rules only fired on the manual "Apply rules" click, so users
 * thought their rules were broken. Now any new/changed row gets evaluated
 * automatically; the manual button stays as a safety net + backfill tool.
 */
async function evaluateRulesForRow(
  supabase: SupabaseClient,
  tableId: string,
  tenantId: string,
  rowData: Record<string, unknown>,
  existingTags: string[] = [],
): Promise<{ assigned_to: string; assigned_to_name: string; tags: string[] } | null> {
  const { data: rules } = await supabase
    .from('lead_assignment_rules')
    .select('*')
    .eq('table_id', tableId)
    .eq('tenant_id', tenantId)
    .eq('is_active', true)
    .order('priority')
  if (!rules?.length) return null
  for (const rule of rules as any[]) {
    if (matchesConditions(rowData ?? {}, rule.conditions ?? [])) {
      const newTags = [...new Set([...(existingTags ?? []), ...((rule.apply_tags ?? []) as string[])])]
      return {
        assigned_to:      rule.assign_to,
        assigned_to_name: rule.assign_to_name,
        tags:             newTags,
      }
    }
  }
  return null
}

interface Condition {
  field: string
  operator: string
  value: string
}

/**
 * Fires `lead.assigned` in-app notifications for any rule-routed assignments
 * in a freshly-inserted batch. Deduped per recipient + rule so a 100-row
 * import that all match the same rule pings the assignee ONCE with a count,
 * not 100 times.
 *
 * Called from webhook ingest + CSV import + manual create paths. Fire-and-
 * forget (caller awaits + swallows) — notification delivery failure must
 * NEVER block the ingestion path.
 */
async function notifyOnAssignment(
  supabase: SupabaseClient,
  tenantId: string,
  tableId: string,
  inserts: Array<{ assigned_to?: string | null; assigned_to_name?: string }>,
): Promise<void> {
  // Group by recipient: { user_id: { count, sample_name } }
  const byRecipient = new Map<string, { count: number; name: string }>()
  for (const r of inserts) {
    if (!r.assigned_to) continue
    const cur = byRecipient.get(r.assigned_to)
    if (cur) cur.count++
    else byRecipient.set(r.assigned_to, { count: 1, name: r.assigned_to_name ?? '' })
  }
  if (byRecipient.size === 0) return

  // Fetch table name + owner ONCE. Owner is excluded from notifications
  // for ingestion paths since the row's user_id stamps to them anyway —
  // pinging them on rows they "created" via webhook ingest is annoying.
  const { data: tbl } = await supabase.from('lead_tables')
    .select('name, user_id').eq('id', tableId).maybeSingle()
  const tableName = tbl?.name ?? 'Table'
  const ownerId   = tbl?.user_id

  await Promise.all(
    Array.from(byRecipient.entries())
      .filter(([userId]) => userId !== ownerId)  // skip self-ping for owner
      .map(([userId, agg]) =>
        emitNotification(supabase, {
          tenant_id: tenantId,
          event_key: 'lead.assigned',
          recipient_user_ids: [userId],
          data: {
            table_name: tableName,
            // Caller-composed summary so the template stays simple ({{summary}}).
            summary: agg.count > 1
              ? `${agg.count} new rows just landed — open My Queue`
              : 'A new row matched a rule routed to you — open My Queue',
          },
          link: `/queue`,
        }),
      ),
  )
}

// ── Router factory ────────────────────────────────────────────────────────────

export function createLeadsRouter(supabase: SupabaseClient, requireAuth: AuthMiddleware, identifyTenant: AuthMiddleware, checkPermission: any) {
  const router = Router()

  // ── Tables ─────────────────────────────────────────────────────────────

  router.get('/lead-tables', requireAuth, identifyTenant, checkPermission('leads', 'view'), async (req, res) => {
    const tenantId = (req as any).tenantId
    const { data, error } = await supabase
      .from('lead_tables')
      .select('*')
      .eq('tenant_id', tenantId)
      .order('created_at', { ascending: false })
    if (error) { res.status(500).json({ error: error.message }); return }
    res.json(data)
  })

  router.post('/lead-tables', requireAuth, identifyTenant, checkPermission('leads', 'edit'), async (req, res) => {
    const tenantId = (req as any).tenantId
    const { name, description = '', source = 'manual', columns = [] } = req.body
    if (!name?.trim()) { res.status(400).json({ error: 'name is required' }); return }

    const userId = (req as any).user.id
    const { data: table, error } = await supabase
      .from('lead_tables')
      .insert({ name: name.trim(), description, source, tenant_id: tenantId, user_id: userId })
      .select()
      .single()
    if (error) { res.status(500).json({ error: error.message }); return }

    // Insert columns
    const defaultCols = columns.length > 0 ? columns : [
      { name: 'Name',   key: 'name',   type: 'text',  is_primary: true,  is_required: true  },
      { name: 'Phone',  key: 'phone',  type: 'phone', is_primary: false, is_required: false },
      { name: 'Email',  key: 'email',  type: 'email', is_primary: false, is_required: false },
      { name: 'Status', key: 'status', type: 'select',is_primary: false, is_required: false,
        options: ['new', 'contacted', 'qualified', 'lost', 'won'] },
      { name: 'Source', key: 'source', type: 'text',  is_primary: false, is_required: false },
      { name: 'Notes',  key: 'notes',  type: 'textarea', is_primary: false, is_required: false },
    ]

    const colRows = defaultCols.map((c: any, i: number) => ({
      table_id:    table.id,
      tenant_id:   tenantId,
      user_id:     userId,
      name:        c.name,
      key:         c.key || toKey(c.name),
      type:        c.type || 'text',
      options:     c.options || [],
      is_required: c.is_required || false,
      is_primary:  c.is_primary || i === 0,
      position:    i,
    }))
    await supabase.from('lead_columns').insert(colRows)

    res.json(table)
  })

  router.get('/lead-tables/:id', requireAuth, identifyTenant, checkPermission('leads', 'view'), async (req, res) => {
    const tenantId = (req as any).tenantId
    const { data: table, error } = await supabase
      .from('lead_tables')
      .select('*')
      .eq('id', req.params.id)
      .eq('tenant_id', tenantId)
      .single()
    if (error) { res.status(404).json({ error: 'Table not found' }); return }

    const { data: columns } = await supabase
      .from('lead_columns')
      .select('*')
      .eq('table_id', table.id)
      .eq('tenant_id', tenantId)
      .order('position')

    // Strip the ingest_token from the generic GET — viewers shouldn't see
    // a write credential. The Source tab fetches the token via the
    // dedicated /api/lead-tables/:id/ingest-token endpoint below, which
    // requires leads:edit.
    const { ingest_token: _, ...safeTable } = table as any
    res.json({ ...safeTable, columns: columns ?? [] })
  })

  // Dedicated ingest-token reveal — gated by leads:edit so read-only roles
  // (viewer, analyst, support_agent) can't pull a write credential.
  router.get('/lead-tables/:id/ingest-token',
    requireAuth, identifyTenant, checkPermission('leads', 'edit'),
    async (req, res) => {
      const tenantId = (req as any).tenantId
      const { data, error } = await supabase
        .from('lead_tables')
        .select('ingest_token')
        .eq('id', req.params.id)
        .eq('tenant_id', tenantId)
        .single()
      if (error || !data) { res.status(404).json({ error: 'Table not found' }); return }
      res.json({ ingest_token: data.ingest_token })
    })

  router.patch('/lead-tables/:id', requireAuth, identifyTenant, checkPermission('leads', 'edit'), async (req, res) => {
    const tenantId = (req as any).tenantId
    // `default_mapping_id` is the table-level pin used by POST /api/ingest/:token
    // to auto-apply a saved mapping to every inbound webhook payload. NULL
    // means store payloads verbatim (the legacy behaviour). UUID values are
    // additionally validated below — we don't trust the client to send a
    // mapping id from a different tenant.
    const patch = pickAllowed(req.body, ['name', 'description', 'source', 'default_mapping_id'] as const) as Record<string, unknown>
    if (patch.default_mapping_id != null) {
      const mid = String(patch.default_mapping_id)
      // Empty string from a "clear" interaction → store as NULL.
      if (mid === '') { patch.default_mapping_id = null }
      else {
        const { data: mp, error: mpErr } = await supabase
          .from('lead_field_mappings')
          .select('id')
          .eq('id', mid)
          .eq('tenant_id', (req as any).tenantId)
          .maybeSingle()
        if (mpErr) { res.status(500).json({ error: mpErr.message }); return }
        if (!mp)   { res.status(400).json({ error: 'default_mapping_id does not belong to this tenant' }); return }
      }
    }
    const { data, error } = await supabase
      .from('lead_tables')
      .update({ ...patch, updated_at: new Date().toISOString() })
      .eq('id', req.params.id)
      .eq('tenant_id', tenantId)
      .select()
      .single()
    if (error) { res.status(500).json({ error: error.message }); return }
    res.json(data)
  })

  router.delete('/lead-tables/:id', requireAuth, identifyTenant, checkPermission('leads', 'delete'), async (req, res) => {
    const tenantId = (req as any).tenantId
    const { error } = await supabase
      .from('lead_tables')
      .delete()
      .eq('id', req.params.id)
      .eq('tenant_id', tenantId)
    if (error) { res.status(500).json({ error: error.message }); return }
    res.json({ success: true })
  })

  // ── Columns ─────────────────────────────────────────────────────────────────

  router.post('/lead-tables/:id/columns', requireAuth, identifyTenant, checkPermission('leads', 'edit'), async (req, res) => {
    const tenantId = (req as any).tenantId
    const { name, type = 'text', options = [], is_required = false } = req.body
    if (!name?.trim()) { res.status(400).json({ error: 'name is required' }); return }

    const { data: existing } = await supabase
      .from('lead_columns')
      .select('position')
      .eq('table_id', req.params.id)
      .eq('tenant_id', tenantId)
      .order('position', { ascending: false })
      .limit(1)
    const position = ((existing?.[0] as any)?.position ?? -1) + 1

    let userId = (req as any).user?.id
    
    if (!userId) {
      // Fallback: get the user_id from the tenant record
      const { data: t } = await supabase.from('tenants').select('user_id').eq('id', tenantId).single()
      userId = t?.user_id
    }

    console.log(`[addColumn] table=${req.params.id}, tenant=${tenantId}, user=${userId || '(MISSING)'}`)

    if (!userId) {
      console.error('[addColumn] ERROR: No user ID found in request or tenant')
      res.status(401).json({ error: 'User ID missing' }); return
    }

    if (!tenantId) {
      console.error('[addColumn] ERROR: No tenant ID found in request')
      res.status(400).json({ error: 'Tenant ID missing' }); return
    }

    try {
      const { data, error } = await supabase
        .from('lead_columns')
        .insert({
          table_id: req.params.id, 
          tenant_id: tenantId, 
          user_id: userId,
          name: name.trim(), 
          key: toKey(name), 
          type, 
          options, 
          is_required, 
          position,
        })
        .select()
        .single()

      if (error) {
        console.error('[addColumn] DB ERROR:', JSON.stringify(error, null, 2))
        res.status(500).json({ error: error.message }); return
      }
      res.json(data)
    } catch (err: any) {
      console.error('[addColumn] FATAL ERROR:', err.message)
      res.status(500).json({ error: err.message }); return
    }
  })

  router.patch('/lead-tables/:id/columns/:colId', requireAuth, identifyTenant, checkPermission('leads', 'edit'), async (req, res) => {
    const tenantId = (req as any).tenantId
    const patch = pickAllowed(req.body, ['name', 'key', 'type', 'options', 'is_required', 'is_primary', 'position'] as const)
    const { data, error } = await supabase
      .from('lead_columns')
      .update(patch)
      .eq('id', req.params.colId)
      .eq('tenant_id', tenantId)
      .select()
      .single()
    if (error) { res.status(500).json({ error: error.message }); return }
    res.json(data)
  })

  router.delete('/lead-tables/:id/columns/:colId', requireAuth, identifyTenant, checkPermission('leads', 'delete'), async (req, res) => {
    const tenantId = (req as any).tenantId
    const { error } = await supabase
      .from('lead_columns')
      .delete()
      .eq('id', req.params.colId)
      .eq('tenant_id', tenantId)
    if (error) { res.status(500).json({ error: error.message }); return }
    res.json({ success: true })
  })

  // ── Rows ────────────────────────────────────────────────────────────────────

  router.get('/lead-tables/:id/rows', requireAuth, identifyTenant, checkPermission('leads', 'view'), async (req, res) => {
    const tenantId = (req as any).tenantId
    const userId   = (req as any).user.id
    const {
      search, status, assigned_to, tag,
      limit = '100', offset = '0',
    } = req.query as Record<string, string>

    // Resolve `assigned_to=me` to current user's id so the FE can use a
    // stable sentinel (no need to know the user's UUID up front).
    const resolvedAssignedTo = assigned_to === 'me' ? userId : assigned_to

    let q = supabase
      .from('lead_rows')
      .select('*', { count: 'exact' })
      .eq('table_id', req.params.id)
      .eq('tenant_id', tenantId)
      .order('created_at', { ascending: false })
      .range(Number(offset), Number(offset) + Number(limit) - 1)

    if (status)             q = q.eq('status', status)
    if (resolvedAssignedTo) q = q.eq('assigned_to', resolvedAssignedTo)
    if (tag)                q = q.contains('tags', [tag])
    if (search)             q = (q as any).ilike('data::text', `%${search}%`)

    // Dynamic data filters. Keys are interpolated directly into the
    // PostgREST column expression `data->>${key}` — only allow safe
    // identifiers so a malicious key can't inject PostgREST operators
    // or break the request shape (e.g. "foo,bar.eq.x").
    const SAFE_KEY = /^[a-z0-9_]{1,64}$/i
    const filters = req.query.filters as string
    if (filters) {
      try {
        const parsed = JSON.parse(filters)
        Object.entries(parsed).forEach(([key, val]) => {
          if (!SAFE_KEY.test(key)) return  // silently drop unsafe keys
          if (val) {
            q = q.ilike(`data->>${key}`, `%${val}%`)
          }
        })
      } catch (e) {}
    }

    const { data, count, error } = await q
    if (error) { res.status(500).json({ error: error.message }); return }
    res.json({ rows: data ?? [], total: count ?? 0 })
  })

  router.post('/lead-tables/:id/rows', requireAuth, identifyTenant, checkPermission('leads', 'edit'), async (req, res) => {
    const tenantId = (req as any).tenantId
    const baseTags = (req.body.tags ?? []) as string[]
    const baseAssignTo     = req.body.assigned_to ?? null
    const baseAssignToName = req.body.assigned_to_name ?? ''
    const tableIdStr = String(req.params.id)
    // Auto-apply assignment rules unless caller explicitly opted out.
    // (Workflows that compute their own assignment can pass skip_rules: true.)
    const ruleResult = req.body.skip_rules
      ? null
      : await evaluateRulesForRow(supabase, tableIdStr, tenantId, req.body.data ?? {}, baseTags)
    const { data, error } = await supabase
      .from('lead_rows')
      .insert({
        table_id:         tableIdStr,
        tenant_id:        tenantId,
        user_id:          (req as any).user.id,
        data:             req.body.data ?? {},
        // Caller's explicit assignment takes priority; rule fills the gap.
        assigned_to:      baseAssignTo      ?? ruleResult?.assigned_to      ?? null,
        assigned_to_name: baseAssignToName  || (ruleResult?.assigned_to_name ?? ''),
        tags:             ruleResult?.tags  ?? baseTags,
        status:           req.body.status ?? 'new',
      })
      .select()
      .single()
    if (error) { res.status(500).json({ error: error.message }); return }

    // Notify the assignee (if a rule placed them on the row). Manual create
    // path — UI flow, so the toast in the FE confirms the create; this
    // notification reaches the assignee on their bell + MyQueue badge.
    if (ruleResult?.assigned_to) {
      void notifyOnAssignment(supabase, tenantId, tableIdStr, [{
        assigned_to: ruleResult.assigned_to,
        assigned_to_name: ruleResult.assigned_to_name,
      }]).catch(e => console.warn('[create-row] notify failed (non-fatal):', e?.message))
    }

    // Calling feature (migration 035): if the lead carries a phone, mirror
    // into contacts so the universal Call action can fire. Fire-and-forget —
    // non-fatal, never blocks the response. Bail silently when phone is
    // absent or the tenant doesn't have calling enabled (the resolver itself
    // is cheap and idempotent).
    void import('./services/contact-resolver').then(({ upsertContactFromLead }) =>
      upsertContactFromLead(supabase, tenantId, {
        id: data.id, data: data.data, tags: data.tags ?? [],
      })
    ).catch(e => console.warn('[create-row] contact resolve (non-fatal):', e?.message))

    res.json({ ...data, _rule_applied: !!ruleResult })
  })

  router.patch('/lead-tables/:id/rows/:rowId', requireAuth, identifyTenant, checkPermission('leads', 'edit'), async (req, res) => {
    const tenantId = (req as any).tenantId
    const tableIdStr = String(req.params.id)
    // Whitelist body fields. Critically prevents callers from rewriting
    // tenant_id / user_id / id / created_at on the row (the .eq('tenant_id')
    // on the UPDATE only restricts the *target* row; the new value still lands).
    const safeBody = pickAllowed(req.body, ['data', 'assigned_to', 'assigned_to_name', 'tags', 'status'] as const)
    // Re-evaluate assignment rules if the row's `data` changed and the caller
    // didn't supply an explicit assigned_to. This keeps assignments live as
    // status / score / segment fields update.
    const dataChanged   = 'data' in safeBody
    const explicitAssign = 'assigned_to' in safeBody
    const patch: Record<string, unknown> = { ...safeBody, updated_at: new Date().toISOString() }
    if (dataChanged && !explicitAssign && !req.body.skip_rules) {
      const { data: existing } = await supabase
        .from('lead_rows').select('tags').eq('id', req.params.rowId).eq('tenant_id', tenantId).maybeSingle()
      const ruleResult = await evaluateRulesForRow(
        supabase, tableIdStr, tenantId, (safeBody.data as Record<string, unknown>) ?? {}, (existing?.tags as string[]) ?? [],
      )
      if (ruleResult) {
        patch.assigned_to      = ruleResult.assigned_to
        patch.assigned_to_name = ruleResult.assigned_to_name
        patch.tags             = ruleResult.tags
      }
    }
    const { data, error } = await supabase
      .from('lead_rows')
      .update(patch)
      .eq('id', req.params.rowId)
      .eq('tenant_id', tenantId)
      .select()
      .single()
    if (error) { res.status(500).json({ error: error.message }); return }
    res.json(data)
  })

  router.delete('/lead-tables/:id/rows/:rowId', requireAuth, identifyTenant, checkPermission('leads', 'delete'), async (req, res) => {
    const tenantId = (req as any).tenantId
    const { error } = await supabase
      .from('lead_rows')
      .delete()
      .eq('id', req.params.rowId)
      .eq('tenant_id', tenantId)
    if (error) { res.status(500).json({ error: error.message }); return }
    res.json({ success: true })
  })

  // Bulk delete via DELETE-with-body. Kept for backwards compat + direct API
  // users; the FE now calls the POST variant below because Cloudflare and
  // some other intermediaries strip request bodies on DELETE by default,
  // which would silently turn bulk delete into a no-op.
  router.delete('/lead-tables/:id/rows', requireAuth, identifyTenant, checkPermission('leads', 'delete'), async (req, res) => {
    return bulkDeleteRows(req, res)
  })

  // CF-safe POST variant. Same payload `{ ids: [...] }`, same response.
  router.post('/lead-tables/:id/rows/bulk-delete', requireAuth, identifyTenant, checkPermission('leads', 'delete'), async (req, res) => {
    return bulkDeleteRows(req, res)
  })

  async function bulkDeleteRows(req: Request, res: Response) {
    const tenantId = (req as any).tenantId
    // Defence-in-depth: identifyTenant always sets this in normal flow, but
    // if it ever falls through, .eq('tenant_id', undefined) becomes a no-WHERE
    // filter that would delete the .in('id', ids) set across ALL tenants.
    if (!tenantId) { res.status(401).json({ error: 'tenant context missing' }); return }
    const { ids } = req.body as { ids: string[] }
    if (!Array.isArray(ids) || ids.length === 0) {
      res.status(400).json({ error: 'ids array required' }); return
    }
    if (ids.length > 1000) {
      res.status(413).json({ error: 'max 1000 ids per request — split into batches' }); return
    }
    const { error } = await supabase
      .from('lead_rows')
      .delete()
      .in('id', ids)
      .eq('tenant_id', tenantId)
    if (error) { res.status(500).json({ error: error.message }); return }
    res.json({ deleted: ids.length })
  }

  // ── My Queue ─────────────────────────────────────────────────────────────────
  // Cross-table view of rows assigned to the current user, plus per-table
  // counts. Powers:
  //   • the /queue page (full list with quick actions)
  //   • the sidebar badge ("5 new for you") via .pending count
  //   • the dashboard widget ("Your queue: X pending")
  // Without this, an assignee like "Nitin" had no way to discover the rows
  // routed to them — assignments were a write-only feature.
  router.get('/leads/my-queue', requireAuth, identifyTenant, checkPermission('leads', 'view'), async (req, res) => {
    const tenantId = (req as any).tenantId
    const userId   = (req as any).user.id
    const limit  = Math.min(Number(req.query.limit ?? 50), 200)
    const status = req.query.status as string | undefined  // optional filter

    // ── Counts ──────────────────────────────────────────────────────────
    // Per-status counts via parallel head-only count queries — much cheaper
    // than the previous "select * then loop" pattern which scaled with the
    // user's total assigned rows. Each query returns just the count + 200
    // bytes of headers, no row payload.
    const STATUSES = ['new', 'contacted', 'qualified', 'lost', 'won'] as const
    const countQueries = await Promise.all([
      // total
      supabase.from('lead_rows')
        .select('id', { count: 'exact', head: true })
        .eq('tenant_id', tenantId).eq('assigned_to', userId),
      // per-status
      ...STATUSES.map(s =>
        supabase.from('lead_rows')
          .select('id', { count: 'exact', head: true })
          .eq('tenant_id', tenantId).eq('assigned_to', userId).eq('status', s),
      ),
    ])
    const counts: Record<string, number> = {
      total:     countQueries[0].count ?? 0,
      new:       countQueries[1].count ?? 0,
      contacted: countQueries[2].count ?? 0,
      qualified: countQueries[3].count ?? 0,
      lost:      countQueries[4].count ?? 0,
      won:       countQueries[5].count ?? 0,
    }

    // ── Per-table real counts ───────────────────────────────────────────
    // Previously computed from the paginated `rows` slice — so for a user
    // with 500 assigned rows across 10 tables, the "by table" breakdown
    // only reflected the first 50 fetched, not the truth. Now uses a
    // grouped count via Supabase's `count: 'exact'` per table_id.
    const { data: tableRows } = await supabase
      .from('lead_rows')
      .select('table_id, lead_tables!inner(id,name)')
      .eq('tenant_id', tenantId)
      .eq('assigned_to', userId)
    const byTableMap = new Map<string, { table_id: string; table_name: string; count: number }>()
    for (const r of (tableRows ?? []) as any[]) {
      const tid = r.table_id
      const existing = byTableMap.get(tid)
      if (existing) { existing.count++ }
      else { byTableMap.set(tid, { table_id: tid, table_name: r.lead_tables?.name ?? 'Untitled', count: 1 }) }
    }

    // ── Paginated list of actual row data ───────────────────────────────
    let q = supabase
      .from('lead_rows')
      .select('id, table_id, data, status, tags, assigned_to_name, created_at, updated_at, lead_tables!inner(id,name)')
      .eq('tenant_id', tenantId)
      .eq('assigned_to', userId)
      .order('created_at', { ascending: false })
      .limit(limit)
    if (status) q = q.eq('status', status)
    const { data: rows, error } = await q
    if (error) { res.status(500).json({ error: error.message }); return }

    res.json({
      counts,
      by_table: Array.from(byTableMap.values()),
      rows: (rows ?? []).map((r: any) => ({
        id: r.id,
        table_id: r.table_id,
        table_name: r.lead_tables?.name ?? '',
        data: r.data,
        status: r.status,
        tags: r.tags,
        assigned_to_name: r.assigned_to_name,
        created_at: r.created_at,
        updated_at: r.updated_at,
      })),
    })
  })

  // ── Bulk Import ──────────────────────────────────────────────────────────────

  router.post('/lead-tables/:id/import', requireAuth, identifyTenant, checkPermission('leads', 'edit'), async (req, res) => {
    const tenantId = (req as any).tenantId
    const { rows, mappings } = req.body as {
      rows: Record<string, string>[]
      mappings: Record<string, string>
    }

    if (!Array.isArray(rows) || rows.length === 0) {
      res.status(400).json({ error: 'rows array is required' }); return
    }

    // Pull active rules ONCE up-front and evaluate in-memory — much faster
    // than the O(rows × DB) approach used by the manual /apply-assignments
    // endpoint, which does a full DB roundtrip per row. For a 5k-row CSV
    // with 10 rules this is the difference between ~30s and ~1s of work.
    const { data: activeRules } = await supabase
      .from('lead_assignment_rules')
      .select('*')
      .eq('table_id', req.params.id)
      .eq('tenant_id', tenantId)
      .eq('is_active', true)
      .order('priority')

    function ruleForData(data: Record<string, unknown>, baseTags: string[]) {
      for (const rule of (activeRules ?? []) as any[]) {
        if (matchesConditions(data, rule.conditions ?? [])) {
          return {
            assigned_to:      rule.assign_to,
            assigned_to_name: rule.assign_to_name,
            tags:             [...new Set([...baseTags, ...((rule.apply_tags ?? []) as string[])])],
          }
        }
      }
      return null
    }

    let assigned = 0
    const transformed = rows.map(row => {
      const data: Record<string, string> = {}
      if (mappings && Object.keys(mappings).length > 0) {
        Object.entries(mappings).forEach(([src, target]) => {
          if (target && target !== '__skip__' && row[src] !== undefined) {
            data[target] = String(row[src] ?? '').trim()
          }
        })
      } else {
        Object.entries(row).forEach(([k, v]) => { data[toKey(k)] = String(v ?? '').trim() })
      }
      const ruleHit = ruleForData(data, [])
      if (ruleHit) assigned++
      return {
        table_id:         req.params.id,
        tenant_id:        tenantId,
        user_id:          (req as any).user.id,
        data,
        status:           'new',
        tags:             ruleHit?.tags ?? [],
        assigned_to:      ruleHit?.assigned_to ?? null,
        assigned_to_name: ruleHit?.assigned_to_name ?? '',
        ingest_source:    'csv',
      }
    })

    let inserted = 0
    const BATCH = 500
    const insertedIds: Array<{ id: string; data: any; tags?: string[] }> = []
    for (let i = 0; i < transformed.length; i += BATCH) {
      const slice = transformed.slice(i, i + BATCH)
      const { data: insRows, error } = await supabase.from('lead_rows').insert(slice).select('id, data, tags')
      if (error) { res.status(500).json({ error: error.message, inserted }); return }
      inserted += Math.min(BATCH, transformed.length - i)
      if (Array.isArray(insRows)) for (const r of insRows) insertedIds.push(r as any)
    }

    // Fire `lead.assigned` notifications for any rule-routed assignments —
    // same dedup-by-recipient pattern as webhook ingest. Fire-and-forget.
    if (assigned > 0) {
      void notifyOnAssignment(supabase, tenantId, String(req.params.id), transformed).catch(e =>
        console.warn('[csv-import] notify failed (non-fatal):', e?.message))
    }

    // Calling feature (migration 035): mirror each newly-imported lead row
    // with a phone into the contacts table. Fire-and-forget; failures don't
    // affect the response. Capped at 200 to avoid hammering the contacts
    // table on bulk uploads — production should move this to a worker.
    void import('./services/contact-resolver').then(({ upsertContactFromLead }) => {
      const subset = insertedIds.slice(0, 200)
      return Promise.allSettled(subset.map(r =>
        upsertContactFromLead(supabase, tenantId, { id: r.id, data: r.data, tags: r.tags ?? [] })
      ))
    }).catch(e => console.warn('[csv-import] contact resolve (non-fatal):', e?.message))

    res.json({ inserted, auto_assigned: assigned })
  })

  // ── Webhook ingest ──────────────────────────────────────────────────────────
  // Public, token-secured endpoint for any external system (Zapier, n8n,
  // Pipedream, custom backends, raw HTML forms) to POST rows into a table.
  // The token is the only credential — surfaced on the table's Source tab
  // and rotatable via /lead-tables/:id/rotate-ingest-token.
  //
  // Body shapes accepted:
  //   { rows: [{...}, {...}] }    — bulk
  //   { row:  {...} }             — single row
  //   {...}                       — bare object treated as one row
  //
  // Each row goes through evaluateRulesForRow so assignment rules fire on
  // ingest just like manual + CSV creation.

  // Rate-limit state lives at module scope (above) so the timer + bucket Map
  // are singletons regardless of how many times createLeadsRouter is called.
  router.post('/ingest/:token', async (req, res) => {
    const token = String(req.params.token ?? '').trim()
    // Stable error shape regardless of validity → no token-validity oracle.
    // (Previously: 400 "token required" vs 404 "invalid token" vs 400 "expected
    // JSON object" let an attacker cheaply distinguish a real token from a
    // fake one before paying the rate-limit cost.)
    const fail = () => { res.status(401).json({ error: 'invalid request' }) }

    if (!token) { fail(); return }

    // Per-IP + per-token bucket. `req.ip` resolves the real client through
    // X-Forwarded-For because src/index.ts sets `trust proxy` to the configured
    // hop count. Without that setting, every request behind the proxy would
    // share one bucket (DoS legit traffic) — see TRUST_PROXY_HOPS env var.
    const ip = (req.ip ?? req.socket.remoteAddress ?? 'unknown')
    if (!takeIngestToken(`${ip}:${token}`)) {
      res.setHeader('Retry-After', '5')
      res.status(429).json({ error: 'rate limit exceeded' }); return
    }

    const { data: table, error: tableErr } = await supabase
      .from('lead_tables')
      .select('id, tenant_id, user_id, default_mapping_id')
      .eq('ingest_token', token)
      .maybeSingle()
    if (tableErr || !table) { fail(); return }

    // Pinned mapping (if any) — loaded ONCE before processing the batch.
    // Failure to load (e.g. mapping deleted concurrently) falls back to
    // verbatim mode rather than rejecting the request; that matches the
    // ON DELETE SET NULL semantics on the column. See lib/apply-mapping.ts
    // for the shared transform pipeline (same one the FE preview uses).
    const pinnedMapping = await loadMapping(supabase, table.tenant_id, (table as any).default_mapping_id)

    // Coerce to an array of plain row objects.
    let rowList: Array<Record<string, unknown>>
    if (Array.isArray(req.body?.rows))      rowList = req.body.rows
    else if (req.body?.row && typeof req.body.row === 'object') rowList = [req.body.row]
    else if (req.body && typeof req.body === 'object' && !Array.isArray(req.body)) rowList = [req.body]
    else { res.status(400).json({ error: 'expected JSON object or { rows: [...] }' }); return }

    if (rowList.length === 0) { res.json({ inserted: 0, auto_assigned: 0 }); return }
    if (rowList.length > 1000) {
      res.status(413).json({ error: 'max 1000 rows per request — split into batches' }); return
    }

    // Webhook capture: if the user is currently listening on the Mapping
    // tab for this table, snapshot the FIRST inbound row so the FE can
    // auto-fill the mapping editor with the real-world payload shape.
    // The actual insert below proceeds normally — capture is a side-channel
    // for debugging, not a replacement for the data flow.
    {
      const cap = captureBuffer.get(table.id)
      if (cap && cap.capturing_until > Date.now() && !cap.captured) {
        cap.captured = rowList[0] as Record<string, unknown>
      }
    }

    // Pre-fetch active rules once for the batch so we don't hammer the DB.
    const { data: activeRules } = await supabase
      .from('lead_assignment_rules')
      .select('*')
      .eq('table_id', table.id)
      .eq('tenant_id', table.tenant_id)
      .eq('is_active', true)
      .order('priority')

    function ruleFor(data: Record<string, unknown>) {
      for (const rule of (activeRules ?? []) as any[]) {
        if (matchesConditions(data, rule.conditions ?? [])) {
          return {
            assigned_to:      rule.assign_to,
            assigned_to_name: rule.assign_to_name,
            tags:             [...((rule.apply_tags ?? []) as string[])],
          }
        }
      }
      return null
    }

    let assigned = 0
    const inserts = rowList.map(raw => {
      // Two shapes:
      //   (a) Pinned mapping present → run the row through the shared
      //       transform pipeline, producing only the target columns the
      //       mapping defines. Anything the mapping doesn't reference is
      //       intentionally dropped (the pin is a contract — payload may
      //       contain noise the table doesn't want).
      //   (b) No pin → legacy verbatim shape: every payload key becomes a
      //       column (with `toKey` slugification), JSON-stringify nested
      //       objects so the JSONB has predictable shape.
      let data: Record<string, unknown>
      if (pinnedMapping) {
        data = applyMappingToPayload(pinnedMapping, raw)
      } else {
        data = {}
        for (const [k, v] of Object.entries(raw)) {
          if (v === null || v === undefined) continue
          data[toKey(k)] = typeof v === 'object' ? JSON.stringify(v) : String(v)
        }
      }
      const hit = ruleFor(data)
      if (hit) assigned++
      return {
        table_id:         table.id,
        tenant_id:        table.tenant_id,
        user_id:          table.user_id,
        data,
        status:           'new',
        tags:             hit?.tags ?? [],
        assigned_to:      hit?.assigned_to ?? null,
        assigned_to_name: hit?.assigned_to_name ?? '',
        // Audit trail — distinguishes webhook-ingested rows from manual
        // creations even though both stamp user_id = table.user_id.
        ingest_source:    'webhook',
      }
    })

    const { data: insertedRows, error: insErr } = await supabase
      .from('lead_rows').insert(inserts).select('id, data, tags')
    if (insErr) { res.status(500).json({ error: insErr.message }); return }

    // Fire `lead.assigned` notifications to anyone the rules just routed rows
    // to. Fire-and-forget (await but swallow errors) — notification delivery
    // failure shouldn't block ingestion. We dedupe by recipient + matched-rule
    // so a 100-row webhook that all match the same rule pings the assignee
    // ONCE with a count, not 100 times.
    if (assigned > 0) {
      void notifyOnAssignment(supabase, table.tenant_id, table.id, inserts).catch(e =>
        console.warn('[ingest] notify failed (non-fatal):', e?.message))
    }

    // Calling feature (migration 035): mirror lead → contact for phone-bearing
    // rows. Fire-and-forget; cap at 100 to keep the response fast on bulk
    // ingest. Tenants without calling enabled pay essentially nothing because
    // the resolver short-circuits on missing phone.
    if (Array.isArray(insertedRows) && insertedRows.length > 0) {
      void import('./services/contact-resolver').then(({ upsertContactFromLead }) => {
        const subset = (insertedRows as Array<{ id: string; data: any; tags?: string[] }>).slice(0, 100)
        return Promise.allSettled(subset.map(r =>
          upsertContactFromLead(supabase, table.tenant_id, { id: r.id, data: r.data, tags: r.tags ?? [] })
        ))
      }).catch(e => console.warn('[ingest] contact resolve (non-fatal):', e?.message))
    }

    res.json({ inserted: inserts.length, auto_assigned: assigned })
  })

  // Rotate the ingest token (do this if it leaks). Owner-only via the
  // standard `leads:edit` permission. Returns the new token.
  router.post('/lead-tables/:id/rotate-ingest-token',
    requireAuth, identifyTenant, checkPermission('leads', 'edit'),
    async (req, res) => {
      const tenantId = (req as any).tenantId
      // Postgres uuid_generate_v4 isn't always available — generate via
      // Node's crypto.randomUUID() to keep this portable.
      const newToken = randomUUID()
      const { data, error } = await supabase
        .from('lead_tables')
        .update({ ingest_token: newToken, updated_at: new Date().toISOString() })
        .eq('id', req.params.id)
        .eq('tenant_id', tenantId)
        .select('ingest_token')
        .single()
      if (error) { res.status(500).json({ error: error.message }); return }
      res.json({ ingest_token: data.ingest_token })
    })

  // ── Webhook capture (Mapping panel debugging aid) ──────────────────────
  // Open a 60-second window during which the next inbound POST to this
  // table's ingest URL gets snapshotted. The Mapping panel polls
  // /capture-status every 2s and auto-fills its source-payload textarea
  // when something lands. Saves users from having to copy-paste a real
  // Zapier payload by hand.
  const CAPTURE_WINDOW_MS = 60_000
  router.post('/lead-tables/:id/capture-start',
    requireAuth, identifyTenant, checkPermission('leads', 'edit'),
    async (req, res) => {
      const tenantId = (req as any).tenantId
      const tableId = String(req.params.id)
      // Tenant-scope guard so a user can't open a capture window on
      // another tenant's table id.
      const { data: tbl } = await supabase.from('lead_tables')
        .select('id').eq('id', tableId).eq('tenant_id', tenantId).maybeSingle()
      if (!tbl) { res.status(404).json({ error: 'table not found' }); return }
      captureBuffer.set(tableId, { capturing_until: Date.now() + CAPTURE_WINDOW_MS })
      res.json({ capturing_until_ms: CAPTURE_WINDOW_MS, expires_at: new Date(Date.now() + CAPTURE_WINDOW_MS).toISOString() })
    })

  router.get('/lead-tables/:id/capture-status',
    requireAuth, identifyTenant, checkPermission('leads', 'view'),
    async (req, res) => {
      const tenantId = (req as any).tenantId
      const tableId = String(req.params.id)
      // Same tenant-scope check — capture entries are keyed by tableId,
      // and tableId is a uuid (low collision) but defence-in-depth.
      const { data: tbl } = await supabase.from('lead_tables')
        .select('id').eq('id', tableId).eq('tenant_id', tenantId).maybeSingle()
      if (!tbl) { res.status(404).json({ error: 'table not found' }); return }
      const cap = captureBuffer.get(tableId)
      if (!cap) { res.json({ status: 'idle' }); return }
      if (cap.captured) {
        // Drain on read — single-shot capture. User clicks Listen again to
        // start another window.
        captureBuffer.delete(tableId)
        res.json({ status: 'captured', payload: cap.captured })
        return
      }
      const remainingMs = Math.max(0, cap.capturing_until - Date.now())
      if (remainingMs === 0) {
        captureBuffer.delete(tableId)
        res.json({ status: 'expired' })
        return
      }
      res.json({ status: 'listening', remaining_ms: remainingMs })
    })

  router.post('/lead-tables/:id/capture-cancel',
    requireAuth, identifyTenant, checkPermission('leads', 'edit'),
    async (req, res) => {
      // Tenant-scope guard mirrors capture-start. Without it, an authed user
      // with leads:edit on tenant A could DoS-cancel tenant B's capture
      // window by guessing the uuid. Low impact (no payload exposure) but
      // trivially fixed.
      const tenantId = (req as any).tenantId
      const tableId = String(req.params.id)
      const { data: tbl } = await supabase.from('lead_tables')
        .select('id').eq('id', tableId).eq('tenant_id', tenantId).maybeSingle()
      if (!tbl) { res.status(404).json({ error: 'table not found' }); return }
      captureBuffer.delete(tableId)
      res.json({ cancelled: true })
    })

  // ── Assignment Rules ─────────────────────────────────────────────────────────

  router.get('/lead-tables/:id/assignments', requireAuth, identifyTenant, checkPermission('leads', 'view'), async (req, res) => {
    const tenantId = (req as any).tenantId
    const { data, error } = await supabase
      .from('lead_assignment_rules')
      .select('*')
      .eq('table_id', req.params.id)
      .eq('tenant_id', tenantId)
      .order('priority')
    if (error) { res.status(500).json({ error: error.message }); return }
    res.json(data)
  })

  // Verify a user_id is actually a member of the given tenant. Used to stop
  // tenant admins from assigning rows to users in other tenants (which would
  // attribute that data to a stranger and pollute their /leads/my-queue).
  async function isUserInTenant(userId: string, tenantId: string): Promise<boolean> {
    if (!userId || !tenantId) return false
    // Owner of the tenant is always considered "in" — no role row needed.
    const [{ data: owner }, { data: assignment }] = await Promise.all([
      supabase.from('tenants').select('id').eq('id', tenantId).eq('user_id', userId).maybeSingle(),
      supabase.from('user_role_assignments').select('id').eq('user_id', userId).eq('tenant_id', tenantId).is('disabled_at', null).maybeSingle(),
    ])
    return !!owner || !!assignment
  }

  // Allowed columns on lead_assignment_rules — never accept tenant_id, user_id,
  // table_id, id, created_at from the client (those are stamped server-side).
  const RULE_FIELDS = ['name', 'priority', 'conditions', 'assign_to', 'assign_to_name', 'assign_to_role', 'apply_tags', 'is_active'] as const

  router.post('/lead-tables/:id/assignments', requireAuth, identifyTenant, checkPermission('leads', 'edit'), async (req, res) => {
    const tenantId = (req as any).tenantId
    const safe = pickAllowed(req.body, RULE_FIELDS)
    if (safe.assign_to && !(await isUserInTenant(String(safe.assign_to), tenantId))) {
      res.status(400).json({ error: 'assign_to must be a member of this tenant' }); return
    }
    const { data, error } = await supabase
      .from('lead_assignment_rules')
      .insert({ ...safe, table_id: req.params.id, tenant_id: tenantId, user_id: (req as any).user.id })
      .select()
      .single()
    if (error) { res.status(500).json({ error: error.message }); return }
    res.json(data)
  })

  router.patch('/lead-tables/:id/assignments/:ruleId', requireAuth, identifyTenant, checkPermission('leads', 'edit'), async (req, res) => {
    const tenantId = (req as any).tenantId
    const safe = pickAllowed(req.body, RULE_FIELDS)
    if (safe.assign_to && !(await isUserInTenant(String(safe.assign_to), tenantId))) {
      res.status(400).json({ error: 'assign_to must be a member of this tenant' }); return
    }
    const { data, error } = await supabase
      .from('lead_assignment_rules')
      .update(safe)
      .eq('id', req.params.ruleId)
      .eq('tenant_id', tenantId)
      .select()
      .single()
    if (error) { res.status(500).json({ error: error.message }); return }
    res.json(data)
  })

  router.delete('/lead-tables/:id/assignments/:ruleId', requireAuth, identifyTenant, checkPermission('leads', 'delete'), async (req, res) => {
    const tenantId = (req as any).tenantId
    const { error } = await supabase
      .from('lead_assignment_rules')
      .delete()
      .eq('id', req.params.ruleId)
      .eq('tenant_id', tenantId)
    if (error) { res.status(500).json({ error: error.message }); return }
    res.json({ success: true })
  })

  // Apply assignment rules to rows in a table (or a filtered segment)
  router.post('/lead-tables/:id/apply-assignments', requireAuth, identifyTenant, checkPermission('leads', 'edit'), async (req, res) => {
    const tenantId = (req as any).tenantId
    const { row_ids, filter } = req.body as {
      row_ids?: string[]
      filter?: { status?: string; assigned_to?: string }
    }

    const { data: rules } = await supabase
      .from('lead_assignment_rules')
      .select('*')
      .eq('table_id', req.params.id)
      .eq('tenant_id', tenantId)
      .eq('is_active', true)
      .order('priority')

    if (!rules?.length) { res.json({ updated: 0 }); return }

    let q = supabase
      .from('lead_rows')
      .select('*')
      .eq('table_id', req.params.id)
      .eq('tenant_id', tenantId)

    if (row_ids?.length) q = q.in('id', row_ids)
    if (filter?.status)      q = q.eq('status', filter.status)
    if (filter?.assigned_to) q = q.eq('assigned_to', filter.assigned_to)

    const { data: rows } = await q
    if (!rows?.length) { res.json({ updated: 0 }); return }

    let updated = 0
    for (const row of rows as any[]) {
      for (const rule of rules as any[]) {
        if (matchesConditions(row.data ?? {}, rule.conditions ?? [])) {
          const newTags = [...new Set([...(row.tags ?? []), ...(rule.apply_tags ?? [])])]
          await supabase.from('lead_rows').update({
            assigned_to:      rule.assign_to,
            assigned_to_name: rule.assign_to_name,
            tags:             newTags,
            updated_at:       new Date().toISOString(),
          }).eq('id', row.id).eq('tenant_id', tenantId)
          updated++
          break // first matching rule wins (priority order)
        }
      }
    }
    res.json({ updated })
  })

  // ── Field Mapping Presets ────────────────────────────────────────────────────
  
  router.get('/lead-mappings', requireAuth, identifyTenant, checkPermission('leads', 'view'), async (req, res) => {
    const tenantId = (req as any).tenantId
    const { data, error } = await supabase
      .from('lead_field_mappings')
      .select('*')
      .eq('tenant_id', tenantId)
      .order('created_at', { ascending: false })
    if (error) { res.status(500).json({ error: error.message }); return }
    res.json(data)
  })

  router.get('/lead-tables/:id/mappings', requireAuth, identifyTenant, checkPermission('leads', 'view'), async (req, res) => {
    const tenantId = (req as any).tenantId
    const { data, error } = await supabase
      .from('lead_field_mappings')
      .select('*')
      .eq('table_id', req.params.id)
      .eq('tenant_id', tenantId)
      .order('created_at', { ascending: false })
    if (error) { res.status(500).json({ error: error.message }); return }
    res.json(data)
  })

  router.post('/lead-tables/:id/mappings', requireAuth, identifyTenant, checkPermission('leads', 'edit'), async (req, res) => {
    const tenantId = (req as any).tenantId
    const safe = pickAllowed(req.body, ['name', 'source_type', 'mappings'] as const)
    const { data, error } = await supabase
      .from('lead_field_mappings')
      .insert({ ...safe, table_id: req.params.id, tenant_id: tenantId, user_id: (req as any).user.id })
      .select()
      .single()
    if (error) { res.status(500).json({ error: error.message }); return }
    res.json(data)
  })

  router.delete('/lead-tables/:id/mappings/:mapId', requireAuth, identifyTenant, checkPermission('leads', 'delete'), async (req, res) => {
    const tenantId = (req as any).tenantId
    const { error } = await supabase
      .from('lead_field_mappings')
      .delete()
      .eq('id', req.params.mapId)
      .eq('tenant_id', tenantId)
    if (error) { res.status(500).json({ error: error.message }); return }
    res.json({ success: true })
  })

  router.get('/lead-tables/:id/lookup-options/:colKey', requireAuth, identifyTenant, checkPermission('leads', 'view'), async (req, res) => {
    const { id, colKey } = req.params
    const tenantId = (req as any).tenantId

    const { data, error } = await supabase
      .from('lead_rows')
      .select('data')
      .eq('table_id', id)
      .eq('tenant_id', tenantId)

    if (error) { res.status(500).json({ error: error.message }); return }

    const options = [...new Set(data.map(r => r.data?.[String(colKey)]).filter(Boolean))].sort()
    res.json(options)
  })

  return router
}
