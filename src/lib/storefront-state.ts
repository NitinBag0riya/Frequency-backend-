/**
 * Reader for the storefront-api mirror blob (public.storefront_state).
 *
 * storefront-api dual-writes its entire in-memory store to a single JSON row
 * per environment (see storefront-api/db.js `backupToSupabase`). Shape:
 *   { tenants: { [slug]: { items, categories, ingredients, stockLedger, orders, ... } } }
 *
 * ponytail: we read the mirror instead of adding a cross-service HTTP hop.
 *   Ceiling: 5–15 min lag vs live storefront-api state (backup cadence).
 *   Upgrade path: add per-tenant read endpoints on storefront-api and hit them.
 */

import type { SupabaseClient } from '@supabase/supabase-js'

export interface StorefrontTenant {
  slug: string
  tenantId: string | null    // resolved from public.tenants.slug
  items?: any[]
  categories?: any[]
  ingredients?: any[]
  stockLedger?: any[]
  orders?: any[]
  guests?: any[]
}

/** Load every storefront_state row and flatten to one array of tenants,
 *  resolving each `slug` → the matching `tenants.id`. Tenants absent from
 *  Supabase (e.g. seed-only local slugs) are skipped. */
export async function loadStorefrontTenants(
  supabase: SupabaseClient,
): Promise<StorefrontTenant[]> {
  const { data: rows, error } = await supabase
    .from('storefront_state')
    .select('id, data')
  if (error || !rows?.length) return []

  // Merge every environment row's tenants map. Later rows overwrite earlier
  // ones for a duplicate slug — deterministic by row id order.
  const merged: Record<string, any> = {}
  for (const row of rows) {
    const tenants = (row?.data as any)?.tenants
    if (tenants && typeof tenants === 'object') Object.assign(merged, tenants)
  }
  const slugs = Object.keys(merged)
  if (!slugs.length) return []

  const { data: tRows } = await supabase
    .from('tenants')
    .select('id, slug')
    .in('slug', slugs)
  const slugToId = new Map<string, string>()
  for (const r of tRows ?? []) if (r?.slug && r?.id) slugToId.set(r.slug, r.id)

  return slugs
    .map(slug => ({ slug, tenantId: slugToId.get(slug) ?? null, ...(merged[slug] || {}) }))
    .filter(t => t.tenantId) as StorefrontTenant[]
}
