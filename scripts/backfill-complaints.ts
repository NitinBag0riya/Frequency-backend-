/**
 * Backfill historic storefront complaints into the `complaints` table.
 *
 * Storefront complaints have never lived in a table — they're embedded on the
 * order object (`order.complaints[]`) plus low-rating feedback (`order.rating`
 * + `order.comment`). Those orders are mirrored to the main-DB `orders` table
 * (id, raw jsonb, tenant_id) by storefront-api/db.js. This script reads them and
 * emits one normalised `complaints` row per complaint entry, and one per rating
 * ≤ 3 that carries a comment (a low rating with text IS a complaint; a bare 5★
 * is not).
 *
 * Idempotent: unique(source, external_id) → re-running upserts, never dupes.
 * Does NOT notify (historic rows shouldn't ring the bell). Read-only against
 * orders; only writes complaints.
 *
 * Run: `npx tsx scripts/backfill-complaints.ts [--dry]`
 */
import dotenv from 'dotenv'
import { createClient } from '@supabase/supabase-js'
import { normaliseStorefrontComplaint } from '../src/routes/complaints'

dotenv.config()

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://yiicpndeggaedxobyopu.supabase.co'
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
const DRY = process.argv.includes('--dry')

async function main() {
  if (!KEY) { console.error('SUPABASE_SERVICE_ROLE_KEY not set'); process.exit(1) }
  const supabase = createClient(SUPABASE_URL, KEY)

  // Orders carry the embedded complaints in their `raw` blob. tenant_id is
  // already resolved on the row by storefront-api's dual-write.
  const { data: orders, error } = await supabase
    .from('orders').select('id, tenant_id, raw').limit(10000)
  if (error) { console.error('orders read failed:', error.message); process.exit(1) }

  const rows: Record<string, any>[] = []
  for (const o of orders ?? []) {
    const tenantId = (o as any).tenant_id
    const raw = (o as any).raw
    if (!tenantId || !raw || typeof raw !== 'object') continue

    // 1) explicit complaints[]
    const complaints = Array.isArray(raw.complaints) ? raw.complaints : []
    complaints.forEach((c: any, i: number) => {
      const text = typeof c === 'string' ? c : (c?.text ?? '')
      if (!text) return
      rows.push(normaliseStorefrontComplaint({
        tenantId, order: raw, index: i, text, at: c?.at ?? raw.createdAt ?? null, kind: 'complaint',
      }))
    })

    // 2) low-rating feedback WITH a comment (rating ≤ 3 + text)
    const rating = Number(raw.rating)
    const comment = (raw.comment ?? '').trim?.() ?? ''
    if (Number.isFinite(rating) && rating > 0 && rating <= 3 && comment) {
      rows.push(normaliseStorefrontComplaint({
        tenantId, order: raw, index: 0, text: comment, at: raw.ratedAt ?? raw.createdAt ?? null, kind: 'rating',
      }))
    }
  }

  console.log(`Found ${rows.length} storefront complaint row(s) across ${orders?.length ?? 0} orders.`)
  if (DRY) { console.log(JSON.stringify(rows.slice(0, 5), null, 2)); console.log('(dry run — nothing written)'); return }
  if (!rows.length) return

  // Upsert in batches on the (source, external_id) unique key.
  let written = 0
  for (let i = 0; i < rows.length; i += 500) {
    const batch = rows.slice(i, i + 500).map(r => ({ ...r, updated_at: new Date().toISOString() }))
    const { error: upErr } = await supabase.from('complaints')
      .upsert(batch, { onConflict: 'source,external_id', ignoreDuplicates: false })
    if (upErr) { console.error('upsert failed:', upErr.message); process.exit(1) }
    written += batch.length
  }
  console.log(`Backfilled ${written} complaint row(s).`)
}

main().catch(e => { console.error(e); process.exit(1) })
