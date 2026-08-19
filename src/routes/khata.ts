/**
 * Frequency Khata — customer ledger / udhaar (Khatabook competitor).
 *
 * A per-tenant running ledger of what each customer (party) owes or has paid.
 * `ledger_entries` is the store; direction semantics:
 *   • 'debit'  = YOU GAVE (sold on credit / customer's due goes UP)
 *   • 'credit' = YOU GOT  (customer paid / due goes DOWN)
 * A party's balance = Σ debit − Σ credit. Positive → customer owes you
 * (receivable); negative → advance / you owe them.
 *
 * `source` defaults to 'manual'. The MOAT (phase 2) is auto-filling entries
 * from transactions we already own — orders/POS settlements write source='order'
 * so the khata fills itself. Reelo & Khatabook can't: Reelo doesn't own the txn
 * rail, Khatabook is manual-only. This module is phase 1 (manual + read/rollup);
 * the auto-fill hook lands on the order/settlement path, reusing addEntry().
 *
 * ponytail: party rollups are computed in JS from all tenant rows — fine at SMB
 * volume. Ceiling: swap to a SQL aggregate/materialized rollup if a tenant's
 * ledger crosses ~10k entries.
 */

import express from 'express'
import { SupabaseClient } from '@supabase/supabase-js'
import { maybeAutoTaskForKhataDue } from '../lib/task-auto'

type Mw = (req: express.Request, res: express.Response, next: express.NextFunction) => void | Promise<void>

const DIRECTIONS = ['debit', 'credit'] as const
type Direction = (typeof DIRECTIONS)[number]

/** Stable party key: prefer last-10 phone digits, else a name slug. */
function partyKeyFrom(phone?: string, name?: string): string {
  const p = String(phone ?? '').replace(/\D/g, '')
  if (p.length >= 10) return 'p:' + p.slice(-10)
  const n = String(name ?? '').trim().toLowerCase().replace(/\s+/g, '-').slice(0, 40)
  return 'n:' + (n || 'unknown')
}

interface PartyRollup {
  partyKey: string
  name: string | null
  phone: string | null
  balance: number
  lastAt: string
  entryCount: number
}

function rollup(rows: any[]): PartyRollup[] {
  const map = new Map<string, PartyRollup>()
  for (const e of rows) {
    const k = e.party_key
    const signed = e.direction === 'debit' ? Number(e.amount) : -Number(e.amount)
    const cur = map.get(k)
    if (!cur) {
      map.set(k, { partyKey: k, name: e.party_name ?? null, phone: e.party_phone ?? null, balance: signed, lastAt: e.at, entryCount: 1 })
    } else {
      cur.balance += signed
      cur.entryCount++
      if (e.at > cur.lastAt) { cur.lastAt = e.at; cur.name = e.party_name ?? cur.name; cur.phone = e.party_phone ?? cur.phone }
    }
  }
  // round to paise to avoid float drift
  for (const p of map.values()) p.balance = Math.round(p.balance * 100) / 100
  return [...map.values()].sort((a, b) => (a.lastAt < b.lastAt ? 1 : -1))
}

/** Shared insert used by manual POST and (phase 2) the auto-fill hook. */
export async function addLedgerEntry(
  supabase: SupabaseClient,
  tenantId: string,
  e: { partyName?: string; partyPhone?: string; partyKey?: string; direction: Direction; amount: number; note?: string; source?: string; byEmail?: string; at?: string; outletId?: string | null },
) {
  const party_key = e.partyKey || partyKeyFrom(e.partyPhone, e.partyName)
  return supabase.from('ledger_entries').insert({
    tenant_id: tenantId,
    party_key,
    party_name: e.partyName ?? null,
    party_phone: e.partyPhone ?? null,
    direction: e.direction,
    amount: e.amount,
    note: e.note ?? null,
    source: e.source ?? 'manual',
    by_email: e.byEmail ?? null,
    // Which outlet this due/payment belongs to (AdminOutlet id); null = unassigned.
    outlet_id: e.outletId ? String(e.outletId).slice(0, 64) : null,
    ...(e.at ? { at: e.at } : {}),
  }).select().single()
}

export function createKhataRouter(supabase: SupabaseClient, requireAuth: Mw, identifyTenant: Mw, checkPermission: (f: string, a: 'view' | 'edit' | 'delete') => Mw) {
  const router = express.Router()
  const view = [requireAuth, identifyTenant, checkPermission('leads', 'view')]
  const edit = [requireAuth, identifyTenant, checkPermission('leads', 'edit')]
  const del  = [requireAuth, identifyTenant, checkPermission('leads', 'delete')]

  // GET /khata/summary — totals for the header (receivable / payable / parties).
  router.get('/khata/summary', ...view, async (req, res) => {
    const tenantId = (req as any).tenantId
    const { data, error } = await supabase.from('ledger_entries')
      .select('party_key,party_name,party_phone,direction,amount,at').eq('tenant_id', tenantId)
    if (error) return res.status(500).json({ error: error.message })
    const parties = rollup(data ?? [])
    const receivable = parties.filter(p => p.balance > 0).reduce((s, p) => s + p.balance, 0)
    const payable = parties.filter(p => p.balance < 0).reduce((s, p) => s - p.balance, 0)
    res.json({
      partyCount: parties.length,
      totalReceivable: Math.round(receivable * 100) / 100,
      totalPayable: Math.round(payable * 100) / 100,
      net: Math.round((receivable - payable) * 100) / 100,
    })
  })

  // GET /khata/parties — one row per party with running balance, latest first.
  router.get('/khata/parties', ...view, async (req, res) => {
    const tenantId = (req as any).tenantId
    const { data, error } = await supabase.from('ledger_entries')
      .select('party_key,party_name,party_phone,direction,amount,at').eq('tenant_id', tenantId)
    if (error) return res.status(500).json({ error: error.message })
    let parties = rollup(data ?? [])
    const q = String(req.query.q ?? '').trim().toLowerCase()
    if (q) parties = parties.filter(p => (p.name ?? '').toLowerCase().includes(q) || (p.phone ?? '').includes(q))
    res.json({ parties })
  })

  // GET /khata/parties/:key — that party's ledger timeline + balance.
  router.get('/khata/parties/:key', ...view, async (req, res) => {
    const tenantId = (req as any).tenantId
    const { data, error } = await supabase.from('ledger_entries')
      .select('*').eq('tenant_id', tenantId).eq('party_key', req.params.key).order('at', { ascending: false })
    if (error) return res.status(500).json({ error: error.message })
    const entries = data ?? []
    const balance = entries.reduce((s, e) => s + (e.direction === 'debit' ? Number(e.amount) : -Number(e.amount)), 0)
    const head = entries[0]
    res.json({
      partyKey: req.params.key,
      name: head?.party_name ?? null,
      phone: head?.party_phone ?? null,
      balance: Math.round(balance * 100) / 100,
      entries,
    })
  })

  // POST /khata/entries — record a debit/credit.
  router.post('/khata/entries', ...edit, async (req, res) => {
    const tenantId = (req as any).tenantId
    const b = (req.body ?? {}) as any
    const direction = String(b.direction)
    const amount = Number(b.amount)
    if (!DIRECTIONS.includes(direction as Direction)) return res.status(400).json({ error: "direction must be 'debit' (you gave) or 'credit' (you got)" })
    if (!(amount > 0)) return res.status(400).json({ error: 'amount must be a positive number' })
    if (!b.partyName && !b.partyPhone && !b.partyKey) return res.status(400).json({ error: 'a party name or phone is required' })
    const { data, error } = await addLedgerEntry(supabase, tenantId, {
      partyName: b.partyName, partyPhone: b.partyPhone, partyKey: b.partyKey,
      direction: direction as Direction, amount, note: b.note, at: b.at, outletId: b.outletId,
      byEmail: (req as any).user?.email ?? null,
    })
    if (error) return res.status(500).json({ error: error.message })
    res.json({ entry: data })
    // SOP auto-fire: a debit that pushes a customer's running balance over the threshold
    // spawns a follow-up task for the owner. Fire-and-forget — never delays/fails the
    // ledger write (already responded above); deduped per party via source_key.
    if (data && direction === 'debit') {
      void maybeAutoTaskForKhataDue(supabase, tenantId, { partyKey: (data as any).party_key, partyName: (data as any).party_name })
        .catch(err => console.warn('[khata] auto-task failed:', err?.message))
    }
  })

  // PATCH /khata/entries/:id — edit amount/direction/note (tenant-scoped).
  router.patch('/khata/entries/:id', ...edit, async (req, res) => {
    const tenantId = (req as any).tenantId
    const b = (req.body ?? {}) as any
    const patch: Record<string, unknown> = {}
    if (b.direction !== undefined) {
      if (!DIRECTIONS.includes(b.direction)) return res.status(400).json({ error: 'invalid direction' })
      patch.direction = b.direction
    }
    if (b.amount !== undefined) {
      if (!(Number(b.amount) > 0)) return res.status(400).json({ error: 'amount must be positive' })
      patch.amount = Number(b.amount)
    }
    if (b.note !== undefined) patch.note = b.note
    if (b.at !== undefined) patch.at = b.at
    if (b.outletId !== undefined) patch.outlet_id = b.outletId ? String(b.outletId).slice(0, 64) : null
    // Party rename/rephone (the dashboard edit form sends these) — recompute the
    // stable party_key so the entry still merges with the right customer.
    if (b.partyName !== undefined || b.partyPhone !== undefined) {
      if (b.partyName !== undefined) patch.party_name = String(b.partyName).trim() || null
      if (b.partyPhone !== undefined) patch.party_phone = String(b.partyPhone).trim() || null
      patch.party_key = partyKeyFrom(b.partyPhone, b.partyName)
    }
    if (!Object.keys(patch).length) return res.status(400).json({ error: 'nothing to update' })
    const { data, error } = await supabase.from('ledger_entries').update(patch)
      .eq('tenant_id', tenantId).eq('id', req.params.id).select().single()
    if (error) return res.status(500).json({ error: error.message })
    res.json({ entry: data })
  })

  // DELETE /khata/entries/:id
  router.delete('/khata/entries/:id', ...del, async (req, res) => {
    const tenantId = (req as any).tenantId
    const { error } = await supabase.from('ledger_entries').delete()
      .eq('tenant_id', tenantId).eq('id', req.params.id)
    if (error) return res.status(500).json({ error: error.message })
    res.json({ ok: true })
  })

  return router
}
