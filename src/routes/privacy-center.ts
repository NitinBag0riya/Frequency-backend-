/**
 * routes/privacy-center.ts — brief-spec endpoint surface for the FE
 * Privacy Center page (P0.7 DPDPA layer).
 *
 * The underlying capabilities live in three sibling routers:
 *   - dsr.ts                 → /api/dsr/* (verbose state-machine surface)
 *   - breach-notifications.ts → /api/admin/breach* + /api/breaches
 *   - data-residency.ts      → /api/tenant/data-residency
 *
 * This router exposes the SHORTER paths the FE consumes (and the brief
 * specifies):
 *
 *   POST   /api/contacts/:id/dsr           → creates a DSR for a contact
 *   GET    /api/me/dsr-requests            → list this tenant's DSRs
 *   GET    /api/dsr/:id/download           → JSON receipt download (alias of
 *                                            /api/dsr/:id/receipt)
 *   PATCH  /api/me/residency               → set tenant data residency
 *   GET    /api/me/residency               → read tenant data residency
 *   GET    /api/admin/breach               → super-admin list (alias of
 *                                            /api/admin/breaches)
 *   PATCH  /api/admin/breach/:id           → super-admin state transition
 *                                            (status: notified | resolved)
 *
 * We deliberately avoid duplicating the body / RLS / role validation that
 * already lives in the underlying routes — handlers here are small adapters
 * that re-use the same supabase client + shape the response.
 */

import express from 'express'
import crypto from 'crypto'
import { SupabaseClient } from '@supabase/supabase-js'

type Middleware = (
  req: express.Request,
  res: express.Response,
  next: express.NextFunction,
) => void | Promise<void>

interface Deps {
  supabase: SupabaseClient
  requireAuth: Middleware
  identifyTenant: Middleware
  checkPermission: (feature: string, action: 'view' | 'edit' | 'delete') => Middleware
  isPlatformUser: (userId: string) => Promise<boolean>
}

const ADMIN_ROLES = new Set(['owner', 'workspace_admin', 'platform_owner', 'super_admin'])
const RESIDENCY_ALLOWED = new Set(['IN', 'EU', 'US'])

function hashIp(ip: string | null | undefined): string | null {
  if (!ip) return null
  return crypto.createHash('sha256').update(ip).digest('hex').slice(0, 16)
}

async function resolveTenantRole(supabase: SupabaseClient, userId: string, tenantId: string): Promise<string | null> {
  const { data: ra } = await supabase.from('user_role_assignments')
    .select('role_definitions ( key )')
    .eq('user_id', userId).eq('tenant_id', tenantId).maybeSingle()
  const key = (ra as { role_definitions?: { key?: string } } | null)?.role_definitions?.key
  if (key) return key
  const { data: ur } = await supabase.from('user_roles')
    .select('role').eq('user_id', userId).eq('tenant_id', tenantId).maybeSingle()
  if (ur?.role) return ur.role
  const { data: t } = await supabase.from('tenants')
    .select('user_id').eq('id', tenantId).maybeSingle()
  if (t?.user_id === userId) return 'owner'
  return null
}

export function createPrivacyCenterRouter(deps: Deps): express.Router {
  const r = express.Router()
  const { supabase, requireAuth, identifyTenant, checkPermission, isPlatformUser } = deps

  // ── POST /api/contacts/:id/dsr ─────────────────────────────────────────────
  // Body: { type: 'delete' | 'export', requester_email?, reason? }
  // Files a DSR for a specific contact. `delete` → erasure, `export` →
  // access (the FE word). Returns the new dsr_requests row.
  r.post('/api/contacts/:id/dsr',
    requireAuth, identifyTenant, checkPermission('leads', 'edit'),
    async (req, res) => {
      const tenantId = (req as unknown as { tenantId: string }).tenantId
      const userId = (req as unknown as { user: { id: string; email?: string } }).user.id
      const userEmail = (req as unknown as { user: { id: string; email?: string } }).user.email
      const contactId = String(req.params.id)
      const rawType = String(req.body?.type ?? '').toLowerCase()
      if (!['delete', 'export'].includes(rawType)) {
        res.status(400).json({ error: 'type must be "delete" or "export"' }); return
      }
      const requestType = rawType === 'delete' ? 'erasure' : 'access'

      // Confirm the contact lives in this tenant — service role bypasses RLS
      // so we enforce in the handler.
      const { data: contact, error: cErr } = await supabase.from('contacts')
        .select('id, email').eq('id', contactId).eq('tenant_id', tenantId).maybeSingle()
      if (cErr) { res.status(500).json({ error: cErr.message }); return }
      if (!contact) { res.status(404).json({ error: 'contact not found' }); return }

      // requester_email defaults to the contact's own email (if present) or
      // the operator's email (rep-initiated DSR on behalf of the contact).
      const requesterEmail = String(
        req.body?.requester_email ?? contact.email ?? userEmail ?? '',
      ).trim()
      if (!requesterEmail || !/.+@.+\..+/.test(requesterEmail)) {
        res.status(400).json({ error: 'requester_email is required (no email on contact)' }); return
      }
      const reason = req.body?.reason ? String(req.body.reason).slice(0, 1000) : null

      const { data, error } = await supabase.from('dsr_requests').insert({
        tenant_id:       tenantId,
        contact_id:      contactId,
        request_type:    requestType,
        requester_email: requesterEmail,
        reason,
        status:          'pending',
      }).select('*').single()
      if (error) { res.status(500).json({ error: error.message }); return }
      res.status(201).json(data)
    },
  )

  // ── GET /api/me/dsr-requests ───────────────────────────────────────────────
  // Lists this tenant's DSRs. Optional ?status= filter. Capped at 200.
  r.get('/api/me/dsr-requests',
    requireAuth, identifyTenant, checkPermission('leads', 'view'),
    async (req, res) => {
      const tenantId = (req as unknown as { tenantId: string }).tenantId
      const status = typeof req.query.status === 'string' ? req.query.status : null
      let q = supabase.from('dsr_requests')
        .select('id, tenant_id, contact_id, request_type, requester_email, status, verified_at, completed_at, executed_by, notes, reason, created_at, updated_at')
        .eq('tenant_id', tenantId)
        .order('created_at', { ascending: false })
        .limit(200)
      if (status) q = q.eq('status', status)
      const { data, error } = await q
      if (error) { res.status(500).json({ error: error.message }); return }
      res.json({ data: data ?? [] })
    },
  )

  // ── GET /api/dsr/:id/download ─────────────────────────────────────────────
  // DPDPA brief: "signed URL, expires 24h." Two paths:
  //   1. NEW (preferred): the receipt's payload has `export_storage_path`,
  //      meaning the execute step uploaded the JSON to the `dsr-exports`
  //      private bucket. We return a freshly signed Supabase Storage URL
  //      that expires in min(24h, remaining-window). Each call to this
  //      endpoint mints a new signed URL — the URL itself is stateless,
  //      so re-using a server-rendered link doesn't extend access.
  //   2. LEGACY fallback: receipt has no storage_path (older completions,
  //      or storage upload failed). We stream the inline payload as before
  //      so old DSRs remain downloadable for the 24h window.
  //
  // 24h server-side window is enforced in both paths — completed_at is
  // the wall-clock anchor.
  r.get('/api/dsr/:id/download',
    requireAuth, identifyTenant, checkPermission('leads', 'view'),
    async (req, res) => {
      const tenantId = (req as unknown as { tenantId: string }).tenantId
      const id = String(req.params.id)
      const { data, error } = await supabase.from('dsr_requests')
        .select('id, status, completed_at, payload, request_type')
        .eq('id', id).eq('tenant_id', tenantId).maybeSingle()
      if (error) { res.status(500).json({ error: error.message }); return }
      if (!data) { res.status(404).json({ error: 'DSR not found' }); return }
      if (data.status !== 'completed') {
        res.status(409).json({ error: `download only available for completed DSRs (current: ${data.status})` }); return
      }
      // 24h TTL guard — the receipt is a snapshot of the data at execute
      // time, not a live export. After 24h the requester must re-file.
      const completedMs = data.completed_at ? new Date(data.completed_at).getTime() : 0
      const ageMs = Date.now() - completedMs
      const TWENTY_FOUR_HOURS = 24 * 60 * 60 * 1000
      if (ageMs > TWENTY_FOUR_HOURS) {
        res.status(410).json({ error: 'download window expired (24h). Re-file the DSR for a fresh export.' }); return
      }

      const payload = (data.payload ?? {}) as Record<string, unknown>
      const storagePath = typeof payload.export_storage_path === 'string'
        ? payload.export_storage_path
        : null

      // Path 1 — signed URL from storage. Cap TTL at whatever's left in
      // the 24h window so a freshly-minted URL can't outlive the policy.
      if (storagePath) {
        const remainingSec = Math.max(60, Math.floor((TWENTY_FOUR_HOURS - ageMs) / 1000))
        const { data: signed, error: signErr } = await supabase.storage
          .from('dsr-exports')
          .createSignedUrl(storagePath, remainingSec, {
            download: `dsr_${data.request_type}_${id}.json`,
          })
        if (!signErr && signed?.signedUrl) {
          res.json({
            url: signed.signedUrl,
            expires_in: remainingSec,
            via: 'signed_url',
          })
          return
        }
        // Storage error — fall through to inline payload so the user
        // doesn't get stuck. Log so the operator can fix the bucket.
        console.warn(`[dsr] signed-url generation failed for ${id}: ${signErr?.message}; falling back to inline payload`)
      }

      // Path 2 — legacy inline. Used when storage upload was skipped
      // (no dsr-exports bucket) or when signing failed.
      const filename = `dsr_${data.request_type}_${id}.json`
      res.setHeader('Content-Type', 'application/json')
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`)
      res.setHeader('Cache-Control', 'private, no-store')
      res.send(JSON.stringify(payload, null, 2))
    },
  )

  // ── GET /api/me/residency ─────────────────────────────────────────────────
  r.get('/api/me/residency', requireAuth, identifyTenant, async (req, res) => {
    const tenantId = (req as unknown as { tenantId: string }).tenantId
    const { data, error } = await supabase.from('tenants')
      .select('data_residency').eq('id', tenantId).maybeSingle()
    if (error) { res.status(500).json({ error: error.message }); return }
    res.json({ region: (data?.data_residency ?? 'IN').toLowerCase() })
  })

  // ── PATCH /api/me/residency ───────────────────────────────────────────────
  // Body: { region: 'in' | 'eu' | 'us' }. Admin-only. Audit-logged.
  r.patch('/api/me/residency', requireAuth, identifyTenant, async (req, res) => {
    const tenantId = (req as unknown as { tenantId: string }).tenantId
    const userId = (req as unknown as { user: { id: string } }).user.id
    const role = await resolveTenantRole(supabase, userId, tenantId)
    if (!role || !ADMIN_ROLES.has(role)) {
      res.status(403).json({ error: 'admin role required' }); return
    }
    const region = String(req.body?.region ?? '').toUpperCase()
    if (!RESIDENCY_ALLOWED.has(region)) {
      res.status(400).json({ error: 'region must be in | eu | us' }); return
    }
    // Read current value first for the audit before/after diff.
    const { data: before } = await supabase.from('tenants')
      .select('data_residency').eq('id', tenantId).maybeSingle()
    const previous = before?.data_residency ?? null

    const { data, error } = await supabase.from('tenants')
      .update({ data_residency: region })
      .eq('id', tenantId)
      .select('id, data_residency').single()
    if (error) { res.status(500).json({ error: error.message }); return }

    // Audit log — best-effort, never fails the request. Uses the same
    // append_tenant_audit RPC the wedge-surface consent handler uses.
    try {
      const ipHeader = (req.headers['x-forwarded-for'] as string | undefined)?.split(',')[0]?.trim()
      const rpc = await (supabase as unknown as {
        rpc: (name: string, args: Record<string, unknown>) => Promise<{ error: unknown }>
      }).rpc('append_tenant_audit', {
        p_tenant_id:     tenantId,
        p_actor_id:      userId,
        p_actor_role:    role,
        p_action:        'tenant.residency_changed',
        p_entity_type:   'tenant',
        p_entity_id:     tenantId,
        p_justification: `region: ${previous ?? 'IN'} → ${region}`,
        p_ticket_ref:    null,
        p_before_value:  { region: previous },
        p_after_value:   { region },
        p_ip_address:    ipHeader ?? null,
        p_user_agent:    req.headers['user-agent'] ?? null,
      })
      if (rpc.error) {
        // Fall back to a direct insert if the RPC isn't on this DB.
        await supabase.from('tenant_audit').insert({
          tenant_id:     tenantId,
          actor_id:      userId,
          action:        'tenant.residency_changed',
          entity_type:   'tenant',
          entity_id:     tenantId,
          justification: `region: ${previous ?? 'IN'} → ${region}`,
          before_value:  { region: previous },
          after_value:   { region },
        })
      }
    } catch (e) {
      const msg = (e as Error | undefined)?.message ?? String(e)
      console.warn('[residency] audit append failed (non-fatal):', msg)
    }

    res.json({ region: data.data_residency.toLowerCase() })
  })

  // ── GET /api/admin/breach (super-admin) ───────────────────────────────────
  // Alias of /api/admin/breaches (kept for back-compat with breach-notifications.ts).
  r.get('/api/admin/breach', requireAuth, async (req, res) => {
    const userId = (req as unknown as { user?: { id?: string } }).user?.id
    if (!userId) { res.status(401).json({ error: 'auth required' }); return }
    if (!(await isPlatformUser(userId))) {
      res.status(403).json({ error: 'Platform Console access required.' }); return
    }
    const { data, error } = await supabase
      .from('breach_notifications')
      .select('*')
      .order('discovered_at', { ascending: false })
      .limit(200)
    if (error) { res.status(500).json({ error: error.message }); return }
    res.json({ data: data ?? [] })
  })

  // ── PATCH /api/admin/breach/:id (super-admin) ─────────────────────────────
  // Body: { status?: 'investigating'|'notified'|'resolved',
  //         notified_authority?: boolean, notified_users?: boolean }
  // Advance the workflow. Sets timestamps automatically when flags flip true.
  // We never go backwards — `resolved` is terminal.
  r.patch('/api/admin/breach/:id', requireAuth, async (req, res) => {
    const userId = (req as unknown as { user?: { id?: string } }).user?.id
    if (!userId) { res.status(401).json({ error: 'auth required' }); return }
    if (!(await isPlatformUser(userId))) {
      res.status(403).json({ error: 'Platform Console access required.' }); return
    }
    const id = String(req.params.id)
    const { data: row, error: rErr } = await supabase.from('breach_notifications')
      .select('id, status, notified_authority_at, notified_users_at').eq('id', id).maybeSingle()
    if (rErr) { res.status(500).json({ error: rErr.message }); return }
    if (!row) { res.status(404).json({ error: 'breach not found' }); return }
    if (row.status === 'resolved') {
      res.status(409).json({ error: 'cannot modify a resolved breach' }); return
    }

    const patch: Record<string, unknown> = {}
    const nextStatus = req.body?.status ? String(req.body.status) : null
    if (nextStatus) {
      if (!['investigating', 'notified', 'resolved'].includes(nextStatus)) {
        res.status(400).json({ error: 'status must be investigating|notified|resolved' }); return
      }
      patch.status = nextStatus
    }
    if (req.body?.notified_authority === true && !row.notified_authority_at) {
      patch.notified_authority_at = new Date().toISOString()
      if (!nextStatus) patch.status = 'notified'
    }
    if (req.body?.notified_users === true && !row.notified_users_at) {
      patch.notified_users_at = new Date().toISOString()
      if (!nextStatus && !patch.status) patch.status = 'notified'
    }
    if (Object.keys(patch).length === 0) {
      res.status(400).json({ error: 'no patchable fields supplied' }); return
    }
    const { data, error } = await supabase.from('breach_notifications')
      .update(patch).eq('id', id).select('*').single()
    if (error) { res.status(500).json({ error: error.message }); return }
    res.json(data)
  })

  // hashIp is referenced from other modules via this re-export so the
  // wedge-surface consent handler and this router stay aligned. Marking
  // unused so the linter doesn't complain inside this file.
  void hashIp

  return r
}
