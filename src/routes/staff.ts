/**
 * Staff endpoints — attendance events + payroll upserts.
 *
 * Both routes are tenant-scoped and permission-gated via the shared
 * requireAuth + identifyTenant + checkPermission middleware, matching the
 * vendors/tasks/khata pattern. Reads are provided by direct Supabase queries
 * from the dashboard via RLS (tenant-member SELECT policy on both tables).
 *
 * Perm key = 'staff' — reuses the leads/CRM RBAC via PERMISSION_KEY_ALIASES.
 * Add this to PERMISSION_KEY_ALIASES in src/index.ts if not already present:
 *   staff: ['leads', 'contacts'],
 */

import express from 'express'
import type { SupabaseClient } from '@supabase/supabase-js'

type Mw = (req: express.Request, res: express.Response, next: express.NextFunction) => void | Promise<void>

const KINDS = new Set(['in', 'out', 'break-start', 'break-end'])

export function createStaffRouter(
  supabase: SupabaseClient,
  requireAuth: Mw,
  identifyTenant: Mw,
  checkPermission: (f: string, a: 'view' | 'edit' | 'delete') => Mw,
) {
  const router = express.Router()
  const view = [requireAuth, identifyTenant, checkPermission('staff', 'view')]
  const edit = [requireAuth, identifyTenant, checkPermission('staff', 'edit')]

  // ── Attendance ──────────────────────────────────────────────────────────────
  router.post('/staff/attendance', ...edit, async (req, res) => {
    const tenantId = (req as any).tenantId as string
    const b = (req.body ?? {}) as any
    const kind = String(b.kind ?? '')
    const staffEmail = String(b.staffEmail ?? '').trim().toLowerCase()
    if (!staffEmail) return res.status(400).json({ error: 'staffEmail required' })
    if (!KINDS.has(kind)) return res.status(400).json({ error: 'kind must be one of in|out|break-start|break-end' })

    const row = {
      tenant_id: tenantId,
      outlet_id: b.outletId ? String(b.outletId).slice(0, 64) : null,
      staff_email: staffEmail,
      staff_name: typeof b.staffName === 'string' ? b.staffName.trim() || null : null,
      kind,
      note: typeof b.note === 'string' ? b.note.trim().slice(0, 300) || null : null,
      at: new Date().toISOString(),
    }
    const { data, error } = await supabase.from('staff_attendance').insert(row).select().single()
    if (error) return res.status(500).json({ error: error.message })
    res.json({ event: data })
  })

  // Convenience GET so the dashboard doesn't need direct Supabase for the last-N view.
  router.get('/staff/attendance', ...view, async (req, res) => {
    const tenantId = (req as any).tenantId as string
    const limit = Math.min(500, Math.max(1, parseInt(String(req.query.limit ?? '100'), 10) || 100))
    let q = supabase.from('staff_attendance').select('*').eq('tenant_id', tenantId)
      .order('at', { ascending: false }).limit(limit)
    if (req.query.staffEmail) q = q.eq('staff_email', String(req.query.staffEmail).toLowerCase())
    if (req.query.outletId)   q = q.eq('outlet_id', String(req.query.outletId))
    const { data, error } = await q
    if (error) return res.status(500).json({ error: error.message })
    res.json({ events: data ?? [] })
  })

  // ── Payroll ─────────────────────────────────────────────────────────────────
  // Upsert on (tenant_id, staff_email, period_start). PATCHing an existing row
  // just re-runs this — no distinct PATCH path needed.
  router.post('/staff/payroll', ...edit, async (req, res) => {
    const tenantId = (req as any).tenantId as string
    const b = (req.body ?? {}) as any
    const staffEmail = String(b.staffEmail ?? '').trim().toLowerCase()
    const periodStart = String(b.periodStart ?? '')
    const periodEnd   = String(b.periodEnd ?? '')
    const amount = Number(b.amountInr)
    if (!staffEmail) return res.status(400).json({ error: 'staffEmail required' })
    if (!/^\d{4}-\d{2}-\d{2}$/.test(periodStart) || !/^\d{4}-\d{2}-\d{2}$/.test(periodEnd))
      return res.status(400).json({ error: 'periodStart / periodEnd must be YYYY-MM-DD' })
    if (!Number.isFinite(amount) || amount < 0) return res.status(400).json({ error: 'amountInr must be ≥ 0' })

    const status = b.status === 'paid' ? 'paid' : 'pending'
    const row: Record<string, unknown> = {
      tenant_id: tenantId,
      staff_email: staffEmail,
      period_start: periodStart,
      period_end: periodEnd,
      amount_inr: Math.round(amount * 100) / 100,
      status,
      due_on: b.dueOn && /^\d{4}-\d{2}-\d{2}$/.test(String(b.dueOn)) ? b.dueOn : null,
      paid_on: status === 'paid'
        ? (b.paidOn && /^\d{4}-\d{2}-\d{2}$/.test(String(b.paidOn)) ? b.paidOn : new Date().toISOString().slice(0, 10))
        : null,
      updated_at: new Date().toISOString(),
    }
    const { data, error } = await supabase.from('staff_payroll').upsert(row, {
      onConflict: 'tenant_id,staff_email,period_start',
    }).select().single()
    if (error) return res.status(500).json({ error: error.message })
    res.json({ payroll: data })
  })

  router.get('/staff/payroll', ...view, async (req, res) => {
    const tenantId = (req as any).tenantId as string
    let q = supabase.from('staff_payroll').select('*').eq('tenant_id', tenantId)
      .order('period_start', { ascending: false }).limit(500)
    if (req.query.status) q = q.eq('status', String(req.query.status))
    if (req.query.staffEmail) q = q.eq('staff_email', String(req.query.staffEmail).toLowerCase())
    const { data, error } = await q
    if (error) return res.status(500).json({ error: error.message })
    res.json({ payroll: data ?? [] })
  })

  return router
}
