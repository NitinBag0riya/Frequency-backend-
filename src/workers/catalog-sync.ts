/**
 * Worker: catalog-sync — mirror storefront-api items into public.catalog_items.
 *
 * Ticks every 5 min (dev: 30 min). Reads the storefront_state blob, extracts
 * items per tenant, upserts. Rows are DELETED for items missing from the live
 * catalog so HQ menu-health never counts a removed item.
 *
 * ponytail: plain setInterval mounted from index.ts. No BullMQ ceremony —
 * single-writer semantics are fine for a mirror table at 8-tenant scale.
 * Upgrade path: promote to `src/workers/*` BullMQ pattern once we run
 * multiple API replicas or the loop starts costing >1s per tick.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { loadStorefrontTenants } from '../lib/storefront-state'
import { pollIntervalMs } from '../lib/poller-gate'

const TICK_MS = pollIntervalMs('CATALOG_SYNC_INTERVAL_MS', {
  prod: 5 * 60_000,
  dev: 30 * 60_000,
})

function itemRow(tenantId: string, item: any, catNameById: Map<string, string>) {
  const id = String(item?.id ?? '').slice(0, 128)
  if (!id) return null
  const price = Number(item?.price)
  return {
    tenant_id: tenantId,
    item_id: id,
    name: String(item?.name ?? '').slice(0, 300) || id,
    category: item?.categoryId ? (catNameById.get(String(item.categoryId)) ?? null) : null,
    price_inr: Number.isFinite(price) ? price : null,
    image_url: typeof item?.image === 'string' ? item.image : (item?.image?.url ?? null),
    has_recipe: Array.isArray(item?.recipe) && item.recipe.length > 0,
    is_available: !(item?.soldOut === true),
    updated_at: new Date().toISOString(),
  }
}

export async function runCatalogSyncTick(supabase: SupabaseClient): Promise<{ upserted: number; deleted: number }> {
  const tenants = await loadStorefrontTenants(supabase)
  let upserted = 0
  let deleted = 0
  for (const t of tenants) {
    const catNameById = new Map<string, string>()
    for (const c of t.categories ?? []) if (c?.id) catNameById.set(String(c.id), String(c.name ?? ''))
    const rows = (t.items ?? []).map(i => itemRow(t.tenantId!, i, catNameById)).filter(Boolean) as any[]
    if (rows.length) {
      const { error } = await supabase.from('catalog_items').upsert(rows, { onConflict: 'tenant_id,item_id' })
      if (!error) upserted += rows.length
    }
    // Delete rows for items no longer in the live catalog.
    const liveIds = new Set(rows.map(r => r.item_id))
    const { data: existing } = await supabase.from('catalog_items').select('item_id').eq('tenant_id', t.tenantId!)
    const stale = (existing ?? []).map(r => r.item_id).filter(id => !liveIds.has(id))
    if (stale.length) {
      const { error } = await supabase.from('catalog_items').delete().eq('tenant_id', t.tenantId!).in('item_id', stale)
      if (!error) deleted += stale.length
    }
  }
  return { upserted, deleted }
}

/** Start the setInterval loop. Call once from index.ts boot. */
export function startCatalogSync(supabase: SupabaseClient) {
  if (process.env.CATALOG_SYNC_DISABLED === '1') return
  const tick = () => runCatalogSyncTick(supabase).catch(e => console.warn('[catalog-sync] tick error:', e?.message))
  setTimeout(tick, 30_000).unref()   // first tick after boot warmup
  setInterval(tick, TICK_MS).unref()
}
