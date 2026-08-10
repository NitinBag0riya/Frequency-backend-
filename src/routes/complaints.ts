/**
 * Unified Complaints router (HoReCa-only).
 *
 * One `complaints` table, three sources (storefront | swiggy | zomato), the
 * EXISTING notification path (emitNotification), and local action endpoints for
 * the dashboard inbox modal. See docs/complaints-feature-design.md.
 *
 *   POST  /api/complaints/ingest             internal (x-internal-secret) — storefront-api pushes new complaints here
 *   GET   /api/complaints                     list + filters + pagination      (view)
 *   GET   /api/complaints/summary             R11 analytics groupBy            (view)
 *   GET   /api/complaints/:id                 detail                           (view)
 *   POST  /api/complaints/:id/acknowledge     new → acknowledged               (edit)
 *   POST  /api/complaints/:id/assign          set assignee_user_id             (edit)
 *   POST  /api/complaints/:id/note            append internal note to raw      (edit)
 *   POST  /api/complaints/:id/reply           storefront: sent · aggregator: QUEUED (honesty) (edit)
 *   POST  /api/complaints/:id/resolve         local resolve (aggregator resolve stays internal) (edit)
 *
 * Honesty (hard rule): aggregator (swiggy/zomato) write-backs are QUEUED, never
 * faked — Swiggy has no captured write mutation; Zomato's updateComplaint is a
 * scaffold. Only storefront replies are actually delivered (we own the channel).
 */
import express from 'express'
import crypto from 'crypto'
import { SupabaseClient } from '@supabase/supabase-js'
import { emitNotification, tenantNotifyRecipients } from './notifications'

type Mw = (req: express.Request, res: express.Response, next: express.NextFunction) => void | Promise<void>

const SOURCE_LABEL: Record<string, string> = { storefront: 'Storefront', swiggy: 'Swiggy', zomato: 'Zomato' }
// Internal SLA policy for storefront complaints (no source deadline) — 4h.
const STOREFRONT_SLA_MS = Number(process.env.COMPLAINT_STOREFRONT_SLA_MS ?? 4 * 60 * 60 * 1000)

// ── Pure normalisers (exported for backfill + self-check) ───────────────────

/** Swiggy issueType → normalised category (spec §1a). */
export function categoryFromSwiggy(issueType?: string | null): string {
  switch ((issueType || '').toUpperCase()) {
    case 'MISSING_ITEMS': return 'missing_items'
    case 'WRONG_ITEMS': return 'wrong_items'
    case 'QUALITY_ISSUES': return 'quality'
    case 'QUANTITY_ISSUES': return 'quantity'
    case 'SPILLAGE_ISSUES':
    case 'PACKAGING_AND_SPILLAGE_ISSUES': return 'spillage'
    case 'PACKAGING_ISSUES': return 'packaging'
    default: return 'unknown'
  }
}

/**
 * Deterministic severity (spec §1b). No source field for it.
 *  high   if due within 12h, OR rating ≤ 2, OR category ∈ {missing,wrong,quality}
 *  low    if resolved/closed, OR rating ≥ 4
 *  normal otherwise
 */
export function deriveSeverity(input: {
  dueAt?: string | null; rating?: number | null; category?: string | null; status?: string | null
}): 'low' | 'normal' | 'high' {
  const { dueAt, rating, category, status } = input
  if (status === 'resolved' || status === 'closed') return 'low'
  if (rating != null && rating >= 4) return 'low'
  const dueSoon = dueAt ? (new Date(dueAt).getTime() - Date.now()) <= 12 * 3600_000 : false
  const hotCat = category === 'missing_items' || category === 'wrong_items' || category === 'quality'
  if (dueSoon || (rating != null && rating <= 2) || hotCat) return 'high'
  return 'normal'
}

/**
 * Map one storefront `order.complaints[]` entry (or a low-rating+comment) to a
 * complaints row. `index` disambiguates multiple complaints on one order.
 * Returns the DB row shape (snake_case). tenant_id must be resolved by caller.
 */
export function normaliseStorefrontComplaint(args: {
  tenantId: string
  order: any
  index: number
  text: string
  at?: number | null
  kind?: 'complaint' | 'rating'
}): Record<string, any> {
  const { tenantId, order, index, text, at, kind = 'complaint' } = args
  const orderId = String(order?.id ?? '')
  const opened = at ? new Date(at).toISOString() : new Date().toISOString()
  const rating = Number.isFinite(order?.rating) ? Number(order.rating) : null
  const category = 'other'
  const dueAt = new Date((at ?? Date.now()) + STOREFRONT_SLA_MS).toISOString()
  return {
    tenant_id: tenantId,
    outlet_ref: order?.outletId ?? null,
    source: 'storefront',
    external_id: `${orderId}:${kind}:${index}`,
    order_ref: orderId || null,
    category,
    raw_issue_type: kind,
    severity: deriveSeverity({ dueAt, rating, category, status: 'new' }),
    status: 'new',
    customer_name: order?.guestName || order?.posGuestName || null,
    customer_context: order?.table != null ? `Table ${order.table}` : 'Pickup',
    body: text || null,
    rating,
    opened_at: opened,
    due_at: dueAt,
    raw: { source_order: orderId, kind, text, at: at ?? null, notes: [] },
  }
}

// ── Notify helper (reuses emitNotification transport) ───────────────────────
async function emitComplaintNew(supabase: SupabaseClient, tenantId: string, row: any): Promise<void> {
  const recipients = await tenantNotifyRecipients(supabase, tenantId)
  if (!recipients.length) return
  await emitNotification(supabase, {
    tenant_id: tenantId,
    event_key: 'complaint.new',
    recipient_user_ids: recipients,
    link: '/complaints',
    data: {
      source_label: SOURCE_LABEL[row.source] ?? row.source,
      customer: row.customer_name || 'A guest',
      category: row.category || 'complaint',
      order_short: String(row.order_ref ?? '').slice(-4) || '—',
      priority: row.severity === 'high' ? 'high' : 'normal',
    },
  })
}

const nowIso = () => new Date().toISOString()

// Best-effort delivery of a storefront reply to the guest via storefront-api's
// internal push endpoint. Returns true only on a real 2xx — so we NEVER mark a
// reply "sent" unless it was actually delivered. Unconfigured / failure → false
// (caller keeps reply_state='queued', honest).
async function deliverStorefrontReply(row: any, text: string): Promise<boolean> {
  const base = process.env.STOREFRONT_API_URL || process.env.MAIN_STOREFRONT_API_URL
  const secret = process.env.INTERNAL_TRIGGER_SECRET
  if (!base || !secret) return false
  try {
    const guestKey = row?.raw?.guest_key ?? row?.raw?.source_order_guest_key ?? null
    const r = await fetch(`${base.replace(/\/$/, '')}/internal/guest-notify`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-internal-secret': secret },
      body: JSON.stringify({
        tenant_id: row.tenant_id, order_id: row.order_ref, guest_key: guestKey,
        title: 'A reply to your feedback', body: text,
      }),
    })
    return r.ok
  } catch { return false }
}

export function createComplaintsRouter(
  supabase: SupabaseClient,
  requireAuth: Mw,
  identifyTenant: Mw,
  checkPermission: (f: string, a: 'view' | 'edit' | 'delete') => Mw,
) {
  const router = express.Router()
  const view = [requireAuth, identifyTenant, checkPermission('complaints', 'view')]
  const edit = [requireAuth, identifyTenant, checkPermission('complaints', 'edit')]

  // ── Internal ingest (storefront-api → here). Shared-secret, fail-closed. ──
  // Upserts a normalised row and, on a GENUINELY NEW row, emits complaint.new
  // down the existing notification path. Idempotent via unique(source,external_id).
  router.post('/complaints/ingest', async (req, res) => {
    const secret = process.env.INTERNAL_TRIGGER_SECRET
    const provided = String(req.headers['x-internal-secret'] ?? '')
    if (!secret || provided.length !== secret.length ||
        !crypto.timingSafeEqual(Buffer.from(provided, 'utf8'), Buffer.from(secret, 'utf8'))) {
      res.status(401).json({ error: 'unauthorized' }); return
    }
    const b = (req.body ?? {}) as any
    // Accept either a pre-normalised row (tenant_id + source + external_id) OR a
    // storefront {tenant_id, order, index, text, at, kind} payload.
    let row: Record<string, any> | null = null
    if (b.order && b.tenant_id) {
      row = normaliseStorefrontComplaint({
        tenantId: String(b.tenant_id), order: b.order, index: Number(b.index ?? 0),
        text: String(b.text ?? ''), at: b.at ?? null, kind: b.kind === 'rating' ? 'rating' : 'complaint',
      })
    } else if (b.tenant_id && b.source && b.external_id) {
      row = { ...b }
    }
    if (!row || !row.tenant_id || !row.source || !row.external_id) {
      res.status(400).json({ error: 'tenant_id, source and (order|external_id) required' }); return
    }
    // Ack early; do the write + notify without blocking the storefront response.
    res.json({ ok: true })
    void (async () => {
      try {
        const { data: existing } = await supabase.from('complaints')
          .select('id').eq('source', row!.source).eq('external_id', row!.external_id).maybeSingle()
        if (existing) {
          await supabase.from('complaints').update({ raw: row!.raw ?? {}, updated_at: nowIso() }).eq('id', (existing as any).id)
          return
        }
        const { data: inserted, error } = await supabase.from('complaints')
          .insert({ ...row, updated_at: nowIso() }).select().single()
        if (error) { console.warn('[complaints] ingest insert failed:', error.message); return }
        await emitComplaintNew(supabase, row!.tenant_id, inserted)
      } catch (e: any) {
        console.warn('[complaints] ingest crashed:', e?.message ?? e)
      }
    })()
  })

  // ── List + filters + pagination ─────────────────────────────────────────
  router.get('/complaints', ...view, async (req, res) => {
    const tenantId = (req as any).tenantId
    const q = req.query as Record<string, string>
    const page = Math.max(1, parseInt(q.page ?? '1', 10) || 1)
    const pageSize = Math.min(100, Math.max(1, parseInt(q.pageSize ?? '25', 10) || 25))
    let sel = supabase.from('complaints').select('*', { count: 'exact' }).eq('tenant_id', tenantId)
    if (q.status) sel = sel.in('status', q.status.split(',').filter(Boolean))
    if (q.source) sel = sel.in('source', q.source.split(',').filter(Boolean))
    if (q.severity) sel = sel.in('severity', q.severity.split(',').filter(Boolean))
    if (q.category) sel = sel.in('category', q.category.split(',').filter(Boolean))
    // "expiring < 24h" chip: open rows with a due_at inside the next 24h.
    if (q.expiring === '1' || q.expiring === 'true') {
      sel = sel.lte('due_at', new Date(Date.now() + 24 * 3600_000).toISOString())
        .in('status', ['new', 'acknowledged', 'in_progress'])
    }
    const from = (page - 1) * pageSize
    const { data, error, count } = await sel
      .order('opened_at', { ascending: false })
      .range(from, from + pageSize - 1)
    if (error) return res.status(500).json({ error: error.message })
    res.json({ complaints: data ?? [], total: count ?? 0, page, pageSize })
  })

  // ── R11 analytics groupBy (volume by source/category/status + SLA) ───────
  router.get('/complaints/summary', ...view, async (req, res) => {
    const tenantId = (req as any).tenantId
    const { data, error } = await supabase.from('complaints')
      .select('source, category, status, severity, due_at, resolved_at, opened_at, escalated_notified_at')
      .eq('tenant_id', tenantId).limit(5000)
    if (error) return res.status(500).json({ error: error.message })
    const rows = data ?? []
    const tally = (key: string) => rows.reduce((m: Record<string, number>, r: any) => {
      const k = r[key] ?? 'unknown'; m[k] = (m[k] ?? 0) + 1; return m
    }, {})
    const open = rows.filter((r: any) => !['resolved', 'closed'].includes(r.status)).length
    const resolved = rows.filter((r: any) => r.resolved_at)
    // SLA: of rows that HAD a deadline, how many resolved before it.
    const withDue = rows.filter((r: any) => r.due_at)
    const breached = withDue.filter((r: any) =>
      r.escalated_notified_at || (r.resolved_at && new Date(r.resolved_at) > new Date(r.due_at))).length
    const resTimesMin = resolved
      .map((r: any) => (new Date(r.resolved_at).getTime() - new Date(r.opened_at).getTime()) / 60000)
      .filter((n: number) => n >= 0).sort((a: number, b: number) => a - b)
    const medianResolveMin = resTimesMin.length
      ? Math.round(resTimesMin[Math.floor(resTimesMin.length / 2)]) : null
    res.json({
      total: rows.length, open,
      bySource: tally('source'), byCategory: tally('category'),
      byStatus: tally('status'), bySeverity: tally('severity'),
      sla: {
        withDeadline: withDue.length, breached,
        compliancePct: withDue.length ? Math.round(((withDue.length - breached) / withDue.length) * 100) : null,
      },
      medianResolveMin,
    })
  })

  // ── Detail ──────────────────────────────────────────────────────────────
  router.get('/complaints/:id', ...view, async (req, res) => {
    const tenantId = (req as any).tenantId
    const { data, error } = await supabase.from('complaints')
      .select('*').eq('tenant_id', tenantId).eq('id', String(req.params.id)).maybeSingle()
    if (error) return res.status(500).json({ error: error.message })
    if (!data) return res.status(404).json({ error: 'Complaint not found' })
    res.json(data)
  })

  // Fetch a tenant-scoped row or 404. Shared by the action endpoints.
  async function loadOwned(tenantId: string, id: string) {
    const { data } = await supabase.from('complaints')
      .select('*').eq('tenant_id', tenantId).eq('id', id).maybeSingle()
    return data as any
  }

  // ── Acknowledge (new → acknowledged) ─────────────────────────────────────
  router.post('/complaints/:id/acknowledge', ...edit, async (req, res) => {
    const tenantId = (req as any).tenantId
    const c = await loadOwned(tenantId, String(req.params.id))
    if (!c) return res.status(404).json({ error: 'Complaint not found' })
    const patch: any = { acknowledged_at: c.acknowledged_at ?? nowIso(), updated_at: nowIso() }
    if (c.status === 'new') patch.status = 'acknowledged'
    const { data, error } = await supabase.from('complaints').update(patch).eq('id', c.id).select().single()
    if (error) return res.status(500).json({ error: error.message })
    res.json(data)
  })

  // ── Assign to staff ──────────────────────────────────────────────────────
  router.post('/complaints/:id/assign', ...edit, async (req, res) => {
    const tenantId = (req as any).tenantId
    const c = await loadOwned(tenantId, String(req.params.id))
    if (!c) return res.status(404).json({ error: 'Complaint not found' })
    const assignee = (req.body ?? {}).assignee_user_id ?? null
    const patch: any = { assignee_user_id: assignee, updated_at: nowIso() }
    // Picking someone up implies it's being worked → move new/ack forward.
    if (assignee && (c.status === 'new' || c.status === 'acknowledged')) patch.status = 'in_progress'
    const { data, error } = await supabase.from('complaints').update(patch).eq('id', c.id).select().single()
    if (error) return res.status(500).json({ error: error.message })
    res.json(data)
  })

  // ── Internal note (appended to raw.notes[]) — never customer-facing ──────
  router.post('/complaints/:id/note', ...edit, async (req, res) => {
    const tenantId = (req as any).tenantId
    const text = String((req.body ?? {}).text ?? '').slice(0, 2000).trim()
    if (!text) return res.status(400).json({ error: 'note text required' })
    const c = await loadOwned(tenantId, String(req.params.id))
    if (!c) return res.status(404).json({ error: 'Complaint not found' })
    const raw = (c.raw && typeof c.raw === 'object') ? c.raw : {}
    const notes = Array.isArray(raw.notes) ? raw.notes : []
    notes.push({ text, at: nowIso(), by: (req as any).user?.id ?? null })
    const { data, error } = await supabase.from('complaints')
      .update({ raw: { ...raw, notes }, updated_at: nowIso() }).eq('id', c.id).select().single()
    if (error) return res.status(500).json({ error: error.message })
    res.json(data)
  })

  // ── Reply to customer. storefront = real (sent) · aggregator = QUEUED. ────
  router.post('/complaints/:id/reply', ...edit, async (req, res) => {
    const tenantId = (req as any).tenantId
    const text = String((req.body ?? {}).text ?? '').slice(0, 2000).trim()
    if (!text) return res.status(400).json({ error: 'reply text required' })
    const c = await loadOwned(tenantId, String(req.params.id))
    if (!c) return res.status(404).json({ error: 'Complaint not found' })

    let reply_state: 'sent' | 'queued' = 'queued'
    if (c.source === 'storefront') {
      // We own the channel — attempt real delivery; only mark 'sent' on success.
      const delivered = await deliverStorefrontReply(c, text)
      reply_state = delivered ? 'sent' : 'queued'
    }
    // Aggregators (swiggy/zomato): stays 'queued' — no verified write-back exists.
    const { data, error } = await supabase.from('complaints').update({
      reply_text: text, reply_state,
      resolution_status: reply_state === 'sent' ? 'replied' : c.resolution_status ?? null,
      updated_at: nowIso(),
    }).eq('id', c.id).select().single()
    if (error) return res.status(500).json({ error: error.message })
    res.json({
      ...data,
      _notice: c.source === 'storefront'
        ? (reply_state === 'sent' ? 'Reply sent to the guest.' : 'Reply saved — guest delivery channel is not configured yet, so it is queued.')
        : `Queued — will send to ${SOURCE_LABEL[c.source]} once the connector is verified against a live capture.`,
    })
  })

  // ── Resolve (local). Aggregator resolve-to-source stays internal/gated. ──
  router.post('/complaints/:id/resolve', ...edit, async (req, res) => {
    const tenantId = (req as any).tenantId
    const c = await loadOwned(tenantId, String(req.params.id))
    if (!c) return res.status(404).json({ error: 'Complaint not found' })
    const b = (req.body ?? {}) as any
    const resolution_status = ['refunded', 'comped', 'replied', 'no_action', 'na'].includes(b.resolution_status)
      ? b.resolution_status : (c.resolution_status ?? 'no_action')
    // A breached (escalated) complaint can still be resolved — don't block it.
    const { data, error } = await supabase.from('complaints').update({
      status: 'resolved', resolved_at: nowIso(), resolution_status, updated_at: nowIso(),
    }).eq('id', c.id).select().single()
    if (error) return res.status(500).json({ error: error.message })
    res.json({
      ...data,
      _notice: c.source === 'storefront' ? 'Marked resolved.'
        : `Marked resolved in Frequency. NOT pushed to ${SOURCE_LABEL[c.source]} — aggregator resolve is gated until the connector is verified.`,
    })
  })

  return router
}
