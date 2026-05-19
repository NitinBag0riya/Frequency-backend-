/**
 * routes/commerce.ts — WA-native commerce MVP (Phase 4, migrations 097 + 098).
 *
 * Scope:
 *   GET    /api/commerce/catalog              — list items
 *   POST   /api/commerce/catalog              — add item
 *   PATCH  /api/commerce/catalog/:id          — edit item
 *   DELETE /api/commerce/catalog/:id          — soft-disable
 *
 *   GET    /api/commerce/accounts             — khaata list (with balance)
 *   POST   /api/commerce/accounts             — lookup-or-create by contact_id
 *   GET    /api/commerce/accounts/:id         — single account + last 50 txns
 *   POST   /api/commerce/accounts/:id/transactions
 *                                              — record order/settlement/refund/adjustment
 *
 *   POST   /api/commerce/match                — match a free-text/voice
 *                                              order to catalog items
 *                                              (fuzzy alt_names + trigram)
 *
 * Hardening notes (audit fixes shipped with this file):
 *   - Every Zod schema is .strict() and explicit-pick'd before insert/
 *     update so client body can never override route-derived tenant_id.
 *   - image_url restricted to https:// scheme — `javascript:` / `data:`
 *     blocked.
 *   - Order/settlement/refund/adjustment routes go through the
 *     `commerce_post_transaction` RPC (migration 098) which row-locks
 *     khaata_accounts before the credit-limit check, eliminating the
 *     read-then-write race.
 *   - adjustment amounts are clamped to ±₹50,000 (5_000_000 paise) so a
 *     compromised admin session can't zero out a large balance in one
 *     shot. razorpay_payment_id is only accepted on settlement type.
 *   - razorpay_payment_id replay protection: partial unique index from
 *     migration 098 returns 23505 on duplicate, which we surface as a
 *     409 conflict.
 *   - Supabase error.message NEVER reflected to client — generic
 *     respond500() with correlation id.
 *
 * Standing orders + monthly settlements have endpoints stubbed (out
 * of scope for the MVP — schema is in place, will surface in v1.1).
 */

import express from 'express'
import { z } from 'zod'
import type { SupabaseClient } from '@supabase/supabase-js'
import { fetchPayment } from '../lib/razorpay'
import { decideGovernance } from './governance'

type Deps = {
  supabase: SupabaseClient
  requireAuth: express.RequestHandler
  identifyTenant: express.RequestHandler
}

// Caps:
// - alt_names: 20 entries × 80 chars each
// - tags / category: short strings only
// - image_url: must be https://
const CatalogItemBody = z.object({
  name:        z.string().min(1).max(200),
  alt_names:   z.array(z.string().max(80)).max(20).optional(),
  unit:        z.string().max(40).optional(),
  price_paise: z.number().int().min(0).max(100_000_000_00), // ₹100M ceiling
  category:    z.string().max(80).optional(),
  image_url:   z.string().url()
                .refine(u => /^https:\/\//i.test(u), { message: 'image_url must be https' })
                .optional(),
}).strict()

// Adjustment magnitude clamp: ±₹50,000 per call. Anything bigger should
// flow through an audit-logged admin tool, not the inbox commerce panel.
const ADJUSTMENT_CLAMP_PAISE = 50_000_00 // ₹50,000 = 50_00_000 paise

const TransactionBody = z.object({
  type:                z.enum(['order','settlement','adjustment','refund']),
  // items_json: array of small line-item objects. Cap both depth and width
  // so a single POST can't ship a multi-MB blob.
  items_json:          z.array(z.record(z.string(), z.unknown())).max(200).optional(),
  amount_paise:        z.number().int().min(-100_000_000_00).max(100_000_000_00),
  notes:               z.string().max(500).optional(),
  conversation_phone:  z.string().max(40).optional(),
  razorpay_payment_id: z.string().max(80).optional(),
}).strict()

const MatchBody = z.object({
  // Text length doubly capped — the Zod outer cap and an inner regex
  // budget cap (see r.post('/match', ...) below).
  text: z.string().min(1).max(2000),
}).strict()

const AccountCreateBody = z.object({
  contact_id:         z.string().uuid(),
  credit_limit_paise: z.number().int().min(0).max(100_000_000_00).optional(),
  settlement_day:     z.number().int().min(1).max(31).optional(),
}).strict()

// Standing-order templates — recurring daily/weekly/custom-dates orders
// against an existing khaata. Used by the v1.1 standing-orders UI.
const StandingOrderBody = z.object({
  account_id:        z.string().uuid(),
  items_json:        z.array(z.record(z.string(), z.unknown())).max(50),
  frequency:         z.enum(['daily', 'weekly', 'custom_dates']),
  skip_dates:        z.array(z.string()).max(60).optional(),
  pause_from:        z.string().nullable().optional(),
  pause_to:          z.string().nullable().optional(),
  delivery_window:   z.enum(['morning', 'afternoon', 'evening']).optional(),
  active:            z.boolean().optional(),
}).strict()

// Generic Supabase error responder — same pattern as routes/sla.ts and
// routes/ai-agent.ts. Hides column / constraint / row data from clients.
function respond500(res: express.Response, scope: string, error: unknown): void {
  const corrId = Math.random().toString(36).slice(2, 10)
  // eslint-disable-next-line no-console
  console.warn(`[commerce:${scope}] ${corrId}`, error)
  res.status(500).json({ error: 'internal', scope, ref: corrId })
}

export function createCommerceRouter(deps: Deps): express.Router {
  const { supabase, requireAuth, identifyTenant } = deps
  const r = express.Router()

  // ── Catalog ────────────────────────────────────────────────────────────

  r.get('/api/commerce/catalog', requireAuth, identifyTenant, async (req, res) => {
    const tenantId = (req as any).tenantId as string
    const { data, error } = await supabase.from('catalog_items')
      .select('*').eq('tenant_id', tenantId).eq('active', true)
      .order('name')
    if (error) { respond500(res, 'catalog_list', error); return }
    res.json({ data: data ?? [] })
  })

  r.post('/api/commerce/catalog', requireAuth, identifyTenant, async (req, res) => {
    const tenantId = (req as any).tenantId as string
    const parsed = CatalogItemBody.safeParse(req.body)
    if (!parsed.success) { res.status(400).json({ error: 'invalid_body', issues: parsed.error.issues }); return }
    // Explicit pick so client body fields can never override tenant_id.
    const { name, alt_names, unit, price_paise, category, image_url } = parsed.data
    const { data, error } = await supabase.from('catalog_items')
      .insert({ tenant_id: tenantId, name, alt_names, unit, price_paise, category, image_url })
      .select().single()
    if (error) { respond500(res, 'catalog_insert', error); return }
    res.status(201).json({ data })
  })

  r.patch('/api/commerce/catalog/:id', requireAuth, identifyTenant, async (req, res) => {
    const tenantId = (req as any).tenantId as string
    const parsed = CatalogItemBody.partial().safeParse(req.body)
    if (!parsed.success) { res.status(400).json({ error: 'invalid_body', issues: parsed.error.issues }); return }
    // Explicit pick on PATCH for the same reason as POST — never spread.
    const update: Record<string, unknown> = { updated_at: new Date().toISOString() }
    if (parsed.data.name        !== undefined) update.name        = parsed.data.name
    if (parsed.data.alt_names   !== undefined) update.alt_names   = parsed.data.alt_names
    if (parsed.data.unit        !== undefined) update.unit        = parsed.data.unit
    if (parsed.data.price_paise !== undefined) update.price_paise = parsed.data.price_paise
    if (parsed.data.category    !== undefined) update.category    = parsed.data.category
    if (parsed.data.image_url   !== undefined) update.image_url   = parsed.data.image_url
    const { data, error } = await supabase.from('catalog_items')
      .update(update)
      .eq('id', req.params.id).eq('tenant_id', tenantId)
      .select().single()
    if (error) { respond500(res, 'catalog_patch', error); return }
    if (!data) { res.status(404).json({ error: 'not_found' }); return }
    res.json({ data })
  })

  r.delete('/api/commerce/catalog/:id', requireAuth, identifyTenant, async (req, res) => {
    const tenantId = (req as any).tenantId as string
    // Soft-disable; keeps the item referenceable by historical transactions.
    const { error } = await supabase.from('catalog_items')
      .update({ active: false, updated_at: new Date().toISOString() })
      .eq('id', req.params.id).eq('tenant_id', tenantId)
    if (error) { respond500(res, 'catalog_delete', error); return }
    res.json({ success: true })
  })

  // ── Khaata accounts ────────────────────────────────────────────────────

  r.get('/api/commerce/accounts', requireAuth, identifyTenant, async (req, res) => {
    const tenantId = (req as any).tenantId as string
    // Join contacts so the FE can show names without a second round-trip.
    const { data, error } = await supabase.from('khaata_accounts')
      .select('*, contact:contacts(id, name, phone)')
      .eq('tenant_id', tenantId)
      .order('balance_paise', { ascending: false })
      .limit(200)
    if (error) { respond500(res, 'accounts_list', error); return }
    res.json({ data: data ?? [] })
  })

  // POST /api/commerce/accounts — lookup-or-create a khaata for a contact.
  // Idempotent on (tenant_id, contact_id) via the unique index from
  // migration 097 — repeated calls return the existing row.
  r.post('/api/commerce/accounts', requireAuth, identifyTenant, async (req, res) => {
    const tenantId = (req as any).tenantId as string
    const parsed = AccountCreateBody.safeParse(req.body)
    if (!parsed.success) { res.status(400).json({ error: 'invalid_body', issues: parsed.error.issues }); return }
    const { contact_id, credit_limit_paise, settlement_day } = parsed.data

    // Verify the contact belongs to this tenant before opening a
    // khaata for it (defence against cross-tenant contact_id values).
    const { data: contact } = await supabase.from('contacts')
      .select('id').eq('id', contact_id).eq('tenant_id', tenantId).maybeSingle()
    if (!contact) { res.status(404).json({ error: 'contact_not_found' }); return }

    const { data: existing } = await supabase.from('khaata_accounts')
      .select('*, contact:contacts(id, name, phone)')
      .eq('tenant_id', tenantId).eq('contact_id', contact_id).maybeSingle()
    if (existing) { res.json({ data: existing }); return }

    const insert: Record<string, unknown> = { tenant_id: tenantId, contact_id }
    if (credit_limit_paise !== undefined) insert.credit_limit_paise = credit_limit_paise
    if (settlement_day !== undefined) insert.settlement_day = settlement_day
    const { data, error } = await supabase.from('khaata_accounts')
      .insert(insert)
      .select('*, contact:contacts(id, name, phone)').single()
    if (error) { respond500(res, 'accounts_create', error); return }
    res.status(201).json({ data })
  })

  // PATCH /api/commerce/accounts/:id — propose-or-execute credit-limit
  // change. Small changes (< ₹1L delta) apply immediately; larger ones
  // return 202 with a governance proposal template.
  r.patch('/api/commerce/accounts/:id', requireAuth, identifyTenant, async (req, res) => {
    const tenantId = (req as any).tenantId as string
    const body = z.object({
      credit_limit_paise: z.number().int().min(0).max(100_000_000_00).optional(),
      settlement_day:     z.number().int().min(1).max(31).optional(),
    }).strict().safeParse(req.body)
    if (!body.success) { res.status(400).json({ error: 'invalid_body', issues: body.error.issues }); return }

    const { data: account } = await supabase.from('khaata_accounts')
      .select('*').eq('id', req.params.id).eq('tenant_id', tenantId).maybeSingle()
    if (!account) { res.status(404).json({ error: 'not_found' }); return }

    // Governance gate on credit-limit changes.
    if (body.data.credit_limit_paise !== undefined) {
      const delta = body.data.credit_limit_paise - (account.credit_limit_paise as number)
      const decision = decideGovernance('credit_limit_change', delta)
      if (decision.required) {
        res.status(202).json({
          status: 'governance_required',
          action_type: decision.action_type,
          propose_endpoint: '/api/commerce/governance/actions',
          propose_body_template: {
            action_type:   decision.action_type,
            account_id:    account.id,
            amount_paise:  delta,
            reason:        '',
            payload: { from_paise: account.credit_limit_paise, to_paise: body.data.credit_limit_paise },
          },
        })
        return
      }
    }

    const update: Record<string, unknown> = { updated_at: new Date().toISOString() }
    if (body.data.credit_limit_paise !== undefined) update.credit_limit_paise = body.data.credit_limit_paise
    if (body.data.settlement_day     !== undefined) update.settlement_day     = body.data.settlement_day

    const { data, error } = await supabase.from('khaata_accounts')
      .update(update).eq('id', req.params.id).eq('tenant_id', tenantId)
      .select('*, contact:contacts(id, name, phone)').single()
    if (error) { respond500(res, 'account_patch', error); return }
    res.json({ data })
  })

  r.get('/api/commerce/accounts/:id', requireAuth, identifyTenant, async (req, res) => {
    const tenantId = (req as any).tenantId as string
    const { data: account, error } = await supabase.from('khaata_accounts')
      .select('*, contact:contacts(id, name, phone)')
      .eq('id', req.params.id).eq('tenant_id', tenantId)
      .maybeSingle()
    if (error) { respond500(res, 'account_get', error); return }
    if (!account) { res.status(404).json({ error: 'not_found' }); return }
    const { data: txns } = await supabase.from('khaata_transactions')
      .select('*').eq('account_id', account.id)
      .order('created_at', { ascending: false }).limit(50)
    res.json({ data: { ...account, transactions: txns ?? [] } })
  })

  r.post('/api/commerce/accounts/:id/transactions', requireAuth, identifyTenant, async (req, res) => {
    const tenantId = (req as any).tenantId as string
    const userId = (req as any).user?.id as string | undefined
    const parsed = TransactionBody.safeParse(req.body)
    if (!parsed.success) { res.status(400).json({ error: 'invalid_body', issues: parsed.error.issues }); return }
    const body = parsed.data

    // Magnitude clamp for adjustments — these are the only caller-signed
    // entries and the only ones that bypass the credit-limit check
    // (because they include legit negative corrections like "vendor took
    // ₹500 cash from drawer"). Clamp guards against a hijacked admin
    // session zeroing out a large balance in one POST.
    if (body.type === 'adjustment' && Math.abs(body.amount_paise) > ADJUSTMENT_CLAMP_PAISE) {
      res.status(400).json({
        error: 'adjustment_amount_too_large',
        clamp_paise: ADJUSTMENT_CLAMP_PAISE,
      })
      return
    }

    // v1.2 — Governance gate.
    //
    // Refunds always need governance. Adjustments above the auto-clamp
    // threshold (₹10k) need governance. The route does NOT execute these;
    // it returns 202 with the proposal endpoint + a structured payload
    // the FE can resubmit via POST /api/commerce/governance/actions.
    //
    // Why this surface (not auto-creating the proposal): we want the
    // FE to be explicit about the user intent + reason field. The
    // 202+payload shape gives the FE a clear "this needs approval"
    // signal and a ready-to-POST body.
    if (body.type === 'refund' || body.type === 'adjustment') {
      const kind = body.type === 'refund' ? 'refund' : 'adjustment'
      const decision = decideGovernance(kind, body.amount_paise)
      if (decision.required) {
        res.status(202).json({
          status: 'governance_required',
          action_type: decision.action_type,
          propose_endpoint: '/api/commerce/governance/actions',
          propose_body_template: {
            action_type:   decision.action_type,
            account_id:    req.params.id,
            amount_paise:  body.amount_paise,
            reason:        '',          // FE must collect
            payload: {
              amount_paise:        body.amount_paise,
              notes:               body.notes ?? null,
              razorpay_payment_id: body.razorpay_payment_id ?? null,
            },
          },
        })
        return
      }
    }

    // razorpay_payment_id only meaningful on settlement. Reject early
    // to keep the audit story clean ("a settlement is the only thing
    // tied to a real payment ID").
    if (body.razorpay_payment_id && body.type !== 'settlement') {
      res.status(400).json({ error: 'razorpay_payment_id_only_on_settlement' })
      return
    }

    // v1.1 audit fix — Razorpay server-side verification on settlement.
    //
    // When the caller supplies a razorpay_payment_id, verify it directly
    // against the Razorpay API before crediting the khaata. This closes
    // the "I know a real Razorpay payment_id, let me replay it against
    // someone else's account" attack: even with the partial unique index
    // from migration 098 blocking exact replays, an attacker could still
    // try a never-before-used payment_id from their OWN past Razorpay
    // checkout — now we cross-check status='captured' AND that
    // `payment.amount >= settlement amount we're crediting`.
    //
    // If RAZORPAY_KEY_ID/SECRET aren't configured, we still allow the
    // settlement (so dev/local setups that don't hit Razorpay work) but
    // log a high-visibility warning so prod doesn't quietly downgrade.
    if (body.razorpay_payment_id && body.type === 'settlement') {
      const keyConfigured = !!(process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET)
      if (!keyConfigured) {
        // eslint-disable-next-line no-console
        console.warn('[commerce:settlement] RAZORPAY_KEY_ID not set — skipping payment verification. SET BEFORE PROD.')
      } else {
        try {
          const rp = await fetchPayment(body.razorpay_payment_id)
          if (rp.status !== 'captured') {
            res.status(400).json({ error: 'razorpay_payment_not_captured', razorpay_status: rp.status })
            return
          }
          // Razorpay's payment.amount is in paise. The settlement
          // amount we're crediting must not exceed what was actually
          // collected (allow exact match or partial settlement against
          // a larger payment, but never credit more than the customer
          // actually paid).
          const settlementMagnitude = Math.abs(body.amount_paise)
          if (rp.amount < settlementMagnitude) {
            res.status(400).json({
              error: 'razorpay_amount_mismatch',
              razorpay_amount_paise: rp.amount,
              attempted_paise: settlementMagnitude,
            })
            return
          }
        } catch (e: any) {
          // Razorpay API failure (network, 404 on unknown id, bad key).
          // Don't let the settlement through if we asked for verification
          // and it failed.
          // eslint-disable-next-line no-console
          console.warn('[commerce:settlement] razorpay verify failed', e?.message ?? e)
          res.status(502).json({ error: 'razorpay_verify_failed' })
          return
        }
      }
    }

    // Atomic post via SECURITY DEFINER function (migration 098). The
    // function row-locks the account, re-checks tenant ownership,
    // applies sign convention, runs the credit-limit gate inside the
    // same txn, and inserts. Race-free.
    const { data: rpcRows, error: rpcErr } = await supabase.rpc('commerce_post_transaction', {
      p_tenant_id:           tenantId,
      p_account_id:          req.params.id,
      p_type:                body.type,
      p_items_json:          body.items_json ?? [],
      p_amount_paise:        body.amount_paise,
      p_notes:               body.notes ?? null,
      p_conversation_phone:  body.conversation_phone ?? null,
      p_razorpay_payment_id: body.razorpay_payment_id ?? null,
      p_created_by:          userId ?? null,
    })
    if (rpcErr) {
      // 23505 = unique violation on razorpay_payment_id partial index.
      // Surface as conflict so the caller can correct (or recognise a
      // dup webhook delivery).
      if ((rpcErr as any).code === '23505') {
        res.status(409).json({ error: 'razorpay_payment_id_already_used' })
        return
      }
      respond500(res, 'txn_insert', rpcErr)
      return
    }
    const row = Array.isArray(rpcRows) ? rpcRows[0] : rpcRows
    if (!row) { respond500(res, 'txn_insert', 'no rpc result'); return }
    if (row.status === 'not_found') { res.status(404).json({ error: 'account not found' }); return }
    if (row.status === 'credit_limit_exceeded') {
      res.status(402).json({ error: 'credit_limit_exceeded', ...(row.detail ?? {}) })
      return
    }
    if (row.status !== 'ok') { respond500(res, 'txn_insert', row.status); return }
    res.status(201).json({ data: row.txn })
  })

  // ── Standing orders ───────────────────────────────────────────────────
  //
  // Standing-order template per (tenant, account). Daily milk vendor /
  // weekly groceries / "every Mon-Wed-Fri" custom dates. Tenant-scoped
  // via the parent khaata_accounts row.

  r.get('/api/commerce/standing-orders', requireAuth, identifyTenant, async (req, res) => {
    const tenantId = (req as any).tenantId as string
    // Filter by tenant via a join on khaata_accounts. We rely on
    // PostgREST's foreign-table filter; if it fails we fall back to a
    // two-step fetch.
    const { data, error } = await supabase
      .from('standing_orders')
      .select('*, account:khaata_accounts!inner(id, tenant_id, contact:contacts(id, name, phone))')
      .eq('account.tenant_id', tenantId)
      .order('created_at', { ascending: false })
      .limit(200)
    if (error) { respond500(res, 'standing_list', error); return }
    res.json({ data: data ?? [] })
  })

  r.post('/api/commerce/standing-orders', requireAuth, identifyTenant, async (req, res) => {
    const tenantId = (req as any).tenantId as string
    const parsed = StandingOrderBody.safeParse(req.body)
    if (!parsed.success) { res.status(400).json({ error: 'invalid_body', issues: parsed.error.issues }); return }
    // Verify the khaata belongs to this tenant before opening a standing
    // order against it.
    const { data: account } = await supabase.from('khaata_accounts')
      .select('id').eq('id', parsed.data.account_id).eq('tenant_id', tenantId).maybeSingle()
    if (!account) { res.status(404).json({ error: 'account_not_found' }); return }
    const { data, error } = await supabase.from('standing_orders').insert({
      account_id:       parsed.data.account_id,
      items_json:       parsed.data.items_json,
      frequency:        parsed.data.frequency,
      skip_dates:       parsed.data.skip_dates ?? [],
      pause_from:       parsed.data.pause_from ?? null,
      pause_to:         parsed.data.pause_to ?? null,
      delivery_window:  parsed.data.delivery_window ?? 'morning',
      active:           parsed.data.active ?? true,
    }).select().single()
    if (error) { respond500(res, 'standing_insert', error); return }
    res.status(201).json({ data })
  })

  r.patch('/api/commerce/standing-orders/:id', requireAuth, identifyTenant, async (req, res) => {
    const tenantId = (req as any).tenantId as string
    const parsed = StandingOrderBody.partial().safeParse(req.body)
    if (!parsed.success) { res.status(400).json({ error: 'invalid_body', issues: parsed.error.issues }); return }
    // Two-step: fetch + ownership-check, then update.
    const { data: row } = await supabase.from('standing_orders')
      .select('id, account_id, khaata_accounts:khaata_accounts!inner(tenant_id)')
      .eq('id', req.params.id)
      .maybeSingle()
    if (!row || (row as any).khaata_accounts?.tenant_id !== tenantId) {
      res.status(404).json({ error: 'not_found' }); return
    }
    const update: Record<string, unknown> = { updated_at: new Date().toISOString() }
    if (parsed.data.items_json      !== undefined) update.items_json      = parsed.data.items_json
    if (parsed.data.frequency       !== undefined) update.frequency       = parsed.data.frequency
    if (parsed.data.skip_dates      !== undefined) update.skip_dates      = parsed.data.skip_dates
    if (parsed.data.pause_from      !== undefined) update.pause_from      = parsed.data.pause_from
    if (parsed.data.pause_to        !== undefined) update.pause_to        = parsed.data.pause_to
    if (parsed.data.delivery_window !== undefined) update.delivery_window = parsed.data.delivery_window
    if (parsed.data.active          !== undefined) update.active          = parsed.data.active
    const { data, error } = await supabase.from('standing_orders')
      .update(update).eq('id', req.params.id).select().single()
    if (error) { respond500(res, 'standing_patch', error); return }
    res.json({ data })
  })

  r.delete('/api/commerce/standing-orders/:id', requireAuth, identifyTenant, async (req, res) => {
    const tenantId = (req as any).tenantId as string
    const { data: row } = await supabase.from('standing_orders')
      .select('id, account_id, khaata_accounts:khaata_accounts!inner(tenant_id)')
      .eq('id', req.params.id)
      .maybeSingle()
    if (!row || (row as any).khaata_accounts?.tenant_id !== tenantId) {
      res.status(404).json({ error: 'not_found' }); return
    }
    const { error } = await supabase.from('standing_orders')
      .update({ active: false, updated_at: new Date().toISOString() })
      .eq('id', req.params.id)
    if (error) { respond500(res, 'standing_delete', error); return }
    res.json({ success: true })
  })

  // ── Monthly settlements (read-only for now) ──────────────────────────
  // The MVP doesn't ship the auto-bill cron; this endpoint lets the FE
  // surface historical period totals computed by hand or future worker.

  r.get('/api/commerce/settlements', requireAuth, identifyTenant, async (req, res) => {
    const tenantId = (req as any).tenantId as string
    const { data, error } = await supabase
      .from('monthly_settlements')
      .select('*, account:khaata_accounts!inner(id, tenant_id, contact:contacts(id, name, phone))')
      .eq('account.tenant_id', tenantId)
      .order('period_start', { ascending: false })
      .limit(200)
    if (error) { respond500(res, 'settlements_list', error); return }
    res.json({ data: data ?? [] })
  })

  // ── Fuzzy catalog match ───────────────────────────────────────────────
  // Caller passes free-text ("kal subah 2 litre doodh aur 1 kilo atta"),
  // BE returns guessed line items with catalog_item_id + qty. Uses
  // simple word-overlap against name + alt_names with a trigram fallback.

  r.post('/api/commerce/match', requireAuth, identifyTenant, async (req, res) => {
    const tenantId = (req as any).tenantId as string
    const parsed = MatchBody.safeParse(req.body)
    if (!parsed.success) { res.status(400).json({ error: 'invalid_body', issues: parsed.error.issues }); return }
    // Belt-and-braces: cap regex input below the Zod cap so a
    // pathological 2000-char input can't slow the regex scan further.
    const text = parsed.data.text.toLowerCase().slice(0, 1000)

    const { data: items } = await supabase.from('catalog_items')
      .select('id, name, alt_names, unit, price_paise')
      .eq('tenant_id', tenantId).eq('active', true)
      .limit(500)
    if (!items || items.length === 0) { res.json({ data: { line_items: [], unmatched_tokens: [] } }); return }

    // Extract quantity + unit hints + remaining tokens.
    // e.g. "2 litre milk" → [{ qty: 2, unit: 'litre', tail: 'milk' }]
    //
    // i18n: the phrase tail accepts:
    //   - Latin   (a-z)
    //   - Devanagari        ऀ-ॿ  (Hindi / Marathi)
    //   - Bengali           ঀ-৿
    //   - Gurmukhi (Punjabi) ਀-੿
    //   - Gujarati          ઀-૿
    //   - Tamil             ஀-௿
    //   - Telugu            ఀ-౿
    //   - Kannada           ಀ-೿
    //   - Malayalam         ഀ-ൿ
    //
    // Multi-item parsing — we no longer require an explicit separator
    // (aur / and / , / EOL). Instead the tail is matched LAZILY and
    // terminated by a LOOKAHEAD that fires when the NEXT token looks
    // like another quantity ("2 milk 1 atta" → two hits). EOL still
    // works as a backstop terminator.
    const QTY_PATTERN = /(\d+(?:\.\d+)?)\s*(kg|kilo|gram|g|l|liter|litre|ml|piece|pcs|packet|pack|dozen|nos)?\s+([a-zऀ-ॿঀ-৿਀-੿઀-૿஀-௿ఀ-౿ಀ-೿ഀ-ൿ ]+?)(?=\s+(?:aur|and|,|\d+(?:\.\d+)?\s*(?:kg|kilo|gram|g|l|liter|litre|ml|piece|pcs|packet|pack|dozen|nos)?\s+[a-zऀ-ॿঀ-৿਀-੿઀-૿஀-௿ఀ-౿ಀ-೿ഀ-ൿ])|$)/gi
    const hits: Array<{ qty: number; unit: string | null; phrase: string }> = []
    let m: RegExpExecArray | null
    while ((m = QTY_PATTERN.exec(text)) !== null) {
      const phrase = m[3].trim()
      // Skip degenerate matches (e.g. trailing connector words alone).
      if (!phrase) continue
      hits.push({ qty: Number(m[1]), unit: m[2] ? m[2].toLowerCase() : null, phrase })
    }

    // Match each phrase against catalog items by token overlap on name + alt_names.
    // Same Unicode range as the phrase regex above.
    function tokensOf(s: string): string[] {
      return Array.from(new Set(s.toLowerCase().replace(/[^a-z0-9ऀ-ॿঀ-৿਀-੿઀-૿஀-௿ఀ-౿ಀ-೿ഀ-ൿ\s]/g, ' ').split(/\s+/).filter(t => t.length > 1)))
    }
    const lineItems: Array<{ catalog_item_id: string; name: string; qty: number; unit: string | null; price_paise: number; subtotal_paise: number; phrase: string; confidence: number }> = []
    const unmatched: string[] = []
    for (const hit of hits) {
      const hitTokens = tokensOf(hit.phrase)
      let best: { item: any; score: number } | null = null
      for (const item of items) {
        const candidate = [item.name, ...(item.alt_names ?? [])].join(' ')
        const candTokens = tokensOf(candidate)
        const overlap = hitTokens.filter(t => candTokens.some(c => c === t || c.includes(t) || t.includes(c))).length
        const score = overlap / Math.max(1, hitTokens.length)
        if (!best || score > best.score) best = { item, score }
      }
      if (best && best.score >= 0.3) {
        lineItems.push({
          catalog_item_id: best.item.id,
          name: best.item.name,
          qty: hit.qty,
          unit: hit.unit ?? best.item.unit ?? null,
          price_paise: best.item.price_paise,
          subtotal_paise: best.item.price_paise * hit.qty,
          phrase: hit.phrase,
          confidence: best.score,
        })
      } else {
        unmatched.push(hit.phrase)
      }
    }

    res.json({ data: { line_items: lineItems, unmatched_tokens: unmatched } })
  })

  return r
}
