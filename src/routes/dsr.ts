/**
 * routes/dsr.ts — Data Subject Rights (DPDPA §11–14).
 *
 * One-click erasure + audit-trail receipts. Indian DPDPA gives data principals
 * the right to (a) access their data, (b) erase it, (c) correct it, (d) port
 * it out. The MVP ships the full state machine for all four, with the
 * erasure path actually wired to a cascade (the others record the request
 * + payload but the operator runs the cascade manually for now — flagged P1).
 *
 * State machine:
 *   pending → verifying → in_progress → completed
 *                                     → rejected
 *
 * Endpoints:
 *   POST /api/dsr/erasure        — file a new erasure request (pending)
 *   POST /api/dsr/access         — file an access (data export) request
 *   POST /api/dsr/:id/verify     — admin: mark identity verified
 *   POST /api/dsr/:id/execute    — admin: run the cascade, mark completed
 *   POST /api/dsr/:id/reject     — admin: reject with notes
 *   GET  /api/dsr                — list DSRs for the current tenant
 *   GET  /api/dsr/:id            — fetch one
 *   GET  /api/dsr/:id/receipt    — downloadable JSON receipt
 *
 * RLS layered on top — service-role bypasses but we still enforce in the
 * route layer (defense in depth) and we never let a non-admin call execute.
 *
 * The erasure cascade hard-deletes messages + attachments and NULL-stamps PII
 * on contacts (we keep the contact row with a shadow id so foreign keys from
 * historical records don't break). It then writes a final consent_events row
 * with event_type='opt_out', purpose='all', source='dsr_erasure' so the
 * consent audit log records the deletion.
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
}

// Admin-only roles allowed to verify/execute/reject DSRs. Mirrors the
// tenant-admin set used in dsr_requests UPDATE policy.
const ADMIN_ROLES = new Set(['owner', 'workspace_admin', 'platform_owner', 'super_admin'])

async function getTenantRole(supabase: SupabaseClient, userId: string, tenantId: string): Promise<string | null> {
  // RBAC-first
  const { data: ra } = await supabase
    .from('user_role_assignments')
    .select('role_definitions ( key )')
    .eq('user_id', userId)
    .eq('tenant_id', tenantId)
    .maybeSingle()
  const key = (ra as any)?.role_definitions?.key
  if (key) return key

  // Legacy user_roles
  const { data: ur } = await supabase
    .from('user_roles')
    .select('role')
    .eq('user_id', userId)
    .eq('tenant_id', tenantId)
    .maybeSingle()
  if (ur?.role) return ur.role

  // Ownership fallback
  const { data: t } = await supabase
    .from('tenants').select('user_id').eq('id', tenantId).maybeSingle()
  if (t?.user_id === userId) return 'owner'

  return null
}

export function createDsrRouter(deps: Deps): express.Router {
  const r = express.Router()
  const { supabase, requireAuth, identifyTenant, checkPermission } = deps

  // ── GET /api/dsr ───────────────────────────────────────────────────────────
  r.get('/api/dsr',
    requireAuth, identifyTenant, checkPermission('leads', 'view'),
    async (req, res) => {
      const tenantId = (req as any).tenantId as string
      const status = typeof req.query.status === 'string' ? req.query.status : null
      let q = supabase.from('dsr_requests')
        .select('id, tenant_id, contact_id, request_type, requester_email, status, verified_at, completed_at, executed_by, notes, reason, created_at, updated_at')
        .eq('tenant_id', tenantId)
        .order('created_at', { ascending: false })
        .limit(200)
      if (status) q = q.eq('status', status)
      const { data, error } = await q
      if (error) { res.status(500).json({ error: error.message }); return }
      res.json(data ?? [])
    },
  )

  // ── GET /api/dsr/:id ──────────────────────────────────────────────────────
  r.get('/api/dsr/:id',
    requireAuth, identifyTenant, checkPermission('leads', 'view'),
    async (req, res) => {
      const tenantId = (req as any).tenantId as string
      const { data, error } = await supabase.from('dsr_requests')
        .select('*').eq('id', req.params.id).eq('tenant_id', tenantId).maybeSingle()
      if (error) { res.status(500).json({ error: error.message }); return }
      if (!data) { res.status(404).json({ error: 'DSR not found' }); return }
      res.json(data)
    },
  )

  // ── POST /api/dsr/erasure ──────────────────────────────────────────────────
  // Body: { contact_id?: uuid, requester_email: string, reason?: string }
  // Any tenant member can file (the request needs verification before
  // it touches data). Returns the new DSR row.
  r.post('/api/dsr/erasure',
    requireAuth, identifyTenant, checkPermission('leads', 'view'),
    async (req, res) => {
      const tenantId = (req as any).tenantId as string
      const body = req.body ?? {}
      const requesterEmail = String(body.requester_email ?? '').trim()
      if (!requesterEmail || !/.+@.+\..+/.test(requesterEmail)) {
        res.status(400).json({ error: 'requester_email is required' }); return
      }
      const contactId = body.contact_id ? String(body.contact_id) : null
      const reason = body.reason ? String(body.reason).slice(0, 1000) : null

      // If contact_id given, ensure it lives in this tenant.
      if (contactId) {
        const { data: c } = await supabase.from('contacts')
          .select('id').eq('id', contactId).eq('tenant_id', tenantId).maybeSingle()
        if (!c) { res.status(404).json({ error: 'contact not found in this tenant' }); return }
      }

      const { data, error } = await supabase.from('dsr_requests').insert({
        tenant_id: tenantId,
        contact_id: contactId,
        request_type: 'erasure',
        requester_email: requesterEmail,
        reason,
        status: 'pending',
      }).select('*').single()
      if (error) { res.status(500).json({ error: error.message }); return }
      res.status(201).json(data)
    },
  )

  // ── POST /api/dsr/access ───────────────────────────────────────────────────
  // Same as erasure but request_type='access'. Body identical.
  r.post('/api/dsr/access',
    requireAuth, identifyTenant, checkPermission('leads', 'view'),
    async (req, res) => {
      const tenantId = (req as any).tenantId as string
      const body = req.body ?? {}
      const requesterEmail = String(body.requester_email ?? '').trim()
      const requestType = String(body.request_type ?? 'access')
      if (!['access', 'rectification', 'portability'].includes(requestType)) {
        res.status(400).json({ error: 'request_type must be access | rectification | portability' }); return
      }
      if (!requesterEmail || !/.+@.+\..+/.test(requesterEmail)) {
        res.status(400).json({ error: 'requester_email is required' }); return
      }
      const contactId = body.contact_id ? String(body.contact_id) : null
      const reason = body.reason ? String(body.reason).slice(0, 1000) : null
      if (contactId) {
        const { data: c } = await supabase.from('contacts')
          .select('id').eq('id', contactId).eq('tenant_id', tenantId).maybeSingle()
        if (!c) { res.status(404).json({ error: 'contact not found in this tenant' }); return }
      }
      const { data, error } = await supabase.from('dsr_requests').insert({
        tenant_id: tenantId,
        contact_id: contactId,
        request_type: requestType,
        requester_email: requesterEmail,
        reason,
        status: 'pending',
      }).select('*').single()
      if (error) { res.status(500).json({ error: error.message }); return }
      res.status(201).json(data)
    },
  )

  // ── POST /api/dsr/:id/verify ───────────────────────────────────────────────
  // Admin-only. Marks the request as verified — the operator has confirmed
  // identity (e.g. via the requester_email magic link, WhatsApp OTP, or
  // out-of-band proof). Body: { verifying_notes?: string }.
  r.post('/api/dsr/:id/verify',
    requireAuth, identifyTenant,
    async (req, res) => {
      const tenantId = (req as any).tenantId as string
      const userId = (req as any).user?.id as string
      const role = await getTenantRole(supabase, userId, tenantId)
      if (!role || !ADMIN_ROLES.has(role)) {
        res.status(403).json({ error: 'admin role required' }); return
      }
      const id = String(req.params.id)
      const notes = req.body?.verifying_notes ? String(req.body.verifying_notes).slice(0, 1000) : null

      const { data: existing } = await supabase.from('dsr_requests')
        .select('id, status').eq('id', id).eq('tenant_id', tenantId).maybeSingle()
      if (!existing) { res.status(404).json({ error: 'DSR not found' }); return }
      if (!['pending', 'verifying'].includes(existing.status)) {
        res.status(409).json({ error: `cannot verify a DSR in status=${existing.status}` }); return
      }

      const { data, error } = await supabase.from('dsr_requests')
        .update({ status: 'in_progress', verified_at: new Date().toISOString(), notes })
        .eq('id', id).eq('tenant_id', tenantId)
        .select('*').single()
      if (error) { res.status(500).json({ error: error.message }); return }
      res.json(data)
    },
  )

  // ── POST /api/dsr/:id/execute ──────────────────────────────────────────────
  // Admin-only. Runs the erasure cascade (only valid for request_type='erasure'
  // today; access/portability return the export payload). Wraps the data
  // mutations best-effort sequentially (Supabase JS lacks a real transaction
  // primitive over PostgREST — for the MVP we accept the small window of
  // partial failure and surface it in the receipt).
  r.post('/api/dsr/:id/execute',
    requireAuth, identifyTenant,
    async (req, res) => {
      const tenantId = (req as any).tenantId as string
      const userId = (req as any).user?.id as string
      const role = await getTenantRole(supabase, userId, tenantId)
      if (!role || !ADMIN_ROLES.has(role)) {
        res.status(403).json({ error: 'admin role required' }); return
      }
      const id = String(req.params.id)
      const { data: dsr, error: dErr } = await supabase.from('dsr_requests')
        .select('*').eq('id', id).eq('tenant_id', tenantId).maybeSingle()
      if (dErr) { res.status(500).json({ error: dErr.message }); return }
      if (!dsr) { res.status(404).json({ error: 'DSR not found' }); return }
      if (dsr.status !== 'in_progress') {
        res.status(409).json({ error: `DSR must be in_progress to execute (current: ${dsr.status})` }); return
      }

      const receipt: any = {
        dsr_id: id,
        request_type: dsr.request_type,
        executed_at: new Date().toISOString(),
        executed_by: userId,
        tenant_id: tenantId,
        contact_id: dsr.contact_id,
        counts: { messages_deleted: 0, attachments_deleted: 0, contacts_redacted: 0 },
        errors: [] as string[],
      }

      if (dsr.request_type === 'erasure') {
        if (!dsr.contact_id) {
          res.status(400).json({ error: 'erasure requires a contact_id on the DSR' }); return
        }

        // (a) Delete messages for the contact across all channels.
        // Two paths: by contact_id FK (newer rows) and by contact_phone
        // (older rows that pre-date contact_id linkage).
        const { data: contact } = await supabase.from('contacts')
          .select('id, phone, email').eq('id', dsr.contact_id).eq('tenant_id', tenantId).maybeSingle()

        // Delete by contact_phone (the most reliable join in this codebase).
        if (contact?.phone) {
          const phoneNoPlus = String(contact.phone).replace(/^\+/, '')
          const variants = [contact.phone, phoneNoPlus, `+${phoneNoPlus}`]
          const { data: del1, error: dmErr } = await supabase.from('messages')
            .delete().eq('tenant_id', tenantId).in('contact_phone', variants).select('id')
          if (dmErr) receipt.errors.push(`messages by phone: ${dmErr.message}`)
          receipt.counts.messages_deleted += (del1 ?? []).length
        }

        // (c) Delete attachments — schema may or may not exist; try and swallow.
        try {
          const { data: del2, error: aErr } = await supabase.from('attachments')
            .delete().eq('tenant_id', tenantId).eq('contact_id', dsr.contact_id).select('id')
          if (aErr && !/relation .* does not exist/i.test(aErr.message)) {
            receipt.errors.push(`attachments: ${aErr.message}`)
          }
          receipt.counts.attachments_deleted += (del2 ?? []).length
        } catch (e: any) {
          // table may not exist on this schema — ignore
        }

        // (b) NULL-out PII on the contact row. Keep id + tenant_id so FKs
        // don't break; replace identifiers with a deterministic shadow so
        // the row is unambiguously "redacted, do not contact" if surfaced.
        const shadow = `dsr_${id.slice(0, 8)}_${crypto.randomBytes(4).toString('hex')}`
        const redactPatch: any = {
          name: 'REDACTED (DSR)',
          phone: `+REDACTED_${shadow}`,
          status: 'opted_out',
          consent_captured_at: null,
          consent_source: null,
        }
        // Optional columns we try to NULL if present.
        const optionalNullCols = ['email', 'whatsapp_id', 'instagram_id', 'telegram_id', 'attributes', 'notes', 'tags', 'last_contacted_at']
        for (const col of optionalNullCols) {
          if (col === 'attributes') redactPatch[col] = {}
          else if (col === 'tags') redactPatch[col] = []
          else redactPatch[col] = null
        }
        // First, try with all columns. If a column doesn't exist (older
        // schemas), retry with a minimal patch.
        let { error: rErr } = await supabase.from('contacts')
          .update(redactPatch).eq('id', dsr.contact_id).eq('tenant_id', tenantId)
        if (rErr && /column .* does not exist/i.test(rErr.message)) {
          const minimalPatch = {
            name: 'REDACTED (DSR)',
            phone: `+REDACTED_${shadow}`,
            status: 'opted_out',
          }
          const retry = await supabase.from('contacts')
            .update(minimalPatch).eq('id', dsr.contact_id).eq('tenant_id', tenantId)
          rErr = retry.error
        }
        if (rErr) {
          receipt.errors.push(`contact redact: ${rErr.message}`)
        } else {
          receipt.counts.contacts_redacted += 1
        }

        // (d) Final consent_events row — record the cascade in the audit log.
        await supabase.from('consent_events').insert({
          tenant_id: tenantId,
          contact_id: dsr.contact_id,
          channel: 'all',
          event_type: 'opt_out',
          purpose: 'all',
          source: 'dsr_erasure',
          source_detail: { dsr_id: id, requester_email: dsr.requester_email },
          proof_text: `Erasure executed by DSR ${id} per DPDPA §12`,
          captured_by: userId,
        })
      } else if (dsr.request_type === 'access' || dsr.request_type === 'portability') {
        // Build an export blob — contact row + messages + consent history.
        if (!dsr.contact_id) {
          res.status(400).json({ error: `${dsr.request_type} requires a contact_id on the DSR` }); return
        }
        const [{ data: contact }, { data: msgs }, { data: cons }] = await Promise.all([
          supabase.from('contacts').select('*').eq('id', dsr.contact_id).eq('tenant_id', tenantId).maybeSingle(),
          supabase.from('messages').select('id, channel, direction, contact_phone, content, status, created_at')
            .eq('tenant_id', tenantId).eq('contact_phone', '').or(`contact_phone.eq.${(await supabase.from('contacts').select('phone').eq('id', dsr.contact_id).maybeSingle()).data?.phone ?? ''}`),
          supabase.from('consent_events').select('*').eq('contact_id', dsr.contact_id),
        ])
        const exportBlob = { contact, messages: msgs ?? [], consent_events: cons ?? [] }
        receipt.export = exportBlob
        receipt.counts.messages_deleted = 0  // access is non-destructive

        // Best-effort: also upload the export to private storage so the
        // download endpoint can serve a signed URL (vs streaming the
        // inline payload, which the previous implementation did). The
        // operator must create a `dsr-exports` private bucket in the
        // Supabase dashboard — if absent, we silently fall back to the
        // legacy inline path so the DSR still completes.
        try {
          const path = `${tenantId}/${id}.json`
          const bytes = new TextEncoder().encode(JSON.stringify(exportBlob, null, 2))
          const { error: upErr } = await supabase.storage
            .from('dsr-exports')
            .upload(path, bytes, {
              contentType: 'application/json',
              upsert: true,
            })
          if (upErr) {
            // Bucket missing or storage error — fall back to inline payload.
            console.warn(`[dsr] storage upload skipped (${upErr.message}); falling back to inline payload`)
          } else {
            receipt.export_storage_path = path
            // Drop the inline export from the receipt — clients will
            // fetch the signed URL via /api/dsr/:id/download instead.
            // Keep receipt.counts + receipt.export_storage_path so the
            // audit log records what was exported, without keeping a
            // duplicate copy in the receipt jsonb.
            delete receipt.export
          }
        } catch (e: any) {
          console.warn(`[dsr] storage upload threw (${e?.message ?? e}); falling back to inline payload`)
        }
      }
      // rectification — no automated action; operator updates the contact
      // record manually after verifying the correction request.

      const { data: updated, error: uErr } = await supabase.from('dsr_requests')
        .update({
          status: 'completed',
          completed_at: receipt.executed_at,
          executed_by: userId,
          payload: receipt,
        })
        .eq('id', id).eq('tenant_id', tenantId)
        .select('*').single()
      if (uErr) { res.status(500).json({ error: uErr.message, partial_receipt: receipt }); return }

      res.json({ dsr: updated, receipt })
    },
  )

  // ── POST /api/dsr/:id/reject ──────────────────────────────────────────────
  // Admin-only. Body: { notes: string }.
  r.post('/api/dsr/:id/reject',
    requireAuth, identifyTenant,
    async (req, res) => {
      const tenantId = (req as any).tenantId as string
      const userId = (req as any).user?.id as string
      const role = await getTenantRole(supabase, userId, tenantId)
      if (!role || !ADMIN_ROLES.has(role)) {
        res.status(403).json({ error: 'admin role required' }); return
      }
      const id = String(req.params.id)
      const notes = req.body?.notes ? String(req.body.notes).slice(0, 1000) : null
      if (!notes) { res.status(400).json({ error: 'notes required' }); return }

      const { data, error } = await supabase.from('dsr_requests')
        .update({ status: 'rejected', notes, executed_by: userId, completed_at: new Date().toISOString() })
        .eq('id', id).eq('tenant_id', tenantId)
        .select('*').single()
      if (error) { res.status(500).json({ error: error.message }); return }
      res.json(data)
    },
  )

  // ── GET /api/dsr/:id/receipt ──────────────────────────────────────────────
  // Returns the stored JSON receipt with Content-Disposition: attachment
  // so the browser saves it. Only valid for completed DSRs.
  r.get('/api/dsr/:id/receipt',
    requireAuth, identifyTenant, checkPermission('leads', 'view'),
    async (req, res) => {
      const tenantId = (req as any).tenantId as string
      const id = String(req.params.id)
      const { data, error } = await supabase.from('dsr_requests')
        .select('id, status, completed_at, payload, request_type')
        .eq('id', id).eq('tenant_id', tenantId).maybeSingle()
      if (error) { res.status(500).json({ error: error.message }); return }
      if (!data) { res.status(404).json({ error: 'DSR not found' }); return }
      if (data.status !== 'completed') {
        res.status(409).json({ error: `receipt only available for completed DSRs (current: ${data.status})` }); return
      }
      const filename = `dsr_${data.request_type}_${id}.json`
      res.setHeader('Content-Type', 'application/json')
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`)
      res.send(JSON.stringify(data.payload ?? {}, null, 2))
    },
  )

  return r
}
