/**
 * Entitlements resolver — the single runtime authority for "can this tenant
 * use feature X?" and "what is this tenant's limit for metric Y?".
 *
 * Three-layer merge, most-specific wins (Stripe/WorkOS pattern), with a HARD
 * vertical gate on top that no plan or override can cross:
 *
 *   effective(tenant, feature) =
 *       tenant_override(enabled)         -- 3. admin per-tenant allow/deny  (highest)
 *    ?? plan_grant(plan_features)        -- 2. what the plan includes
 *    ?? feature.default_enabled          -- 1. global default              (lowest)
 *      AND feature.verticals ∋ businessGroup(tenant.business_type)   -- hard gate
 *
 * Fail closed: unknown feature key, missing tenant, or any read error → deny.
 *
 * Enforcement stays server-side (this + checkLimit on mutating routes). The FE
 * mirror is GET /api/entitlements — UX only.
 */

import type { SupabaseClient } from '@supabase/supabase-js'

// ─── Vertical grouping (mirror of FE src/lib/storefront.ts businessGroup) ────
// Keep in lockstep with the FE helper; the canonical groups are the columns of
// the vertical module matrix.
export type BusinessGroup = 'horeca' | 'salon' | 'real_estate' | 'd2c' | 'other'

export function businessGroup(type: string | null | undefined): BusinessGroup {
  switch (type) {
    case 'horeca': case 'restaurant': case 'cafe': case 'hotel': case 'cloud_kitchen':
      return 'horeca'
    case 'd2c': case 'ecommerce': case 'retail':
      return 'd2c'
    case 'salon': case 'spa': case 'wellness': case 'services':
      return 'salon'
    case 'real_estate':
      return 'real_estate'
    default:
      return 'other'
  }
}

export interface FeatureRow {
  key: string
  verticals: string[]
  default_enabled: boolean
  gate_style: string
}

interface TenantRow {
  business_type: string | null
  plan_id: string | null
  status: string | null
}

// Small in-process cache for the features registry (tiny + static-ish table).
let _featuresCache: { at: number; rows: Map<string, FeatureRow> } | null = null
const FEATURES_TTL_MS = 60_000

async function loadFeatures(sb: SupabaseClient): Promise<Map<string, FeatureRow>> {
  if (_featuresCache && Date.now() - _featuresCache.at < FEATURES_TTL_MS) return _featuresCache.rows
  const { data } = await sb.from('features').select('key, verticals, default_enabled, gate_style')
  const rows = new Map<string, FeatureRow>()
  for (const r of (data ?? []) as FeatureRow[]) rows.set(r.key, r)
  // Cache even an empty result briefly so a features-table hiccup doesn't
  // hammer the DB; callers still fail closed on a missing key.
  _featuresCache = { at: Date.now(), rows }
  return rows
}

/** Test/ops hook — drop the features cache (e.g. after a matrix edit). */
export function invalidateFeaturesCache(): void { _featuresCache = null }

// ── Platform kill-switch (§2.1 layer 1) ──────────────────────────────────────
// A feature_flags row keyed to a feature registry key with is_enabled=false is a
// GLOBAL OFF: it forces that feature off for EVERY tenant, above plan and tenant
// override (non-overridable). Only an explicit is_enabled=false kills — a missing
// flag never does. Cached like features; fail-OPEN on the switch (a flags-table
// hiccup must not silently disable everyone's features).
let _killCache: { at: number; keys: Set<string> } | null = null
const KILL_TTL_MS = 60_000

async function loadKillSwitches(sb: SupabaseClient): Promise<Set<string>> {
  if (_killCache && Date.now() - _killCache.at < KILL_TTL_MS) return _killCache.keys
  const keys = new Set<string>()
  try {
    const { data } = await sb.from('feature_flags').select('key').eq('is_enabled', false)
    for (const r of (data ?? []) as { key: string }[]) keys.add(r.key)
  } catch { /* flags read failed → no kill switches this cycle (fail-open on the switch) */ }
  _killCache = { at: Date.now(), keys }
  return keys
}

/** Test/ops hook — drop the kill-switch cache (e.g. after a flag toggle). */
export function invalidateKillSwitchCache(): void { _killCache = null }

async function loadTenant(sb: SupabaseClient, tenantId: string): Promise<TenantRow | null> {
  const [{ data: t }, { data: sub }] = await Promise.all([
    sb.from('tenants').select('business_type').eq('id', tenantId).maybeSingle(),
    sb.from('tenant_subscriptions').select('plan_id, status').eq('tenant_id', tenantId).maybeSingle(),
  ])
  if (!t && !sub) return null
  return {
    business_type: (t as any)?.business_type ?? null,
    plan_id: (sub as any)?.plan_id ?? null,
    status: (sub as any)?.status ?? null,
  }
}

function verticalAllowed(feature: FeatureRow, bizGroup: BusinessGroup): boolean {
  const v = feature.verticals ?? ['*']
  return v.includes('*') || v.includes(bizGroup)
}

/** A subscription status that entitles the tenant to its paid plan. */
function grantsAccess(status: string | null): boolean {
  return status === 'active' || status === 'trial'
}

interface OverrideRow { is_enabled: boolean | null; expires_at: string | null; quota_override: any }

async function loadOverride(sb: SupabaseClient, tenantId: string, key: string): Promise<OverrideRow | null> {
  const { data } = await sb.from('tenant_entitlements')
    .select('is_enabled, expires_at, quota_override')
    .eq('tenant_id', tenantId).eq('feature', key).maybeSingle()
  return (data as OverrideRow) ?? null
}

function overrideActive(ov: OverrideRow | null): boolean {
  if (!ov) return false
  if (ov.expires_at && new Date(ov.expires_at).getTime() <= Date.now()) return false
  return true
}

async function planGrants(sb: SupabaseClient, planId: string | null, key: string): Promise<boolean> {
  if (!planId) return false
  const { data } = await sb.from('plan_features')
    .select('feature_key').eq('plan_id', planId).eq('feature_key', key).maybeSingle()
  return !!data
}

/**
 * Resolve whether a tenant may use a single feature. Fail-closed on any error.
 */
export async function hasFeature(sb: SupabaseClient, tenantId: string, key: string): Promise<boolean> {
  try {
    const [features, tenant] = await Promise.all([loadFeatures(sb), loadTenant(sb, tenantId)])
    const feature = features.get(key)
    if (!feature) return false                       // unknown key → deny
    if (!tenant) return false                        // no tenant → deny
    const bg = businessGroup(tenant.business_type)
    if (!verticalAllowed(feature, bg)) return false  // HARD vertical gate

    const killed = await loadKillSwitches(sb)
    if (killed.has(key)) return false                // layer 1: platform kill-switch (non-overridable)

    const ov = await loadOverride(sb, tenantId, key)
    if (overrideActive(ov) && ov!.is_enabled !== null) return ov!.is_enabled  // layer 3

    if (grantsAccess(tenant.status) && await planGrants(sb, tenant.plan_id, key)) return true  // layer 2
    return feature.default_enabled                   // layer 1
  } catch (e) {
    console.error('[entitlements] hasFeature failed — deny', key, e)
    return false
  }
}

/**
 * Resolve the full {feature: bool} map + limits for one tenant. Powers
 * GET /api/entitlements (FE mirror). One features read + one plan_features read
 * + one overrides read.
 */
export async function resolveEntitlements(
  sb: SupabaseClient, tenantId: string,
): Promise<{ features: Record<string, boolean>; limits: Record<string, number>; gate_styles: Record<string, string>; business_group: BusinessGroup }> {
  const [features, tenant] = await Promise.all([loadFeatures(sb), loadTenant(sb, tenantId)])
  const bg = businessGroup(tenant?.business_type)

  // Bulk-load plan grants + tenant overrides in two queries.
  const [{ data: grants }, { data: overrides }, { data: planRow }] = await Promise.all([
    tenant?.plan_id
      ? sb.from('plan_features').select('feature_key').eq('plan_id', tenant.plan_id)
      : Promise.resolve({ data: [] as any[] }),
    sb.from('tenant_entitlements').select('feature, is_enabled, expires_at, quota_override').eq('tenant_id', tenantId),
    tenant?.plan_id
      ? sb.from('plans').select('limits').eq('id', tenant.plan_id).maybeSingle()
      : Promise.resolve({ data: null as any }),
  ])

  const granted = new Set((grants ?? []).map((g: any) => g.feature_key))
  const ovMap = new Map<string, OverrideRow>()
  const now = Date.now()
  for (const o of (overrides ?? []) as any[]) {
    if (o.expires_at && new Date(o.expires_at).getTime() <= now) continue
    ovMap.set(o.feature, o)
  }

  const killed = await loadKillSwitches(sb)
  const access = grantsAccess(tenant?.status ?? null)
  const out: Record<string, boolean> = {}
  const gate_styles: Record<string, string> = {}
  for (const [key, f] of features) {
    gate_styles[key] = f.gate_style
    if (!verticalAllowed(f, bg)) { out[key] = false; continue }
    if (killed.has(key)) { out[key] = false; continue }   // layer 1: platform kill-switch
    const ov = ovMap.get(key)
    if (ov && ov.is_enabled !== null) { out[key] = ov.is_enabled; continue }
    out[key] = (access && granted.has(key)) || f.default_enabled
  }

  // Limits: plan.limits merged with any per-tenant quota_override.
  const planLimits: Record<string, number> = ((planRow as any)?.limits as Record<string, number>) ?? {}
  const mergedQuota: Record<string, number> = {}
  for (const o of ovMap.values()) {
    if (o.quota_override && typeof o.quota_override === 'object') Object.assign(mergedQuota, o.quota_override)
  }
  const limits: Record<string, number> = { ...planLimits, ...mergedQuota }

  return { features: out, limits, gate_styles, business_group: bg }
}

/**
 * Detailed per-feature resolution for the naruto tenant cockpit matrix.
 *
 * Same three-layer merge + hard vertical gate as resolveEntitlements/hasFeature
 * (single source of truth), but returns the *source* of each decision so the
 * super-admin can see plan-default vs override vs vertical-gated at a glance and
 * know which rows are safe to toggle. One features read + one plan_features read
 * + one overrides read + one plan.limits read — the whole matrix in one call.
 */
export interface FeatureMatrixRow {
  key: string
  name: string
  category: string
  sort_order: number
  verticals: string[]
  gate_style: string
  default_enabled: boolean
  plan_granted: boolean
  /** Raw override value if an active override row exists (null = quota-only or none). */
  override_enabled: boolean | null
  expires_at: string | null
  quota_override: Record<string, number> | null
  /** Effective on/off after the full merge. */
  resolved: boolean
  /** What decided `resolved`: which layer won (hard gate or platform kill-switch). */
  source: 'override' | 'plan' | 'default' | 'vertical' | 'kill_switch'
  /** Feature is not allowed for this tenant's vertical — locked, not toggleable. */
  vertical_locked: boolean
}

/**
 * Pure per-feature decision — the exact layer precedence hasFeature enforces,
 * factored out so the cockpit matrix and a DB-free self-check share it.
 * Precedence: hard vertical gate → active override → plan grant → global default.
 */
export function decideFeature(input: {
  vertical_locked: boolean
  override_enabled: boolean | null   // null = no active on/off override
  plan_granted: boolean
  default_enabled: boolean
}): { resolved: boolean; source: FeatureMatrixRow['source'] } {
  if (input.vertical_locked) return { resolved: false, source: 'vertical' }
  if (input.override_enabled !== null) return { resolved: input.override_enabled, source: 'override' }
  if (input.plan_granted) return { resolved: true, source: 'plan' }
  return { resolved: input.default_enabled, source: 'default' }
}

export async function resolveEntitlementsDetailed(
  sb: SupabaseClient, tenantId: string,
): Promise<{
  business_group: BusinessGroup
  plan_id: string | null
  status: string | null
  plan_limits: Record<string, number>
  quota_override: Record<string, number>
  features: FeatureMatrixRow[]
}> {
  // Full feature rows (incl. name/category/sort_order) — not the cached slim map.
  const [{ data: featureRows }, tenant] = await Promise.all([
    sb.from('features').select('key, name, category, sort_order, verticals, default_enabled, gate_style').order('sort_order'),
    loadTenant(sb, tenantId),
  ])
  const bg = businessGroup(tenant?.business_type)

  const [{ data: grants }, { data: overrides }, { data: planRow }] = await Promise.all([
    tenant?.plan_id
      ? sb.from('plan_features').select('feature_key').eq('plan_id', tenant.plan_id)
      : Promise.resolve({ data: [] as any[] }),
    sb.from('tenant_entitlements').select('feature, is_enabled, expires_at, quota_override').eq('tenant_id', tenantId),
    tenant?.plan_id
      ? sb.from('plans').select('limits').eq('id', tenant.plan_id).maybeSingle()
      : Promise.resolve({ data: null as any }),
  ])

  const granted = new Set((grants ?? []).map((g: any) => g.feature_key))
  const now = Date.now()
  const ovMap = new Map<string, OverrideRow>()
  const quotaMerged: Record<string, number> = {}
  for (const o of (overrides ?? []) as any[]) {
    if (o.expires_at && new Date(o.expires_at).getTime() <= now) continue  // expired → ignore
    ovMap.set(o.feature, o)
    if (o.quota_override && typeof o.quota_override === 'object') Object.assign(quotaMerged, o.quota_override)
  }
  const access = grantsAccess(tenant?.status ?? null)
  const killed = await loadKillSwitches(sb)

  const features: FeatureMatrixRow[] = (featureRows ?? []).map((f: any) => {
    const verticals: string[] = f.verticals ?? ['*']
    const vertical_locked = !(verticals.includes('*') || verticals.includes(bg))
    const ov = ovMap.get(f.key) ?? null
    const plan_granted = access && granted.has(f.key)
    const override_enabled = ov ? ov.is_enabled : null
    // Layer 1: a global kill-switch forces OFF and is non-overridable — surface it
    // as its own source so the cockpit shows WHY the row is locked off.
    const killSwitched = killed.has(f.key)
    const { resolved, source } = killSwitched
      ? { resolved: false, source: 'kill_switch' as const }
      : decideFeature({ vertical_locked, override_enabled, plan_granted, default_enabled: !!f.default_enabled })

    return {
      key: f.key, name: f.name, category: f.category ?? 'platform',
      sort_order: f.sort_order ?? 0, verticals, gate_style: f.gate_style ?? 'hidden',
      default_enabled: !!f.default_enabled, plan_granted,
      override_enabled,
      expires_at: ov?.expires_at ?? null,
      quota_override: (ov?.quota_override as Record<string, number>) ?? null,
      resolved, source, vertical_locked: vertical_locked || killSwitched,
    }
  })

  return {
    business_group: bg,
    plan_id: tenant?.plan_id ?? null,
    status: tenant?.status ?? null,
    plan_limits: ((planRow as any)?.limits as Record<string, number>) ?? {},
    quota_override: quotaMerged,
    features,
  }
}

/**
 * Quota resolution: a per-tenant override beats the plan limit. Used by
 * checkLimit so an admin quota bump takes effect without a plan change.
 */
export function resolveLimit(
  planLimits: Record<string, number> | null | undefined,
  quotaOverride: Record<string, number> | null | undefined,
  metric: string,
): number {
  const ov = quotaOverride?.[metric]
  if (ov !== undefined && ov !== null) return Number(ov)
  const pl = planLimits?.[metric]
  return pl !== undefined && pl !== null ? Number(pl) : -1
}

/**
 * Load the merged per-tenant quota override object (all non-null
 * quota_override jsonbs on active entitlement rows). Cheap single query.
 */
export async function loadQuotaOverride(sb: SupabaseClient, tenantId: string): Promise<Record<string, number>> {
  const { data } = await sb.from('tenant_entitlements')
    .select('quota_override, expires_at')
    .eq('tenant_id', tenantId)
    .not('quota_override', 'is', null)
  const merged: Record<string, number> = {}
  const now = Date.now()
  for (const r of (data ?? []) as any[]) {
    if (r.expires_at && new Date(r.expires_at).getTime() <= now) continue
    if (r.quota_override && typeof r.quota_override === 'object') Object.assign(merged, r.quota_override)
  }
  return merged
}
