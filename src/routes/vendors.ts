/**
 * Order stock from vendors — "Suppliers" (HoReCa-only).
 *
 * Suppliers (name + WhatsApp phone) and stock orders (purchase_orders). The
 * order itself is SENT from the operator's own WhatsApp via a wa.me link the FE
 * opens — this module never calls the Meta API; it just tracks state (draft →
 * sent → received) and, on receipt, posts ONE vendor payable into the shared
 * Khata ledger via addLedgerEntry(). So "You owe <supplier>" rolls up alongside
 * the customer khata, keyed 'vendor:<phone>' to stay distinct from customers.
 *
 * Tenant-scoped + feature/permission-gated exactly like khata.ts (reuses the
 * `leads` permission alias via PERMISSION_KEY_ALIASES: suppliers → leads).
 * Money-integrity: amount ≥ 0, we never edit the original ledger entry, and a
 * received PO is idempotent — re-posting is blocked once ledger_entry_id is set.
 */
import express from 'express'
import { SupabaseClient } from '@supabase/supabase-js'
import { addLedgerEntry } from './khata'

type Mw = (req: express.Request, res: express.Response, next: express.NextFunction) => void | Promise<void>

const STATUSES = ['draft', 'sent', 'received', 'cancelled'] as const
type Status = (typeof STATUSES)[number]

export interface POLine {
  name: string
  qty: number
  unit: string
  qtyReceived?: number
  price?: number
  ingredientId?: string | null   // links an inventory ingredient → survives for re-sync
}

/** Last-10 digits — the same normalisation the khata party key uses, so a
 *  vendor's phone maps to a stable 'vendor:<phone>' ledger key. */
export function vendorPhone(raw?: string | null): string {
  return String(raw ?? '').replace(/\D/g, '').slice(-10)
}

/** Sanitise a client-supplied lines array into well-typed POLine rows.
 *  `withReceipt` also keeps qtyReceived + price (the goods-receipt fields). */
export function cleanLines(raw: unknown, withReceipt = false): POLine[] {
  if (!Array.isArray(raw)) return []
  const out: POLine[] = []
  for (const r of raw as any[]) {
    const name = typeof r?.name === 'string' ? r.name.trim() : ''
    if (!name) continue
    const qty = Number(r?.qty)
    const line: POLine = {
      name,
      qty: Number.isFinite(qty) && qty > 0 ? qty : 1,
      unit: typeof r?.unit === 'string' && r.unit.trim() ? r.unit.trim() : 'pcs',
    }
    if (r?.ingredientId) line.ingredientId = String(r.ingredientId).slice(0, 64)
    if (withReceipt) {
      const qr = Number(r?.qtyReceived)
      const price = Number(r?.price)
      line.qtyReceived = Number.isFinite(qr) && qr >= 0 ? qr : 0
      line.price = Number.isFinite(price) && price >= 0 ? price : 0
    }
    out.push(line)
  }
  return out
}

/** Money that actually arrived: Σ(qtyReceived × price). Pure — self-checked. */
export function receivedTotal(lines: POLine[]): number {
  const t = lines.reduce((s, l) => s + (Number(l.qtyReceived) || 0) * (Number(l.price) || 0), 0)
  return Math.round(t * 100) / 100
}

export function createVendorsRouter(
  supabase: SupabaseClient,
  requireAuth: Mw,
  identifyTenant: Mw,
  checkPermission: (f: string, a: 'view' | 'edit' | 'delete') => Mw,
) {
  const router = express.Router()
  // Gated behind the `suppliers` feature/entitlement; reuses the leads RBAC
  // permission via PERMISSION_KEY_ALIASES (suppliers → leads), like khata.
  const view = [requireAuth, identifyTenant, checkPermission('suppliers', 'view')]
  const edit = [requireAuth, identifyTenant, checkPermission('suppliers', 'edit')]
  const del  = [requireAuth, identifyTenant, checkPermission('suppliers', 'delete')]

  // ── Vendors ────────────────────────────────────────────────────────────────
  router.get('/vendors', ...view, async (req, res) => {
    const tenantId = (req as any).tenantId
    const { data, error } = await supabase.from('vendors')
      .select('*').eq('tenant_id', tenantId).order('created_at', { ascending: false })
    if (error) return res.status(500).json({ error: error.message })
    res.json({ vendors: data ?? [] })
  })

  router.post('/vendors', ...edit, async (req, res) => {
    const tenantId = (req as any).tenantId
    const b = (req.body ?? {}) as any
    const name = typeof b.name === 'string' ? b.name.trim() : ''
    if (!name) return res.status(400).json({ error: 'a supplier name is required' })
    const { data, error } = await supabase.from('vendors').insert({
      tenant_id: tenantId,
      name,
      phone: vendorPhone(b.phone) || null,
      address: typeof b.address === 'string' && b.address.trim() ? b.address.trim() : null,
      note: typeof b.note === 'string' && b.note.trim() ? b.note.trim() : null,
    }).select().single()
    if (error) return res.status(500).json({ error: error.message })
    res.json({ vendor: data })
  })

  router.patch('/vendors/:id', ...edit, async (req, res) => {
    const tenantId = (req as any).tenantId
    const b = (req.body ?? {}) as any
    const patch: Record<string, unknown> = {}
    if (b.name !== undefined) { const n = String(b.name).trim(); if (!n) return res.status(400).json({ error: 'name cannot be empty' }); patch.name = n }
    if (b.phone !== undefined) patch.phone = vendorPhone(b.phone) || null
    if (b.address !== undefined) patch.address = String(b.address).trim() || null
    if (b.note !== undefined) patch.note = String(b.note).trim() || null
    if (!Object.keys(patch).length) return res.status(400).json({ error: 'nothing to update' })
    const { data, error } = await supabase.from('vendors').update(patch)
      .eq('tenant_id', tenantId).eq('id', req.params.id).select().single()
    if (error) return res.status(500).json({ error: error.message })
    res.json({ vendor: data })
  })

  router.delete('/vendors/:id', ...del, async (req, res) => {
    const tenantId = (req as any).tenantId
    const { error } = await supabase.from('vendors').delete()
      .eq('tenant_id', tenantId).eq('id', req.params.id)
    if (error) return res.status(500).json({ error: error.message })
    res.json({ ok: true })
  })

  // ── Purchase orders (stock orders) ──────────────────────────────────────────
  router.get('/purchase-orders', ...view, async (req, res) => {
    const tenantId = (req as any).tenantId
    let q = supabase.from('purchase_orders').select('*').eq('tenant_id', tenantId).order('created_at', { ascending: false })
    if (req.query.vendor_id) q = q.eq('vendor_id', String(req.query.vendor_id))
    if (req.query.status) q = q.eq('status', String(req.query.status))
    const { data, error } = await q
    if (error) return res.status(500).json({ error: error.message })
    res.json({ orders: data ?? [] })
  })

  router.post('/purchase-orders', ...edit, async (req, res) => {
    const tenantId = (req as any).tenantId
    const b = (req.body ?? {}) as any
    if (!b.vendor_id) return res.status(400).json({ error: 'pick a supplier' })
    const status: Status = b.status === 'sent' ? 'sent' : 'draft'
    const { data, error } = await supabase.from('purchase_orders').insert({
      tenant_id: tenantId,
      vendor_id: b.vendor_id,
      outlet_ref: b.outlet_ref ?? null,
      status,
      lines: cleanLines(b.lines),
      note: typeof b.note === 'string' && b.note.trim() ? b.note.trim() : null,
      ...(status === 'sent' ? { sent_at: new Date().toISOString() } : {}),
    }).select().single()
    if (error) return res.status(500).json({ error: error.message })
    res.json({ order: data })
  })

  router.patch('/purchase-orders/:id', ...edit, async (req, res) => {
    const tenantId = (req as any).tenantId
    const b = (req.body ?? {}) as any
    const { data: po, error: loadErr } = await supabase.from('purchase_orders')
      .select('status').eq('tenant_id', tenantId).eq('id', req.params.id).maybeSingle()
    if (loadErr) return res.status(500).json({ error: loadErr.message })
    if (!po) return res.status(404).json({ error: 'order not found' })
    if (po.status === 'received') return res.status(409).json({ error: 'this order is already received' })
    const patch: Record<string, unknown> = {}
    if (b.vendor_id !== undefined) patch.vendor_id = b.vendor_id || null
    if (b.outlet_ref !== undefined) patch.outlet_ref = b.outlet_ref || null
    if (b.lines !== undefined) patch.lines = cleanLines(b.lines)
    if (b.note !== undefined) patch.note = String(b.note).trim() || null
    if (b.status !== undefined && (b.status === 'draft' || b.status === 'cancelled')) patch.status = b.status
    if (!Object.keys(patch).length) return res.status(400).json({ error: 'nothing to update' })
    const { data, error } = await supabase.from('purchase_orders').update(patch)
      .eq('tenant_id', tenantId).eq('id', req.params.id).select().single()
    if (error) return res.status(500).json({ error: error.message })
    res.json({ order: data })
  })

  // POST /purchase-orders/:id/send — the FE already opened wa.me; just mark sent.
  router.post('/purchase-orders/:id/send', ...edit, async (req, res) => {
    const tenantId = (req as any).tenantId
    const { data: po, error: loadErr } = await supabase.from('purchase_orders')
      .select('status').eq('tenant_id', tenantId).eq('id', req.params.id).maybeSingle()
    if (loadErr) return res.status(500).json({ error: loadErr.message })
    if (!po) return res.status(404).json({ error: 'order not found' })
    if (po.status === 'received') return res.status(409).json({ error: 'this order is already received' })
    const { data, error } = await supabase.from('purchase_orders')
      .update({ status: 'sent', sent_at: new Date().toISOString() })
      .eq('tenant_id', tenantId).eq('id', req.params.id).select().single()
    if (error) return res.status(500).json({ error: error.message })
    res.json({ order: data })
  })

  // POST /purchase-orders/:id/receive — "update what came".
  // Body: { lines:[{name,qty,unit,qtyReceived,price}], note? }. Posts ONE khata
  // payable = Σ(qtyReceived × price) and marks the PO received.
  router.post('/purchase-orders/:id/receive', ...edit, async (req, res) => {
    const tenantId = (req as any).tenantId
    const b = (req.body ?? {}) as any

    const { data: po, error: loadErr } = await supabase.from('purchase_orders')
      .select('*').eq('tenant_id', tenantId).eq('id', req.params.id).maybeSingle()
    if (loadErr) return res.status(500).json({ error: loadErr.message })
    if (!po) return res.status(404).json({ error: 'order not found' })
    // Only a sent order can be received (never a draft, cancelled, or already-received one).
    if (po.status !== 'sent') {
      return res.status(409).json({ error: po.status === 'received' ? 'this order is already received' : `cannot receive a ${po.status} order` })
    }

    const lines = cleanLines(b.lines, true)
    const amount = receivedTotal(lines)  // ≥ 0 by construction (cleanLines floors negatives to 0)

    // Load the vendor for the ledger party name/phone.
    let vendorName = 'Supplier'
    let phone = ''
    if (po.vendor_id) {
      const { data: v } = await supabase.from('vendors').select('name,phone').eq('tenant_id', tenantId).eq('id', po.vendor_id).maybeSingle()
      if (v) { vendorName = v.name || vendorName; phone = vendorPhone(v.phone) }
    }

    // ATOMIC CLAIM — the real idempotency guard. Flip sent→received ONLY if the row is
    // still 'sent' and has no payable yet. On a double-tap / retry / two-tab race exactly
    // ONE request wins this conditional update; every other gets 409 and posts nothing.
    // (A read-then-check guard is a TOCTOU hole that can double-post the payable.)
    const { data: claimed, error: claimErr } = await supabase.from('purchase_orders').update({
      status: 'received',
      received_at: new Date().toISOString(),
      lines,
      ...(typeof b.note === 'string' ? { note: b.note.trim() || null } : {}),
    }).eq('tenant_id', tenantId).eq('id', req.params.id).eq('status', 'sent').is('ledger_entry_id', null).select().maybeSingle()
    if (claimErr) return res.status(500).json({ error: claimErr.message })
    if (!claimed) return res.status(409).json({ error: 'this order is already received' })

    // Only the winner reaches here → post the payable, then pin ledger_entry_id. A crash
    // between the claim and this post leaves a received PO with no payable (reconcilable,
    // and far cheaper than a double-charge). Party key uses the SAME token the FE keys
    // "You owe" by — phone last-10, else the vendor id — so the payable is never orphaned.
    let ledgerEntryId: string | null = null
    if (amount > 0) {
      const { data: entry, error: ledErr } = await addLedgerEntry(supabase, tenantId, {
        partyKey: 'vendor:' + (po.vendor_id || 'unknown'),   // immutable id, not phone (a phone edit must not orphan the ledger)
        partyName: vendorName,
        partyPhone: phone || undefined,
        direction: 'credit',           // credit = WE OWE the supplier (payable; balance goes negative)
        amount,
        source: 'purchase',
        note: 'Stock received',
        byEmail: (req as any).user?.email ?? null,
      })
      if (ledErr) return res.status(500).json({ error: ledErr.message })
      ledgerEntryId = entry?.id ?? null
      if (ledgerEntryId) await supabase.from('purchase_orders').update({ ledger_entry_id: ledgerEntryId }).eq('tenant_id', tenantId).eq('id', req.params.id)
    }

    res.json({ order: { ...claimed, ledger_entry_id: ledgerEntryId }, amount })
  })

  return router
}
