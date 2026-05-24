/**
 * Pipeline pack seed — boot-time idempotent upsert.
 *
 * Each pack TS manifest in src/data/packs/ exports a *_PACK_ROW constant
 * shaped like a pipeline_packs row. On every BE boot we upsert all of
 * them keyed on `slug`. This means:
 *
 *   • New pack added in code → ships to prod on the next deploy.
 *   • Manifest content edited (new template, new workflow blueprint) →
 *     the pack row in DB is refreshed without a migration.
 *   • install_count is preserved (only set on first insert, never
 *     overwritten on subsequent upserts — see the do-update clause).
 *
 * Called from src/index.ts at server startup, after the supabase
 * client is constructed. Failures are logged but don't crash boot
 * (a single bad pack file shouldn't take the API offline).
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { REAL_ESTATE_PACK_ROW } from '../data/packs/real-estate-pack'

const ALL_PACK_ROWS = [
  REAL_ESTATE_PACK_ROW,
]

export async function seedPipelinePacks(supabase: SupabaseClient): Promise<void> {
  for (const row of ALL_PACK_ROWS) {
    try {
      // Two-step: upsert without touching install_count on conflict.
      // Supabase JS client's onConflict update happens to overwrite
      // every column passed in — so we read the existing row first and
      // skip the install_count field if it's already in the DB.
      const { data: existing } = await supabase
        .from('pipeline_packs')
        .select('id, install_count, updated_at')
        .eq('slug', row.slug)
        .maybeSingle()

      if (existing) {
        // Refresh manifest + metadata; leave install_count alone.
        const { error } = await supabase
          .from('pipeline_packs')
          .update({
            name:          row.name,
            description:   row.description,
            vertical:      row.vertical,
            is_curated:    row.is_curated,
            manifest_json: row.manifest_json,
          })
          .eq('id', (existing as { id: string }).id)
        if (error) {
          console.warn(`[seed-packs] update ${row.slug} failed:`, error.message)
        }
      } else {
        const { error } = await supabase
          .from('pipeline_packs')
          .insert({ ...row, install_count: 0 })
        if (error) {
          console.warn(`[seed-packs] insert ${row.slug} failed:`, error.message)
        }
      }
    } catch (e: any) {
      console.warn(`[seed-packs] ${row.slug} threw:`, e?.message ?? e)
    }
  }
}
