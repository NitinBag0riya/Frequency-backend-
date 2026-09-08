/**
 * One-shot backfill: catalog_items ← storefront_state blob.
 * Idempotent — an upsert on (tenant_id, item_id). Safe to re-run.
 *
 * Usage: SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... npx tsx scripts/backfill-catalog.ts
 */
import '../src/env'
import { createClient } from '@supabase/supabase-js'
import { runCatalogSyncTick } from '../src/workers/catalog-sync'

async function main() {
  const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)
  const { upserted, deleted } = await runCatalogSyncTick(supabase)
  console.log(`[backfill-catalog] upserted=${upserted} deleted=${deleted}`)
}
main().catch(e => { console.error(e); process.exit(1) })
