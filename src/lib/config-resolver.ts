/**
 * Per-feature config resolver — the runtime authority for "what value does this
 * tenant use for option X?".
 *
 * Three-layer merge, most-specific wins (mirrors the entitlements resolver):
 *
 *   getConfig(tenant, 'pos.tax_mode') =
 *       tenant_config(tenant, key)         -- 3. per-tenant override   (highest)
 *    ?? plan_config(plan, key)             -- 2. per-plan override
 *    ?? features.config_schema[opt].default -- 1. platform default     (lowest)
 *
 * Keys are namespaced `feature.option` (feature = features.key, option = a key
 * in that feature's config_schema.options[]). Enforcement of the resolved value
 * stays with each feature's own code — this only resolves the value.
 */

import type { SupabaseClient } from '@supabase/supabase-js'

export interface ConfigOption {
  key: string
  label: string
  type: 'enum' | 'number' | 'boolean' | 'string'
  default?: unknown
  options?: string[]
  help?: string
}

// Small in-process cache of the feature config_schema (tiny, static-ish table).
let _schemaCache: { at: number; byFeature: Map<string, ConfigOption[]> } | null = null
const SCHEMA_TTL_MS = 60_000

async function loadSchema(sb: SupabaseClient): Promise<Map<string, ConfigOption[]>> {
  if (_schemaCache && Date.now() - _schemaCache.at < SCHEMA_TTL_MS) return _schemaCache.byFeature
  const { data } = await sb.from('features').select('key, config_schema').not('config_schema', 'is', null)
  const byFeature = new Map<string, ConfigOption[]>()
  for (const row of (data ?? []) as any[]) {
    const opts = (row.config_schema?.options ?? []) as ConfigOption[]
    if (Array.isArray(opts) && opts.length) byFeature.set(row.key, opts)
  }
  _schemaCache = { at: Date.now(), byFeature }
  return byFeature
}

/** Invalidate the schema cache (call after a super-admin edits config_schema). */
export function invalidateConfigSchema(): void { _schemaCache = null }

function splitKey(configKey: string): { feature: string; option: string } | null {
  const dot = configKey.indexOf('.')
  if (dot <= 0 || dot === configKey.length - 1) return null
  return { feature: configKey.slice(0, dot), option: configKey.slice(dot + 1) }
}

function platformDefault(opts: ConfigOption[] | undefined, option: string): unknown {
  return opts?.find(o => o.key === option)?.default
}

/**
 * Resolve one config value for a tenant. Returns the platform default when no
 * override exists, or `undefined` if the key isn't a known option.
 */
export async function getConfig(sb: SupabaseClient, tenantId: string, configKey: string): Promise<unknown> {
  const parts = splitKey(configKey)
  if (!parts) return undefined
  const schema = await loadSchema(sb)
  const opts = schema.get(parts.feature)
  if (!opts) return undefined

  // 3. tenant override
  const { data: t } = await sb.from('tenant_config').select('value').eq('tenant_id', tenantId).eq('config_key', configKey).maybeSingle()
  if (t && t.value !== null && t.value !== undefined) return t.value

  // 2. plan override
  const { data: sub } = await sb.from('tenant_subscriptions').select('plan_id').eq('tenant_id', tenantId).maybeSingle()
  const planId = (sub as any)?.plan_id
  if (planId) {
    const { data: p } = await sb.from('plan_config').select('value').eq('plan_id', planId).eq('config_key', configKey).maybeSingle()
    if (p && p.value !== null && p.value !== undefined) return p.value
  }

  // 1. platform default
  return platformDefault(opts, parts.option)
}

/**
 * Resolve every configurable option for a tenant, grouped by feature, merged
 * with its schema + effective value + which layer it came from. Powers the
 * tenant Settings options panel + the super-admin tenant drawer.
 */
export async function resolveTenantConfig(sb: SupabaseClient, tenantId: string): Promise<Array<{
  feature: string
  options: Array<ConfigOption & { key: string; value: unknown; source: 'tenant' | 'plan' | 'default' }>
}>> {
  const schema = await loadSchema(sb)
  const { data: sub } = await sb.from('tenant_subscriptions').select('plan_id').eq('tenant_id', tenantId).maybeSingle()
  const planId = (sub as any)?.plan_id ?? null

  const [{ data: tRows }, { data: pRows }] = await Promise.all([
    sb.from('tenant_config').select('config_key, value').eq('tenant_id', tenantId),
    planId ? sb.from('plan_config').select('config_key, value').eq('plan_id', planId) : Promise.resolve({ data: [] as any[] } as any),
  ])
  const tMap = new Map((tRows ?? []).map((r: any) => [r.config_key, r.value]))
  const pMap = new Map((pRows ?? []).map((r: any) => [r.config_key, r.value]))

  const out: Array<{ feature: string; options: any[] }> = []
  for (const [feature, opts] of schema.entries()) {
    const resolved = opts.map(o => {
      const ck = `${feature}.${o.key}`
      if (tMap.has(ck) && tMap.get(ck) !== null) return { ...o, value: tMap.get(ck), source: 'tenant' as const }
      if (pMap.has(ck) && pMap.get(ck) !== null) return { ...o, value: pMap.get(ck), source: 'plan' as const }
      return { ...o, value: o.default, source: 'default' as const }
    })
    out.push({ feature, options: resolved })
  }
  return out
}
