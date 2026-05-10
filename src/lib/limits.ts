/**
 * Plan-limit enforcement.
 *
 * Routes that mutate billable resources call `checkLimit(supabase, tenantId,
 * metric)` BEFORE the insert. If the tenant is at or over the cap, the route
 * returns 402 Payment Required with a clear "Upgrade to <next-tier>" message.
 *
 * Without this, a Free-tier tenant could send unlimited messages, create
 * unlimited workflows, etc. — the FE BillingPage shows usage bars but the
 * actual writes were unprotected.
 *
 * Counts are computed live from canonical tables (same approach as
 * /api/billing/usage). The unwritten `usage_counters` table from migration
 * 021 stays unused — when a counter-writer worker exists this can switch to
 * cached reads.
 *
 * Convention for plan.limits jsonb (mirrors PRICING_SPEC + migration 017):
 *   - missing key  → unlimited (no cap)
 *   - -1           → unlimited (explicit Enterprise sentinel)
 *   - 0            → blocked entirely
 *   - >0           → finite cap
 */

import type { SupabaseClient } from '@supabase/supabase-js'

export type LimitMetric =
  | 'contacts_max'
  | 'messages_per_month'
  | 'workflows_max'
  | 'broadcasts_per_day'
  | 'team_size_max'
  | 'ai_tokens_per_month'
  /**
   * Per-tenant AI cost cap in WHOLE DOLLARS per IST month. The hard
   * margin firewall — protects Frequency from a workflow looping AI
   * calls that would otherwise blow past the token cap's dollar cost
   * (Sonnet output is 15× pricier than Haiku input, so the same token
   * count means anywhere from $1 to $75 in real Anthropic spend).
   * lib/ai-usage.ts:recordAiUsage writes the cents counter at every
   * call; this cap reads it via getAiDollarsThisMonth.
   */
  | 'ai_dollars_per_month'

export interface LimitCheck {
  allowed: boolean
  current: number
  max:     number  // -1 = unlimited (already grouped with allowed:true here)
  reason?: string
  upgrade_to?: string  // next tier name; FE can build the upgrade CTA
}

/**
 * Returns whether the tenant can perform one more action of `metric`. Cheap
 * (one count query + one plan lookup), safe to call inline before every
 * mutation.
 */
export async function checkLimit(
  supabase: SupabaseClient,
  tenantId: string,
  metric: LimitMetric,
): Promise<LimitCheck> {
  // 1. Resolve current plan + limits. The tenant_subscriptions row is the
  // source of truth; falls back to 'free' if no row (brand-new tenant).
  const { data: sub } = await supabase.from('tenant_subscriptions')
    .select('plan_id, status, current_period_end, plans(limits)')
    .eq('tenant_id', tenantId).maybeSingle()

  // PRICING_SPEC §3.4: 'cancelled' subscriptions keep their plan limits
  // until current_period_end (the user already paid for the period). After
  // the period ends, downgrade to free. 'past_due' is a separate state where
  // payment failed — also downgrade so the tenant feels the consequence.
  const cancelledButStillPaid =
    sub?.status === 'cancelled' &&
    !!sub.current_period_end &&
    new Date(sub.current_period_end).getTime() > Date.now()
  const grantsAccess = sub?.status === 'active' || sub?.status === 'trial' || cancelledButStillPaid

  // Plan limits: prefer the joined plan row, fall back to free, fall back
  // to a hardcoded fail-closed defaults dict if both lookups return empty.
  // The hardcoded fallback is a CRITICAL revenue safeguard — without it,
  // a botched migration that empties the plans table would silently disable
  // ALL enforcement (every metric would default to -1 = unlimited).
  const joinedPlanLimits = pickJoinedLimits((sub as any)?.plans)
  const planLimits: Record<string, number> = grantsAccess && Object.keys(joinedPlanLimits).length > 0
    ? joinedPlanLimits
    : await freeLimits(supabase)

  const max = Number(planLimits[metric] ?? -1)
  // -1 (or anything <0) = unlimited. Allow without counting.
  if (max < 0) return { allowed: true, current: 0, max: -1 }
  if (max === 0) {
    return {
      allowed: false, current: 0, max: 0,
      reason: `${prettyMetric(metric)} is not available on your plan`,
      upgrade_to: 'starter',
    }
  }

  // 2. Count current usage for this metric.
  const current = await countUsage(supabase, tenantId, metric)

  if (current >= max) {
    return {
      allowed: false, current, max,
      reason: `${prettyMetric(metric)} limit reached (${current} / ${max} on your plan)`,
      upgrade_to: nextTierForMetric(metric),
    }
  }
  return { allowed: true, current, max }
}

/**
 * Express convenience: call this at the top of a mutating route. Returns true
 * if the response was already sent (so the caller bails). Standardises the
 * 402 shape so the FE can show a consistent upgrade modal.
 */
export async function blockIfOverLimit(
  res: { status: (n: number) => { json: (b: any) => void } },
  supabase: SupabaseClient,
  tenantId: string,
  metric: LimitMetric,
): Promise<boolean> {
  const check = await checkLimit(supabase, tenantId, metric)
  if (!check.allowed) {
    res.status(402).json({
      error: check.reason,
      code: 'plan_limit_exceeded',
      metric, current: check.current, max: check.max, upgrade_to: check.upgrade_to,
    })
    return true
  }
  return false
}

// ─── Internals ────────────────────────────────────────────────────────────

/**
 * Hardcoded fail-closed defaults for the free tier. Used when the `plans`
 * table is missing the free row OR has a null `limits` jsonb (botched
 * migration / direct manual edit). Prefer this over fail-open because the
 * alternative is silently disabling ALL enforcement for unsubscribed
 * tenants — exactly the case where revenue protection matters most.
 *
 * Numbers mirror PRICING_SPEC §2.2 free tier (intentionally tight).
 */
const FAIL_CLOSED_FREE_DEFAULTS: Record<string, number> = {
  contacts_max:         100,
  messages_per_month:   100,
  workflows_max:        1,
  broadcasts_per_day:   1,
  team_size_max:        1,
  ai_tokens_per_month:  0,
  // Hardcoded $1/mo ceiling for the fail-closed Free tier — covers
  // typical experimental usage (a handful of parse-workflow calls)
  // without ever exposing Frequency to runaway AI cost on a misconfigured
  // plans table. Real Free tier in DB is $0.50; this is the SAFETY NET
  // when the DB read fails entirely.
  ai_dollars_per_month: 1,
}

/**
 * Supabase nested `select('…, plans(limits)')` returns `plans` as an OBJECT
 * for unambiguous one-to-one FKs but as an ARRAY for many-to-one. Defend
 * against both shapes — without this, `(sub as any).plans?.limits` reads
 * `undefined` from an array and falls through to free limits even on
 * paying tenants.
 */
function pickJoinedLimits(joined: any): Record<string, number> {
  if (!joined) return {}
  const row = Array.isArray(joined) ? joined[0] : joined
  return (row?.limits as Record<string, number> | undefined) ?? {}
}

async function freeLimits(supabase: SupabaseClient): Promise<Record<string, number>> {
  const { data } = await supabase.from('plans').select('limits').eq('id', 'free').maybeSingle()
  const dbLimits = (data?.limits as Record<string, number> | null | undefined) ?? null
  if (!dbLimits || Object.keys(dbLimits).length === 0) {
    // DB is misconfigured. Log loudly + use the hardcoded fallback so we
    // fail CLOSED (block at low limits) rather than fail OPEN (unlimited).
    console.warn('[limits] free plan limits missing from DB — using hardcoded fail-closed defaults')
    return FAIL_CLOSED_FREE_DEFAULTS
  }
  return dbLimits
}

async function countUsage(
  supabase: SupabaseClient,
  tenantId: string,
  metric: LimitMetric,
): Promise<number> {
  switch (metric) {
    case 'contacts_max': {
      const { count } = await supabase.from('contacts')
        .select('id', { count: 'exact', head: true })
        .eq('tenant_id', tenantId)
      return count ?? 0
    }
    case 'messages_per_month': {
      // IST month boundary — same logic as /api/billing/usage so the bars
      // and the limit-block agree on which messages count "this month".
      const IST_OFFSET_MIN = 5 * 60 + 30
      const nowIst = new Date(Date.now() + IST_OFFSET_MIN * 60_000)
      const monthStartUtcMs = Date.UTC(nowIst.getUTCFullYear(), nowIst.getUTCMonth(), 1) - IST_OFFSET_MIN * 60_000
      const monthStartIso = new Date(monthStartUtcMs).toISOString()
      const { count } = await supabase.from('messages')
        .select('id', { count: 'exact', head: true })
        .eq('tenant_id', tenantId)
        .gte('created_at', monthStartIso)
      return count ?? 0
    }
    case 'workflows_max': {
      // Counts only LIVE workflows — drafts/paused/archived don't count.
      // Matches the schema enum ('draft','live','paused','archived').
      const { count } = await supabase.from('workflows')
        .select('id', { count: 'exact', head: true })
        .eq('tenant_id', tenantId)
        .eq('status', 'live')
      return count ?? 0
    }
    case 'broadcasts_per_day': {
      // Last 24h rolling window (not calendar day) — matches user mental
      // model "I sent 5 today, can I send another?".
      const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
      const { count } = await supabase.from('broadcasts')
        .select('id', { count: 'exact', head: true })
        .eq('tenant_id', tenantId)
        .gte('created_at', since)
      return count ?? 0
    }
    case 'team_size_max': {
      const { count } = await supabase.from('user_role_assignments')
        .select('id', { count: 'exact', head: true })
        .eq('tenant_id', tenantId)
        .is('disabled_at', null)
      return count ?? 0
    }
    case 'ai_tokens_per_month': {
      // Live count — `lib/ai-usage.ts:recordAiUsage()` writes to the
      // `usage_counters` table from every Frequency AI call site
      // (parse-workflow, workflow-recos, run_ai_responder node, skill
      // match). Period boundary is the IST calendar month, same convention
      // as messages_per_month so the bars + the limit-block agree.
      const { getAiTokensThisMonth } = await import('./ai-usage')
      return await getAiTokensThisMonth(supabase, tenantId)
    }
    case 'ai_dollars_per_month': {
      // Dollar-cost cap — same period boundary, reads the
      // `ai_cost_cents` counter that recordAiUsage writes alongside
      // ai_tokens. Returns whole dollars (cents/100, ceil) so a $4.50
      // spend hits a $5 cap. Margin floor enforcement.
      const { getAiDollarsThisMonth } = await import('./ai-usage')
      return await getAiDollarsThisMonth(supabase, tenantId)
    }
  }
}

function prettyMetric(metric: LimitMetric): string {
  return ({
    contacts_max:         'Contact',
    messages_per_month:   'Monthly message',
    workflows_max:        'Active workflow',
    broadcasts_per_day:   'Daily broadcast',
    team_size_max:        'Team seat',
    ai_tokens_per_month:  'Monthly AI token',
    ai_dollars_per_month: 'Monthly AI spend ($)',
  })[metric]
}

/**
 * Best-guess next tier the user should upgrade to. Crude heuristic — the
 * FE can always link to /settings/billing for the canonical comparison.
 */
function nextTierForMetric(metric: LimitMetric): string {
  // ai_tokens + ai_dollars + workflows tend to bite first on Starter → Growth.
  // contacts + messages bite first on Free → Starter.
  if (metric === 'ai_tokens_per_month'
   || metric === 'ai_dollars_per_month'
   || metric === 'workflows_max') return 'growth'
  return 'starter'
}
