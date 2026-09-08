/**
 * Worker: wastage-sync — mirror storefront-api wastage-ledger rows into
 * public.wastage_entries. Ticks every 15 min (dev: 60 min).
 *
 * Reads `stockLedger` from each tenant's storefront blob, filters to
 * `reason='wastage'`, upserts. `id` = the ledger entry id, so a re-run is a
 * no-op. Rolling 30-day window to keep the upsert set bounded — older wastage
 * rows are kept in Supabase once mirrored, we just stop touching them.
 *
 * ponytail: setInterval, same rationale as catalog-sync.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { loadStorefrontTenants } from '../lib/storefront-state'
import { pollIntervalMs } from '../lib/poller-gate'

const TICK_MS = pollIntervalMs('WASTAGE_SYNC_INTERVAL_MS', {
  prod: 15 * 60_000,
  dev: 60 * 60_000,
})
const WINDOW_MS = 30 * 86400_000

function row(tenantId: string, e: any, ingById: Map<string, any>) {
  const id = String(e?.id ?? '').slice(0, 128)
  if (!id) return null
  const ing = ingById.get(String(e?.ingredientId ?? ''))
  const qty = Math.abs(Number(e?.qty) || 0)
  const cost = ing ? Number(ing?.costPerUnit) || 0 : 0
  const at = new Date(Number(e?.at) || Date.now()).toISOString()
  return {
    id,
    tenant_id: tenantId,
    outlet_id: e?.outletId ?? null,
    ingredient_id: e?.ingredientId ?? null,
    ingredient_name: ing?.name ?? e?.ingredientId ?? null,
    qty,
    unit: e?.unit ?? ing?.unit ?? null,
    value_inr: Math.round(qty * cost * 100) / 100,
    reason: e?.category ?? e?.note ?? null,
    at,
  }
}

export async function runWastageSyncTick(supabase: SupabaseClient): Promise<{ upserted: number }> {
  const tenants = await loadStorefrontTenants(supabase)
  const cutoff = Date.now() - WINDOW_MS
  let upserted = 0
  for (const t of tenants) {
    const ingById = new Map<string, any>()
    for (const i of t.ingredients ?? []) if (i?.id) ingById.set(String(i.id), i)
    const rows = (t.stockLedger ?? [])
      .filter((e: any) => e?.reason === 'wastage' && (Number(e?.at) || 0) >= cutoff)
      .map((e: any) => row(t.tenantId!, e, ingById))
      .filter(Boolean) as any[]
    if (!rows.length) continue
    const { error } = await supabase.from('wastage_entries').upsert(rows, { onConflict: 'id' })
    if (!error) upserted += rows.length
  }
  return { upserted }
}

export function startWastageSync(supabase: SupabaseClient) {
  if (process.env.WASTAGE_SYNC_DISABLED === '1') return
  const tick = () => runWastageSyncTick(supabase).catch(e => console.warn('[wastage-sync] tick error:', e?.message))
  setTimeout(tick, 45_000).unref()
  setInterval(tick, TICK_MS).unref()
}
