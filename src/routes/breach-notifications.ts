/**
 * routes/breach-notifications.ts — DPDPA §8(6) breach workflow.
 *
 * Super-admin authored. Tenants see "any breach affecting my tenant" via
 * the RLS read policy on breach_notifications (tenant_id matching THEIR
 * tenant OR tenant_id NULL = platform-wide).
 *
 * Endpoints (all super-admin):
 *   POST /api/admin/breach                       — record a new breach
 *   POST /api/admin/breach/:id/notify-authority  — mark authority notified (stub)
 *   POST /api/admin/breach/:id/notify-users      — mark users notified (stub)
 *   POST /api/admin/breach/:id/resolve           — mark resolved
 *   GET  /api/admin/breaches                     — list (paginated, super-admin)
 *   GET  /api/breaches                           — tenant-scoped list (their own + platform-wide)
 *
 * State machine: investigating → notified → resolved.
 *
 * Notification fan-out is stubbed (no Resend mass-send wired). P1 follow-up
 * to queue a BullMQ job that emails every affected_contact in batches.
 */

import express from 'express'
import { SupabaseClient } from '@supabase/supabase-js'
import { enqueueBreachNotification } from '../queue'

type Middleware = (
  req: express.Request,
  res: express.Response,
  next: express.NextFunction,
) => void | Promise<void>

interface Deps {
  supabase: SupabaseClient
  requireAuth: Middleware
  identifyTenant: Middleware
  isPlatformUser: (userId: string) => Promise<boolean>
}

export function createBreachNotificationsRouter(deps: Deps): express.Router {
  const r = express.Router()
  const { supabase, requireAuth, identifyTenant, isPlatformUser } = deps

  // Super-admin guard. Identical shape to the inline check used at the
  // top of the existing /api/admin/* handlers in index.ts.
  const requireSuperAdmin: Middleware = async (req, res, next) => {
    const user = (req as any).user
    if (!user?.id) { res.status(401).json({ error: 'auth required' }); return }
    if (!(await isPlatformUser(user.id))) {
      res.status(403).json({ error: 'Platform Console access required.' }); return
    }
    next()
  }

  // ── GET /api/admin/breaches ───────────────────────────────────────────────
  r.get('/api/admin/breaches', requireAuth, requireSuperAdmin, async (_req, res) => {
    const { data, error } = await supabase
      .from('breach_notifications')
      .select('*')
      .order('discovered_at', { ascending: false })
      .limit(200)
    if (error) { res.status(500).json({ error: error.message }); return }
    res.json(data ?? [])
  })

  // ── POST /api/admin/breach ────────────────────────────────────────────────
  // Body: { tenant_id?, severity, description, affected_contact_count,
  //          affected_data_classes }
  r.post('/api/admin/breach', requireAuth, requireSuperAdmin, async (req, res) => {
    const user = (req as any).user
    const body = req.body ?? {}
    const severity = String(body.severity ?? '')
    if (!['low', 'medium', 'high', 'critical'].includes(severity)) {
      res.status(400).json({ error: 'severity must be low|medium|high|critical' }); return
    }
    const description = String(body.description ?? '').trim()
    if (description.length < 8) {
      res.status(400).json({ error: 'description too short' }); return
    }
    const affectedDataClasses = Array.isArray(body.affected_data_classes)
      ? body.affected_data_classes.map((c: any) => String(c)).slice(0, 50)
      : []
    const affectedContactCount = Number(body.affected_contact_count ?? 0)
    if (!Number.isFinite(affectedContactCount) || affectedContactCount < 0) {
      res.status(400).json({ error: 'affected_contact_count must be a non-negative integer' }); return
    }
    const tenantId = body.tenant_id ? String(body.tenant_id) : null

    const { data, error } = await supabase.from('breach_notifications').insert({
      tenant_id: tenantId,
      severity,
      description,
      affected_contact_count: Math.floor(affectedContactCount),
      affected_data_classes: affectedDataClasses,
      created_by: user.id,
      status: 'investigating',
    }).select('*').single()
    if (error) { res.status((error as any).code === 'PGRST116' ? 404 : 500).json({ error: (error as any).code === 'PGRST116' ? 'not found' : error.message }); return }
    res.status(201).json(data)
  })

  // ── POST /api/admin/breach/:id/notify-authority ───────────────────────────
  // Stubbed — records the timestamp + flips status. The real DPDPA Board
  // filing is an out-of-band process today (PDF + ticket). P1 follow-up to
  // wire the e-form submission once the Board publishes a stable API.
  r.post('/api/admin/breach/:id/notify-authority', requireAuth, requireSuperAdmin, async (req, res) => {
    const id = String(req.params.id)
    const { data: row, error: rErr } = await supabase.from('breach_notifications')
      .select('id, status').eq('id', id).maybeSingle()
    if (rErr) { res.status(500).json({ error: rErr.message }); return }
    if (!row) { res.status(404).json({ error: 'breach not found' }); return }
    if (row.status === 'resolved') {
      res.status(409).json({ error: 'cannot notify on a resolved breach' }); return
    }
    const { data, error } = await supabase.from('breach_notifications')
      .update({ notified_authority_at: new Date().toISOString(), status: 'notified' })
      .eq('id', id).select('*').single()
    if (error) { res.status((error as any).code === 'PGRST116' ? 404 : 500).json({ error: (error as any).code === 'PGRST116' ? 'not found' : error.message }); return }
    res.json(data)
  })

  // ── POST /api/admin/breach/:id/notify-users ───────────────────────────────
  // Stamps notified_users_at + enqueues the BullMQ fan-out job. Idempotent:
  // re-POSTs do NOT re-enqueue because fanout_queued_at is checked first
  // (jobId on the BullMQ side is a second guard — same breachId can't add
  // twice). The worker (workers/breach-notification-sender.ts) expands to
  // recipients, upserts breach_notification_recipients, sends via Resend.
  r.post('/api/admin/breach/:id/notify-users', requireAuth, requireSuperAdmin, async (req, res) => {
    const id = String(req.params.id)
    const { data: row, error: rErr } = await supabase.from('breach_notifications')
      .select('id, status, fanout_queued_at').eq('id', id).maybeSingle()
    if (rErr) { res.status(500).json({ error: rErr.message }); return }
    if (!row) { res.status(404).json({ error: 'breach not found' }); return }
    if (row.status === 'resolved') {
      res.status(409).json({ error: 'cannot notify users on a resolved breach' }); return
    }

    const nowIso = new Date().toISOString()
    const patch: Record<string, unknown> = { notified_users_at: nowIso }
    let enqueued = false
    if (!row.fanout_queued_at) {
      patch.fanout_queued_at = nowIso
      try {
        await enqueueBreachNotification({ breachId: id })
        enqueued = true
      } catch (err: any) {
        // If the queue is unavailable, surface a clear 500 so the operator
        // knows to retry — we do NOT stamp fanout_queued_at when the enqueue
        // itself failed (otherwise a second click would be skipped).
        delete patch.fanout_queued_at
        res.status(500).json({ error: `fan-out enqueue failed: ${err?.message ?? err}` }); return
      }
    }

    const { data, error } = await supabase.from('breach_notifications')
      .update(patch).eq('id', id).select('*').single()
    if (error) { res.status((error as any).code === 'PGRST116' ? 404 : 500).json({ error: (error as any).code === 'PGRST116' ? 'not found' : error.message }); return }
    res.json({ ...data, fanout_enqueued: enqueued })
  })

  // ── GET /api/admin/breach/:id/recipients ─────────────────────────────────
  // Super-admin view of per-recipient delivery state. The FE
  // BreachNotificationsPage uses this to render a collapsible "Delivery
  // status" panel under each breach row. Joins to tenants for the display
  // name; service-role bypasses RLS so this is always full-fidelity.
  r.get('/api/admin/breach/:id/recipients', requireAuth, requireSuperAdmin, async (req, res) => {
    const id = String(req.params.id)
    const { data, error } = await supabase
      .from('breach_notification_recipients')
      .select('id, tenant_id, recipient_email, recipient_name, recipient_role, send_status, queued_at, sent_at, failed_at, error, tenants:tenant_id (name)')
      .eq('breach_id', id)
      .order('queued_at', { ascending: false })
    if (error) { res.status(500).json({ error: error.message }); return }
    const recipients = (data ?? []).map((row: any) => ({
      id:               row.id,
      tenant_id:        row.tenant_id,
      tenant_name:      row.tenants?.name ?? null,
      recipient_email:  row.recipient_email,
      recipient_name:   row.recipient_name,
      recipient_role:   row.recipient_role,
      send_status:      row.send_status,
      queued_at:        row.queued_at,
      sent_at:          row.sent_at,
      failed_at:        row.failed_at,
      error:            row.error,
    }))
    const summary = { queued: 0, sent: 0, failed: 0, bounced: 0 }
    for (const r of recipients) {
      const k = r.send_status as keyof typeof summary
      if (k in summary) summary[k]++
    }
    res.json({ recipients, summary })
  })

  // ── POST /api/admin/breach/:id/resolve ────────────────────────────────────
  r.post('/api/admin/breach/:id/resolve', requireAuth, requireSuperAdmin, async (req, res) => {
    const id = String(req.params.id)
    const { data, error } = await supabase.from('breach_notifications')
      .update({ status: 'resolved' })
      .eq('id', id).select('*').single()
    if (error) { res.status((error as any).code === 'PGRST116' ? 404 : 500).json({ error: (error as any).code === 'PGRST116' ? 'not found' : error.message }); return }
    if (!data) { res.status(404).json({ error: 'breach not found' }); return }
    res.json(data)
  })

  // ── GET /api/breaches ─────────────────────────────────────────────────────
  // Tenant-scoped read: tenant's own breaches + platform-wide breaches.
  // RLS already enforces this; we use the standard tenant-auth chain and
  // let the policy filter rows.
  r.get('/api/breaches', requireAuth, identifyTenant, async (req, res) => {
    const tenantId = (req as any).tenantId as string
    const { data, error } = await supabase
      .from('breach_notifications')
      .select('id, tenant_id, severity, discovered_at, description, affected_contact_count, affected_data_classes, notified_users_at, notified_authority_at, status')
      .or(`tenant_id.is.null,tenant_id.eq.${tenantId}`)
      .order('discovered_at', { ascending: false })
      .limit(100)
    if (error) { res.status(500).json({ error: error.message }); return }
    res.json(data ?? [])
  })

  return r
}
