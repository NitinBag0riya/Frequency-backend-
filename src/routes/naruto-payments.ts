/**
 * naruto-payments — the platform (/naruto §9) "Payments & money" backend: one
 * cross-tenant view of the money flowing through Frequency storefronts.
 *
 * DATA SOURCE. Storefront orders live in the storefront-api process (db().orders),
 * NOT in Supabase — the Supabase `lead_rows` Orders mirror is opt-in per tenant and
 * drops the payment fields (method/paidAt/gateway/refund/fee). So the ledger is
 * sourced from storefront-api's cross-tenant endpoint
 *   GET /admin/platform/transactions   (added this wave; shared-secret, cross-tenant)
 * which emits RAW money facts per money-bearing order. THIS module owns the money
 * math (platform fee, est. gateway fee, net, settlement) + tenant vertical/plan
 * enrichment + pagination/rollups, so the numbers are defined in one typed place
 * (see naruto-payments.selfcheck.ts).
 *
 * The dashboard never holds the storefront ADMIN_SECRET (it would leak in the
 * bundle). Every route here is gated by requirePlatformCapability BEFORE it proxies
 * to storefront-api with the secret — the capability guard is the real fence.
 *
 * Endpoints (all requireAuth + a platform capability):
 *   GET  /api/super-admin/payments/ledger      payments.read   — server-paginated txns + summary
 *   GET  /api/super-admin/payments/revenue     payments.read   — GMV/commission/take-rate rollups + trend
 *   GET  /api/super-admin/payments/webhooks     payments.read   — per-tenant payment-webhook health
 *   POST /api/super-admin/payments/:id/killswitch  payments.killswitch.write — disable online pay → COD
 *
 * WIRE(naruto): register in index.ts next to the other naruto routers (below
 *   createNarutoStorefrontRouter, ABOVE the catch-all 404):
 *     import { createNarutoPaymentsRouter } from './routes/naruto-payments'
 *     app.use(createNarutoPaymentsRouter({ supabase, requireAuth }))
 */
import express from 'express'
import type { SupabaseClient } from '@supabase/supabase-js'
import { requirePlatformCapability } from '../lib/platform-guard.js'
import { withApproval, registerPlatformAction, BreakGlassDenied, type ActionExecutor } from './platform-approvals.js'
import { recordPlatformAudit } from '../lib/platform-audit.js'

type Mw = (req: express.Request, res: express.Response, next: express.NextFunction) => void | Promise<void>
interface Deps { supabase: SupabaseClient; requireAuth: Mw }

// ── Money math (pure; self-checked in naruto-payments.selfcheck.ts) ───────────
// One place that turns storefront-api's raw order facts into platform money. All
// amounts are rupees (the raw platform fee arrives in paise). Kept side-effect-free
// so the ledger + revenue rollups agree and the numbers are testable without a DB.

/** Estimated gateway (PSP) fee — Razorpay/Cashfree standard ~2%. An ESTIMATE: the
 *  PSP invoices real fees monthly; we don't store per-txn PSP fee. Labelled "est" in UI. */
export const GATEWAY_FEE_EST_PCT = 0.02

/** Raw money facts per money-bearing order, as emitted by storefront-api
 *  GET /admin/platform/transactions. */
export interface RawTxn {
  orderId: string
  slug: string
  tenantName: string
  gross: number                 // ₹
  method: 'prepaid' | 'cod'
  gateway: 'razorpay' | 'cashfree' | null
  txnId: string | null
  paidAt: number | null
  createdAt: number | null
  status: string
  refunded: boolean
  platformFeePaise: number | null   // actual Route split recorded at capture
  viaPlatformRoute: boolean
}
export interface TenantMeta { tenantId: string; name: string; vertical: string; plan: string }
export interface LedgerRow {
  orderId: string; slug: string; tenantName: string; vertical: string; plan: string
  gross: number; platformFee: number; gatewayFee: number; net: number
  method: 'prepaid' | 'cod'; gateway: string | null; txnId: string | null
  settlement: 'routed' | 'direct' | 'cod' | 'refunded' | 'pending'
  refunded: boolean; at: number | null
}
export interface LedgerSummary {
  gross: number; commission: number; gatewayFees: number; net: number
  count: number; refundCount: number; refundAmount: number; takeRate: number
}

const round2 = (n: number) => Math.round(n * 100) / 100

export function ledgerRowOf(raw: RawTxn, meta?: TenantMeta): LedgerRow {
  const gross = Math.max(0, Number(raw.gross) || 0)
  const platformFee = raw.platformFeePaise != null ? round2(raw.platformFeePaise / 100) : 0
  // Gateway fee only on prepaid orders that actually went through a PSP; COD is cash.
  const gatewayFee = raw.method === 'prepaid' && raw.gateway ? round2(gross * GATEWAY_FEE_EST_PCT) : 0
  // Net to tenant: COD = full cash in the merchant's hand; prepaid = after platform + PSP fees.
  const net = raw.method === 'cod' ? gross : round2(gross - platformFee - gatewayFee)
  const settlement: LedgerRow['settlement'] =
    raw.refunded ? 'refunded'
    : raw.method === 'cod' ? 'cod'
    : raw.viaPlatformRoute ? 'routed'
    : raw.gateway ? 'direct'
    : 'pending'
  return {
    orderId: raw.orderId, slug: raw.slug, tenantName: raw.tenantName,
    vertical: meta?.vertical ?? 'other', plan: meta?.plan ?? 'none',
    gross, platformFee, gatewayFee, net,
    method: raw.method, gateway: raw.gateway, txnId: raw.txnId,
    settlement, refunded: !!raw.refunded, at: raw.paidAt ?? raw.createdAt ?? null,
  }
}

export function buildLedger(raws: RawTxn[], meta: Map<string, TenantMeta>): { rows: LedgerRow[]; summary: LedgerSummary } {
  const rows = raws.map(r => ledgerRowOf(r, meta.get(String(r.slug).toLowerCase())))
  const live = rows.filter(r => !r.refunded)
  const refunded = rows.filter(r => r.refunded)
  const sum = (a: LedgerRow[], k: keyof LedgerRow) => round2(a.reduce((s, r) => s + (Number(r[k]) || 0), 0))
  const gross = sum(live, 'gross')
  const commission = sum(live, 'platformFee')
  return {
    rows,
    summary: {
      gross, commission,
      gatewayFees: sum(live, 'gatewayFee'),
      net: sum(live, 'net'),
      count: live.length,
      refundCount: refunded.length,
      refundAmount: sum(refunded, 'gross'),
      takeRate: gross > 0 ? round2((commission / gross) * 100) / 100 : 0,
    },
  }
}

const monthKey = (ms: number | null) => {
  const d = new Date(ms || 0)
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`
}

export interface RevenueRollup {
  summary: LedgerSummary
  compare: { gross: number; commission: number } | null
  byVertical: Array<{ key: string; gross: number; commission: number; count: number; takeRate: number }>
  byPlan: Array<{ key: string; gross: number; commission: number; count: number; takeRate: number }>
  byTenant: Array<{ slug: string; name: string; vertical: string; plan: string; gross: number; commission: number; count: number; spark: number[] }>
  trend: Array<{ month: string; gross: number; commission: number }>
}

export function rollupRevenue(raws: RawTxn[], meta: Map<string, TenantMeta>, compareRaws: RawTxn[] = []): RevenueRollup {
  const { rows, summary } = buildLedger(raws, meta)
  const live = rows.filter(r => !r.refunded)

  const group = (keyOf: (r: LedgerRow) => string) => {
    const m = new Map<string, { gross: number; commission: number; count: number }>()
    for (const r of live) {
      const k = keyOf(r) || 'other'
      const g = m.get(k) ?? { gross: 0, commission: 0, count: 0 }
      g.gross += r.gross; g.commission += r.platformFee; g.count += 1
      m.set(k, g)
    }
    return [...m.entries()].map(([key, v]) => ({
      key, gross: round2(v.gross), commission: round2(v.commission), count: v.count,
      takeRate: v.gross > 0 ? round2((v.commission / v.gross) * 100) / 100 : 0,
    })).sort((a, b) => b.gross - a.gross)
  }

  // Monthly trend across the window (for the primary chart).
  const trendMap = new Map<string, { gross: number; commission: number }>()
  for (const r of live) {
    const k = monthKey(r.at)
    const g = trendMap.get(k) ?? { gross: 0, commission: 0 }
    g.gross += r.gross; g.commission += r.platformFee
    trendMap.set(k, g)
  }
  const trend = [...trendMap.entries()].sort((a, b) => a[0].localeCompare(b[0]))
    .map(([month, v]) => ({ month, gross: round2(v.gross), commission: round2(v.commission) }))

  // Per-tenant with a monthly GMV sparkline series.
  const tenantMap = new Map<string, { name: string; vertical: string; plan: string; gross: number; commission: number; count: number; months: Map<string, number> }>()
  for (const r of live) {
    const g = tenantMap.get(r.slug) ?? { name: r.tenantName, vertical: r.vertical, plan: r.plan, gross: 0, commission: 0, count: 0, months: new Map() }
    g.gross += r.gross; g.commission += r.platformFee; g.count += 1
    g.months.set(monthKey(r.at), (g.months.get(monthKey(r.at)) || 0) + r.gross)
    tenantMap.set(r.slug, g)
  }
  const months = trend.map(t => t.month)
  const byTenant = [...tenantMap.entries()].map(([slug, v]) => ({
    slug, name: v.name, vertical: v.vertical, plan: v.plan,
    gross: round2(v.gross), commission: round2(v.commission), count: v.count,
    spark: months.map(m => round2(v.months.get(m) || 0)),
  })).sort((a, b) => b.gross - a.gross)

  const cmp = buildLedger(compareRaws, meta).summary
  return {
    summary,
    compare: compareRaws.length ? { gross: cmp.gross, commission: cmp.commission } : null,
    byVertical: group(r => r.vertical),
    byPlan: group(r => r.plan),
    byTenant, trend,
  }
}

const SF_API = process.env.STOREFRONT_API_URL || 'http://localhost:5181'
const SF_SECRET = process.env.STOREFRONT_ADMIN_SECRET || 'dev-admin'

// storefront-api cross-tenant read (no X-Tenant — the endpoint is deliberately
// platform-wide; the capability guard upstream is what authorizes the caller).
async function sfTransactions(qs: URLSearchParams): Promise<{ rows: RawTxn[]; total: number }> {
  const r = await fetch(`${SF_API}/admin/platform/transactions?${qs}`, {
    headers: { 'X-Admin-Secret': SF_SECRET },
  })
  if (!r.ok) throw new Error(`storefront-api transactions → ${r.status}`)
  const j: any = await r.json()
  return { rows: Array.isArray(j?.rows) ? j.rows : [], total: Number(j?.total) || 0 }
}
// Per-tenant config PATCH (X-Tenant slug) — reused for the kill switch (no new
// storefront-api endpoint: cleanSettings merges {payments:{online}} in place).
async function sfConfigPatch(slug: string, body: unknown): Promise<void> {
  const r = await fetch(`${SF_API}/admin/config`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', 'X-Tenant': slug, 'X-Admin-Secret': SF_SECRET },
    body: JSON.stringify(body),
  })
  if (!r.ok) throw new Error(`storefront-api config PATCH → ${r.status}: ${await r.text().catch(() => '')}`)
}
// Per-tenant config READ (X-Tenant slug) — for the Route/gateway card: reads back
// the stored routeAccountId + online flag without a per-tenant operator session.
async function sfConfigGet(slug: string): Promise<any> {
  const r = await fetch(`${SF_API}/admin/config`, {
    headers: { 'X-Tenant': slug, 'X-Admin-Secret': SF_SECRET },
  })
  if (!r.ok) throw new Error(`storefront-api config GET → ${r.status}`)
  return r.json()
}

// slug → { vertical, plan, name } for the whole platform, one query. Verticals/plans
// live in Supabase; storefront-api only knows name+slug. Keyed by slug (the ledger's join key).
async function tenantMetaBySlug(supabase: SupabaseClient): Promise<Map<string, TenantMeta>> {
  const { data } = await supabase.from('tenants')
    .select('id, slug, business_name, business_type, tenant_subscriptions ( plan_id, status )')
    .not('slug', 'is', null)
  const m = new Map<string, TenantMeta>()
  for (const t of (data ?? []) as any[]) {
    if (!t.slug) continue
    const sub = Array.isArray(t.tenant_subscriptions) ? t.tenant_subscriptions[0] : t.tenant_subscriptions
    m.set(String(t.slug).toLowerCase(), {
      tenantId: t.id,
      name: t.business_name ?? t.slug,
      vertical: t.business_type ?? 'other',
      plan: sub?.plan_id ?? 'none',
    })
  }
  return m
}

export function createNarutoPaymentsRouter({ supabase, requireAuth }: Deps): express.Router {
  const r = express.Router()

  // Kill-switch executor — registered at setup so an approval survives a process
  // restart between propose and approve (§1.2). Auditing owned by withApproval.
  const killswitchExecutor: ActionExecutor = async ({ args }) => {
    await sfConfigPatch(args.slug, { settings: { payments: { online: args.online } } })
    return { online: args.online, slug: args.slug }
  }
  registerPlatformAction('payments.killswitch', killswitchExecutor)

  // ── 1. Transactions ledger (server-paginated) ──────────────────────────────
  r.get('/api/super-admin/payments/ledger',
    requireAuth, requirePlatformCapability(supabase, 'payments.read'),
    async (req, res) => {
      try {
        const { slug, from, to, page = '1', pageSize = '25' } = req.query as Record<string, string>
        const qs = new URLSearchParams()
        if (slug) qs.set('slug', slug)
        if (from) qs.set('from', from)
        if (to) qs.set('to', to)
        const [{ rows: raw }, meta] = await Promise.all([sfTransactions(qs), tenantMetaBySlug(supabase)])
        const ledger = buildLedger(raw, meta)   // money math + enrichment (one place)
        const p = Math.max(1, parseInt(page, 10) || 1)
        const ps = Math.min(200, Math.max(1, parseInt(pageSize, 10) || 25))
        const start = (p - 1) * ps
        res.json({
          data: ledger.rows.slice(start, start + ps),
          total: ledger.rows.length,
          page: p, pageSize: ps,
          totalPages: Math.max(1, Math.ceil(ledger.rows.length / ps)),
          summary: ledger.summary,           // gross/commission/gatewayFees/net/refunds over the filtered set
        })
      } catch (e: any) { res.status(502).json({ error: e?.message || 'ledger unavailable' }) }
    })

  // ── 2. Revenue dashboard rollups ───────────────────────────────────────────
  r.get('/api/super-admin/payments/revenue',
    requireAuth, requirePlatformCapability(supabase, 'payments.read'),
    async (req, res) => {
      try {
        const { from, to } = req.query as Record<string, string>
        const qs = new URLSearchParams()
        if (from) qs.set('from', from)
        if (to) qs.set('to', to)
        const [{ rows: raw }, meta] = await Promise.all([sfTransactions(qs), tenantMetaBySlug(supabase)])
        // Comparison window = the equal-length span immediately before [from,to] (MoM/period-over-period).
        let compare: RawTxn[] = []
        if (from && to) {
          const f = new Date(from).getTime(), t = new Date(to).getTime()
          if (f && t && t > f) {
            const cq = new URLSearchParams({ from: new Date(f - (t - f)).toISOString(), to: new Date(f).toISOString() })
            compare = (await sfTransactions(cq)).rows
          }
        }
        res.json(rollupRevenue(raw, meta, compare))
      } catch (e: any) { res.status(502).json({ error: e?.message || 'revenue unavailable' }) }
    })

  // ── 3. Payment-webhook health (per tenant) ─────────────────────────────────
  // Sources that EXIST: `tenant_integrations` (razorpay/cashfree connected + webhook_token
  // minted) and `webhook_dead_letter` (failed inbound webhooks, the DLQ). "Last received
  // OK" uses last-paid recency from the ledger as a success proxy.
  // WIRE(naruto): payment-webhook.ts fires workflow triggers but does NOT persist a per-
  // receipt success log, so there is no true success COUNT (only failures via the DLQ).
  // Upgrade: log each verified inbound webhook (provider, tenant, outcome, ts) → exact
  // failure-rate + last-received. Until then failure-rate is DLQ-count-only (denominator
  // unknown) and last-OK is the last settled payment.
  r.get('/api/super-admin/payments/webhooks',
    requireAuth, requirePlatformCapability(supabase, 'payments.read'),
    async (_req, res) => {
      try {
        const [meta, integ, dlq, { rows: raw }] = await Promise.all([
          tenantMetaBySlug(supabase),
          supabase.from('tenant_integrations').select('tenant_id, key, metadata').in('key', ['razorpay', 'cashfree']),
          supabase.from('webhook_dead_letter').select('tenant_id, source, last_error, created_at, replayed_at')
            .in('source', ['razorpay', 'cashfree', 'payment']).order('created_at', { ascending: false }).limit(500),
          sfTransactions(new URLSearchParams()),
        ])
        // tenantId → last successful settled payment (proxy for "last webhook received OK").
        const byId = new Map<string, TenantMeta>()
        for (const m of meta.values()) byId.set(m.tenantId, m)
        const lastPaidByTenant = new Map<string, number>()
        for (const o of raw) {
          if (!o.paidAt) continue
          const m = meta.get(String(o.slug).toLowerCase()); if (!m) continue
          const cur = lastPaidByTenant.get(m.tenantId) || 0
          if (Number(o.paidAt) > cur) lastPaidByTenant.set(m.tenantId, Number(o.paidAt))
        }
        const rows = ((integ.data ?? []) as any[]).map(row => {
          const md = row.metadata || {}
          const fails = ((dlq.data ?? []) as any[]).filter(d => d.tenant_id === row.tenant_id && (d.source === row.key || d.source === 'payment'))
          const openFails = fails.filter(d => !d.replayed_at)
          const m = byId.get(row.tenant_id)
          return {
            tenantId: row.tenant_id,
            tenantName: m?.name ?? row.tenant_id,
            provider: row.key,
            configured: !!md.webhook_token,
            needsSecret: row.key === 'razorpay' && !md.webhook_secret_enc,
            failures: fails.length,
            openFailures: openFails.length,
            lastError: fails[0]?.last_error ?? null,
            lastFailureAt: fails[0]?.created_at ?? null,
            lastPaidAt: lastPaidByTenant.get(row.tenant_id) ?? null,
          }
        })
        res.json({ data: rows })
      } catch (e: any) { res.status(502).json({ error: e?.message || 'webhook health unavailable' }) }
    })

  // ── 4. Online-payment kill switch (reason-gated, audited) ──────────────────
  // Instantly flips settings.payments.online. The storefront degrades to COD safely:
  // storefront/src/runtime.ts paymentMethods() returns ['cod'] whenever online is off,
  // and FLOORS to ['cod'] even if COD were also off — checkout never has zero options.
  // Idempotent: setting online to its current value is a harmless no-op write.
  r.post('/api/super-admin/payments/:tenantId/killswitch',
    requireAuth, requirePlatformCapability(supabase, 'payments.killswitch.write'),
    async (req, res) => {
      const tenantId = String(req.params.tenantId)
      const online = !!(req.body ?? {}).online
      const reason = String((req.body ?? {}).reason ?? '').trim()
      if (!reason) { res.status(400).json({ error: 'reason required' }); return }
      const { data: t } = await supabase.from('tenants').select('slug, business_name').eq('id', tenantId).maybeSingle()
      const slug = (t as any)?.slug
      if (!slug) { res.status(404).json({ error: 'unknown tenant' }); return }
      try {
        // §1.2 — an approval rule may gate the kill switch. No rule → applies now
        // + audits (withApproval owns the audit row). Best-effort merchant notify
        // still pending (see WIRE note): the audit row + storefront change are the
        // durable record until a merchant-notify primitive exists.
        const out = await withApproval({
          supabase, req, action: 'payments.killswitch', tenantId, reason,
          breakGlass: !!(req.body ?? {}).break_glass,
          args: { slug, online }, before: { 'payments.online': !online },
          apply: killswitchExecutor,
        })
        if (out.status === 'pending') { res.json(out); return }
        res.json({ ok: true, online, slug, ...(out.breakGlass ? { breakGlass: true } : {}) })
      } catch (e: any) {
        if (e instanceof BreakGlassDenied) { res.status(403).json({ error: e.message }); return }
        res.status(502).json({ error: e?.message || 'kill switch failed' })
      }
    })

  // ── 5. Frequency gateway / Route split (per tenant) ────────────────────────
  // Surfaces the Razorpay Route linked-account id (acc_…) + online-payment flag on
  // /naruto so a platform admin can wire a tenant's 1% split here instead of opening
  // that tenant's own Storefront Settings. The acc_… is MINTED in Razorpay (Route →
  // Linked Accounts, KYC) — this only stores the id the storefront-api splits to.
  const ACC_RE = /^acc_[A-Za-z0-9]+$/
  const resolveSlug = async (tenantId: string): Promise<string | null> => {
    const { data } = await supabase.from('tenants').select('slug').eq('id', tenantId).maybeSingle()
    return (data as any)?.slug ?? null
  }

  // Cheap tenant list for the picker (one query, no storefront-api calls).
  r.get('/api/super-admin/payments/gateway-tenants',
    requireAuth, requirePlatformCapability(supabase, 'payments.read'),
    async (_req, res) => {
      try {
        const meta = await tenantMetaBySlug(supabase)
        const tenants = [...meta.entries()]
          .map(([slug, m]) => ({ tenantId: m.tenantId, name: m.name, slug, vertical: m.vertical }))
          .sort((a, b) => a.name.localeCompare(b.name))
        res.json({ tenants })
      } catch (e: any) { res.status(502).json({ error: e?.message || 'tenant list unavailable' }) }
    })

  // Read one tenant's gateway config (lazy, on picker select).
  r.get('/api/super-admin/payments/:tenantId/gateway',
    requireAuth, requirePlatformCapability(supabase, 'payments.read'),
    async (req, res) => {
      try {
        const slug = await resolveSlug(String(req.params.tenantId))
        if (!slug) { res.status(404).json({ error: 'unknown tenant' }); return }
        const cfg = await sfConfigGet(slug)
        res.json({ slug, routeAccountId: cfg?.routeAccountId ?? null, online: !!cfg?.settings?.payments?.online })
      } catch (e: any) { res.status(502).json({ error: e?.message || 'gateway config unavailable' }) }
    })

  // Set the Route account id and/or online flag (reason-free config write; audited).
  r.patch('/api/super-admin/payments/:tenantId/gateway',
    requireAuth, requirePlatformCapability(supabase, 'payments.killswitch.write'),
    async (req, res) => {
      const tenantId = String(req.params.tenantId)
      const body = (req.body ?? {}) as { routeAccountId?: string | null; online?: boolean }
      const hasAcc = Object.prototype.hasOwnProperty.call(body, 'routeAccountId')
      const acc = hasAcc ? (String(body.routeAccountId ?? '').trim() || null) : undefined
      if (acc && !ACC_RE.test(acc)) { res.status(400).json({ error: 'routeAccountId must look like acc_XXXXXXXX' }); return }
      const slug = await resolveSlug(tenantId)
      if (!slug) { res.status(404).json({ error: 'unknown tenant' }); return }
      const patch: any = {}
      if (acc !== undefined) patch.routeAccountId = acc
      if (typeof body.online === 'boolean') patch.settings = { payments: { online: body.online } }
      if (!Object.keys(patch).length) { res.status(400).json({ error: 'nothing to update' }); return }
      try {
        await sfConfigPatch(slug, patch)
        await recordPlatformAudit(supabase, req, {
          capability: 'payments.killswitch.write', action: 'payments.gateway.set', tenant_id: tenantId,
          after: { ...(acc !== undefined ? { routeAccountId: acc } : {}), ...(typeof body.online === 'boolean' ? { online: body.online } : {}) },
        })
        res.json({ ok: true, ...(acc !== undefined ? { routeAccountId: acc } : {}), ...(typeof body.online === 'boolean' ? { online: body.online } : {}) })
      } catch (e: any) { res.status(502).json({ error: e?.message || 'gateway update failed' }) }
    })

  return r
}
