/**
 * Worker: data-source-sync (singleton repeatable, every 5 minutes)
 *
 * Polls the `data_source_subscriptions` table for rows where
 *   status = 'active' AND next_sync_at <= now()
 * and re-imports the latest data from the external source into the linked
 * lead_table. Today: Google Sheets only — Airtable / CSV URL are stubbed.
 *
 * Hot-path notes:
 *   - Per-tick batch size is bounded so a slow Google API can't block the
 *     queue; remaining due subs are picked up on the next tick.
 *   - Failures don't kill the tick — we record `last_error` on the row and
 *     leave it active; the user sees the error on the FE.
 *   - Idempotent inserts: we look up by the primary-key column value before
 *     inserting, and we update existing rows by primary key on every poll.
 *
 * Lives on the same `system.cron` queue as the schedule-poller and
 * template-sync workers; routed by `job.name === 'data-source-sync'` so they
 * don't step on each other.
 */

import '../env'
import { Worker, Job } from 'bullmq'
import { createClient } from '@supabase/supabase-js'
import { Q, connection, cronQueue } from '../queue'
import { sheetsReadRange } from '../google'
import { listAllRecords } from '../lib/airtable'
import { loadMapping, applyMappingToPayload, type DecodedField } from '../lib/apply-mapping'

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://yiicpndeggaedxobyopu.supabase.co'
const supabase = createClient(SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY!)

const SYNC_INTERVAL_MS = Number(process.env.DATA_SOURCE_SYNC_INTERVAL_MS ?? 5 * 60 * 1000)
const BATCH_SIZE = 25

export async function startDataSourceSyncWorker() {
  // Singleton repeatable — same dedupe pattern as template-sync.
  await cronQueue.add(
    'data-source-sync',
    {},
    {
      jobId: 'singleton-data-source-sync',
      repeat: { every: SYNC_INTERVAL_MS },
      removeOnComplete: { count: 50 },
      removeOnFail:     { count: 50 },
    }
  )

  const worker = new Worker(
    Q.cron,
    async (job: Job) => {
      if (job.name !== 'data-source-sync') return { skipped: 'not for me' }
      return runTick()
    },
    { connection, concurrency: 1 },
  )

  worker.on('failed', (job, err) => {
    if (job?.name === 'data-source-sync') {
      console.warn(`[data-source-sync] tick failed: ${err.message}`)
    }
  })

  console.log(`[worker:data-source-sync] started, interval=${SYNC_INTERVAL_MS}ms`)
  return worker
}

async function runTick() {
  const startedAt = Date.now()
  const nowIso = new Date().toISOString()
  const { data: due, error } = await supabase
    .from('data_source_subscriptions')
    .select('*')
    .eq('status', 'active')
    .lte('next_sync_at', nowIso)
    .order('next_sync_at', { ascending: true })
    .limit(BATCH_SIZE)
  if (error) throw new Error(`load due subs: ${error.message}`)
  if (!due || due.length === 0) return { synced: 0 }

  let succeeded = 0, failed = 0, totalImported = 0, totalUpdated = 0
  for (const sub of due) {
    try {
      let result: { imported: number; updated: number; warning?: string }
      if      (sub.source_type === 'google_sheet') result = await syncGoogleSheet(sub)
      else if (sub.source_type === 'airtable')     result = await syncAirtable(sub)
      else throw new Error(`source_type=${sub.source_type} not supported yet`)
      await supabase.from('data_source_subscriptions').update({
        last_synced_at: new Date().toISOString(),
        next_sync_at:   new Date(Date.now() + (sub.sync_interval_minutes * 60_000)).toISOString(),
        rows_imported:  (sub.rows_imported ?? 0) + result.imported,
        rows_updated:   (sub.rows_updated  ?? 0) + result.updated,
        // last_error doubles as a "things the user needs to know" channel.
        // A successful sync clears it unless the source flagged a soft warning
        // (e.g. record cap hit on Airtable). The Source tab shows last_error
        // verbatim, so the warning surfaces there without a new column.
        last_error:     result.warning ?? null,
        updated_at:     new Date().toISOString(),
      }).eq('id', sub.id)
      succeeded++
      totalImported += result.imported
      totalUpdated  += result.updated
    } catch (err: any) {
      failed++
      // Bump next_sync_at by 1 interval so we retry next tick instead of busy-looping.
      await supabase.from('data_source_subscriptions').update({
        last_error:     err?.message ?? String(err),
        next_sync_at:   new Date(Date.now() + (sub.sync_interval_minutes * 60_000)).toISOString(),
        updated_at:     new Date().toISOString(),
      }).eq('id', sub.id)
      console.warn(`[data-source-sync] sub=${sub.id} failed: ${err?.message}`)
    }
  }

  const ms = Date.now() - startedAt
  console.log(`[data-source-sync] tick done — synced=${succeeded} failed=${failed} imported=${totalImported} updated=${totalUpdated} ${ms}ms`)
  return { synced: succeeded, failed, totalImported, totalUpdated, durationMs: ms }
}

// ── Google Sheets sync ───────────────────────────────────────────────────────
async function syncGoogleSheet(sub: any): Promise<{ imported: number; updated: number }> {
  const { spreadsheet_id, tab_name } = (sub.source_config ?? {}) as { spreadsheet_id: string; tab_name?: string }
  if (!spreadsheet_id) throw new Error('subscription missing spreadsheet_id')

  // Tenant-scoped Google access
  const { data: tenant } = await supabase.from('tenants')
    .select('id, user_id, google_access_token, google_refresh_token, google_token_expiry')
    .eq('id', sub.tenant_id).maybeSingle()
  if (!tenant?.google_access_token) throw new Error('Google not connected for this tenant')

  // Optional pinned mapping from the global library — applied to every row
  // after the raw header→key step. When absent, falls back to the legacy
  // keyify-only path (back-compat). Identifier-level access control happens
  // inside loadMapping (tenant-scoped query).
  const pinnedMapping = await loadMapping(supabase, sub.tenant_id, sub.default_mapping_id)

  // Read the entire tab in one go (capped to 5000 rows for safety).
  const range = `${tab_name ?? 'Sheet1'}!1:5000`
  const values = await sheetsReadRange(tenant, spreadsheet_id, range)
  const [headerRow = [], ...dataRows] = values
  if (headerRow.length === 0) return { imported: 0, updated: 0 }

  const keys = headerRow.map(keyify)
  const primaryKey = keys[0]

  // Pull existing rows once to dedupe by primary value (cheaper than per-row queries).
  // When a mapping is pinned, the visible `data` no longer carries the raw
  // header keys — so we also stash the raw primary-key value under
  // `_source_pk` on every write. Lookup tries both: `_source_pk` first
  // (mapping-aware, stable across renames), `primaryKey` second (legacy
  // rows written before mappings were pinned). New code keeps writing both.
  const { data: existingRows } = await supabase.from('lead_rows')
    .select('id, data')
    .eq('table_id', sub.lead_table_id)
    .limit(10000)
  const byPrimary = new Map<string, { id: string; data: any }>()
  for (const r of existingRows ?? []) {
    const v = String(
      (r.data as any)?._source_pk
      ?? (r.data as any)?.[primaryKey]
      ?? '',
    ).trim()
    if (v) byPrimary.set(v, r)
  }

  let imported = 0, updated = 0
  for (const row of dataRows) {
    // Build the raw header-keyed object first. This is the shape the pinned
    // mapping operates on — same shape the user sees in the FE preview when
    // they pasted a sample, so transforms behave identically.
    const rawByHeader: Record<string, string> = {}
    for (let i = 0; i < keys.length; i++) rawByHeader[keys[i]] = String(row[i] ?? '')

    // When a mapping is pinned, apply it. Otherwise: pass-through (legacy
    // behaviour — every header → column key, raw value). We always stash
    // the raw primary-key under `_source_pk` so dedup stays stable across
    // mapping changes (see the byPrimary build above).
    const data: Record<string, string> = pinnedMapping
      ? applyMappingToPayload(pinnedMapping, rawByHeader)
      : { ...rawByHeader }

    const pk = String(rawByHeader[primaryKey] ?? '').trim()
    if (!pk) continue
    data._source_pk = pk

    const existing = byPrimary.get(pk)
    if (existing) {
      // Update only if any value changed
      const prev = existing.data as Record<string, any>
      let changed = false
      for (const k of keys) if (String(prev?.[k] ?? '') !== data[k]) { changed = true; break }
      if (changed) {
        await supabase.from('lead_rows')
          .update({ data, updated_at: new Date().toISOString() })
          .eq('id', existing.id)
        updated++
      }
    } else {
      await supabase.from('lead_rows').insert({
        tenant_id: sub.tenant_id,
        user_id:   tenant.user_id,
        table_id:  sub.lead_table_id,
        data, status: 'new', tags: [],
      })
      imported++
    }
  }
  return { imported, updated }
}

// ── Airtable sync ────────────────────────────────────────────────────────────
// Same shape as syncGoogleSheet: pull all records (capped to 5000),
// dedupe against existing rows by Airtable's stable record id (which we
// stash in lead_rows.data.airtable_record_id), insert new + update changed.
async function syncAirtable(sub: any): Promise<{ imported: number; updated: number; warning?: string }> {
  const { base_id, table_id, table_name, view } = (sub.source_config ?? {}) as any
  if (!base_id) throw new Error('subscription missing base_id')
  // Either form is accepted by listAllRecords / Airtable's REST API. Mirror
  // endpoint stashes both `table_id` (Airtable id 'tblXXX') and `table_name`
  // (human-readable) — prefer the id since it's stable across renames.
  const tableRef = String(table_id ?? table_name ?? '')
  if (!tableRef) throw new Error('subscription missing table_id and table_name')

  // Pull tenant for user_id (for lead_rows.user_id which is NOT NULL).
  const { data: tenant } = await supabase.from('tenants')
    .select('id, user_id').eq('id', sub.tenant_id).maybeSingle()
  if (!tenant) throw new Error('tenant not found')

  // Pull all records (worker reuses getValidToken for refresh) — capped at
  // 5000 records per sync to bound memory + Airtable rate-limit exposure.
  const records = await listAllRecords(supabase, sub.tenant_id, base_id, tableRef, {
    view,
    maxPages: 50,  // 50 × 100 = 5000
  })
  // Track whether we hit the cap so we can surface it as last_error rather
  // than silently dropping records 5001+. Worker tick records 'truncated'
  // suffix on the subscription so the user sees it on the Source tab.
  const hitCap = records.length >= 50 * 100
  if (records.length === 0) return { imported: 0, updated: 0 }

  // The mapping was stashed at mirror time (field name → our column key).
  // This is the static rename-only map. The richer `default_mapping_id`
  // below (if pinned) layers transforms on top of this rename — the user
  // can lowercase emails, coerce budgets to numbers, regex-extract IDs etc.
  const fieldMap = (sub.column_mappings ?? {}) as Record<string, string>

  // Optional pinned mapping with transforms (separate from the static
  // rename map above). When set, it runs AFTER the rename map normalizes
  // Airtable's field names to our column keys — so users can pin a single
  // mapping in the library and reuse it across the webhook + the sheets +
  // the airtable source for the same target table.
  const pinnedMapping = await loadMapping(supabase, sub.tenant_id, sub.default_mapping_id)

  // Dedupe via Airtable's stable record id, stashed into data.airtable_record_id
  // on every insert. Far more reliable than a column-value primary key for
  // Airtable specifically (records can be renamed; ids never change).
  const { data: existingRows } = await supabase.from('lead_rows')
    .select('id, data')
    .eq('table_id', sub.lead_table_id)
    .limit(10000)
  const byRecordId = new Map<string, { id: string; data: any }>()
  for (const r of existingRows ?? []) {
    const rid = (r.data as any)?.airtable_record_id
    if (rid) byRecordId.set(String(rid), r)
  }

  let imported = 0, updated = 0
  for (const rec of records) {
    // Step 1: apply the static rename map (Airtable field name → our key).
    const renamed: Record<string, string> = {}
    for (const [fieldName, value] of Object.entries(rec.fields)) {
      const key = fieldMap[fieldName] ?? keyify(fieldName)
      renamed[key] = value == null ? '' : (typeof value === 'object' ? JSON.stringify(value) : String(value))
    }

    // Step 2: if a pinned mapping exists, run the renamed object through
    // the transform pipeline. Otherwise pass-through. Always keep the
    // Airtable record id so the dedupe map above keeps working.
    const data: Record<string, string> = pinnedMapping
      ? { ...applyMappingToPayload(pinnedMapping, renamed), airtable_record_id: rec.id }
      : { airtable_record_id: rec.id, ...renamed }

    const existing = byRecordId.get(rec.id)
    if (existing) {
      // Compare full data shape — change-detect to avoid useless writes.
      const prev = existing.data as Record<string, any>
      let changed = false
      for (const k of Object.keys(data)) if (String(prev?.[k] ?? '') !== data[k]) { changed = true; break }
      if (changed) {
        await supabase.from('lead_rows')
          .update({ data, updated_at: new Date().toISOString() })
          .eq('id', existing.id)
        updated++
      }
    } else {
      await supabase.from('lead_rows').insert({
        tenant_id: sub.tenant_id,
        user_id:   tenant.user_id,
        table_id:  sub.lead_table_id,
        data, status: 'new', tags: [],
        ingest_source: 'sync',
      })
      imported++
    }
  }
  return {
    imported, updated,
    warning: hitCap ? 'Sync truncated at 5000 records — only the first 5000 are mirrored each tick. Use Airtable views to filter or contact support to raise the cap.' : undefined,
  }
}

function keyify(label: string): string {
  return String(label).toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 60) || 'col'
}
