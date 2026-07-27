/**
 * Salon/services vertical — appointments CRUD (the "one calendar" core of the
 * salon journey). Per-tenant, RLS-backed. FE-gated to service-pack tenants
 * (salon/spa/wellness). Booking-site intake + WhatsApp reminders are follow-ons
 * that also write here (source stays implicit for now).
 */
import express from 'express'
import { SupabaseClient } from '@supabase/supabase-js'

type Mw = (req: express.Request, res: express.Response, next: express.NextFunction) => void | Promise<void>
const STATUSES = ['booked', 'confirmed', 'completed', 'no_show', 'cancelled'] as const

export function createAppointmentsRouter(supabase: SupabaseClient, requireAuth: Mw, identifyTenant: Mw, checkPermission: (f: string, a: 'view' | 'edit' | 'delete') => Mw) {
  const router = express.Router()
  const view = [requireAuth, identifyTenant, checkPermission('leads', 'view')]
  const edit = [requireAuth, identifyTenant, checkPermission('leads', 'edit')]

  // GET /appointments?from=&to=&status= — list (default: today onward).
  router.get('/appointments', ...view, async (req, res) => {
    const tenantId = (req as any).tenantId
    let q = supabase.from('appointments').select('*').eq('tenant_id', tenantId).order('starts_at', { ascending: true })
    if (req.query.from) q = q.gte('starts_at', String(req.query.from))
    if (req.query.to) q = q.lte('starts_at', String(req.query.to))
    if (req.query.status) q = q.eq('status', String(req.query.status))
    const { data, error } = await q
    if (error) return res.status(500).json({ error: error.message })
    res.json({ appointments: data ?? [] })
  })

  // GET /appointments/summary — today's counts.
  router.get('/appointments/summary', ...view, async (req, res) => {
    const tenantId = (req as any).tenantId
    const start = new Date(); start.setHours(0, 0, 0, 0)
    const end = new Date(start); end.setDate(end.getDate() + 1)
    const { data, error } = await supabase.from('appointments').select('status')
      .eq('tenant_id', tenantId).gte('starts_at', start.toISOString()).lt('starts_at', end.toISOString())
    if (error) return res.status(500).json({ error: error.message })
    const rows = data ?? []
    const by = (s: string) => rows.filter(r => r.status === s).length
    res.json({ today: rows.length, confirmed: by('confirmed'), completed: by('completed'), noShow: by('no_show') })
  })

  // POST /appointments — book.
  router.post('/appointments', ...edit, async (req, res) => {
    const tenantId = (req as any).tenantId
    const b = (req.body ?? {}) as any
    if (!b.startsAt) return res.status(400).json({ error: 'startsAt is required' })
    if (!b.customerName && !b.customerPhone) return res.status(400).json({ error: 'a customer name or phone is required' })
    const status = STATUSES.includes(b.status) ? b.status : 'booked'
    const { data, error } = await supabase.from('appointments').insert({
      tenant_id: tenantId,
      customer_name: b.customerName ?? null, customer_phone: b.customerPhone ?? null,
      service: b.service ?? null, stylist: b.stylist ?? null,
      starts_at: b.startsAt, duration_min: b.durationMin != null ? Number(b.durationMin) : 30,
      status, price: b.price != null && b.price !== '' ? Number(b.price) : null, note: b.note ?? null,
      by_email: (req as any).user?.email ?? null,
    }).select().single()
    if (error) return res.status(500).json({ error: error.message })
    res.json({ appointment: data })
  })

  // PATCH /appointments/:id — reschedule / status / details.
  router.patch('/appointments/:id', ...edit, async (req, res) => {
    const tenantId = (req as any).tenantId
    const b = (req.body ?? {}) as any
    const patch: Record<string, unknown> = { updated_at: new Date().toISOString() }
    if (b.status !== undefined) { if (!STATUSES.includes(b.status)) return res.status(400).json({ error: 'bad status' }); patch.status = b.status }
    for (const [k, col] of [['customerName', 'customer_name'], ['customerPhone', 'customer_phone'], ['service', 'service'], ['stylist', 'stylist'], ['note', 'note']] as const)
      if (b[k] !== undefined) patch[col] = b[k]
    if (b.startsAt !== undefined) patch.starts_at = b.startsAt
    if (b.durationMin !== undefined) patch.duration_min = Number(b.durationMin)
    if (b.price !== undefined) patch.price = b.price === '' ? null : Number(b.price)
    const { data, error } = await supabase.from('appointments').update(patch).eq('tenant_id', tenantId).eq('id', req.params.id).select().single()
    if (error) return res.status(500).json({ error: error.message })
    res.json({ appointment: data })
  })

  // DELETE /appointments/:id
  router.delete('/appointments/:id', ...edit, async (req, res) => {
    const tenantId = (req as any).tenantId
    const { error } = await supabase.from('appointments').delete().eq('tenant_id', tenantId).eq('id', req.params.id)
    if (error) return res.status(500).json({ error: error.message })
    res.json({ ok: true })
  })

  return router
}
