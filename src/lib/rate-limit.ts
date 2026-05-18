/**
 * Atomic Redis token-bucket rate limiter — the low-level primitive that
 * `src/lib/quota.ts` builds on top of. Stays narrowly scoped to "INCR a
 * counter, set its TTL on first hit, return the new count" so it can be
 * unit-tested without any plan-lookup or notification noise.
 *
 * Why bare Lua instead of @upstash/ratelimit or a SDK:
 *   - We already have ioredis in deps (queue.ts); a second dep would just be
 *     a thin wrapper around the same primitives.
 *   - We need atomic INCR + EXPIRE so the TTL is set on the very first
 *     increment but never reset on subsequent ones (otherwise a hot tenant
 *     would never let the counter expire). Two separate commands race; one
 *     Lua call does not.
 *   - p99 latency target: sub-1ms. A single EVALSHA hits ~0.3ms intra-region.
 *
 * Pattern:
 *   - Window keys are deterministic (`rl:msg:{tenant}:{YYYY-MM-DD}` for daily,
 *     `rl:msg:{tenant}:{epochMinute}` for per-minute). Day boundary is IST so
 *     it matches the existing limits.ts:countUsage convention — without this,
 *     /api/usage and the rate-limiter would disagree about "today".
 *   - Caller passes the window in seconds; Lua sets EXPIRE on first hit.
 *   - Returns { count_after, ttl_seconds }; caller decides whether to allow.
 *
 * We deliberately do NOT decrement on rejection. Treat the counter as
 * "attempts" not "successful sends". A tenant spamming retries should feel
 * the limit faster, not slower.
 */

import type IORedis from 'ioredis'

// ── Lua script ─────────────────────────────────────────────────────────────
// KEYS[1] = bucket key (e.g. 'rl:msg:abc-123:2026-05-18')
// ARGV[1] = increment amount (integer)
// ARGV[2] = window TTL in seconds (only applied on first INCR)
//
// Returns { count_after_increment, ttl_seconds }. ttl returns -1 if the key
// already had no TTL set (shouldn't happen, but the caller treats negative
// TTLs as "no reset known" and falls back to the window).
const LUA_INCR_WITH_TTL = `
  local key      = KEYS[1]
  local incr_by  = tonumber(ARGV[1]) or 1
  local ttl_secs = tonumber(ARGV[2]) or 60
  local count    = redis.call('INCRBY', key, incr_by)
  if count == incr_by then
    -- First write into this bucket — set the window TTL.
    redis.call('EXPIRE', key, ttl_secs)
    return { count, ttl_secs }
  end
  local ttl = redis.call('TTL', key)
  return { count, ttl }
`

let cachedSha: string | null = null

/**
 * Returns the current count for a bucket key WITHOUT incrementing. Used by
 * /api/usage to surface live usage to the FE billing page. Cheap — a single
 * GET, no Lua.
 */
export async function peekBucket(
  redis: IORedis,
  key: string,
): Promise<{ count: number; ttl: number }> {
  // Pipeline so it's one round-trip.
  const [[, raw], [, ttlRaw]] = (await redis
    .multi()
    .get(key)
    .ttl(key)
    .exec()) as [[Error | null, string | null], [Error | null, number]]
  return {
    count: raw ? Number(raw) || 0 : 0,
    ttl:   typeof ttlRaw === 'number' ? ttlRaw : -1,
  }
}

/**
 * Atomically increment a bucket counter. Sets TTL on the first hit only —
 * subsequent calls within the window leave the TTL alone so the window
 * doesn't slide.
 *
 * Uses EVALSHA after the first call for ~30% lower latency. Re-loads the
 * script if Redis evicted it (NOSCRIPT response → reload + retry).
 */
export async function incrBucket(
  redis: IORedis,
  key: string,
  windowSeconds: number,
  incrBy: number = 1,
): Promise<{ count: number; ttl: number }> {
  if (!cachedSha) {
    cachedSha = (await redis.script('LOAD', LUA_INCR_WITH_TTL)) as string
  }
  try {
    const result = (await redis.evalsha(
      cachedSha, 1, key, String(incrBy), String(windowSeconds),
    )) as [number, number]
    return { count: result[0], ttl: result[1] }
  } catch (e: any) {
    // Script was evicted (rare; happens after SCRIPT FLUSH or Redis restart).
    // Re-load and retry once.
    if (typeof e?.message === 'string' && e.message.includes('NOSCRIPT')) {
      cachedSha = (await redis.script('LOAD', LUA_INCR_WITH_TTL)) as string
      const result = (await redis.evalsha(
        cachedSha, 1, key, String(incrBy), String(windowSeconds),
      )) as [number, number]
      return { count: result[0], ttl: result[1] }
    }
    throw e
  }
}

// ── Window key helpers ─────────────────────────────────────────────────────
// IST day boundary — matches limits.ts:countUsage('messages_per_month') so
// the per-day rate-limit and the per-month aggregate roll on the same wall-
// clock day from the tenant's perspective.

const IST_OFFSET_MIN = 5 * 60 + 30
const SECONDS_PER_DAY = 24 * 60 * 60
const SECONDS_PER_MINUTE = 60

/**
 * Returns the IST calendar date string (YYYY-MM-DD) for "now" — the bucket
 * id for daily quotas. Same boundary used by lib/limits.ts message counts.
 */
export function istDateKey(now: Date = new Date()): string {
  const ist = new Date(now.getTime() + IST_OFFSET_MIN * 60_000)
  const y = ist.getUTCFullYear()
  const m = String(ist.getUTCMonth() + 1).padStart(2, '0')
  const d = String(ist.getUTCDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

/**
 * Returns the integer minute-of-epoch bucket id for per-minute quotas. Same
 * value across all processes so distributed workers share a bucket.
 */
export function minuteKey(now: Date = new Date()): number {
  return Math.floor(now.getTime() / 60_000)
}

/**
 * Seconds remaining in the current IST day. Used as the TTL when bumping
 * a daily bucket on its first hit — guarantees the counter resets exactly
 * at midnight IST.
 */
export function secondsUntilEndOfIstDay(now: Date = new Date()): number {
  const ist = new Date(now.getTime() + IST_OFFSET_MIN * 60_000)
  const dayElapsedSec =
    ist.getUTCHours() * 3600 + ist.getUTCMinutes() * 60 + ist.getUTCSeconds()
  // +5 second safety margin so a long-running worker that increments at
  // 23:59:59 doesn't accidentally bleed into tomorrow's bucket due to clock
  // skew between the JS process and Redis.
  return Math.max(60, SECONDS_PER_DAY - dayElapsedSec + 5)
}

/**
 * Standard window TTLs.
 */
export const DAY_WINDOW = SECONDS_PER_DAY
export const MINUTE_WINDOW = SECONDS_PER_MINUTE

/**
 * Build the canonical Redis key for a quota bucket. Centralised so
 * peekBucket() and incrBucket() callers never disagree on naming.
 *
 *   bucketKey('messages_per_day',    tenantId)
 *     → 'rl:messages_per_day:abc-123:2026-05-18'
 *   bucketKey('messages_per_minute', tenantId)
 *     → 'rl:messages_per_minute:abc-123:35012345'
 */
export function bucketKey(
  quotaKey: string,
  tenantId: string,
  now: Date = new Date(),
): string {
  if (quotaKey.endsWith('_per_minute')) {
    return `rl:${quotaKey}:${tenantId}:${minuteKey(now)}`
  }
  // Default = daily window. Covers messages_per_day, broadcasts_per_day,
  // ai_requests_per_day. Any future per-hour key should add its own branch.
  return `rl:${quotaKey}:${tenantId}:${istDateKey(now)}`
}

/**
 * Window TTL (in seconds) for a given quota key. Mirrors bucketKey so the
 * two helpers can't drift.
 */
export function windowSecondsFor(quotaKey: string, now: Date = new Date()): number {
  if (quotaKey.endsWith('_per_minute')) return MINUTE_WINDOW
  return secondsUntilEndOfIstDay(now)
}
