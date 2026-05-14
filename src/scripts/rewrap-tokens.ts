/**
 * One-time migration: re-encrypt every encrypted-at-rest token from legacy
 * AES-256-CBC format to the new v1 (AES-256-GCM) format defined in
 * src/crypto.ts.
 *
 * Run AFTER deploying the GCM upgrade (B5). The new encrypt() always writes
 * v1, but existing rows continue to read fine via the legacy CBC fallback in
 * decrypt(). This script forces them to v1 so we can eventually drop the
 * fallback.
 *
 * Usage:
 *   npx tsx src/scripts/rewrap-tokens.ts            # dry-run, prints counts
 *   npx tsx src/scripts/rewrap-tokens.ts --apply    # actually writes
 *
 * Env required: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, GOOGLE_TOKEN_SECRET
 *
 * Idempotent. Safe to run multiple times — already-v1 ciphertexts are
 * skipped (we detect by the `v1:` prefix on the stored value).
 *
 * Tables/columns (derived from grep of `encrypt(` callsites):
 *   tenants                      access_token, google_access_token, google_refresh_token
 *   tg_bots                      bot_token
 *   tenant_integrations          access_token, refresh_token
 *
 * If a new encrypted column is added in the future, add it to TABLE_COLS
 * below and re-run this script.
 */

import '../env'
import { createClient } from '@supabase/supabase-js'
import { encrypt, decrypt } from '../crypto'

const SUPABASE_URL = process.env.SUPABASE_URL!
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY!
if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error('[rewrap] SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY required')
  process.exit(1)
}
if (!process.env.GOOGLE_TOKEN_SECRET) {
  console.error('[rewrap] GOOGLE_TOKEN_SECRET required (must match production key, otherwise legacy decrypt will fail)')
  process.exit(1)
}

const supabase = createClient(SUPABASE_URL, SERVICE_KEY)
const APPLY = process.argv.includes('--apply')

const TABLE_COLS: { table: string; pk: string; cols: string[] }[] = [
  { table: 'tenants',             pk: 'id', cols: ['access_token', 'google_access_token', 'google_refresh_token'] },
  { table: 'tg_bots',             pk: 'id', cols: ['bot_token'] },
  { table: 'tenant_integrations', pk: 'id', cols: ['access_token', 'refresh_token'] },
]

const VERSION_PREFIX = 'v1:'

async function rewrapTable(table: string, pk: string, cols: string[]) {
  console.log(`\n[rewrap] === ${table} (${cols.join(', ')}) ===`)
  const { data, error } = await supabase.from(table).select([pk, ...cols].join(','))
  if (error) { console.error(`[rewrap] read failed:`, error.message); return }
  let scanned = 0, alreadyV1 = 0, plaintext = 0, rewrapped = 0, failed = 0
  for (const row of (data ?? []) as Array<Record<string, any>>) {
    scanned++
    const update: Record<string, string | null> = {}
    let dirty = false
    for (const col of cols) {
      const v = row[col]
      if (v == null || v === '') continue
      if (typeof v !== 'string') continue
      if (v.startsWith(VERSION_PREFIX)) { alreadyV1++; continue }
      // Try to decrypt via legacy CBC. If decrypt() returns the input
      // unchanged AND the input doesn't look like a hex IV pair, treat as
      // plaintext and skip (we don't want to "encrypt" garbage).
      const decrypted = decrypt(v)
      if (decrypted === v) {
        // Either ciphertext failed to decrypt, OR the value was never encrypted.
        // Heuristic: legacy ciphertexts are `<32hex>:<hex>` (IV is 16 bytes).
        const looksLikeCbc = /^[0-9a-f]{32}:[0-9a-f]+$/i.test(v)
        if (!looksLikeCbc) { plaintext++; continue }
        // Looks like CBC but didn't decrypt — likely key mismatch. Skip + count.
        failed++
        continue
      }
      const reEncrypted = encrypt(decrypted)
      if (reEncrypted == null) { failed++; continue }
      update[col] = reEncrypted
      dirty = true
    }
    if (dirty) {
      if (APPLY) {
        const { error: updErr } = await supabase.from(table).update(update).eq(pk, row[pk])
        if (updErr) { console.error(`[rewrap] update ${table}.${row[pk]} failed:`, updErr.message); failed++ }
        else rewrapped++
      } else {
        rewrapped++  // count would-be writes in dry-run
      }
    }
  }
  console.log(`[rewrap] ${table}: scanned=${scanned} alreadyV1=${alreadyV1} plaintext-skipped=${plaintext} ${APPLY ? 'rewrapped' : 'would-rewrap'}=${rewrapped} failed=${failed}`)
}

async function main() {
  console.log(`[rewrap] mode=${APPLY ? 'APPLY (writing)' : 'DRY-RUN (no writes)'}`)
  for (const t of TABLE_COLS) {
    await rewrapTable(t.table, t.pk, t.cols)
  }
  console.log('\n[rewrap] done. Re-run with --apply to commit if dry-run looked sane.')
}

main().catch(err => {
  console.error('[rewrap] fatal:', err)
  process.exit(1)
})
