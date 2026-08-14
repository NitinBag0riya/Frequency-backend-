/**
 * Tenant lifecycle state machine (Naruto Platform OS §4).
 *
 *   lead → provisioned → configuring → ready_to_launch → live → healthy ⇄ at_risk
 *        → dormant → churned          ↘ suspended (manual / payment / abuse)
 *
 * Every tenant sits in exactly ONE state. `computeLifecycleState` is a PURE
 * function of a small, explicit `LifecycleSignals` bag — no DB, no clock coupling
 * (inject `now` in tests) — so the same logic runs in the nightly recompute, an
 * on-event hook, or a unit self-check with identical results.
 *
 * The DB side (gatherSignals / recompute*) reads the signals off the existing
 * rails (tenants, tenant_subscriptions, tenant_branding, aggregator_orders) and
 * persists `tenants.lifecycle_state` + `tenants.state_entered_at` — the pair the
 * tenant list renders as state + time-in-state. Persisted only when the state
 * actually changes, so `state_entered_at` is a true "since" timestamp.
 */

import type { SupabaseClient } from '@supabase/supabase-js'

export const LIFECYCLE_STATES = [
  'lead',
  'provisioned',
  'configuring',
  'ready_to_launch',
  'live',
  'healthy',
  'at_risk',
  'dormant',
  'churned',
  'suspended',
] as const

export type LifecycleState = typeof LIFECYCLE_STATES[number]

export interface LifecycleSignals {
  /** Manual / payment / abuse suspension — overrides every other signal. */
  suspended: boolean
  /** Workspace actually exists (owner + slug). A bare CRM lead is not provisioned. */
  provisioned: boolean
  /** Go-live setup progress, 0..1 (checklist fraction; proxy until §8 lands). */
  setupCompleteness: number
  /** Go-live checklist 100% green (blocking items done). */
  goLiveReady: boolean
  /** First REAL order timestamp (ISO) — the launch marker. Null = never launched. */
  firstOrderAt: string | null
  /** Latest of last-login and last-order (ISO). Drives dormant/churn. */
  lastActivityAt: string | null
  recentOrders30d: number
  gmv30d: number
  /** GMV in the 30–60d window, to detect a decline. */
  gmvPrev30d: number
  /** Subscription past_due / unpaid, or a trial that has expired. */
  paymentPastDue: boolean
  /** Injectable clock for deterministic tests. Defaults to Date.now(). */
  now?: string | number | Date
}

const DAY = 86_400_000
// A just-launched tenant reads as `live`; after this it graduates to healthy/at_risk.
export const LIVE_GRACE_DAYS = 7
export const DORMANT_DAYS = 30
export const CHURN_DAYS = 60
// GMV halving (vs the prior 30d window) flips a launched tenant to at_risk.
export const AT_RISK_GMV_DROP = 0.5

/**
 * Decide the single lifecycle state from the signals. Precedence is deliberate:
 * suspension → provisioning → (launched: churn/dormant/risk/live/healthy)
 * → (pre-launch: ready/configuring/provisioned).
 */
export function computeLifecycleState(s: LifecycleSignals): LifecycleState {
  const now = s.now != null ? new Date(s.now).getTime() : Date.now()
  const daysSince = (iso: string | null) =>
    iso ? (now - new Date(iso).getTime()) / DAY : Infinity

  // Suspension is orthogonal and wins outright (spec §4).
  if (s.suspended) return 'suspended'

  // A record that isn't provisioned yet is a lead.
  if (!s.provisioned) return 'lead'

  const launched = !!s.firstOrderAt
  if (launched) {
    const idle = daysSince(s.lastActivityAt)
    if (idle >= CHURN_DAYS) return 'churned'
    if (idle >= DORMANT_DAYS) return 'dormant'

    const declined = s.gmvPrev30d > 0 && s.gmv30d <= s.gmvPrev30d * (1 - AT_RISK_GMV_DROP)
    if (s.paymentPastDue || declined || s.recentOrders30d === 0) return 'at_risk'

    // Fresh launch reads as `live`; established, still-active reads as `healthy`.
    if (daysSince(s.firstOrderAt) < LIVE_GRACE_DAYS) return 'live'
    return 'healthy'
  }

  // Never launched — where are they in setup?
  if (s.goLiveReady) return 'ready_to_launch'
  if (s.setupCompleteness > 0) return 'configuring'
  return 'provisioned'
}

// ─────────────────────────────────────────────────────────────────────────────
// DB side — signal gathering + persistence. Kept in this file so the pure
// function and its only production caller can't drift apart.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Read the lifecycle signals for one tenant off the existing dashboard-DB rails.
 * Best-effort per source: a missing/erroring source degrades to a zero signal
 * rather than throwing, so a recompute never fails on one bad read.
 *
 * ponytail: order signals come from `aggregator_orders` only (the order table in
 * THIS db). Storefront orders live in storefront-api's db. Ceiling: a
 * storefront-only tenant under-counts GMV/first-order. Upgrade path: union the
 * storefront order feed here (or a materialized cross-source orders view) when
 * one exists — the pure function already consumes the unified numbers.
 * setupCompleteness/goLiveReady are a 3-signal proxy until the §8 go-live
 * checklist can feed real values.
 */
export async function gatherSignals(
  supabase: SupabaseClient,
  tenantId: string,
): Promise<LifecycleSignals | null> {
  const now = Date.now()
  const iso30 = new Date(now - 30 * DAY).toISOString()
  const iso60 = new Date(now - 60 * DAY).toISOString()

  const { data: tenant } = await supabase
    .from('tenants')
    .select('id, status, slug, business_type, last_active_at, created_at')
    .eq('id', tenantId)
    .maybeSingle()
  if (!tenant) return null
  const t = tenant as any

  const [{ data: sub }, { data: branding }, { data: firstOrder }, { data: recentOrders }] =
    await Promise.all([
      supabase.from('tenant_subscriptions')
        .select('status, trial_ends_at, current_period_end')
        .eq('tenant_id', tenantId).maybeSingle(),
      supabase.from('tenant_branding')
        .select('tenant_id').eq('tenant_id', tenantId).maybeSingle(),
      supabase.from('aggregator_orders')
        .select('placed_at, created_at')
        .eq('tenant_id', tenantId)
        .order('created_at', { ascending: true }).limit(1).maybeSingle(),
      supabase.from('aggregator_orders')
        .select('gross_amount, placed_at, created_at')
        .eq('tenant_id', tenantId)
        .gte('created_at', iso60),
    ])

  const orders = (recentOrders ?? []) as any[]
  const at = (o: any) => new Date(o.placed_at ?? o.created_at).getTime()
  let recentOrders30d = 0
  let gmv30d = 0
  let gmvPrev30d = 0
  let lastOrderAt = 0
  for (const o of orders) {
    const ts = at(o)
    const amt = Number(o.gross_amount) || 0
    if (ts > lastOrderAt) lastOrderAt = ts
    if (ts >= now - 30 * DAY) { recentOrders30d++; gmv30d += amt }
    else if (ts >= now - 60 * DAY) { gmvPrev30d += amt }
  }

  const fo = firstOrder as any
  const firstOrderAt = fo ? (fo.placed_at ?? fo.created_at) : null

  // lastActivity = latest of last-login and most-recent order.
  const lastLogin = t.last_active_at ? new Date(t.last_active_at).getTime() : 0
  const lastActivityMs = Math.max(lastLogin, lastOrderAt)
  const lastActivityAt = lastActivityMs > 0 ? new Date(lastActivityMs).toISOString() : t.created_at ?? null

  const subRow = sub as any
  const trialExpired = !!subRow?.trial_ends_at &&
    subRow?.status === 'trialing' &&
    new Date(subRow.trial_ends_at).getTime() < now
  const paymentPastDue = ['past_due', 'unpaid', 'canceled'].includes(String(subRow?.status)) || trialExpired

  // Proxy setup completeness from the three reliably-present dashboard signals.
  const setupSteps = [!!t.business_type, !!branding, !!subRow]
  const setupCompleteness = setupSteps.filter(Boolean).length / setupSteps.length

  return {
    suspended: t.status === 'suspended',
    provisioned: !!t.slug,
    setupCompleteness,
    goLiveReady: setupCompleteness >= 1,
    firstOrderAt,
    lastActivityAt,
    recentOrders30d,
    gmv30d,
    gmvPrev30d,
    paymentPastDue,
    now,
  }
}

export interface RecomputeResult {
  tenantId: string
  state: LifecycleState
  previous: LifecycleState | null
  changed: boolean
  stateEnteredAt: string
}

/**
 * Recompute one tenant's lifecycle and persist it IF it changed. `state_entered_at`
 * is only bumped on an actual transition, so time-in-state stays truthful. Returns
 * null if the tenant doesn't exist.
 */
export async function recomputeTenantLifecycle(
  supabase: SupabaseClient,
  tenantId: string,
): Promise<RecomputeResult | null> {
  const signals = await gatherSignals(supabase, tenantId)
  if (!signals) return null

  const { data: current } = await supabase
    .from('tenants')
    .select('lifecycle_state, state_entered_at')
    .eq('id', tenantId)
    .maybeSingle()
  const previous = ((current as any)?.lifecycle_state ?? null) as LifecycleState | null
  const state = computeLifecycleState(signals)

  if (state === previous) {
    return {
      tenantId, state, previous, changed: false,
      stateEnteredAt: (current as any)?.state_entered_at ?? new Date().toISOString(),
    }
  }

  const stateEnteredAt = new Date().toISOString()
  const { error } = await supabase
    .from('tenants')
    .update({ lifecycle_state: state, state_entered_at: stateEnteredAt })
    .eq('id', tenantId)
  if (error) throw new Error(`lifecycle persist failed: ${error.message}`)

  return { tenantId, state, previous, changed: true, stateEnteredAt }
}

/**
 * Nightly recompute across all non-deleted tenants (spec §4: "computed nightly").
 * Sequential + best-effort: one tenant's failure is logged, never aborts the run.
 *
 * WIRE(naruto): register this as the nightly cron. In flowgpt-server/src/queue.ts
 * add a repeatable `system.cron` job (the existing singleton poller pattern,
 * ~queue.ts:304) that calls recomputeAllTenants(supabase) once/day. No new
 * always-on worker — reuse the existing cron queue.
 *
 * ponytail: unpaginated id scan + per-tenant loop. Ceiling: fine to a few
 * thousand tenants; page the id fetch and/or batch with p-limit if it grows.
 */
export async function recomputeAllTenants(
  supabase: SupabaseClient,
): Promise<{ scanned: number; changed: number }> {
  const { data, error } = await supabase
    .from('tenants')
    .select('id')
    .neq('status', 'deleted')
  if (error) throw new Error(`tenant scan failed: ${error.message}`)

  let changed = 0
  for (const row of (data ?? []) as any[]) {
    try {
      const res = await recomputeTenantLifecycle(supabase, row.id)
      if (res?.changed) changed++
    } catch (e: any) {
      console.error(`[tenant-lifecycle] recompute failed tenant=${row.id}:`, e?.message ?? e)
    }
  }
  return { scanned: (data ?? []).length, changed }
}
