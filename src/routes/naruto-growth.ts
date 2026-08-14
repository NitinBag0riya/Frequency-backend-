/**
 * naruto-growth — the platform (/naruto §12) "Growth analytics" backend: one
 * cross-tenant view of how the PLATFORM (not one merchant) is growing.
 *
 * REUSE, DON'T REFETCH. Everything here is composed from aggregates the earlier
 * waves already own — it never recomputes the raw feeds:
 *   • wave-2 lifecycle (tenants.lifecycle_state / state_entered_at) → the funnel,
 *     cohort survival, logo/revenue churn, and the at-risk SET are read straight
 *     off the persisted state. The state machine already decided "who is at_risk";
 *     we only enrich each candidate with WHY + a suggested intervention.
 *   • wave-3 revenue (storefront-api /admin/platform/transactions) → GMV /
 *     commission per tenant, take-rate, unit economics. Same raw source the
 *     Payments router uses; the money facts are summed here, no PSP re-derivation.
 *   • wave-4 limits (lib/plan-limits.resolveTenantLimits) → the expansion queue's
 *     "≥80% of a hard cap" detector. Not recomputed — the enforced resolver is
 *     the single source of usage vs cap.
 *
 * Two endpoints (both requireAuth + payments.read — growth surfaces money, and
 * payments.read is granted to owner/admin/finance/readonly; no new capability):
 *   GET /api/super-admin/growth/analytics    funnel · cohorts · churn/NRR ·
 *                                             unit-econ · vertical comparison ·
 *                                             at-risk queue                (fast)
 *   GET /api/super-admin/growth/expansion     upsell-candidate queue — the
 *                                             per-tenant limit scan lives here so
 *                                             it can be lazy-loaded, keeping the
 *                                             main dashboard snappy.
 *
 * All pure funnel/cohort/churn math is side-effect-free and self-checked in
 * naruto-growth.selfcheck.ts, so the numbers are defined in one testable place.
 *
 * WIRE(naruto): register in index.ts next to the other naruto routers (below
 *   createNarutoPlansRouter, ABOVE the catch-all 404):
 *     import { createNarutoGrowthRouter } from './routes/naruto-growth'
 *     app.use(createNarutoGrowthRouter({ supabase, requireAuth }))
 */
import express from 'express'
import type { SupabaseClient } from '@supabase/supabase-js'
import { requirePlatformCapability } from '../lib/platform-guard.js'
import { resolveTenantLimits } from '../lib/plan-limits.js'

type Mw = (req: express.Request, res: express.Response, next: express.NextFunction) => void | Promise<void>
interface Deps { supabase: SupabaseClient; requireAuth: Mw }

// storefront-api cross-tenant money feed (same as naruto-payments; the capability
// guard upstream is what authorizes the caller, so no per-tenant secret leaks).
const SF_API = process.env.STOREFRONT_API_URL || 'http://localhost:5181'
const SF_SECRET = process.env.STOREFRONT_ADMIN_SECRET || 'dev-admin'
const DAY = 86_400_000
const PLATFORM_FEE_EST_PCT = 0.01   // platform take used ONLY when a Route split wasn't recorded

// Tier ladder (mirror of naruto-plans TIER_ORDER — suggested-plan uses "next up").
const TIER_ORDER = ['free', 'starter', 'growth', 'scale', 'enterprise'] as const

// ── Lifecycle bucketing (the persisted wave-2 state is the single input) ──────
// signup ⊇ activated ⊇ live ⊇ retained. `suspended` masks a tenant's prior state,
// so it counts only toward signup (documented ceiling).
const ACTIVE_LAUNCHED = new Set(['live', 'healthy', 'at_risk'])           // launched & still a customer
const LAUNCHED = new Set(['live', 'healthy', 'at_risk', 'dormant', 'churned'])
const NOT_ACTIVATED = new Set(['lead', 'provisioned'])                    // never got past bare provisioning
const AT_RISK_STATES = new Set(['at_risk', 'dormant'])                    // wave-2's own at-risk set
const RETAINED_STATES = ACTIVE_LAUNCHED                                   // launched AND not lost

// ── Types (mirror src/lib/naruto-growth.ts on the FE) ─────────────────────────
export interface TenantRow {
  id: string; slug: string | null; name: string; vertical: string
  status: string; state: string; stateEnteredAt: string | null
  createdAt: string | null; lastActiveAt: string | null
  planId: string | null; subStatus: string | null
}
export interface FunnelStages { signup: number; activated: number; live: number; retained: number }
export interface CohortRow {
  month: string; size: number
  r30: number; r60: number; r90: number          // survival rate 0..1 (null-safe → 0)
  elig30: number; elig60: number; elig90: number  // cohort members old enough to be measured
}
export interface GmvBucket { total: number; commission: number; last30: number; prev30: number; commission30: number }

const round2 = (n: number) => Math.round(n * 100) / 100
const pct = (num: number, den: number) => (den > 0 ? round2((num / den) * 100) : 0)

// ── Pure: funnel from lifecycle states ────────────────────────────────────────
export function funnelOf(rows: TenantRow[]): FunnelStages {
  let signup = 0, activated = 0, live = 0, retained = 0
  for (const r of rows) {
    signup++
    if (r.state === 'suspended') continue           // masked — signup only
    if (!NOT_ACTIVATED.has(r.state)) activated++
    if (LAUNCHED.has(r.state)) live++
    if (RETAINED_STATES.has(r.state)) retained++
  }
  return { signup, activated, live, retained }
}

function groupFunnel(rows: TenantRow[], keyOf: (r: TenantRow) => string): Record<string, FunnelStages> {
  const buckets = new Map<string, TenantRow[]>()
  for (const r of rows) {
    const k = keyOf(r) || 'unknown'
    ;(buckets.get(k) ?? buckets.set(k, []).get(k)!).push(r)
  }
  const out: Record<string, FunnelStages> = {}
  for (const [k, rs] of buckets) out[k] = funnelOf(rs)
  return out
}

// ── Pure: cohort survival by signup month ─────────────────────────────────────
// We only have CURRENT state (no historical snapshots), so this is survivorship-
// to-today: of a signup-month cohort old enough to be measured at N days, the
// share still a customer (state ∉ churned/dormant/suspended). Documented ceiling —
// upgrade to true point-in-time retention needs a daily lifecycle_state snapshot.
export function cohortsOf(rows: TenantRow[], now = Date.now()): CohortRow[] {
  const byMonth = new Map<string, TenantRow[]>()
  for (const r of rows) {
    if (!r.createdAt) continue
    const d = new Date(r.createdAt)
    if (Number.isNaN(d.getTime())) continue
    const m = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`
    ;(byMonth.get(m) ?? byMonth.set(m, []).get(m)!).push(r)
  }
  const survived = (r: TenantRow) => !['churned', 'dormant', 'suspended', 'lead'].includes(r.state)
  const rows_: CohortRow[] = []
  for (const [month, rs] of byMonth) {
    const ageDays = (r: TenantRow) => (now - new Date(r.createdAt!).getTime()) / DAY
    const at = (days: number) => {
      const elig = rs.filter(r => ageDays(r) >= days)
      const kept = elig.filter(survived).length
      return { elig: elig.length, rate: elig.length ? kept / elig.length : 0 }
    }
    const a30 = at(30), a60 = at(60), a90 = at(90)
    rows_.push({
      month, size: rs.length,
      r30: round2(a30.rate), r60: round2(a60.rate), r90: round2(a90.rate),
      elig30: a30.elig, elig60: a60.elig, elig90: a90.elig,
    })
  }
  return rows_.sort((a, b) => a.month.localeCompare(b.month))
}

// ── Pure: logo & revenue churn + NRR over a trailing window ───────────────────
// churnedLogos = tenants whose state flipped to `churned` inside the window.
// base = those + the currently-active launched set (a proxy for "active at window
// start"). MRR is the tenant's plan price while the sub is non-cancelled.
//
// EXPANSION/CONTRACTION need a subscription-CHANGE event log, which doesn't exist
// yet — so both are 0 and NRR currently equals GRR (gross revenue retention). This
// is called out in the payload (`nrrIsGrr: true`) and the UI. Upgrade path: emit a
// plan_change event (old_plan, new_plan, mrr_delta, at) and sum deltas in-window.
export function churnNrr(
  rows: TenantRow[], mrrOf: (r: TenantRow) => number, now = Date.now(), windowDays = 30,
): {
  logoChurnPct: number; revenueChurnPct: number; nrrPct: number; nrrIsGrr: boolean
  churnedLogos: number; baseLogos: number; mrrStart: number; mrrChurned: number
  mrrExpansion: number; mrrContraction: number; windowDays: number
} {
  const cutoff = now - windowDays * DAY
  const churned = rows.filter(r =>
    r.state === 'churned' && r.stateEnteredAt != null && new Date(r.stateEnteredAt).getTime() >= cutoff)
  const activeLaunched = rows.filter(r => ACTIVE_LAUNCHED.has(r.state))

  const churnedLogos = churned.length
  const baseLogos = churnedLogos + activeLaunched.length
  const mrrChurned = round2(churned.reduce((s, r) => s + mrrOf(r), 0))
  const mrrStart = round2(mrrChurned + activeLaunched.reduce((s, r) => s + mrrOf(r), 0))
  const mrrExpansion = 0, mrrContraction = 0   // no plan-change log yet (ceiling above)

  return {
    logoChurnPct: pct(churnedLogos, baseLogos),
    revenueChurnPct: pct(mrrChurned, mrrStart),
    nrrPct: mrrStart > 0 ? round2(((mrrStart - mrrChurned + mrrExpansion - mrrContraction) / mrrStart) * 100) : 0,
    nrrIsGrr: true,
    churnedLogos, baseLogos, mrrStart, mrrChurned, mrrExpansion, mrrContraction, windowDays,
  }
}

// ── DB adapters (impure) ──────────────────────────────────────────────────────
async function loadTenants(supabase: SupabaseClient): Promise<TenantRow[]> {
  const { data } = await supabase.from('tenants')
    .select('id, slug, business_name, business_type, status, created_at, lifecycle_state, state_entered_at, last_active_at, tenant_subscriptions ( plan_id, status )')
    .neq('status', 'deleted')
  return ((data ?? []) as any[]).map(t => {
    const sub = Array.isArray(t.tenant_subscriptions) ? t.tenant_subscriptions[0] : t.tenant_subscriptions
    return {
      id: t.id, slug: t.slug, name: t.business_name ?? t.slug ?? t.id,
      vertical: t.business_type ?? 'other', status: t.status ?? 'active',
      state: t.lifecycle_state ?? 'lead', stateEnteredAt: t.state_entered_at ?? null,
      createdAt: t.created_at ?? null, lastActiveAt: t.last_active_at ?? null,
      planId: sub?.plan_id ?? null, subStatus: sub?.status ?? null,
    }
  })
}

// plan_id → { price, tier } for MRR + suggested-plan. One query.
async function loadPlans(supabase: SupabaseClient): Promise<Map<string, { price: number; tier: string; name: string }>> {
  const { data } = await supabase.from('plans').select('id, name, tier, monthly_price_inr').eq('scope', 'tenant')
  const m = new Map<string, { price: number; tier: string; name: string }>()
  for (const p of (data ?? []) as any[]) {
    m.set(p.id, { price: Number(p.monthly_price_inr ?? 0), tier: p.tier ?? p.id, name: p.name ?? p.id })
  }
  return m
}

// storefront-api all-time money facts, bucketed per tenant (slug-keyed, lowercased
// to match tenant slugs). Commission prefers the actual Route split; falls back to
// a 1% estimate only when a prepaid order recorded no split.
async function loadGmvBySlug(): Promise<Map<string, GmvBucket>> {
  const out = new Map<string, GmvBucket>()
  let rows: any[] = []
  try {
    const r = await fetch(`${SF_API}/admin/platform/transactions`, { headers: { 'X-Admin-Secret': SF_SECRET } })
    if (r.ok) { const j: any = await r.json(); rows = Array.isArray(j?.rows) ? j.rows : [] }
  } catch { /* storefront-api down → empty money, page still renders lifecycle */ }

  const now = Date.now()
  for (const o of rows) {
    const slug = String(o.slug ?? '').toLowerCase()
    if (!slug) continue
    const gross = Math.max(0, Number(o.gross) || 0)
    const ts = Number(o.paidAt ?? o.createdAt) || 0
    const commission = o.platformFeePaise != null ? Number(o.platformFeePaise) / 100
      : (o.method === 'prepaid' && o.gateway ? round2(gross * PLATFORM_FEE_EST_PCT) : 0)
    const b = out.get(slug) ?? { total: 0, commission: 0, last30: 0, prev30: 0, commission30: 0 }
    b.total += gross; b.commission += commission
    if (ts >= now - 30 * DAY) { b.last30 += gross; b.commission30 += commission }
    else if (ts >= now - 60 * DAY) { b.prev30 += gross }
    out.set(slug, b)
  }
  return out
}

export function createNarutoGrowthRouter({ supabase, requireAuth }: Deps): express.Router {
  const r = express.Router()

  // ── 1. Growth dashboard (funnel · cohorts · churn/NRR · unit-econ · verticals · at-risk) ──
  r.get('/api/super-admin/growth/analytics',
    requireAuth, requirePlatformCapability(supabase, 'payments.read'),
    async (req, res) => {
      try {
        const now = Date.now()
        const windowDays = Math.min(180, Math.max(7, parseInt(String(req.query.windowDays ?? '30'), 10) || 30))
        const [tenants, plans, gmv] = await Promise.all([loadTenants(supabase), loadPlans(supabase), loadGmvBySlug()])

        const mrrOf = (t: TenantRow) =>
          t.planId && !['canceled', 'cancelled'].includes(String(t.subStatus)) ? (plans.get(t.planId)?.price ?? 0) : 0
        const gmvOf = (t: TenantRow): GmvBucket =>
          (t.slug && gmv.get(t.slug.toLowerCase())) || { total: 0, commission: 0, last30: 0, prev30: 0, commission30: 0 }

        // Totals
        const gmvWindow = tenants.reduce((s, t) => s + gmvOf(t).total, 0)
        const commissionWindow = tenants.reduce((s, t) => s + gmvOf(t).commission, 0)
        const commission30 = tenants.reduce((s, t) => s + gmvOf(t).commission30, 0)
        const activeTenants = tenants.filter(t => ACTIVE_LAUNCHED.has(t.state)).length
        const mrrTotal = round2(tenants.reduce((s, t) => s + mrrOf(t), 0))

        // New-vs-churned movement over the window (logo dynamics).
        const winCutoff = now - windowDays * DAY
        const newLogos = tenants.filter(t => t.createdAt != null && new Date(t.createdAt).getTime() >= winCutoff).length
        const churnData = churnNrr(tenants, mrrOf, now, windowDays)

        // Funnel
        const funnel = {
          overall: funnelOf(tenants),
          byVertical: groupFunnel(tenants, t => t.vertical),
          byPlan: groupFunnel(tenants, t => plans.get(t.planId ?? '')?.tier ?? 'none'),
        }

        // Support-actions (unit economics) — one count over the window.
        const { count: supportActions } = await supabase.from('super_admin_audit')
          .select('id', { count: 'exact', head: true })
          .ilike('capability', 'support%')
          .gte('created_at', new Date(now - windowDays * DAY).toISOString())

        // Vertical comparison — the roadmap-deciding view.
        const verticalKeys = [...new Set(tenants.map(t => t.vertical))]
        const verticalComparison = verticalKeys.map(v => {
          const rs = tenants.filter(t => t.vertical === v)
          const f = funnelOf(rs)
          const vGmv = rs.reduce((s, t) => s + gmvOf(t).total, 0)
          const vComm = rs.reduce((s, t) => s + gmvOf(t).commission, 0)
          const vMrr = round2(rs.reduce((s, t) => s + mrrOf(t), 0))
          return {
            vertical: v, tenants: rs.length, live: f.live,
            gmvPerTenant: round2(vGmv / Math.max(1, f.live)),
            retentionPct: pct(f.retained, f.live),
            activationPct: pct(f.activated, f.signup),
            takeRatePct: vGmv > 0 ? round2((vComm / vGmv) * 100) : 0,
            mrr: vMrr,
          }
        }).sort((a, b) => b.gmvPerTenant - a.gmvPerTenant)

        // At-risk queue — reuse wave-2's at_risk/dormant SET, enrich with reason.
        const atRiskCandidates = tenants.filter(t => AT_RISK_STATES.has(t.state))
        const atRiskIds = atRiskCandidates.map(t => t.id)
        let complaintsByTenant = new Map<string, number>()
        let dlqByTenant = new Map<string, number>()
        if (atRiskIds.length) {
          const since = new Date(now - 30 * DAY).toISOString()
          const [{ data: comps }, { data: dlq }] = await Promise.all([
            supabase.from('complaints').select('tenant_id').in('tenant_id', atRiskIds).gte('created_at', since),
            supabase.from('webhook_dead_letter').select('tenant_id, replayed_at')
              .in('tenant_id', atRiskIds).in('source', ['razorpay', 'cashfree', 'payment']).is('replayed_at', null),
          ])
          for (const c of (comps ?? []) as any[]) complaintsByTenant.set(c.tenant_id, (complaintsByTenant.get(c.tenant_id) ?? 0) + 1)
          for (const d of (dlq ?? []) as any[]) dlqByTenant.set(d.tenant_id, (dlqByTenant.get(d.tenant_id) ?? 0) + 1)
        }
        const atRisk = atRiskCandidates.map(t => {
          const g = gmvOf(t)
          const declinePct = g.prev30 > 0 ? round2(((g.last30 - g.prev30) / g.prev30) * 100) : 0
          const loginGapDays = t.lastActiveAt ? Math.floor((now - new Date(t.lastActiveAt).getTime()) / DAY) : null
          const complaints = complaintsByTenant.get(t.id) ?? 0
          const paymentFails = dlqByTenant.get(t.id) ?? 0
          const pastDue = ['past_due', 'unpaid', 'canceled', 'cancelled'].includes(String(t.subStatus))
          // Dominant reason → intervention (priority: money > usage > engagement).
          let reason = 'Inactive — no recent orders', intervention = 'Re-onboarding call: check integrations & re-issue QR'
          if (pastDue || paymentFails > 0) { reason = pastDue ? 'Payment past due' : `${paymentFails} payment webhook failures`; intervention = 'Payments health check + dunning; confirm Route/KYC' }
          else if (g.prev30 > 0 && declinePct <= -50) { reason = `GMV down ${Math.abs(declinePct)}% MoM`; intervention = 'Success call: promos, menu freshness, aggregator sync' }
          else if (loginGapDays != null && loginGapDays >= 14) { reason = `No login for ${loginGapDays}d`; intervention = 'Nudge sequence + operator check-in' }
          else if (complaints >= 3) { reason = `${complaints} complaints in 30d`; intervention = 'Ops review: prep time, cancellations, ratings' }
          return {
            id: t.id, slug: t.slug, name: t.name, vertical: t.vertical, state: t.state,
            stateEnteredAt: t.stateEnteredAt, gmv30: round2(g.last30), declinePct,
            loginGapDays, complaints, paymentFails, mrrAtRisk: round2(mrrOf(t)),
            reason, intervention,
          }
        }).sort((a, b) => b.mrrAtRisk - a.mrrAtRisk || (a.declinePct - b.declinePct))

        res.json({
          generatedAt: new Date(now).toISOString(),
          windowDays,
          totals: {
            tenants: tenants.length,
            live: funnel.overall.live,
            activated: funnel.overall.activated,
            retained: funnel.overall.retained,
            activeTenants,
            mrr: mrrTotal,
            gmv: round2(gmvWindow),
            commission: round2(commissionWindow),
          },
          funnel,
          movement: { newLogos, churnedLogos: churnData.churnedLogos, netLogos: newLogos - churnData.churnedLogos, windowDays },
          cohorts: cohortsOf(tenants, now),
          churn: churnData,
          unitEconomics: {
            activeTenants,
            supportActions: supportActions ?? 0,
            supportActionsPerTenant: activeTenants ? round2((supportActions ?? 0) / activeTenants) : 0,
            revenuePerTenant: activeTenants ? round2(commission30 / activeTenants) : 0,   // monthly commission ÷ active tenant
            takeRatePct: gmvWindow > 0 ? round2((commissionWindow / gmvWindow) * 100) : 0,
          },
          verticalComparison,
          atRisk,
        })
      } catch (e: any) { res.status(500).json({ error: e?.message || 'growth analytics unavailable' }) }
    })

  // ── 2. Expansion-signals queue (upsell candidates) — bounded per-tenant limit scan ──
  // Candidates = the expandable set (live/healthy). Signals:
  //   • usage ≥ 80% of a HARD cap (wave-4 resolveTenantLimits — the enforced path)
  //   • GMV growth ≥ +50% MoM
  // "Heavy beta-feature use" is a documented gap: there is no per-feature usage
  // telemetry to read, so it's omitted rather than faked. Suggested plan = next
  // tier up the ladder from the tenant's current plan.
  r.get('/api/super-admin/growth/expansion',
    requireAuth, requirePlatformCapability(supabase, 'payments.read'),
    async (req, res) => {
      try {
        const limitScan = Math.min(80, Math.max(1, parseInt(String(req.query.limit ?? '40'), 10) || 40))
        const [tenants, plans, gmv] = await Promise.all([loadTenants(supabase), loadPlans(supabase), loadGmvBySlug()])
        const gmvOf = (t: TenantRow): GmvBucket =>
          (t.slug && gmv.get(t.slug.toLowerCase())) || { total: 0, commission: 0, last30: 0, prev30: 0, commission30: 0 }

        // Bound the scan: top expandable tenants by recent GMV (the ones worth upselling).
        const candidates = tenants
          .filter(t => (t.state === 'live' || t.state === 'healthy'))
          .sort((a, b) => gmvOf(b).last30 - gmvOf(a).last30)
          .slice(0, limitScan)

        // ponytail: sequential resolveTenantLimits (each a few queries). Ceiling: fine
        // to ~80 candidates; add p-limit concurrency or a nightly materialized
        // usage-vs-cap table if the scan gets slow.
        const rows: any[] = []
        for (const t of candidates) {
          const g = gmvOf(t)
          const growthPct = g.prev30 > 0 ? round2(((g.last30 - g.prev30) / g.prev30) * 100) : (g.last30 > 0 ? 100 : 0)
          let nearLimits: { key: string; label: string; usage: number; hard: number; pct: number }[] = []
          try {
            const lim = await resolveTenantLimits(supabase, t.id)
            nearLimits = lim.limits
              .filter(l => l.hard > 0 && l.usage != null && l.usage / l.hard >= 0.8)
              .map(l => ({ key: l.key, label: l.label, usage: l.usage!, hard: l.hard, pct: round2((l.usage! / l.hard) * 100) }))
              .sort((a, b) => b.pct - a.pct)
          } catch { /* limit read failed for this tenant → treat as no near-limit signal */ }

          const fastGrowth = growthPct >= 50 && g.last30 > 0
          if (!nearLimits.length && !fastGrowth) continue

          const curTier = plans.get(t.planId ?? '')?.tier ?? 'free'
          const idx = TIER_ORDER.indexOf(curTier as any)
          const suggestedPlan = idx >= 0 && idx < TIER_ORDER.length - 1 ? TIER_ORDER[idx + 1] : null

          const signals: string[] = [
            ...nearLimits.map(l => `${l.label} at ${l.pct}% of cap`),
            ...(fastGrowth ? [`GMV +${growthPct}% MoM`] : []),
          ]
          rows.push({
            id: t.id, slug: t.slug, name: t.name, vertical: t.vertical, state: t.state,
            currentPlan: plans.get(t.planId ?? '')?.name ?? t.planId ?? 'none', currentTier: curTier,
            suggestedPlan, gmv30: round2(g.last30), growthPct,
            nearLimits, signals,
            score: nearLimits.length * 2 + (fastGrowth ? 1 : 0) + (nearLimits[0]?.pct ?? 0) / 100,
          })
        }
        rows.sort((a, b) => b.score - a.score)
        res.json({ data: rows, scanned: candidates.length, betaUsageAvailable: false })
      } catch (e: any) { res.status(500).json({ error: e?.message || 'expansion queue unavailable' }) }
    })

  return r
}
