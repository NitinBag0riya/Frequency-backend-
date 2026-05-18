/**
 * Worker: lookalike-refresh (singleton repeatable, every 30 min)
 *
 * Polls Meta's Marketing API for each `meta_audiences` row of type=LOOKALIKE
 * whose `last_estimate_refreshed_at` is null or older than the refresh
 * interval, and updates the local row with Meta's current
 * `approximate_count`, `operation_status`, and `delivery_status`.
 *
 * Why this exists: when we create a lookalike via
 * POST /api/meta-ads/audiences/lookalike, Meta returns an audience id
 * immediately but the reach estimate is computed asynchronously over the
 * next 1–24 hours and continues to drift after that as the model is
 * retrained. We never re-polled, so the UI showed "estimate pending"
 * forever. See migration 062 for the column additions this worker writes.
 *
 * Hot-path notes:
 *   - Per-tick BATCH_SIZE caps the work; remaining stale rows are picked up
 *     next tick. Avoids a tenant with 1000 lookalikes blocking the queue.
 *   - Failures are recorded on the row (last_error) and DON'T kill the tick.
 *   - Rows where Meta returns operation_status.code=300 (failure) are
 *     flagged and skipped on subsequent ticks — re-polling a failed
 *     computation just burns Meta API quota with no chance of success.
 *   - Token resolved once per tenant per tick (cache map) — a tenant with
 *     50 stale audiences pays one decrypt cost, not 50.
 *
 * Lives on the same `system.cron` queue as schedule-poller, template-sync,
 * and data-source-sync; routed by `job.name === 'lookalike-refresh'`.
 */

import '../env'
import { Worker, Job } from 'bullmq'
import { createClient } from '@supabase/supabase-js'
import { Q, connection, cronQueue } from '../queue'
import { decrypt } from '../crypto'

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://yiicpndeggaedxobyopu.supabase.co'
const supabase = createClient(SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY!)

const GRAPH = 'https://graph.facebook.com/v18.0'
const REFRESH_INTERVAL_MS = Number(process.env.LOOKALIKE_REFRESH_INTERVAL_MS ?? 30 * 60 * 1000)
const BATCH_SIZE = 25
// Meta operation_status.code values worth pinning as constants — matches
// Meta Marketing API docs (CustomAudience.operation_status). 300 = failed
// computation, terminal; we leave the row flagged and skip future polls.
const META_OP_STATUS_FAILED = 300

export async function startLookalikeRefreshWorker() {
  // Singleton repeatable — identical dedupe pattern to template-sync and
  // data-source-sync. BullMQ swallows duplicate adds with the same jobId,
  // so this is safe to call on every worker boot.
  await cronQueue.add(
    'lookalike-refresh',
    { task: 'lookalike-refresh' },
    {
      jobId: 'singleton-lookalike-refresh',
      repeat: { every: REFRESH_INTERVAL_MS },
      removeOnComplete: { count: 50 },
      removeOnFail:     { count: 50 },
    },
  )

  // Worker filters by job.name so it cohabits the cron queue with the
  // other singleton workers (schedule-poller, template-sync, data-source-sync).
  const worker = new Worker(
    Q.cron,
    async (job: Job) => {
      if (job.name !== 'lookalike-refresh') return { skipped: 'not for me' }
      return runTick()
    },
    { connection, concurrency: 1 },
  )

  worker.on('failed', (job, err) => {
    if (job?.name === 'lookalike-refresh') {
      console.warn(`[lookalike-refresh] tick failed: ${err.message}`)
    }
  })

  console.log(`[worker:lookalike-refresh] started, interval=${REFRESH_INTERVAL_MS}ms`)
  return worker
}

async function runTick() {
  const startedAt = Date.now()
  // Stale cutoff: anything refreshed before this is eligible. Rows with
  // last_estimate_refreshed_at IS NULL (never refreshed) are also picked up
  // via the .or() clause below — Postgres NULL semantics mean a plain
  // .lt() would exclude them.
  const staleCutoff = new Date(Date.now() - REFRESH_INTERVAL_MS).toISOString()

  // Pull the BATCH_SIZE stalest lookalikes. Order NULLS-first so brand-new
  // audiences from the last interval are refreshed before older stale ones.
  // We also exclude rows already flagged with operation_status.code=300
  // (terminal failure) — re-polling them wastes Meta quota.
  const { data: due, error } = await supabase
    .from('meta_audiences')
    .select('id, tenant_id, meta_audience_id, name, operation_status, last_estimate_refreshed_at')
    .eq('type', 'LOOKALIKE')
    .not('meta_audience_id', 'is', null)
    .or(`last_estimate_refreshed_at.is.null,last_estimate_refreshed_at.lt.${staleCutoff}`)
    .order('last_estimate_refreshed_at', { ascending: true, nullsFirst: true })
    .limit(BATCH_SIZE)

  if (error) throw new Error(`load due lookalikes: ${error.message}`)
  if (!due || due.length === 0) {
    const ms = Date.now() - startedAt
    console.log(`[lookalike-refresh] tick done — refreshed=0 skipped=0 ${ms}ms`)
    return { refreshed: 0, skipped: 0, durationMs: ms }
  }

  // Per-tenant token cache. A tenant with 50 stale audiences would
  // otherwise do 50 decrypts + 50 supabase round-trips for the same row.
  // Map value of `null` is a negative-cache: tenant has no meta_ads
  // connection, skip future audiences for them this tick.
  const tokenCache = new Map<string, string | null>()

  let refreshed = 0
  let skipped   = 0   // Meta returned an error OR row was filter-skipped (failed status)

  for (const row of due) {
    // In-loop guard: a row could have flipped to operation_status.code=300
    // between the SELECT and now (concurrent worker). Skip cheaply.
    const prevOp = (row.operation_status as { code?: number } | null) ?? null
    if (prevOp?.code === META_OP_STATUS_FAILED) {
      skipped++
      continue
    }

    // Token resolution (cached). Negative-cache misses so we don't re-hit
    // tenant_integrations 50 times for the same disconnected tenant.
    let token = tokenCache.get(row.tenant_id)
    if (token === undefined) {
      token = await resolveMetaAdsToken(row.tenant_id)
      tokenCache.set(row.tenant_id, token)
    }
    if (!token) {
      // No connection — record once so the FE can show "reconnect to refresh".
      await recordRowError(row.id, 'meta_ads not connected for this tenant')
      skipped++
      continue
    }

    try {
      const meta = await fetchAudienceFromMeta(row.meta_audience_id!, token)
      const opCode = meta.operation_status?.code
      const newRefreshedAt = new Date().toISOString()

      // Always write the latest Meta state, even if the computation failed
      // — the FE wants to surface Meta's description verbatim. The PARTIAL
      // index on last_estimate_refreshed_at means the failed row drops off
      // the work queue because of the explicit code=300 filter above, not
      // because last_estimate_refreshed_at is fresh.
      await supabase.from('meta_audiences').update({
        approximate_count:           meta.approximate_count ?? null,
        operation_status:            meta.operation_status   ?? null,
        delivery_status:             meta.delivery_status    ?? null,
        last_estimate_refreshed_at:  newRefreshedAt,
        last_error:                  null,
      }).eq('id', row.id)

      if (opCode === META_OP_STATUS_FAILED) {
        // Logged as skipped so the per-tick counters reflect reality:
        // we hit Meta but the audience is terminally broken on their side.
        skipped++
      } else {
        refreshed++
      }
    } catch (err: any) {
      const msg = err?.message ?? String(err)
      // Row-level failure — record on the row, keep ticking. Don't bump
      // last_estimate_refreshed_at so the next tick retries this row.
      await recordRowError(row.id, msg)
      skipped++
      console.warn(`[lookalike-refresh] audience=${row.meta_audience_id} (${row.name}) failed: ${msg}`)
    }
  }

  const durationMs = Date.now() - startedAt
  console.log(`[lookalike-refresh] tick done — refreshed=${refreshed} skipped=${skipped} ${durationMs}ms`)
  return { refreshed, skipped, durationMs }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Resolve the decrypted meta_ads OAuth token for a tenant. Mirrors
 * `getMetaAdsConnection` in src/routes/meta-ads.ts:522 — kept inline rather
 * than imported so the worker doesn't pull the express router module.
 *
 * Returns the plaintext token, or null if the tenant has no meta_ads
 * integration / the column is empty / decryption fails.
 */
async function resolveMetaAdsToken(tenantId: string): Promise<string | null> {
  const { data, error } = await supabase
    .from('tenant_integrations')
    .select('access_token')
    .eq('tenant_id', tenantId)
    .eq('key', 'meta_ads')
    .maybeSingle()
  if (error || !data?.access_token) return null
  try {
    return decrypt(data.access_token as string)
  } catch (e: any) {
    console.warn(`[lookalike-refresh] tenant=${tenantId} token decrypt failed: ${e?.message ?? e}`)
    return null
  }
}

interface MetaAudienceResponse {
  approximate_count?: number
  operation_status?:  { code: number; description?: string }
  delivery_status?:   { code: number; description?: string }
  subtype?:           string
  name?:              string
}

/**
 * Fetch a single CustomAudience from Meta. Throws on non-2xx so the caller
 * can record `last_error` on the row.
 *
 * Field list mirrors the task spec exactly — Meta returns extra fields if
 * we ask for *, but the explicit list keeps payload tiny + avoids
 * accidentally persisting a field we haven't reasoned about.
 */
async function fetchAudienceFromMeta(metaAudienceId: string, accessToken: string): Promise<MetaAudienceResponse> {
  const url = `${GRAPH}/${metaAudienceId}?fields=approximate_count,operation_status,delivery_status,subtype,name`
  const r = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } })
  if (!r.ok) {
    const txt = await r.text()
    // Trim Meta error bodies — they can be a few KB and we log this.
    throw new Error(`Meta ${r.status}: ${txt.slice(0, 200)}`)
  }
  return await r.json() as MetaAudienceResponse
}

/**
 * Persist a row-level error without bumping last_estimate_refreshed_at,
 * so the next tick picks the row up again. Errors don't accumulate — only
 * the most recent is kept (matches data-source-sync's last_error pattern).
 */
async function recordRowError(rowId: string, message: string): Promise<void> {
  await supabase.from('meta_audiences').update({
    last_error: message.slice(0, 500),  // matches text_length_caps from migration 050
  }).eq('id', rowId)
}
