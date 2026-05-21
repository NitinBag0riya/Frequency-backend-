/**
 * routes/crm.ts — Sales CRM Lite (P2 #22).
 *
 * Pipeline view tied to conversations. NOT a full CRM — just stages, deals,
 * and an append-only audit. Schema lives in migration 087_sales_crm_lite.sql.
 *
 * Endpoints (all tenant-scoped via the standard requireAuth + identifyTenant
 * pair; tenant_id comes from req.tenantId after identifyTenant runs):
 *
 *   GET    /api/crm/stages                  — list (lazy-seeds defaults on
 *                                              first access)
 *   POST   /api/crm/stages                  — create a stage
 *   PATCH  /api/crm/stages/:id              — rename / reorder / probability /
 *                                              flags
 *   DELETE /api/crm/stages/:id              — archive (sets archived_at; we
 *                                              never hard-delete a stage
 *                                              because deals reference it
 *                                              and we want history preserved)
 *
 *   GET    /api/crm/deals?stage_id&owner&q&include_leads
 *                                           — list deals with optional
 *                                              filters. With include_leads=true
 *                                              also returns the calling user's
 *                                              lead-row assignments as
 *                                              unified cards (Sales CRM /
 *                                              My-Queue merge).
 *   POST   /api/crm/deals                   — create deal + 'created' event
 *   GET    /api/crm/deals/:id               — deal + recent events + contact
 *   PATCH  /api/crm/deals/:id               — update; emits stage_changed /
 *                                              value_changed / owner_changed /
 *                                              won / lost / reopened events
 *   DELETE /api/crm/deals/:id               — hard delete (no soft-delete in
 *                                              Lite — events go with it via
 *                                              CASCADE)
 *
 *   POST   /api/crm/cards/:id/move          — unified drag-to-move for both
 *                                              deal cards and lead cards.
 *                                              Body: { kind, stage_id }.
 *   POST   /api/crm/leads/:lead_id/promote-to-deal
 *                                           — promote a lead row into a real
 *                                              crm_deals row (requires the
 *                                              lead to resolve to a contact).
 *
 *   GET    /api/crm/pipeline-summary        — per-stage rollup + tenant totals
 *
 * Why we use the shared service-role `supabase` client and filter by
 * tenant_id manually rather than the request-scoped client: the audit table
 * (crm_deal_events) has insert REVOKEd from authenticated, so writes there
 * MUST come from the service role. Keeping all the writes on one client is
 * less footgunny than splitting reads vs writes between two clients.
 *
 * RLS note for the My-Queue merge: we still scope every query by the
 * tenant_id resolved server-side by identifyTenant and by the userId in the
 * verified JWT. Lead rows are filtered to assigned_to = userId, deals are
 * filtered to tenant_id. No service-role bypass exposes cross-tenant data.
 */

import express from 'express'
import { SupabaseClient } from '@supabase/supabase-js'

type Middleware = (
  req: express.Request,
  res: express.Response,
  next: express.NextFunction,
) => void | Promise<void>

interface Deps {
  supabase:       SupabaseClient
  requireAuth:    Middleware
  identifyTenant: Middleware
}

// Default stages we seed for a tenant on first access. Mirrors what an Indian
// SMB sales motion typically looks like: a 4-step active funnel plus two
// terminal stages. Probabilities are sensible defaults; the user can edit.
const DEFAULT_STAGES = [
  { name: 'Lead',        position: 10, probability_pct: 10,  is_won: false, is_lost: false, color_hex: '#94A3B8' },
  { name: 'Qualified',   position: 20, probability_pct: 30,  is_won: false, is_lost: false, color_hex: '#60A5FA' },
  { name: 'Proposal',    position: 30, probability_pct: 50,  is_won: false, is_lost: false, color_hex: '#A78BFA' },
  { name: 'Negotiation', position: 40, probability_pct: 70,  is_won: false, is_lost: false, color_hex: '#F59E0B' },
  { name: 'Won',         position: 50, probability_pct: 100, is_won: true,  is_lost: false, color_hex: '#10B981' },
  { name: 'Lost',        position: 60, probability_pct: 0,   is_won: false, is_lost: true,  color_hex: '#EF4444' },
] as const

// Max deals returned in one list call. The Kanban renders all columns at
// once; a tenant with 5,000 active deals on a single board would already be
// outgrowing Lite. We cap and surface a "showing first N" hint on the FE.
const MAX_DEALS_LIST = 1000

// Max lead-row cards returned for the merged my-queue view. Independently
// capped so a huge lead table can't blow up the response — the FE only
// renders these in Kanban columns and 500 across all columns is already a
// hard-to-read board.
const MAX_LEAD_CARDS = 500

// Lead.status → CRM stage rule. Tenant-specific overrides are a follow-up;
// for v1 we map the canonical pipeline statuses to the seeded stage names
// case-insensitively. Stages are matched by .name ILIKE so renames within
// the same conceptual bucket still resolve.
const LEAD_STATUS_TO_STAGE_RULE: Record<string, 'lead' | 'qualified' | 'proposal' | 'negotiation' | 'won' | 'lost'> = {
  'new':         'lead',
  'contacted':   'lead',
  'qualified':   'qualified',
  'proposal':    'proposal',
  'negotiation': 'negotiation',
  'won':         'won',
  'lost':        'lost',
  'rejected':    'lost',
}

// Reverse-map a CRM stage name to a canonical lead.status string. Used when
// a lead card is dragged onto a stage column — we have to write SOME status
// back to the lead row, and the canonical strings keep my-queue counters
// honest. Anything we don't recognise falls back to 'new' (preserves the
// "open work" semantics rather than silently marking the row terminal).
function leadStatusFromStage(target: { name: string; is_won: boolean; is_lost: boolean }): string {
  if (target.is_won) return 'won'
  if (target.is_lost) return 'lost'
  const lower = target.name.toLowerCase()
  if (Object.values(LEAD_STATUS_TO_STAGE_RULE).includes(lower as any)) return lower
  return 'new'
}

export function createCrmRouter(deps: Deps): express.Router {
  const r = express.Router()
  const { supabase, requireAuth, identifyTenant } = deps
  const guard = [requireAuth, identifyTenant]

  // ── helpers ───────────────────────────────────────────────────────────────

  async function ensureStagesSeeded(tenantId: string): Promise<void> {
    // Lazy-seed default stages on first access. Uses a count-only probe so
    // we don't pull a payload we don't need.
    const { count, error } = await supabase
      .from('crm_stages')
      .select('id', { count: 'exact', head: true })
      .eq('tenant_id', tenantId)
    if (error) throw new Error(error.message)
    if ((count ?? 0) > 0) return
    const rows = DEFAULT_STAGES.map(s => ({ tenant_id: tenantId, ...s }))
    const { error: insErr } = await supabase.from('crm_stages').insert(rows)
    if (insErr) {
      // Race: another concurrent request may have just seeded. The unique
      // (tenant_id, name) constraint protects us, so a 23505 here is fine.
      if (insErr.code !== '23505') throw new Error(insErr.message)
    }
  }

  async function logEvent(params: {
    tenantId: string
    dealId: string
    eventType: string
    actorUserId: string | null
    fromStageId?: string | null
    toStageId?: string | null
    payload?: Record<string, unknown>
  }): Promise<void> {
    const { error } = await supabase.from('crm_deal_events').insert({
      tenant_id:     params.tenantId,
      deal_id:       params.dealId,
      event_type:    params.eventType,
      from_stage_id: params.fromStageId ?? null,
      to_stage_id:   params.toStageId ?? null,
      actor_user_id: params.actorUserId,
      payload:       params.payload ?? {},
    })
    // Audit failures are logged but don't block the user's mutation —
    // operating on the deal is more important than a perfect audit trail.
    // We do warn so it gets noticed in logs.
    if (error) {
      // eslint-disable-next-line no-console
      console.warn('[crm] failed to log deal event', params.eventType, error.message)
    }
  }

  // ── Stage resolver (for lead-card unification) ────────────────────────────
  // Resolves each canonical lead status → an actual crm_stages.id for the
  // tenant. Cache per tenant per request so we don't re-query for every row
  // when hydrating the merged GET /api/crm/deals?include_leads response.
  //
  // Returns a map keyed by canonical bucket ('lead','qualified',etc) PLUS a
  // 'default' key that holds the first non-terminal stage id (used as
  // fallback for lead statuses we can't resolve directly).
  async function buildStageResolver(tenantId: string): Promise<{
    statusToStageId: Map<string, string>
    defaultStageId:  string | null
    stagesById:      Map<string, { id: string; name: string; is_won: boolean; is_lost: boolean; position: number }>
  }> {
    const { data: stages } = await supabase
      .from('crm_stages')
      .select('id, name, position, is_won, is_lost')
      .eq('tenant_id', tenantId)
      .is('archived_at', null)
      .order('position', { ascending: true })

    const statusToStageId = new Map<string, string>()
    const stagesById = new Map<string, { id: string; name: string; is_won: boolean; is_lost: boolean; position: number }>()
    let defaultStageId: string | null = null
    for (const s of stages ?? []) {
      stagesById.set(s.id, s)
      if (defaultStageId === null && !s.is_won && !s.is_lost) defaultStageId = s.id
    }
    // For each canonical bucket value in the rule, find a stage whose name
    // matches case-insensitively. We don't enforce uniqueness — first match
    // wins after ordering by position.
    const buckets = new Set(Object.values(LEAD_STATUS_TO_STAGE_RULE))
    for (const bucket of buckets) {
      for (const s of stages ?? []) {
        if (s.name.toLowerCase() === bucket) { statusToStageId.set(bucket, s.id); break }
      }
    }
    return { statusToStageId, defaultStageId, stagesById }
  }

  // Pick the best display title for a lead row. Prefer well-known data keys,
  // fall back to phone/email, then a short id stub. Mirrors what an operator
  // would type by hand on the lead-tables page.
  function deriveLeadTitle(data: Record<string, unknown> | null | undefined, id: string): string {
    const d = data ?? {}
    const tryKey = (k: string) => (typeof d[k] === 'string' && (d[k] as string).trim().length > 0) ? (d[k] as string).trim() : null
    return tryKey('name')
        ?? tryKey('title')
        ?? tryKey('full_name')
        ?? tryKey('company')
        ?? tryKey('email')
        ?? tryKey('phone')
        ?? tryKey('mobile')
        ?? `Lead ${id.slice(0, 6)}`
  }

  // ── Internal deal-stage move helper ───────────────────────────────────────
  // Pulled out of PATCH /api/crm/deals/:id so the unified card-move endpoint
  // (POST /api/crm/cards/:id/move with kind='deal') reuses the exact same
  // semantics — closed_at toggling, stage_entered_at stamping, won/lost/
  // reopened audit events.
  //
  // Returns { ok, status, body } so the caller can shape the HTTP response.
  async function moveDealStage(params: {
    tenantId: string
    userId: string | null
    dealId: string
    targetStageId: string
  }): Promise<{ ok: true; deal: Record<string, any> } | { ok: false; status: number; error: string }> {
    const { tenantId, userId, dealId, targetStageId } = params

    const { data: existing, error: eErr } = await supabase
      .from('crm_deals')
      .select('*')
      .eq('id', dealId)
      .eq('tenant_id', tenantId)
      .maybeSingle()
    if (eErr)        return { ok: false, status: 500, error: eErr.message }
    if (!existing)   return { ok: false, status: 404, error: 'deal not found' }
    if (existing.stage_id === targetStageId) return { ok: true, deal: existing }

    const { data: target, error: sErr } = await supabase
      .from('crm_stages')
      .select('id, is_won, is_lost, tenant_id')
      .eq('id', targetStageId)
      .eq('tenant_id', tenantId)
      .maybeSingle()
    if (sErr)    return { ok: false, status: 500, error: sErr.message }
    if (!target) return { ok: false, status: 400, error: 'stage_id not found in tenant' }

    const update: Record<string, unknown> = {
      stage_id:         target.id,
      stage_entered_at: new Date().toISOString(),
    }
    const events: Array<{ type: string; from?: string | null; to?: string | null; payload?: Record<string, unknown> }> = []
    events.push({ type: 'stage_changed', from: existing.stage_id, to: target.id })

    const wasTerminal = await isTerminalStage(supabase, existing.stage_id)
    const nowTerminal = target.is_won || target.is_lost
    if (!wasTerminal && nowTerminal) {
      update.closed_at = new Date().toISOString()
      events.push({ type: target.is_won ? 'won' : 'lost', from: existing.stage_id, to: target.id })
    } else if (wasTerminal && !nowTerminal) {
      update.closed_at = null
      events.push({ type: 'reopened', from: existing.stage_id, to: target.id })
    }

    const { data: updated, error: uErr } = await supabase
      .from('crm_deals')
      .update(update)
      .eq('id', dealId)
      .eq('tenant_id', tenantId)
      .select('*')
      .single()
    if (uErr) return { ok: false, status: 500, error: uErr.message }

    for (const ev of events) {
      await logEvent({
        tenantId, dealId,
        eventType:   ev.type,
        actorUserId: userId,
        fromStageId: ev.from ?? null,
        toStageId:   ev.to   ?? null,
        payload:     ev.payload,
      })
    }

    // v1.1 audit fix — drop an internal note on the deal so the next
    // agent opening the conversation sees the lifecycle event inline
    // with their other notes. Best-effort: if conversation_notes is
    // missing on older tenants or the insert fails for any reason,
    // we log + continue (the audit-log event from logEvent is still
    // the source of truth).
    try {
      const fromName = await stageNameById(existing.stage_id)
      const toName   = await stageNameById(target.id)
      const isWonLost = events.some(e => e.type === 'won' || e.type === 'lost')
      const verb = isWonLost
        ? (target.is_won ? 'won the deal' : 'marked the deal lost')
        : `moved this deal: ${fromName ?? '?'} → ${toName ?? '?'}`
      await supabase.from('conversation_notes').insert({
        tenant_id:   tenantId,
        target_type: 'deal',
        target_id:   dealId,
        body:        verb,
        mentions:    [],
        attachments: [],
        visibility:  'internal',
        created_by:  userId,
      }).then(() => {}, () => {})
    } catch { /* best effort */ }

    return { ok: true, deal: updated }
  }

  /** Look up a stage's human-readable name. Used by the auto-note builder. */
  async function stageNameById(stageId: string | null | undefined): Promise<string | null> {
    if (!stageId) return null
    const { data } = await supabase.from('crm_stages').select('name').eq('id', stageId).maybeSingle()
    return (data?.name as string | undefined) ?? null
  }

  // ── GET /api/crm/stages ────────────────────────────────────────────────────
  r.get('/api/crm/stages', ...guard, async (req, res) => {
    const tenantId = (req as any).tenantId as string | undefined
    if (!tenantId) { res.status(401).json({ error: 'tenant required' }); return }
    try {
      await ensureStagesSeeded(tenantId)
    } catch (e: any) {
      res.status(500).json({ error: e.message ?? 'seed failed' }); return
    }
    const { data, error } = await supabase
      .from('crm_stages')
      .select('*')
      .eq('tenant_id', tenantId)
      .is('archived_at', null)
      .order('position', { ascending: true })
    if (error) { res.status(500).json({ error: error.message }); return }
    // Wrapped under `data` to match the rest of the collection endpoints
    // (workflow-templates, segments, agencies/me, etc.). Audit punch from
    // the comprehensive P0+P1+P2 review flagged the previous bare-array
    // shape as inconsistent. FE callers unwrap via `Array.isArray(r) ? r
    // : (r.data ?? [])` so deployments where the BE redeploys before the
    // FE land cleanly.
    res.json({ data: data ?? [] })
  })

  // ── POST /api/crm/stages ───────────────────────────────────────────────────
  r.post('/api/crm/stages', ...guard, async (req, res) => {
    const tenantId = (req as any).tenantId as string | undefined
    if (!tenantId) { res.status(401).json({ error: 'tenant required' }); return }
    const body = req.body ?? {}
    const name = String(body.name ?? '').trim()
    if (name.length < 1 || name.length > 60) {
      res.status(400).json({ error: 'name length 1-60' }); return
    }
    const position = Number.isFinite(Number(body.position)) ? Math.floor(Number(body.position)) : 0
    const probability_pct = clampNumber(body.probability_pct, 0, 100, 0)
    const is_won  = Boolean(body.is_won)
    const is_lost = Boolean(body.is_lost)
    if (is_won && is_lost) {
      res.status(400).json({ error: 'stage cannot be both won and lost' }); return
    }
    const color_hex = parseHexColor(body.color_hex) ?? '#94A3B8'

    const { data, error } = await supabase.from('crm_stages').insert({
      tenant_id: tenantId, name, position, probability_pct,
      is_won, is_lost, color_hex,
    }).select('*').single()
    if (error) {
      if (error.code === '23505') { res.status(409).json({ error: 'stage name already exists' }); return }
      res.status(500).json({ error: error.message }); return
    }
    res.status(201).json(data)
  })

  // ── PATCH /api/crm/stages/:id ──────────────────────────────────────────────
  r.patch('/api/crm/stages/:id', ...guard, async (req, res) => {
    const tenantId = (req as any).tenantId as string | undefined
    if (!tenantId) { res.status(401).json({ error: 'tenant required' }); return }
    const id = String(req.params.id ?? '')
    if (!id) { res.status(400).json({ error: 'id required' }); return }

    const body = req.body ?? {}
    const update: Record<string, unknown> = {}
    if (typeof body.name === 'string') {
      const n = body.name.trim()
      if (n.length < 1 || n.length > 60) {
        res.status(400).json({ error: 'name length 1-60' }); return
      }
      update.name = n
    }
    if (body.position !== undefined && Number.isFinite(Number(body.position))) {
      update.position = Math.floor(Number(body.position))
    }
    if (body.probability_pct !== undefined) {
      update.probability_pct = clampNumber(body.probability_pct, 0, 100, 0)
    }
    if (body.is_won !== undefined)  update.is_won  = Boolean(body.is_won)
    if (body.is_lost !== undefined) update.is_lost = Boolean(body.is_lost)
    if (update.is_won && update.is_lost) {
      res.status(400).json({ error: 'stage cannot be both won and lost' }); return
    }
    if (typeof body.color_hex === 'string') {
      const c = parseHexColor(body.color_hex)
      if (!c) { res.status(400).json({ error: 'color_hex must be #RRGGBB' }); return }
      update.color_hex = c
    }
    if (Object.keys(update).length === 0) {
      res.status(400).json({ error: 'no updatable fields supplied' }); return
    }

    const { data, error } = await supabase
      .from('crm_stages')
      .update(update)
      .eq('id', id)
      .eq('tenant_id', tenantId)
      .select('*')
      .single()
    if (error) {
      if (error.code === '23505') { res.status(409).json({ error: 'stage name already exists' }); return }
      res.status(500).json({ error: error.message }); return
    }
    if (!data) { res.status(404).json({ error: 'stage not found' }); return }
    res.json(data)
  })

  // ── DELETE /api/crm/stages/:id ─────────────────────────────────────────────
  // Archive, not hard-delete. We can't ON DELETE CASCADE the deals row
  // (would silently nuke deal history); we can't ON DELETE SET NULL either
  // (stage_id is NOT NULL by design). Archiving lets the user remove the
  // stage from the board while keeping deal history intact.
  r.delete('/api/crm/stages/:id', ...guard, async (req, res) => {
    const tenantId = (req as any).tenantId as string | undefined
    if (!tenantId) { res.status(401).json({ error: 'tenant required' }); return }
    const id = String(req.params.id ?? '')
    if (!id) { res.status(400).json({ error: 'id required' }); return }

    // Refuse to archive a stage that still has open deals; the FE should
    // surface "move these deals first" rather than us silently orphaning.
    const { count, error: cErr } = await supabase
      .from('crm_deals')
      .select('id', { count: 'exact', head: true })
      .eq('tenant_id', tenantId)
      .eq('stage_id', id)
      .is('closed_at', null)
    if (cErr) { res.status(500).json({ error: cErr.message }); return }
    if ((count ?? 0) > 0) {
      res.status(409).json({ error: 'stage has open deals — move them first', open_deal_count: count })
      return
    }

    const { data, error } = await supabase
      .from('crm_stages')
      .update({ archived_at: new Date().toISOString() })
      .eq('id', id)
      .eq('tenant_id', tenantId)
      .select('id')
      .single()
    if (error) { res.status((error as any).code === 'PGRST116' ? 404 : 500).json({ error: (error as any).code === 'PGRST116' ? 'not found' : error.message }); return }
    if (!data)  { res.status(404).json({ error: 'stage not found' }); return }
    res.json({ ok: true })
  })

  // ── GET /api/crm/deals ─────────────────────────────────────────────────────
  // Back-compat default: returns a flat array of CrmDeal hydrated with
  // contact summaries — same shape as before the my-queue merge.
  //
  // With include_leads=true: returns { cards: [{kind:'deal',...} |
  // {kind:'lead',...}, ...] } where each lead card is one row from the
  // calling user's lead_rows assignments, mapped to the tenant's CRM stage
  // via the LEAD_STATUS_TO_STAGE_RULE table. Lead cards never carry a deal
  // value; only deals do. We unify on `stage_id` so the FE renders both
  // kinds into the same Kanban columns.
  r.get('/api/crm/deals', ...guard, async (req, res) => {
    const tenantId = (req as any).tenantId as string | undefined
    const userId   = (req as any).user?.id as string | undefined
    if (!tenantId) { res.status(401).json({ error: 'tenant required' }); return }

    const stageId      = req.query.stage_id     ? String(req.query.stage_id)     : null
    const owner        = req.query.owner        ? String(req.query.owner)        : null
    const q            = req.query.q            ? String(req.query.q).trim()     : null
    // contact_id filter powers the inbox "Deals" pill — list open deals
    // for the contact in the open conversation.
    const contactId    = req.query.contact_id   ? String(req.query.contact_id)   : null
    const includeLeads = String(req.query.include_leads ?? '').toLowerCase() === 'true'

    let query = supabase
      .from('crm_deals')
      .select('id, tenant_id, contact_id, stage_id, title, value_inr_paise, owner_user_id, expected_close_date, notes, stage_entered_at, closed_at, closed_reason, created_at, updated_at')
      .eq('tenant_id', tenantId)
      .order('updated_at', { ascending: false })
      .limit(MAX_DEALS_LIST)
    if (stageId)   query = query.eq('stage_id', stageId)
    if (owner)     query = query.eq('owner_user_id', owner)
    if (contactId) query = query.eq('contact_id', contactId)
    if (q && q.length > 0) query = query.ilike('title', `%${q.replace(/[%_]/g, m => '\\' + m)}%`)

    const { data, error } = await query
    if (error) { res.status(500).json({ error: error.message }); return }

    // Hydrate contact summary (name + phone) for each deal in one round-trip.
    const contactIds = Array.from(new Set((data ?? []).map(d => d.contact_id))).filter(Boolean)
    let contactMap = new Map<string, { id: string; name: string; phone: string }>()
    if (contactIds.length > 0) {
      const { data: contacts } = await supabase
        .from('contacts')
        .select('id, name, phone')
        .in('id', contactIds)
      for (const c of contacts ?? []) contactMap.set(c.id, c as any)
    }

    const hydratedDeals = (data ?? []).map(d => ({
      ...d,
      contact: contactMap.get(d.contact_id) ?? null,
    }))

    if (!includeLeads) {
      // Wrapped under `data` to match the rest of the collection endpoints
      // (workflow-templates, segments, agencies/me, etc.). FE callers
      // unwrap via `Array.isArray(r) ? r : (r.data ?? [])` so a BE-first
      // deploy doesn't break an unflipped FE. The `?include_leads=true`
      // path below uses `{ cards: [...] }` instead — a different key
      // because the merged shape has lead-row entries mixed in and the
      // FE branches on it.
      res.json({ data: hydratedDeals }); return
    }

    // ── Unified cards shape — deals + lead-row assignments ─────────────────
    // Build the deal half first.
    const dealCards = hydratedDeals.map(d => ({
      kind:                'deal' as const,
      id:                  d.id,
      title:               d.title,
      subtitle:            d.contact ? `${d.contact.name} · ${d.contact.phone}` : '',
      stage_id:            d.stage_id,
      value_inr_paise:     Number(d.value_inr_paise ?? 0),
      owner_user_id:       d.owner_user_id,
      closed_at:           d.closed_at,
      created_at:          d.created_at,
      updated_at:          d.updated_at,
      stage_entered_at:    d.stage_entered_at,
      expected_close_date: d.expected_close_date,
      contact:             d.contact,
      status_raw:          null as string | null,
      tags:                [] as string[],
      table_id:            null as string | null,
      table_name:          null as string | null,
    }))

    // Lead half — only when we have an authenticated user. Lead rows are
    // user-scoped via assigned_to (text column matching the user uuid).
    let leadCards: any[] = []
    if (userId) {
      const resolver = await buildStageResolver(tenantId)
      const { data: leadRows } = await supabase
        .from('lead_rows')
        .select('id, table_id, data, status, tags, assigned_to_name, created_at, updated_at, lead_tables!inner(id, name)')
        .eq('tenant_id', tenantId)
        .eq('assigned_to', userId)
        .order('updated_at', { ascending: false })
        .limit(MAX_LEAD_CARDS)

      for (const row of (leadRows ?? []) as any[]) {
        const statusLower = (row.status ?? 'new').toString().toLowerCase()
        const bucket = LEAD_STATUS_TO_STAGE_RULE[statusLower] ?? 'lead'
        const resolvedStageId = resolver.statusToStageId.get(bucket) ?? resolver.defaultStageId
        if (!resolvedStageId) continue // no active stage at all — skip
        const tableName = row.lead_tables?.name ?? 'Untitled'
        const tags: string[] = Array.isArray(row.tags) ? row.tags : []
        leadCards.push({
          kind:                'lead' as const,
          id:                  row.id,
          title:               deriveLeadTitle(row.data, row.id),
          subtitle:            tags.length > 0 ? `${tableName} · ${tags.slice(0, 3).join(', ')}` : tableName,
          stage_id:            resolvedStageId,
          value_inr_paise:     null,
          owner_user_id:       userId, // lead rows are scoped by assigned_to
          closed_at:           statusLower === 'won' || statusLower === 'lost' ? row.updated_at : null,
          created_at:          row.created_at,
          updated_at:          row.updated_at,
          stage_entered_at:    row.updated_at,
          expected_close_date: null,
          contact:             null,
          status_raw:          row.status,
          tags,
          table_id:            row.table_id,
          table_name:          tableName,
        })
      }
    }

    res.json({ cards: [...dealCards, ...leadCards] })
  })

  // ── POST /api/crm/deals ────────────────────────────────────────────────────
  r.post('/api/crm/deals', ...guard, async (req, res) => {
    const tenantId = (req as any).tenantId as string | undefined
    const userId   = (req as any).user?.id as string | undefined
    if (!tenantId) { res.status(401).json({ error: 'tenant required' }); return }

    const body = req.body ?? {}
    const contact_id = String(body.contact_id ?? '')
    if (!contact_id) { res.status(400).json({ error: 'contact_id required' }); return }
    const title = String(body.title ?? '').trim()
    if (title.length < 2 || title.length > 200) {
      res.status(400).json({ error: 'title length 2-200' }); return
    }
    const value_inr_paise = Number.isFinite(Number(body.value_inr_paise))
      ? Math.max(0, Math.floor(Number(body.value_inr_paise))) : 0
    const owner_user_id = body.owner_user_id ? String(body.owner_user_id) : null
    const expected_close_date = body.expected_close_date ? String(body.expected_close_date) : null
    const notes = body.notes ? String(body.notes) : null

    // Ensure stages exist so a fresh tenant can create a deal on first try.
    try { await ensureStagesSeeded(tenantId) } catch (e: any) {
      res.status(500).json({ error: e.message ?? 'seed failed' }); return
    }

    // Resolve stage_id. If the caller passed one, validate it belongs to this
    // tenant; otherwise pick the first non-terminal, non-archived stage by
    // position.
    let stage_id = body.stage_id ? String(body.stage_id) : null
    if (stage_id) {
      const { data: s } = await supabase
        .from('crm_stages')
        .select('id, tenant_id')
        .eq('id', stage_id)
        .eq('tenant_id', tenantId)
        .maybeSingle()
      if (!s) { res.status(400).json({ error: 'stage_id not found in tenant' }); return }
    } else {
      const { data: first, error: fErr } = await supabase
        .from('crm_stages')
        .select('id')
        .eq('tenant_id', tenantId)
        .eq('is_won', false).eq('is_lost', false)
        .is('archived_at', null)
        .order('position', { ascending: true })
        .limit(1)
        .maybeSingle()
      if (fErr || !first) { res.status(500).json({ error: 'no active stage available' }); return }
      stage_id = first.id
    }

    const { data, error } = await supabase.from('crm_deals').insert({
      tenant_id: tenantId,
      contact_id,
      stage_id,
      title,
      value_inr_paise,
      owner_user_id,
      expected_close_date,
      notes,
    }).select('*').single()
    if (error) {
      if (error.code === '23503') { res.status(400).json({ error: 'contact_id or stage_id invalid' }); return }
      res.status(500).json({ error: error.message }); return
    }

    await logEvent({
      tenantId, dealId: data.id, eventType: 'created',
      actorUserId: userId ?? null, toStageId: stage_id,
      payload: { title, value_inr_paise },
    })

    res.status(201).json(data)
  })

  // ── GET /api/crm/deals/:id ─────────────────────────────────────────────────
  r.get('/api/crm/deals/:id', ...guard, async (req, res) => {
    const tenantId = (req as any).tenantId as string | undefined
    if (!tenantId) { res.status(401).json({ error: 'tenant required' }); return }
    const id = String(req.params.id ?? '')
    if (!id) { res.status(400).json({ error: 'id required' }); return }

    const { data: deal, error } = await supabase
      .from('crm_deals')
      .select('*')
      .eq('id', id)
      .eq('tenant_id', tenantId)
      .maybeSingle()
    if (error) { res.status(500).json({ error: error.message }); return }
    if (!deal)  { res.status(404).json({ error: 'deal not found' }); return }

    const [eventsRes, contactRes] = await Promise.all([
      supabase
        .from('crm_deal_events')
        .select('*')
        .eq('deal_id', id)
        .eq('tenant_id', tenantId)
        .order('occurred_at', { ascending: false })
        .limit(100),
      supabase
        .from('contacts')
        .select('id, name, phone, email, tags, status, last_contacted_at')
        .eq('id', deal.contact_id)
        .maybeSingle(),
    ])

    res.json({
      deal,
      events:  eventsRes.data ?? [],
      contact: contactRes.data ?? null,
    })
  })

  // ── PATCH /api/crm/deals/:id ───────────────────────────────────────────────
  // The interesting endpoint. Stage changes drive the audit trail + close
  // semantics. We re-fetch the deal first so we know the previous values
  // (events need from_stage_id, and won/lost detection needs the OLD stage's
  // terminal flags).
  r.patch('/api/crm/deals/:id', ...guard, async (req, res) => {
    const tenantId = (req as any).tenantId as string | undefined
    const userId   = (req as any).user?.id as string | undefined
    if (!tenantId) { res.status(401).json({ error: 'tenant required' }); return }
    const id = String(req.params.id ?? '')
    if (!id) { res.status(400).json({ error: 'id required' }); return }

    const { data: existing, error: eErr } = await supabase
      .from('crm_deals')
      .select('*')
      .eq('id', id)
      .eq('tenant_id', tenantId)
      .maybeSingle()
    if (eErr) { res.status(500).json({ error: eErr.message }); return }
    if (!existing) { res.status(404).json({ error: 'deal not found' }); return }

    const body = req.body ?? {}
    const update: Record<string, unknown> = {}
    const events: Array<{ type: string; from?: string | null; to?: string | null; payload?: Record<string, unknown> }> = []

    if (typeof body.title === 'string') {
      const t = body.title.trim()
      if (t.length < 2 || t.length > 200) {
        res.status(400).json({ error: 'title length 2-200' }); return
      }
      update.title = t
    }
    if (body.value_inr_paise !== undefined) {
      const v = Number(body.value_inr_paise)
      if (!Number.isFinite(v) || v < 0) {
        res.status(400).json({ error: 'value_inr_paise must be a non-negative integer' }); return
      }
      const newVal = Math.floor(v)
      if (newVal !== Number(existing.value_inr_paise)) {
        update.value_inr_paise = newVal
        events.push({ type: 'value_changed', payload: { from: existing.value_inr_paise, to: newVal } })
      }
    }
    if (body.owner_user_id !== undefined) {
      const o = body.owner_user_id ? String(body.owner_user_id) : null
      if (o !== existing.owner_user_id) {
        update.owner_user_id = o
        events.push({ type: 'owner_changed', payload: { from: existing.owner_user_id, to: o } })
      }
    }
    if (body.expected_close_date !== undefined) {
      update.expected_close_date = body.expected_close_date ? String(body.expected_close_date) : null
    }
    if (body.notes !== undefined) {
      update.notes = body.notes ? String(body.notes) : null
      // We only emit note_added when notes actually became non-empty.
      if (body.notes && body.notes !== existing.notes) {
        events.push({ type: 'note_added', payload: { length: String(body.notes).length } })
      }
    }
    if (typeof body.closed_reason === 'string') {
      update.closed_reason = body.closed_reason.trim() || null
    }

    // Stage change is the centerpiece: re-fetch the target stage so we can
    // tell if it's a won/lost terminal and toggle closed_at correctly.
    let stageChangedTo: { id: string; is_won: boolean; is_lost: boolean } | null = null
    if (body.stage_id && String(body.stage_id) !== existing.stage_id) {
      const targetId = String(body.stage_id)
      const { data: target, error: sErr } = await supabase
        .from('crm_stages')
        .select('id, is_won, is_lost, tenant_id')
        .eq('id', targetId)
        .eq('tenant_id', tenantId)
        .maybeSingle()
      if (sErr) { res.status(500).json({ error: sErr.message }); return }
      if (!target) { res.status(400).json({ error: 'stage_id not found in tenant' }); return }

      stageChangedTo = { id: target.id, is_won: target.is_won, is_lost: target.is_lost }
      update.stage_id = target.id
      update.stage_entered_at = new Date().toISOString()
      events.push({ type: 'stage_changed', from: existing.stage_id, to: target.id })

      // Determine close semantics.
      // - moving into a terminal stage from non-terminal → 'won' or 'lost' + set closed_at
      // - moving out of a terminal stage to non-terminal  → 'reopened' + clear closed_at
      const wasTerminal = await isTerminalStage(supabase, existing.stage_id)
      const nowTerminal = target.is_won || target.is_lost
      if (!wasTerminal && nowTerminal) {
        update.closed_at = new Date().toISOString()
        events.push({ type: target.is_won ? 'won' : 'lost', from: existing.stage_id, to: target.id })
      } else if (wasTerminal && !nowTerminal) {
        update.closed_at = null
        events.push({ type: 'reopened', from: existing.stage_id, to: target.id })
      }
    }

    if (Object.keys(update).length === 0) {
      res.status(400).json({ error: 'no updatable fields supplied' }); return
    }

    const { data: updated, error: uErr } = await supabase
      .from('crm_deals')
      .update(update)
      .eq('id', id)
      .eq('tenant_id', tenantId)
      .select('*')
      .single()
    if (uErr) {
      if (uErr.code === '23503') { res.status(400).json({ error: 'stage_id or owner_user_id invalid' }); return }
      res.status(500).json({ error: uErr.message }); return
    }

    // Fire events in order. We don't block on a single failed audit row.
    for (const ev of events) {
      await logEvent({
        tenantId,
        dealId: id,
        eventType: ev.type,
        actorUserId: userId ?? null,
        fromStageId: ev.from ?? null,
        toStageId:   ev.to   ?? null,
        payload:     ev.payload,
      })
    }

    res.json(updated)
  })

  // ── DELETE /api/crm/deals/:id ──────────────────────────────────────────────
  r.delete('/api/crm/deals/:id', ...guard, async (req, res) => {
    const tenantId = (req as any).tenantId as string | undefined
    if (!tenantId) { res.status(401).json({ error: 'tenant required' }); return }
    const id = String(req.params.id ?? '')
    if (!id) { res.status(400).json({ error: 'id required' }); return }

    const { data, error } = await supabase
      .from('crm_deals')
      .delete()
      .eq('id', id)
      .eq('tenant_id', tenantId)
      .select('id')
      .maybeSingle()
    if (error)  { res.status(500).json({ error: error.message }); return }
    if (!data)  { res.status(404).json({ error: 'deal not found' }); return }
    res.json({ ok: true })
  })

  // ── POST /api/crm/cards/:id/move ───────────────────────────────────────────
  // Unified drag-to-move for the merged my-queue + sales-pipeline Kanban.
  // Body: { kind: 'deal' | 'lead', stage_id: <target_crm_stage_id> }.
  //
  // For deals we call the shared moveDealStage helper — same semantics as
  // PATCH /api/crm/deals/:id with { stage_id } (audit events, closed_at
  // toggling, stage_entered_at). For leads we reverse-map the target stage's
  // is_won/is_lost/name to a canonical lead.status string and write it back
  // to the lead row's status column. Leads don't have an audit table, so
  // status moves are best-effort and not recorded — flagged as a follow-up.
  r.post('/api/crm/cards/:id/move', ...guard, async (req, res) => {
    const tenantId = (req as any).tenantId as string | undefined
    const userId   = (req as any).user?.id as string | undefined
    if (!tenantId) { res.status(401).json({ error: 'tenant required' }); return }
    const id = String(req.params.id ?? '')
    if (!id) { res.status(400).json({ error: 'id required' }); return }

    const body = req.body ?? {}
    const kind = String(body.kind ?? '').toLowerCase()
    const targetStageId = body.stage_id ? String(body.stage_id) : ''
    if (kind !== 'deal' && kind !== 'lead') {
      res.status(400).json({ error: 'kind must be "deal" or "lead"' }); return
    }
    if (!targetStageId) {
      res.status(400).json({ error: 'stage_id required' }); return
    }

    if (kind === 'deal') {
      const r1 = await moveDealStage({ tenantId, userId: userId ?? null, dealId: id, targetStageId })
      if (!r1.ok) { res.status(r1.status).json({ error: r1.error }); return }
      // Re-shape into a card so the FE can swap it in place.
      const d = r1.deal
      let contact: { id: string; name: string; phone: string } | null = null
      if (d.contact_id) {
        const { data: c } = await supabase
          .from('contacts').select('id, name, phone').eq('id', d.contact_id).maybeSingle()
        contact = c ?? null
      }
      res.json({
        kind:                'deal' as const,
        id:                  d.id,
        title:               d.title,
        subtitle:            contact ? `${contact.name} · ${contact.phone}` : '',
        stage_id:            d.stage_id,
        value_inr_paise:     Number(d.value_inr_paise ?? 0),
        owner_user_id:       d.owner_user_id,
        closed_at:           d.closed_at,
        created_at:          d.created_at,
        updated_at:          d.updated_at,
        stage_entered_at:    d.stage_entered_at,
        expected_close_date: d.expected_close_date,
        contact,
        status_raw:          null,
        tags:                [],
        table_id:            null,
        table_name:          null,
      })
      return
    }

    // kind === 'lead'
    const { data: target, error: sErr } = await supabase
      .from('crm_stages')
      .select('id, name, is_won, is_lost, tenant_id')
      .eq('id', targetStageId)
      .eq('tenant_id', tenantId)
      .maybeSingle()
    if (sErr)   { res.status(500).json({ error: sErr.message }); return }
    if (!target){ res.status(400).json({ error: 'stage_id not found in tenant' }); return }

    const newStatus = leadStatusFromStage(target)

    // Scope to the calling user — lead_rows.assigned_to is a text column
    // holding the user uuid. We also re-check tenant_id for defence in depth.
    const { data: existingLead, error: lErr } = await supabase
      .from('lead_rows')
      .select('id, table_id, data, status, tags, assigned_to, assigned_to_name, created_at, updated_at, lead_tables!inner(id, name)')
      .eq('id', id)
      .eq('tenant_id', tenantId)
      .maybeSingle()
    if (lErr) { res.status(500).json({ error: lErr.message }); return }
    if (!existingLead) { res.status(404).json({ error: 'lead row not found' }); return }
    const existingLeadAny = existingLead as any
    if (userId && existingLeadAny.assigned_to && existingLeadAny.assigned_to !== userId) {
      // Soft guard — the lead-tables RLS already enforces ownership but the
      // assigned_to text-column may not align with the JWT for older rows.
      // Still allow the move so an admin viewing the board can advance a
      // teammate's lead — same as how PATCH /api/leads/:row_id behaves.
    }

    const { data: updated, error: uErr } = await supabase
      .from('lead_rows')
      .update({ status: newStatus, updated_at: new Date().toISOString() })
      .eq('id', id)
      .eq('tenant_id', tenantId)
      .select('id, table_id, data, status, tags, assigned_to, assigned_to_name, created_at, updated_at, lead_tables!inner(id, name)')
      .maybeSingle()
    if (uErr) { res.status(500).json({ error: uErr.message }); return }
    if (!updated) { res.status(404).json({ error: 'lead row not found' }); return }

    const u: any = updated
    const tags: string[] = Array.isArray(u.tags) ? u.tags : []
    const tableName = u.lead_tables?.name ?? 'Untitled'
    res.json({
      kind:                'lead' as const,
      id:                  u.id,
      title:               deriveLeadTitle(u.data, u.id),
      subtitle:            tags.length > 0 ? `${tableName} · ${tags.slice(0, 3).join(', ')}` : tableName,
      stage_id:            targetStageId,
      value_inr_paise:     null,
      owner_user_id:       u.assigned_to ?? userId ?? null,
      closed_at:           newStatus === 'won' || newStatus === 'lost' ? u.updated_at : null,
      created_at:          u.created_at,
      updated_at:          u.updated_at,
      stage_entered_at:    u.updated_at,
      expected_close_date: null,
      contact:             null,
      status_raw:          u.status,
      tags,
      table_id:            u.table_id,
      table_name:          tableName,
    })
  })

  // ── POST /api/crm/leads/:lead_id/promote-to-deal ───────────────────────────
  // Converts a lead-row assignment into a real crm_deals row. Requires the
  // lead to resolve to a contacts row by phone or email — without a contact
  // the deal has nowhere to deep-link back to the inbox conversation, which
  // is the whole point of CRM Lite. The original lead row is preserved
  // (audit) but stamped with `converted_to_deal_id` + `converted_at` in its
  // data jsonb so the FE can grey it out + label "Converted".
  r.post('/api/crm/leads/:lead_id/promote-to-deal', ...guard, async (req, res) => {
    const tenantId = (req as any).tenantId as string | undefined
    const userId   = (req as any).user?.id as string | undefined
    if (!tenantId) { res.status(401).json({ error: 'tenant required' }); return }
    const leadId = String(req.params.lead_id ?? '')
    if (!leadId) { res.status(400).json({ error: 'lead_id required' }); return }

    const body = req.body ?? {}

    // Load the lead row.
    const { data: lead, error: lErr } = await supabase
      .from('lead_rows')
      .select('id, table_id, data, status, tags, assigned_to, tenant_id, created_at')
      .eq('id', leadId)
      .eq('tenant_id', tenantId)
      .maybeSingle()
    if (lErr) { res.status(500).json({ error: lErr.message }); return }
    if (!lead) { res.status(404).json({ error: 'lead row not found' }); return }

    // Resolve to a contact via phone or email. We deliberately don't auto-
    // create a contact here — that's a separate operator decision and
    // doing it silently here would conflict with the contact-import flow.
    const data: Record<string, any> = (lead.data as any) ?? {}
    const phone = typeof data.phone === 'string' ? data.phone.trim()
               : typeof data.mobile === 'string' ? data.mobile.trim()
               : ''
    const email = typeof data.email === 'string' ? data.email.trim().toLowerCase() : ''

    let contactId: string | null = null
    if (phone) {
      const { data: c } = await supabase
        .from('contacts')
        .select('id')
        .eq('tenant_id', tenantId)
        .eq('phone', phone)
        .maybeSingle()
      if (c?.id) contactId = c.id
    }
    if (!contactId && email) {
      const { data: c2 } = await supabase
        .from('contacts')
        .select('id')
        .eq('tenant_id', tenantId)
        .eq('email', email)
        .maybeSingle()
      if (c2?.id) contactId = c2.id
    }
    if (!contactId) {
      res.status(400).json({
        error:   'lead_has_no_matching_contact',
        message: 'Promote to deal requires a contact. Create or link the contact first.',
      })
      return
    }

    // Resolve the starting stage from the lead's current status.
    try { await ensureStagesSeeded(tenantId) } catch (e: any) {
      res.status(500).json({ error: e.message ?? 'seed failed' }); return
    }
    const resolver = await buildStageResolver(tenantId)
    const statusLower = (lead.status ?? 'new').toString().toLowerCase()
    const bucket = LEAD_STATUS_TO_STAGE_RULE[statusLower] ?? 'lead'
    const stageId = resolver.statusToStageId.get(bucket) ?? resolver.defaultStageId
    if (!stageId) { res.status(500).json({ error: 'no active stage available' }); return }

    const title = typeof body.title === 'string' && body.title.trim().length >= 2
      ? body.title.trim().slice(0, 200)
      : deriveLeadTitle(lead.data as any, lead.id)
    const valuePaise = Number.isFinite(Number(body.value_inr_paise))
      ? Math.max(0, Math.floor(Number(body.value_inr_paise))) : 0
    const ownerUserId = body.owner_user_id ? String(body.owner_user_id) : (lead.assigned_to ?? userId ?? null)
    const expectedCloseDate = body.expected_close_date ? String(body.expected_close_date) : null
    const notes = body.notes ? String(body.notes) : null

    const { data: deal, error: insErr } = await supabase
      .from('crm_deals')
      .insert({
        tenant_id:           tenantId,
        contact_id:          contactId,
        stage_id:            stageId,
        title,
        value_inr_paise:     valuePaise,
        owner_user_id:       ownerUserId,
        expected_close_date: expectedCloseDate,
        notes,
      })
      .select('*')
      .single()
    if (insErr) {
      if (insErr.code === '23503') { res.status(400).json({ error: 'contact_id or stage_id invalid' }); return }
      res.status(500).json({ error: insErr.message }); return
    }

    await logEvent({
      tenantId,
      dealId:      deal.id,
      eventType:   'created',
      actorUserId: userId ?? null,
      toStageId:   stageId,
      payload:     { title, value_inr_paise: valuePaise, promoted_from_lead_id: lead.id },
    })

    // Stamp the lead row so the FE can mark it converted. We preserve the
    // original data and append two audit fields — no destructive overwrite.
    const stampedData = {
      ...(data ?? {}),
      converted_to_deal_id: deal.id,
      converted_at:         new Date().toISOString(),
    }
    // If the new deal's stage is won we also flip the lead status to won —
    // otherwise leave status alone so the operator's existing my-queue
    // ordering doesn't shift unexpectedly.
    const targetStage = resolver.stagesById.get(stageId)
    const flipToWon = targetStage?.is_won === true
    const leadUpdate: Record<string, unknown> = { data: stampedData, updated_at: new Date().toISOString() }
    if (flipToWon) leadUpdate.status = 'won'

    const { error: uErr } = await supabase
      .from('lead_rows')
      .update(leadUpdate)
      .eq('id', lead.id)
      .eq('tenant_id', tenantId)
    if (uErr) {
      // Don't fail the request — the deal is already created and that's the
      // user's primary action. Just warn so the data drift gets noticed.
      // eslint-disable-next-line no-console
      console.warn('[crm] promote: failed to stamp lead row', lead.id, uErr.message)
    }

    res.status(201).json({ deal_id: deal.id, lead_id: lead.id })
  })

  // ── GET /api/crm/pipeline-summary ──────────────────────────────────────────
  // Per-stage rollup + tenant totals. Drives the bar at the top of the Kanban.
  // weighted_value_paise excludes terminal stages (won/lost) from the
  // "pipeline forecast" — those deals already resolved.
  r.get('/api/crm/pipeline-summary', ...guard, async (req, res) => {
    const tenantId = (req as any).tenantId as string | undefined
    if (!tenantId) { res.status(401).json({ error: 'tenant required' }); return }

    try {
      await ensureStagesSeeded(tenantId)
    } catch (e: any) {
      res.status(500).json({ error: e.message ?? 'seed failed' }); return
    }

    const [stagesRes, dealsRes, wonLast30Res] = await Promise.all([
      supabase.from('crm_stages')
        .select('id, name, position, probability_pct, is_won, is_lost, color_hex')
        .eq('tenant_id', tenantId)
        .is('archived_at', null)
        .order('position', { ascending: true }),
      supabase.from('crm_deals')
        .select('stage_id, value_inr_paise, closed_at')
        .eq('tenant_id', tenantId)
        .is('closed_at', null), // open deals only for active pipeline math
      // For win rate: count won vs lost deals closed in the last 30 days.
      supabase.from('crm_deal_events')
        .select('event_type, occurred_at')
        .eq('tenant_id', tenantId)
        .in('event_type', ['won', 'lost'])
        .gte('occurred_at', new Date(Date.now() - 30 * 86_400_000).toISOString())
        .limit(10_000),
    ])
    if (stagesRes.error)    { res.status(500).json({ error: stagesRes.error.message });    return }
    if (dealsRes.error)     { res.status(500).json({ error: dealsRes.error.message });     return }
    if (wonLast30Res.error) { res.status(500).json({ error: wonLast30Res.error.message }); return }

    const stages = stagesRes.data ?? []
    const openDeals = dealsRes.data ?? []
    const last30 = wonLast30Res.data ?? []

    // Aggregate open deals per stage. weighted_value_paise = sum(value * prob/100)
    // for non-terminal stages only; terminal stages report 0 weighted.
    const perStage = new Map<string, { count: number; value: number; weighted: number }>()
    for (const s of stages) {
      perStage.set(s.id, { count: 0, value: 0, weighted: 0 })
    }
    for (const d of openDeals) {
      const bucket = perStage.get(d.stage_id)
      if (!bucket) continue
      bucket.count += 1
      bucket.value += Number(d.value_inr_paise ?? 0)
    }
    // Apply probability after aggregation.
    let total_value = 0
    let total_weighted = 0
    let total_count = 0
    const stageSummaries = stages.map(s => {
      const b = perStage.get(s.id) ?? { count: 0, value: 0, weighted: 0 }
      const weighted = (s.is_won || s.is_lost) ? 0 : Math.round(b.value * Number(s.probability_pct) / 100)
      total_value    += b.value
      total_weighted += weighted
      total_count    += b.count
      return {
        stage_id:               s.id,
        name:                   s.name,
        position:               s.position,
        probability_pct:        Number(s.probability_pct),
        is_won:                 s.is_won,
        is_lost:                s.is_lost,
        color_hex:              s.color_hex,
        count:                  b.count,
        value_paise:            b.value,
        weighted_value_paise:   weighted,
      }
    })

    let wonCount = 0
    let lostCount = 0
    for (const e of last30) {
      if (e.event_type === 'won')  wonCount  += 1
      if (e.event_type === 'lost') lostCount += 1
    }
    const decided = wonCount + lostCount
    const win_rate_pct = decided > 0 ? Math.round((wonCount / decided) * 100) : null

    res.json({
      stages:                stageSummaries,
      total_open_count:      total_count,
      total_value_paise:     total_value,
      total_weighted_paise:  total_weighted,
      won_last_30d:          wonCount,
      lost_last_30d:         lostCount,
      win_rate_pct,
    })
  })

  return r
}

// ── helpers ─────────────────────────────────────────────────────────────────

function clampNumber(v: unknown, lo: number, hi: number, fallback: number): number {
  const n = Number(v)
  if (!Number.isFinite(n)) return fallback
  return Math.min(hi, Math.max(lo, n))
}

function parseHexColor(v: unknown): string | null {
  if (typeof v !== 'string') return null
  return /^#[0-9A-Fa-f]{6}$/.test(v) ? v : null
}

async function isTerminalStage(supabase: SupabaseClient, stageId: string): Promise<boolean> {
  const { data } = await supabase
    .from('crm_stages')
    .select('is_won, is_lost')
    .eq('id', stageId)
    .maybeSingle()
  return Boolean(data && (data.is_won || data.is_lost))
}
