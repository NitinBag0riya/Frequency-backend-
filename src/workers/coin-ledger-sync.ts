/**
 * Worker: coin-ledger-sync — emit an 'earn' row into public.coin_ledger for
 * every settled order with coinsEarned > 0.
 *
 * ── Why a sync worker instead of an inline write ──────────────────────────────
 * The order-settle mutation lives in `~/Desktop/flowgpt/storefront-api/server.js`
 * (see `creditCounterCoins` and the earnedCoins() paths in server.js). We can't
 * import that repo from here, so an inline INSERT alongside the settle is a
 * cross-repo change (main session owns it) — flagged in the deliverable report.
 * Until that lands, this worker catches up from `public.orders`, which is
 * dual-written on every settle by storefront-api/db.js.
 *
 * Idempotent: unique index (tenant_id, kind='earn', order_id, party_key).
 * ticks every 10 min (dev: 60 min).
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { pollIntervalMs } from '../lib/poller-gate'

const TICK_MS = pollIntervalMs('COIN_LEDGER_SYNC_INTERVAL_MS', {
  prod: 10 * 60_000,
  dev: 60 * 60_000,
})
const LOOKBACK_HOURS = 48   // safety margin for a worker outage
const BATCH = 500

/** Read a phone-last-10 party key the same way storefront-api does. */
function partyKey(phone: string | null | undefined, guest: string | null | undefined): string {
  const p = String(phone ?? '').replace(/\D/g, '').slice(-10)
  return p || String(guest ?? '').slice(0, 64) || 'anon'
}

export async function runCoinLedgerSyncTick(supabase: SupabaseClient): Promise<{ inserted: number }> {
  const since = new Date(Date.now() - LOOKBACK_HOURS * 3600_000).toISOString()
  // `orders` is the durable mirror. Field names mirror storefront-api/db.js.
  const { data: orders, error } = await supabase
    .from('orders')
    .select('id, tenant_id, guest_phone, guest_key, coins_earned, updated_at')
    .gte('updated_at', since)
    .limit(BATCH)
  if (error || !orders?.length) return { inserted: 0 }

  const rows = orders
    .filter(o => Number(o.coins_earned) > 0 && o.tenant_id)
    .map(o => ({
      tenant_id: o.tenant_id as string,
      party_key: partyKey(o.guest_phone as any, o.guest_key as any),
      phone: String(o.guest_phone ?? '').replace(/\D/g, '').slice(-10) || null,
      delta: Math.round(Number(o.coins_earned) || 0),
      kind: 'earn' as const,
      order_id: String(o.id),
      at: o.updated_at ?? new Date().toISOString(),
    }))
  if (!rows.length) return { inserted: 0 }

  // upsert on the partial-unique index; conflicts are ignored (idempotent).
  const { error: uerr, count } = await supabase
    .from('coin_ledger')
    .upsert(rows, { onConflict: 'tenant_id,kind,order_id,party_key', ignoreDuplicates: true, count: 'exact' })
  if (uerr) console.warn('[coin-ledger-sync] upsert error:', uerr.message)
  return { inserted: count ?? 0 }
}

export function startCoinLedgerSync(supabase: SupabaseClient) {
  if (process.env.COIN_LEDGER_SYNC_DISABLED === '1') return
  const tick = () => runCoinLedgerSyncTick(supabase).catch(e => console.warn('[coin-ledger-sync] tick error:', e?.message))
  setTimeout(tick, 60_000).unref()
  setInterval(tick, TICK_MS).unref()
}
