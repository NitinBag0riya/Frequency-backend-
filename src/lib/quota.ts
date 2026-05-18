/**
 * Per-tenant quota enforcement built on top of `src/lib/rate-limit.ts`.
 *
 *   checkAndConsumeQuota(tenantId, 'messages_per_day', 1)
 *     ↑ atomic, sub-1ms, runs before every msg.send / broadcast.send.
 *
 * Returns either:
 *   { allowed: true,  current_usage, cap, percent, resets_at }
 *     – the call DID consume the token; caller proceeds.
 *   { allowed: false, current_usage, cap, percent, resets_at,
 *     reason: 'over_quota' | 'feature_disabled', upgrade_to: 'starter' }
 *     – the caller MUST NOT proceed; throw RateLimitExceededError so BullMQ
 *       marks the job failed with a clear reason and doesn't retry.
 *
 * Side effect:
 *   When usage crosses 80% (approaching) or 100% (exhausted), this fires
 *   `quota.approaching` / `quota.exhausted` notifications via
 *   `src/lib/quota-notify.ts`. Idempotent per (tenant, quota, day, level)
 *   via the public.quota_notification_log table — workers that restart
 *   don't re-notify. Fire-and-forget; never blocks the send path.
 *
 * Plan resolution caching:
 *   Plan limits change rarely (only when super-admin edits or a billing
 *   webhook lands). We cache plan lookups in-process for 60s — same TTL
 *   convention as message-sender.ts:TENANT_CACHE_TTL_MS — so the hot path
 *   never hits Supabase. On a cache miss we fall back to a single SELECT
 *   and write the result back. Worst case: a quota bump takes 60s to take
 *   effect across all workers, acceptable.
 *
 * Free-tier fallback:
 *   If the tenant has no subscription row OR the join returns no limits
 *   (botched migration), we use the SAME fail-closed defaults as
 *   `lib/limits.ts:FAIL_CLOSED_FREE_DEFAULTS`. This is the critical revenue
 *   safeguard — without it a database glitch would silently unlimit every
 *   tenant. Better to over-block than under-charge.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import type IORedis from 'ioredis'
import {
  bucketKey, incrBucket, peekBucket, windowSecondsFor, istDateKey,
  secondsUntilEndOfIstDay,
} from './rate-limit'

// ── Public types ──────────────────────────────────────────────────────────

export type QuotaKey =
  | 'messages_per_day'
  | 'messages_per_minute'
  | 'broadcasts_per_day'
  | 'ai_requests_per_day'

export interface QuotaCheckResult {
  allowed:        boolean
  current_usage:  number
  cap:            number    // -1 = unlimited (enterprise / scale)
  percent:        number    // 0..100; -1 for unlimited
  resets_at:      string    // ISO; midnight IST for daily, next minute for per-min
  reason?:        'over_quota' | 'feature_disabled'
  upgrade_to?:    'starter' | 'growth' | 'scale'
}

/**
 * Thrown by checkAndConsumeQuota's caller (workers/message-sender.ts) when
 * the quota is exhausted. BullMQ workers re-throw this as-is; the failure
 * handler in queue.ts can detect it via `instanceof RateLimitExceededError`
 * and skip retries (over-quota is not a transient failure).
 */
export class RateLimitExceededError extends Error {
  public readonly code = 'rate_limit_exceeded' as const
  public readonly tenantId: string
  public readonly quotaKey: QuotaKey
  public readonly current: number
  public readonly cap: number
  public readonly resetsAt: string
  constructor(args: {
    tenantId: string
    quotaKey: QuotaKey
    current:  number
    cap:      number
    resetsAt: string
    message?: string
  }) {
    super(args.message ?? `quota ${args.quotaKey} exceeded for tenant ${args.tenantId} (${args.current}/${args.cap})`)
    this.name = 'RateLimitExceededError'
    this.tenantId = args.tenantId
    this.quotaKey = args.quotaKey
    this.current  = args.current
    this.cap      = args.cap
    this.resetsAt = args.resetsAt
    Object.setPrototypeOf(this, RateLimitExceededError.prototype)
  }
}

// ── Internals ─────────────────────────────────────────────────────────────

interface CachedPlan {
  plan_id:  string
  limits:   Record<string, number>
  expiresAt: number
}

const PLAN_CACHE_TTL_MS = 60 * 1000
const planCache = new Map<string, CachedPlan>()

// Mirrors lib/limits.ts:FAIL_CLOSED_FREE_DEFAULTS for the new quota keys.
// Used when the tenant has no subscription OR the plans table is empty.
// Numbers match migration 063 free-tier seeds.
const FAIL_CLOSED_FREE_QUOTAS: Record<QuotaKey, number> = {
  messages_per_day:     100,
  messages_per_minute:    5,
  broadcasts_per_day:     1,   // legacy free-tier value retained from 018
  ai_requests_per_day:   50,
}

async function resolvePlan(
  supabase: SupabaseClient,
  tenantId: string,
): Promise<{ plan_id: string; limits: Record<string, number> }> {
  const hit = planCache.get(tenantId)
  if (hit && hit.expiresAt > Date.now()) {
    return { plan_id: hit.plan_id, limits: hit.limits }
  }

  const { data: sub } = await supabase.from('tenant_subscriptions')
    .select('plan_id, status, current_period_end, plans ( limits )')
    .eq('tenant_id', tenantId)
    .maybeSingle()

  // Same access rules as lib/limits.ts:checkLimit + lib/plans.ts.
  const cancelledButStillPaid =
    sub?.status === 'cancelled' &&
    !!sub.current_period_end &&
    new Date(sub.current_period_end as any).getTime() > Date.now()
  const grantsAccess =
    sub?.status === 'active' || sub?.status === 'trial' || cancelledButStillPaid

  // Pick joined limits; Supabase returns object OR array depending on FK shape.
  const joined: any = (sub as any)?.plans
  const planRow = Array.isArray(joined) ? joined[0] : joined
  const joinedLimits = (planRow?.limits as Record<string, number> | undefined) ?? {}

  let limits: Record<string, number>
  let plan_id: string

  if (grantsAccess && Object.keys(joinedLimits).length > 0) {
    limits  = joinedLimits
    plan_id = String((sub as any).plan_id)
  } else {
    // Fallback: try to read the free row from the plans table; if that's also
    // empty (botched migration) use the hardcoded fail-closed map.
    const { data: freeRow } = await supabase.from('plans')
      .select('limits').eq('id', 'free').maybeSingle()
    const freeLimits = (freeRow?.limits as Record<string, number> | null | undefined) ?? null
    limits = freeLimits && Object.keys(freeLimits).length > 0
      ? freeLimits
      : { ...FAIL_CLOSED_FREE_QUOTAS }
    plan_id = 'free'
  }

  planCache.set(tenantId, { plan_id, limits, expiresAt: Date.now() + PLAN_CACHE_TTL_MS })
  return { plan_id, limits }
}

/**
 * Invalidate the in-process plan cache for a tenant. Called from the
 * billing webhook (and from /api/admin plan-change routes) when a plan
 * upgrade/downgrade has just landed — without this the worker would
 * continue enforcing the old quotas for up to PLAN_CACHE_TTL_MS.
 */
export function invalidatePlanCache(tenantId: string): void {
  planCache.delete(tenantId)
}

function resetsAtIso(quotaKey: QuotaKey, now: Date = new Date()): string {
  if (quotaKey.endsWith('_per_minute')) {
    return new Date(Math.ceil(now.getTime() / 60_000) * 60_000).toISOString()
  }
  const secsLeft = secondsUntilEndOfIstDay(now)
  return new Date(now.getTime() + secsLeft * 1000).toISOString()
}

function nextTierFor(planId: string): 'starter' | 'growth' | 'scale' {
  switch (planId) {
    case 'free':    return 'starter'
    case 'starter': return 'growth'
    case 'growth':  return 'scale'
    default:        return 'scale'
  }
}

// ── Public surface ────────────────────────────────────────────────────────

/**
 * Atomic check + consume. THE hot-path function. Sub-1ms typical (one
 * EVALSHA + a cached plan lookup).
 *
 * If the increment pushes usage over the cap, returns allowed=false WITHOUT
 * decrementing — see rate-limit.ts on "attempts not successes" rationale.
 *
 * Side effects (fire-and-forget, never blocks):
 *   - At ≥80% usage → schedule quota.approaching notification (idempotent)
 *   - At ≥100% usage → schedule quota.exhausted notification (idempotent)
 *
 * Caller pattern (workers/message-sender.ts):
 *   const q = await checkAndConsumeQuota(supabase, redis, tenantId, 'messages_per_day')
 *   if (!q.allowed) throw new RateLimitExceededError({ tenantId, quotaKey: 'messages_per_day', ... })
 */
export async function checkAndConsumeQuota(
  supabase: SupabaseClient,
  redis:    IORedis,
  tenantId: string,
  quotaKey: QuotaKey,
  amount:   number = 1,
): Promise<QuotaCheckResult> {
  const now = new Date()
  const { plan_id, limits } = await resolvePlan(supabase, tenantId)
  const cap = Number(limits[quotaKey] ?? -1)

  // Unlimited tier — always allowed, never notify. Skip Redis entirely so
  // enterprise tenants don't even incur the ~0.3ms round-trip.
  if (cap < 0) {
    return {
      allowed: true, current_usage: 0, cap: -1, percent: -1,
      resets_at: resetsAtIso(quotaKey, now),
    }
  }

  // Quota explicitly set to 0 — feature is disabled on this plan. Surface
  // it as feature_disabled rather than over_quota so the FE upgrade CTA can
  // distinguish "you're rate-limited" from "your plan doesn't include this".
  if (cap === 0) {
    return {
      allowed: false, current_usage: 0, cap: 0, percent: 100,
      resets_at: resetsAtIso(quotaKey, now),
      reason: 'feature_disabled',
      upgrade_to: nextTierFor(plan_id),
    }
  }

  const key = bucketKey(quotaKey, tenantId, now)
  const window = windowSecondsFor(quotaKey, now)
  const { count } = await incrBucket(redis, key, window, amount)

  const percent  = Math.min(100, Math.round((count / cap) * 100))
  const resetsAt = resetsAtIso(quotaKey, now)

  // Side-effect notifications. Fire-and-forget — don't await; don't let a
  // Supabase outage block the worker's send path.
  if (count >= cap) {
    void scheduleQuotaNotification(supabase, {
      tenantId, quotaKey, level: 'exhausted', usage: count, cap, planId: plan_id, resetsAt,
    })
  } else if (count >= Math.floor(cap * 0.8)) {
    void scheduleQuotaNotification(supabase, {
      tenantId, quotaKey, level: 'approaching', usage: count, cap, planId: plan_id, resetsAt,
    })
  }

  if (count > cap) {
    return {
      allowed: false, current_usage: count, cap, percent: 100,
      resets_at: resetsAt,
      reason: 'over_quota',
      upgrade_to: nextTierFor(plan_id),
    }
  }
  return { allowed: true, current_usage: count, cap, percent, resets_at: resetsAt }
}

/**
 * Read-only usage snapshot for /api/usage. No INCR, no side effects.
 * Returns one entry per quota the plan defines. Skips quotas the plan
 * doesn't have (e.g. broadcasts_per_day on a future "messaging only" plan).
 */
export async function getUsageSnapshot(
  supabase: SupabaseClient,
  redis:    IORedis,
  tenantId: string,
): Promise<{
  tenant_id: string
  plan: string
  quotas: Record<string, {
    used: number
    cap: number
    percent: number
    resets_at: string
  }>
}> {
  const now = new Date()
  const { plan_id, limits } = await resolvePlan(supabase, tenantId)

  const out: Record<string, { used: number; cap: number; percent: number; resets_at: string }> = {}
  const quotaKeys: QuotaKey[] = [
    'messages_per_day',
    'messages_per_minute',
    'broadcasts_per_day',
    'ai_requests_per_day',
  ]
  for (const qk of quotaKeys) {
    if (limits[qk] === undefined) continue
    const cap = Number(limits[qk])
    const { count } = cap === 0 || cap < 0
      ? { count: 0 }
      : await peekBucket(redis, bucketKey(qk, tenantId, now))
    const percent = cap > 0 ? Math.min(100, Math.round((count / cap) * 100)) : -1
    out[qk] = { used: count, cap, percent, resets_at: resetsAtIso(qk, now) }
  }
  return { tenant_id: tenantId, plan: plan_id, quotas: out }
}

// ── Notification scheduling (dynamic import to avoid worker boot cycles) ──
//
// quota-notify.ts pulls in routes/notifications.ts which pulls in the email
// + slack adapters. We don't want the workers to load those at boot — they'd
// inflate cold-start and trip env-var checks (Resend keys etc.) on workers
// that never deliver notifications themselves. Lazy import per call: once
// the module is in the require cache, subsequent calls are free.

async function scheduleQuotaNotification(
  supabase: SupabaseClient,
  args: {
    tenantId:  string
    quotaKey:  QuotaKey
    level:     'approaching' | 'exhausted'
    usage:     number
    cap:       number
    planId:    string
    resetsAt:  string
  },
): Promise<void> {
  try {
    const { fireQuotaNotification } = await import('./quota-notify')
    await fireQuotaNotification(supabase, args)
  } catch (e: any) {
    // Notification failure must never break the send path. Log + swallow.
    console.warn(`[quota] notify ${args.level}/${args.quotaKey} for tenant=${args.tenantId} failed:`, e?.message ?? e)
  }
}

// ── Test hook ─────────────────────────────────────────────────────────────
/**
 * Clear the in-process plan cache. Test-only — exported for the smoke
 * script which flips a tenant's quota to 0 mid-test and expects the next
 * checkAndConsumeQuota call to see it without waiting 60s.
 */
export function _clearAllPlanCache(): void {
  planCache.clear()
}

// IST day key re-export so /api/usage can include `bucket_date` in its
// response without importing rate-limit.ts directly.
export { istDateKey }
