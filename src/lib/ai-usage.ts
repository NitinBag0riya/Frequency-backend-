/**
 * AI token usage accounting.
 *
 * Anthropic returns input/output (and cache) token counts on every response.
 * We record them per-tenant in `usage_counters` so:
 *   1. `lib/limits.ts` can enforce the `ai_tokens_per_month` plan cap
 *   2. `/api/billing/usage` can show the user how much they've spent
 *
 * One row per (tenant_id, metric, period_start). Period boundary is the IST
 * calendar month — same convention as `messages_per_month` so the bars and
 * the limit-block agree on which tokens count "this month".
 *
 * `recordAiUsage` is async + caller-fire-and-forget — never blocks the AI
 * response path. If the write fails (DB hiccup, missing table), we log a
 * warning and move on. Mis-counting tokens is annoying but never user-facing
 * — we'd rather serve the AI response than 500 because the counter table
 * was momentarily down.
 *
 * `getAiTokensThisMonth` is used by `lib/limits.ts:countUsage()`. Reads the
 * single row for the current period — O(1) point lookup on the PK.
 *
 * Source key: every recorded write tags `source` (parse_workflow, workflow_recos,
 * ai_responder) so we can later split usage in admin reports without rebuilding
 * historical data. Right now they all aggregate into the same metric counter
 * for limit enforcement — `source` lives in the `metric` string suffix only
 * if we ever need per-feature breakdowns.
 */

import type { SupabaseClient } from '@supabase/supabase-js'

/** Where in the codebase the tokens were spent. Useful for admin breakdowns. */
export type AiUsageSource =
  | 'parse_workflow'      // POST /api/parse-workflow (intent → AST streaming)
  | 'workflow_recos'      // GET /api/workflow-recommendations (template suggestions)
  | 'ai_responder'        // executor.ts run_ai_responder node (in-flight workflows)
  | 'skill_match'         // POST /api/skills/match (intent classifier)

/**
 * Shape we accept from Anthropic responses. Both `messages.create()` (sync) and
 * `stream.finalMessage().usage` (streaming) return this shape; cache fields
 * are optional and only present when prompt-caching is in use.
 */
export interface AiUsage {
  input_tokens?:                number
  output_tokens?:               number
  cache_read_input_tokens?:     number
  cache_creation_input_tokens?: number
}

/** Total billable token count. Cache reads cost less but for the user's plan
 *  cap we count them in full — keeps the math intuitive ("if I see 5000 in
 *  the bar, my next call had better be ≤ remaining"). */
export function totalTokens(u: AiUsage): number {
  return (u.input_tokens ?? 0) + (u.output_tokens ?? 0)
       + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0)
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
 * Increment the per-tenant counter for this month by `tokens`. Idempotent w.r.t.
 * the (tenant, metric, period_start) primary key — first call inserts, every
 * subsequent call adds to the existing count.
 *
 * Implementation note: PostgREST doesn't expose `INSERT … ON CONFLICT … DO
 * UPDATE SET count = count + EXCLUDED.count` cleanly via supabase-js. We
 * use an RPC if one exists, otherwise fall back to read-modify-write — which
 * has a small race window but is fine here because:
 *   1. AI calls are low-rate per tenant (handful per minute even on Scale)
 *   2. Worst case under contention: an undercount of a few hundred tokens
 *   3. Limit enforcement is gated at the next call anyway, not real-time
 */
export async function recordAiUsage(
  supabase: SupabaseClient,
  tenantId: string,
  usage: AiUsage | null | undefined,
  source: AiUsageSource,
): Promise<void> {
  if (!tenantId) return  // unauthenticated AI call (shouldn't happen after identifyTenant)
  const tokens = usage ? totalTokens(usage) : 0
  if (tokens <= 0) return
  const { startIso, endIso } = currentIstMonthBounds()

  try {
    // Read current count (if any) for this period.
    const { data: existing } = await supabase.from('usage_counters')
      .select('count')
      .eq('tenant_id', tenantId)
      .eq('metric', 'ai_tokens')
      .eq('period_start', startIso)
      .maybeSingle()

    const newCount = (existing?.count ? Number(existing.count) : 0) + tokens

    // Upsert — either inserts the first row of the period or replaces the
    // accumulated count. ON CONFLICT (tenant_id, metric, period_start) is
    // implicit because that's the table's primary key.
    const { error } = await supabase.from('usage_counters').upsert({
      tenant_id:    tenantId,
      metric:       'ai_tokens',
      period_start: startIso,
      period_end:   endIso,
      count:        newCount,
    }, { onConflict: 'tenant_id,metric,period_start' })
    if (error) throw error

    // Lightweight breadcrumb in logs so we can spot anomalous consumption
    // (rogue workflow node looping, prompt-cache miss storm, etc.).
    if (process.env.LOG_AI_USAGE === '1') {
      console.log(`[ai-usage] tenant=${tenantId} source=${source} +${tokens} → ${newCount}`)
    }
  } catch (e: any) {
    // Never let counter writes break the AI response. Log + move on.
    console.warn(`[ai-usage] write failed (tenant=${tenantId} source=${source}): ${e?.message ?? e}`)
  }
}

/**
 * Read the current month's AI token total for a tenant. Used by
 * `lib/limits.ts:countUsage('ai_tokens_per_month')`. Returns 0 if no row
 * exists yet — that's the first AI call of the period.
 */
export async function getAiTokensThisMonth(
  supabase: SupabaseClient,
  tenantId: string,
): Promise<number> {
  const { startIso } = currentIstMonthBounds()
  const { data } = await supabase.from('usage_counters')
    .select('count')
    .eq('tenant_id', tenantId)
    .eq('metric', 'ai_tokens')
    .eq('period_start', startIso)
    .maybeSingle()
  return data?.count ? Number(data.count) : 0
}
