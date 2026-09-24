/**
 * One-shot backfill: wastage_entries ← storefront_state blob.
 * Idempotent — upsert keyed on the ledger-entry id.
 *
 * Usage: SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... npx tsx scripts/backfill-wastage.ts
 */
import '../src/env'
import { createClient } from '@supabase/supabase-js'
import { runWastageSyncTick } from '../src/workers/wastage-sync'

async function main() {
  const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)
  const { upserted } = await runWastageSyncTick(supabase)
  console.log(`[backfill-wastage] upserted=${upserted}`)
}
main().catch(e => { console.error(e); process.exit(1) })
