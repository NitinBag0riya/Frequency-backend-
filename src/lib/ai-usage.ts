/**
 * Frequency AI usage accounting — tokens AND dollar cost per tenant.
 *
 * Two counters per (tenant, period):
 *   - `ai_tokens`      — sum of all token types (input + output + cache).
 *                        Used for the "you've used X / Y tokens" usage bar.
 *   - `ai_cost_cents`  — actual USD cost in cents, computed at write-time
 *                        using the model's per-token rate (Anthropic).
 *                        This is what enforces the dollar cap in the
 *                        Growth/Scale plans where token caps alone don't
 *                        protect Frequency's gross margin.
 *
 * Why both: a token cap is intuitive for users ("I've sent X messages") but
 * tokens vary 5× in cost across models — Sonnet output is 15× more than
 * Haiku input, so a "5M token cap" can mean anywhere from $5 to $75
 * depending on what the workflow actually invoked. Tracking dollars
 * separately is the only way to guarantee a per-tenant margin floor.
 *
 * Cost rates (Anthropic public pricing, USD per 1M tokens):
 *   Sonnet 4:    input  $3.00   output $15.00   cache_read $0.30   cache_write $3.75
 *   Haiku 4.5:   input  $1.00   output $5.00    cache_read $0.10   cache_write $1.25
 *
 * cache_read = 90% off input. cache_write = 25% premium on input. Both are
 * already in `usage` from the SDK when prompt-caching is enabled
 * (cache_read_input_tokens, cache_creation_input_tokens).
 *
 * recordAiUsage is fire-and-forget — never blocks the AI response path.
 * If the upsert fails (DB hiccup, missing column), we log and move on.
 * Mis-counting tokens is annoying but never user-facing — better to serve
 * the AI response than 500 because a counter table was momentarily down.
 */

import type { SupabaseClient } from '@supabase/supabase-js'

/** Where in the codebase the tokens were spent. */
export type AiUsageSource =
  | 'parse_workflow'
  | 'workflow_recos'
  | 'ai_responder'
  | 'skill_match'
  | 'call_transcript'
  | 'call_sentiment'

/**
 * Anthropic SDK's usage shape. Cache fields are optional and only present
 * when prompt-caching is enabled at the call site.
 */
export interface AiUsage {
  input_tokens?:                number
  output_tokens?:               number
  cache_read_input_tokens?:     number
  cache_creation_input_tokens?: number
}

/**
 * Per-model price points in CENTS PER 1,000,000 TOKENS.
 *
 * Add a new model = add a new entry. Models we don't recognise fall back
 * to Sonnet rates (the more expensive of the two we use) so we
 * never under-bill the cost counter on an unknown model.
 *
 * Bumping rates: Anthropic publishes price changes; reflect them here +
 * any per-tenant grandfathering should be handled in the plan-limit
 * layer, not here.
 */
const RATES_CPM: Record<string, { in: number; out: number; cache_read: number; cache_write: number }> = {
  'claude-sonnet-4-6':    { in: 300, out: 1500, cache_read: 30,  cache_write: 375 },
  'claude-sonnet-4-5':    { in: 300, out: 1500, cache_read: 30,  cache_write: 375 },
  'claude-3-5-sonnet':    { in: 300, out: 1500, cache_read: 30,  cache_write: 375 },
  'claude-haiku-4-5':     { in: 100, out: 500,  cache_read: 10,  cache_write: 125 },
  'claude-3-5-haiku':     { in: 100, out: 500,  cache_read: 10,  cache_write: 125 },
}

const FALLBACK_RATES = RATES_CPM['claude-sonnet-4-6']

/** Total billable token count (sum of all categories). */
export function totalTokens(u: AiUsage): number {
  return (u.input_tokens ?? 0) + (u.output_tokens ?? 0)
       + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0)
}

/**
 * Compute USD cost in cents for a given Anthropic call. Uses the model's
 * per-category rate; falls back to Sonnet rates if model unknown so we
 * never under-bill.
 *
 * Returns 0 if usage is empty. Rounds UP (Math.ceil) so a fraction-of-a-cent
 * call still increments the counter — protects margin on the long tail.
 */
export function computeCostCents(u: AiUsage, model: string): number {
  const rates = RATES_CPM[model] ?? FALLBACK_RATES
  const inputBase    = u.input_tokens ?? 0
  const cacheReadIn  = u.cache_read_input_tokens ?? 0
  const cacheWriteIn = u.cache_creation_input_tokens ?? 0
  // The SDK's `input_tokens` does NOT include cached portions — Anthropic
  // splits them out so callers get accurate per-bucket counts. So we sum
  // each bucket × its rate.
  const cents =
    (inputBase    * rates.in          / 1_000_000) +
    (cacheReadIn  * rates.cache_read  / 1_000_000) +
    (cacheWriteIn * rates.cache_write / 1_000_000) +
    ((u.output_tokens ?? 0) * rates.out / 1_000_000)
  return Math.ceil(cents)
}

/** Boundary of the current IST calendar month, returned as ISO timestamps. */
export function currentIstMonthBounds(): { startIso: string; endIso: string } {
  const IST_OFFSET_MIN = 5 * 60 + 30
  const nowIst = new Date(Date.now() + IST_OFFSET_MIN * 60_000)
  const startUtcMs = Date.UTC(nowIst.getUTCFullYear(), nowIst.getUTCMonth(), 1) - IST_OFFSET_MIN * 60_000
  const endUtcMs   = Date.UTC(nowIst.getUTCFullYear(), nowIst.getUTCMonth() + 1, 1) - IST_OFFSET_MIN * 60_000
  return { startIso: new Date(startUtcMs).toISOString(), endIso: new Date(endUtcMs).toISOString() }
}

/**
 * Increment BOTH counters (tokens + cost-in-cents) for this tenant +
 * current period. Two upserts; both safe to retry. Read-modify-write has
 * a small race window, fine here because per-tenant AI calls are
 * low-rate (handful per minute even on Scale) and limit enforcement
 * gates at the next call anyway.
 */
export async function recordAiUsage(
  supabase: SupabaseClient,
  tenantId: string,
  usage: AiUsage | null | undefined,
  source: AiUsageSource,
  model: string = 'claude-sonnet-4-6',
): Promise<void> {
  if (!tenantId) return  // unauthenticated AI call (shouldn't happen post identifyTenant)
  const tokens = usage ? totalTokens(usage) : 0
  if (tokens <= 0) return
  const costCents = usage ? computeCostCents(usage, model) : 0
  const { startIso, endIso } = currentIstMonthBounds()

  try {
    await Promise.all([
      upsertCounter(supabase, tenantId, 'ai_tokens',      startIso, endIso, tokens),
      upsertCounter(supabase, tenantId, 'ai_cost_cents',  startIso, endIso, costCents),
    ])
    if (process.env.LOG_AI_USAGE === '1') {
      console.log(`[ai-usage] tenant=${tenantId} src=${source} model=${model} tokens=+${tokens} cents=+${costCents}`)
    }
  } catch (e: any) {
    console.warn(`[ai-usage] write failed (tenant=${tenantId} src=${source}): ${e?.message ?? e}`)
  }
}

async function upsertCounter(
  supabase: SupabaseClient,
  tenantId: string,
  metric: string,
  startIso: string,
  endIso: string,
  delta: number,
): Promise<void> {
  if (delta <= 0) return
  // Read-modify-write — small race window, acceptable for low-rate per-tenant AI calls.
  const { data: existing } = await supabase.from('usage_counters')
    .select('count')
    .eq('tenant_id', tenantId)
    .eq('metric', metric)
    .eq('period_start', startIso)
    .maybeSingle()
  const newCount = (existing?.count ? Number(existing.count) : 0) + delta
  const { error } = await supabase.from('usage_counters').upsert({
    tenant_id:    tenantId,
    metric,
    period_start: startIso,
    period_end:   endIso,
    count:        newCount,
  }, { onConflict: 'tenant_id,metric,period_start' })
  if (error) throw error
}

/**
 * Read the current month's AI token total. Used by lib/limits.ts:countUsage
 * for the `ai_tokens_per_month` plan cap.
 */
export async function getAiTokensThisMonth(
  supabase: SupabaseClient,
  tenantId: string,
): Promise<number> {
  return await readCounter(supabase, tenantId, 'ai_tokens')
}

/**
 * Read the current month's AI cost in WHOLE DOLLARS (cents/100, rounded up).
 * Used by lib/limits.ts:countUsage for the `ai_dollars_per_month` plan cap.
 *
 * Rounded UP so the counter exceeds the cap conservatively — a $4.50 spend
 * counts as $5 against a $10 cap. Better to under-allow than to overspend.
 */
export async function getAiDollarsThisMonth(
  supabase: SupabaseClient,
  tenantId: string,
): Promise<number> {
  const cents = await readCounter(supabase, tenantId, 'ai_cost_cents')
  return Math.ceil(cents / 100)
}

async function readCounter(
  supabase: SupabaseClient,
  tenantId: string,
  metric: string,
): Promise<number> {
  const { startIso } = currentIstMonthBounds()
  const { data } = await supabase.from('usage_counters')
    .select('count')
    .eq('tenant_id', tenantId)
    .eq('metric', metric)
    .eq('period_start', startIso)
    .maybeSingle()
  return data?.count ? Number(data.count) : 0
}
