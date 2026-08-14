/**
 * Naruto Platform OS §3 — plan limits model (pure logic + DB readers).
 *
 * The PURE half (resolveCap / capState / limitViolations / removedFeatures) is
 * the source of truth for the downgrade guard and the tenant limits panel, and
 * is unit-tested by naruto-plans.selfcheck.ts (no DB, no network).
 *
 * The DB half resolves a tenant's *effective* caps honouring:
 *   1. the plan VERSION the subscription is pinned to (grandfathering) — an
 *      older version reads its immutable plan_versions snapshot, the current
 *      version reads the live plans row;
 *   2. per-tenant tenant_limit_overrides (soft + hard);
 *   3. live usage counts for the metered limits.
 *
 * Cap convention (mirrors lib/limits.ts): -1 = unlimited · 0 = blocked ·
 * >0 = finite · absent key = unlimited.
 */

import type { SupabaseClient } from '@supabase/supabase-js'

export const UNLIMITED = -1

// ─── Pure cap resolution ──────────────────────────────────────────────────────

export interface CapPair {
  soft: number | null // warn line; null = no soft warning
  hard: number        // block line; -1 = unlimited
}

function firstNum(...xs: Array<number | null | undefined>): number | null {
  for (const x of xs) if (x !== null && x !== undefined) return Number(x)
  return null
}

/** Per-tenant override beats the plan; null/undefined = inherit. Hard defaults
 *  to unlimited when neither layer sets it (limits.ts "absent = unlimited"). */
export function resolveCap(
  planHard: number | null | undefined,
  planSoft: number | null | undefined,
  ovHard: number | null | undefined,
  ovSoft: number | null | undefined,
): CapPair {
  return {
    hard: firstNum(ovHard, planHard) ?? UNLIMITED,
    soft: firstNum(ovSoft, planSoft),
  }
}

export type CapState = 'unlimited' | 'unmetered' | 'ok' | 'warn' | 'over'

/** Where a limit sits given its live usage. `null` usage = not metered yet. */
export function capState(usage: number | null, cap: CapPair): CapState {
  if (cap.hard < 0) {
    if (usage !== null && cap.soft != null && usage >= cap.soft) return 'warn'
    return 'unlimited'
  }
  if (usage === null) return 'unmetered'
  if (usage > cap.hard) return 'over'
  if (cap.soft != null && usage >= cap.soft) return 'warn'
  return 'ok'
}

export interface Violation { key: string; usage: number; targetHard: number }

/**
 * Limits a plan change would VIOLATE: metered live usage that already exceeds
 * the target plan's HARD cap. This is what BLOCKS a downgrade (spec §3 /
 * acceptance #6). Absent or unlimited target caps never violate.
 */
export function limitViolations(
  targetHard: Record<string, number>,
  usage: Record<string, number | null>,
): Violation[] {
  const out: Violation[] = []
  for (const [key, u] of Object.entries(usage)) {
    if (u === null) continue
    const cap = targetHard[key]
    if (cap === undefined || cap < 0) continue // absent/unlimited = no violation
    if (u > cap) out.push({ key, usage: u, targetHard: cap })
  }
  return out
}

const hasFeature = (arr: string[], k: string) => arr.includes('*') || arr.includes(k)

/** Features present on the current plan but gone on the target (removal set). */
export function removedFeatures(current: string[], target: string[]): string[] {
  if (target.includes('*')) return []
  return current.filter(k => k !== '*' && !hasFeature(target, k))
}

// ─── Plan-version resolution (grandfathering) ─────────────────────────────────

export interface PlanDef {
  plan_id: string
  version: number
  name: string
  monthly_price_inr: number
  features: string[]
  limits: Record<string, number>       // hard caps
  soft_limits: Record<string, number>
  trial_days: number
}

function planRowToDef(row: any): PlanDef {
  return {
    plan_id: row.id,
    version: Number(row.version ?? 1),
    name: row.name,
    monthly_price_inr: Number(row.monthly_price_inr ?? 0),
    features: (row.features ?? []) as string[],
    limits: (row.limits ?? {}) as Record<string, number>,
    soft_limits: (row.soft_limits ?? {}) as Record<string, number>,
    trial_days: Number(row.trial_days ?? 0),
  }
}

/** The live (current-version) definition of a plan, or null if unknown. */
export async function loadLivePlanDef(sb: SupabaseClient, planId: string): Promise<PlanDef | null> {
  const { data } = await sb.from('plans').select('*').eq('id', planId).maybeSingle()
  return data ? planRowToDef(data) : null
}

/**
 * Resolve the plan definition a subscription is ENTITLED to: its pinned version
 * if that version is older than the live one (read the snapshot), otherwise the
 * live row. A null/absent pin resolves to the live row.
 */
export async function resolvePinnedPlanDef(
  sb: SupabaseClient, planId: string, pinnedVersion: number | null | undefined,
): Promise<PlanDef | null> {
  const live = await loadLivePlanDef(sb, planId)
  if (!live) return null
  if (pinnedVersion == null || pinnedVersion >= live.version) return live
  const { data: snap } = await sb.from('plan_versions')
    .select('*').eq('plan_id', planId).eq('version', pinnedVersion).maybeSingle()
  if (!snap) return live // snapshot missing → safest is the live def
  return {
    plan_id: planId,
    version: Number((snap as any).version),
    name: (snap as any).name ?? live.name,
    monthly_price_inr: Number((snap as any).monthly_price_inr ?? live.monthly_price_inr),
    features: ((snap as any).features ?? []) as string[],
    limits: ((snap as any).limits ?? {}) as Record<string, number>,
    soft_limits: ((snap as any).soft_limits ?? {}) as Record<string, number>,
    trial_days: Number((snap as any).trial_days ?? live.trial_days),
  }
}

// ─── Live usage counters (metered limits only) ────────────────────────────────

async function countRows(
  sb: SupabaseClient, table: string, apply: (q: any) => any,
): Promise<number | null> {
  try {
    const { count, error } = await apply(
      sb.from(table).select('id', { count: 'exact', head: true }),
    )
    if (error) return null
    return count ?? 0
  } catch { return null }
}

function istMonthStartIso(): string {
  const IST = 5 * 60 + 30
  const nowIst = new Date(Date.now() + IST * 60_000)
  const ms = Date.UTC(nowIst.getUTCFullYear(), nowIst.getUTCMonth(), 1) - IST * 60_000
  return new Date(ms).toISOString()
}

/** metric → live counter. Absent metrics are treated as "not metered" (null). */
const COUNTERS: Record<string, (sb: SupabaseClient, tid: string) => Promise<number | null>> = {
  outlets_max:  (sb, t) => countRows(sb, 'tenant_outlets', q => q.eq('tenant_id', t)),
  team_size_max: (sb, t) => countRows(sb, 'user_role_assignments', q => q.eq('tenant_id', t).is('disabled_at', null)),
  campaigns_max: (sb, t) => countRows(sb, 'campaigns', q => q.eq('tenant_id', t)),
  messages_per_month: (sb, t) => countRows(sb, 'messages', q => q.eq('tenant_id', t).gte('created_at', istMonthStartIso())),
}

/** Usage for the requested metrics; null where the metric is not metered. */
export async function usageForMetrics(
  sb: SupabaseClient, tenantId: string, keys: string[],
): Promise<Record<string, number | null>> {
  const out: Record<string, number | null> = {}
  await Promise.all(keys.map(async k => {
    out[k] = COUNTERS[k] ? await COUNTERS[k](sb, tenantId) : null
  }))
  return out
}

// ─── Effective tenant limits (the tenant panel + downgrade preview reader) ─────

export interface LimitDefRow {
  key: string; label: string; unit: string; category: string
  verticals: string[]; metered: boolean; sort_order: number
}

export interface EffectiveLimit extends LimitDefRow {
  soft: number | null
  hard: number
  usage: number | null
  overridden: boolean
  state: CapState
}

export interface TenantLimits {
  tenantId: string
  planId: string | null
  planVersion: number | null
  status: string | null
  limits: EffectiveLimit[]
}

export async function loadLimitDefs(sb: SupabaseClient): Promise<LimitDefRow[]> {
  const { data } = await sb.from('plan_limit_defs').select('*').order('sort_order')
  return (data ?? []) as LimitDefRow[]
}

/** Full effective-limits read for a tenant — caps (version-pinned), overrides,
 *  live usage and the resulting state per limit. */
export async function resolveTenantLimits(sb: SupabaseClient, tenantId: string): Promise<TenantLimits> {
  const defs = await loadLimitDefs(sb)
  const { data: sub } = await sb.from('tenant_subscriptions')
    .select('plan_id, plan_version, status').eq('tenant_id', tenantId).maybeSingle()

  const planDef = sub?.plan_id ? await resolvePinnedPlanDef(sb, sub.plan_id, (sub as any).plan_version) : null

  const { data: ovRows } = await sb.from('tenant_limit_overrides')
    .select('limit_key, soft_cap, hard_cap').eq('tenant_id', tenantId)
  const overrides = new Map<string, { soft_cap: number | null; hard_cap: number | null }>()
  for (const r of (ovRows ?? []) as any[]) overrides.set(r.limit_key, { soft_cap: r.soft_cap, hard_cap: r.hard_cap })

  const usage = await usageForMetrics(sb, tenantId, defs.filter(d => d.metered).map(d => d.key))

  const limits: EffectiveLimit[] = defs.map(d => {
    const ov = overrides.get(d.key)
    const cap = resolveCap(planDef?.limits?.[d.key], planDef?.soft_limits?.[d.key], ov?.hard_cap, ov?.soft_cap)
    const u = d.metered ? (usage[d.key] ?? null) : null
    return {
      ...d, soft: cap.soft, hard: cap.hard, usage: u,
      overridden: !!ov, state: capState(u, cap),
    }
  })

  return {
    tenantId,
    planId: sub?.plan_id ?? null,
    planVersion: (sub as any)?.plan_version ?? null,
    status: sub?.status ?? null,
    limits,
  }
}

// ─── Downgrade guard (server-side re-validation of the FE preview) ────────────

export interface DowngradeImpact {
  targetPlanId: string
  targetVersion: number
  removedFeatures: string[]
  violations: Violation[]     // metered usage above the target hard cap → BLOCKS
  blocking: boolean
}

/**
 * Compute what a move to `targetPlanId` breaks for a tenant. Feature removals
 * are informational; limit violations block unless the operator force-resolves.
 */
export async function computeDowngradeImpact(
  sb: SupabaseClient, tenantId: string, targetPlanId: string, targetVersion?: number,
): Promise<DowngradeImpact | null> {
  const target = await resolvePinnedPlanDef(sb, targetPlanId, targetVersion ?? null)
  if (!target) return null

  const { data: sub } = await sb.from('tenant_subscriptions')
    .select('plan_id, plan_version').eq('tenant_id', tenantId).maybeSingle()
  const current = sub?.plan_id ? await resolvePinnedPlanDef(sb, sub.plan_id, (sub as any).plan_version) : null

  const defs = await loadLimitDefs(sb)
  const usage = await usageForMetrics(sb, tenantId, defs.filter(d => d.metered).map(d => d.key))
  const violations = limitViolations(target.limits, usage)

  return {
    targetPlanId,
    targetVersion: target.version,
    removedFeatures: removedFeatures(current?.features ?? [], target.features),
    violations,
    blocking: violations.length > 0,
  }
}
