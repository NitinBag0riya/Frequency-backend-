/**
 * Plan-lookup helper.
 *
 * Canonical source: `tenant_subscriptions` (NOT `tenants.plan_id`, which
 * does not exist as a column — the column was removed when subscriptions
 * moved to their own table). Mirrors the pattern at src/index.ts:485 and
 * src/lib/limits.ts:64.
 *
 * Why a dedicated helper: four sites in the WhatsApp Calling code path
 * queried `tenants.plan_id` directly and silently failed (PostgREST 42703).
 * Consolidating the lookup here keeps every caller honest about the
 * `'active' | 'trial' | 'cancelled-but-still-paid'` rules.
 */

import type { SupabaseClient } from '@supabase/supabase-js'

export interface ActivePlan {
  plan_id:  string
  features: string[]
  limits:   Record<string, number>
}

/**
 * Returns the tenant's currently effective plan, or `null` if the tenant has
 * no subscription row (treat as Free in callers).
 *
 * Treats `status='cancelled'` with `current_period_end` in the future as
 * still active (the customer paid for the period). Matches the convention
 * used in `src/lib/limits.ts:checkLimit`.
 */
export async function getActivePlanForTenant(
  supabase: SupabaseClient,
  tenantId: string,
): Promise<ActivePlan | null> {
  const { data: sub } = await supabase.from('tenant_subscriptions')
    .select('plan_id, status, current_period_end, plans ( features, limits )')
    .eq('tenant_id', tenantId)
    .maybeSingle()
  if (!sub) return null

  const cancelledButStillPaid =
    sub.status === 'cancelled' &&
    !!sub.current_period_end &&
    new Date(sub.current_period_end as any).getTime() > Date.now()
  const grantsAccess = sub.status === 'active' || sub.status === 'trial' || cancelledButStillPaid
  if (!grantsAccess) return null

  // Supabase nested select returns the joined row as object (one-to-one FK)
  // OR array (depending on the FK shape). Defend against both — same trick
  // as `pickJoinedLimits` in src/lib/limits.ts.
  const joined: any = (sub as any).plans
  const planRow = Array.isArray(joined) ? joined[0] : joined
  return {
    plan_id:  sub.plan_id as string,
    features: (planRow?.features ?? []) as string[],
    limits:   (planRow?.limits ?? {}) as Record<string, number>,
  }
}
