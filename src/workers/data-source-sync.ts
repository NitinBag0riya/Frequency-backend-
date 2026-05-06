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
      let result: { imported: number; updated: number }
      if (sub.source_type === 'google_sheet') {
        result = await syncGoogleSheet(sub)
      } else {
        // Airtable / csv_url stubs — recorded as errors so the user knows it's unsupported.
        throw new Error(`source_type=${sub.source_type} not supported yet`)
      }
      await supabase.from('data_source_subscriptions').update({
        last_synced_at: new Date().toISOString(),
        next_sync_at:   new Date(Date.now() + (sub.sync_interval_minutes * 60_000)).toISOString(),
        rows_imported:  (sub.rows_imported ?? 0) + result.imported,
        rows_updated:   (sub.rows_updated  ?? 0) + result.updated,
        last_error:     null,
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

  // Read the entire tab in one go (capped to 5000 rows for safety).
  const range = `${tab_name ?? 'Sheet1'}!1:5000`
  const values = await sheetsReadRange(tenant, spreadsheet_id, range)
  const [headerRow = [], ...dataRows] = values
  if (headerRow.length === 0) return { imported: 0, updated: 0 }

  const keys = headerRow.map(keyify)
  const primaryKey = keys[0]

  // Pull existing rows once to dedupe by primary value (cheaper than per-row queries).
  const { data: existingRows } = await supabase.from('lead_rows')
    .select('id, data')
    .eq('table_id', sub.lead_table_id)
    .limit(10000)
  const byPrimary = new Map<string, { id: string; data: any }>()
  for (const r of existingRows ?? []) {
    const v = String((r.data as any)?.[primaryKey] ?? '').trim()
    if (v) byPrimary.set(v, r)
  }

  let imported = 0, updated = 0
  for (const row of dataRows) {
    const data: Record<string, string> = {}
    for (let i = 0; i < keys.length; i++) data[keys[i]] = String(row[i] ?? '')
    const pk = data[primaryKey]?.trim()
    if (!pk) continue

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

function keyify(label: string): string {
  return String(label).toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 60) || 'col'
}
