/**
 * One-shot backfill: coin_ledger ← public.orders (walks every historical row).
 *
 * Emits one 'earn' row per order with coins_earned > 0. Idempotent — the
 * partial-unique index (tenant_id, kind, order_id, party_key) means re-runs
 * skip rows we already inserted.
 *
 * Usage: SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... npx tsx scripts/backfill-coin-ledger.ts
 */
import '../src/env'
import { createClient } from '@supabase/supabase-js'

const PAGE = 1000

function partyKey(phone: string | null, guest: string | null): string {
  const p = String(phone ?? '').replace(/\D/g, '').slice(-10)
  return p || String(guest ?? '').slice(0, 64) || 'anon'
}

async function main() {
  const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)
  let cursor: string | null = null
  let totalInserted = 0
  let totalSeen = 0

  for (;;) {
    let q = supabase.from('orders')
      .select('id, tenant_id, guest_phone, guest_key, coins_earned, updated_at')
      .order('updated_at', { ascending: true })
      .limit(PAGE)
    if (cursor) q = q.gt('updated_at', cursor)
    const { data: orders, error } = await q
    if (error) { console.error(error.message); process.exit(1) }
    if (!orders?.length) break

    totalSeen += orders.length
    const rows = orders
      .filter(o => Number(o.coins_earned) > 0 && o.tenant_id)
      .map(o => ({
        tenant_id: o.tenant_id as string,
        party_key: partyKey(o.guest_phone as any, o.guest_key as any),
        phone: String(o.guest_phone ?? '').replace(/\D/g, '').slice(-10) || null,
        delta: Math.round(Number(o.coins_earned) || 0),
        kind: 'earn' as const,
        order_id: String(o.id),
        at: (o.updated_at as any) ?? new Date().toISOString(),
      }))

    if (rows.length) {
      const { error: uerr, count } = await supabase.from('coin_ledger')
        .upsert(rows, { onConflict: 'tenant_id,kind,order_id,party_key', ignoreDuplicates: true, count: 'exact' })
      if (uerr) { console.error(uerr.message); process.exit(1) }
      totalInserted += count ?? 0
    }
    cursor = orders[orders.length - 1].updated_at as any
    console.log(`[backfill-coin-ledger] seen=${totalSeen} inserted=${totalInserted} cursor=${cursor}`)
    if (orders.length < PAGE) break
  }
  console.log(`[backfill-coin-ledger] done — seen=${totalSeen} inserted=${totalInserted}`)
}
main().catch(e => { console.error(e); process.exit(1) })
