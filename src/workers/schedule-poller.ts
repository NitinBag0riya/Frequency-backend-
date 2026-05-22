/**
 * Worker: system.cron (singleton)
 *
 * Repeatable BullMQ job runs every 30s on exactly one worker (single-instance
 * lock via `jobId`). Each run:
 *   1. SELECT scheduled_jobs WHERE status='pending' AND resume_at <= now()
 *      LIMIT 200
 *   2. For each row, dispatch onto the appropriate queue:
 *        workflow_resume      → workflowQueue
 *        broadcast_send       → broadcastQueue
 *        campaign_step        → workflowQueue (TODO when campaigns ship)
 *        template_status_sync → (no-op for now; Phase 2)
 *   3. Mark dispatched.
 *
 * If the poller misses a tick (process restart), pg_cron fallback (configured
 * via SQL) can also POST to /api/internal/poll-jobs as a safety net.
 */

import '../env'
import { Worker, Job } from 'bullmq'
import { createClient } from '@supabase/supabase-js'
import {
  Q, connection, cronQueue,
  enqueueWorkflowExecution, enqueueBroadcast,
} from '../queue'
import { executeCampaignStep } from '../engine/campaign'
import { isPollerEnabled, cleanRepeatablesByName, STUB_WORKER, logGate, pollIntervalMs } from '../lib/poller-gate'

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://yiicpndeggaedxobyopu.supabase.co'
const supabase = createClient(SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY!)

// 30s in prod (matches the existing scheduled_jobs SLA expectation) but
// 5 min in dev — devs who flip POLLERS_ENABLED on still shouldn't burn
// Redis ops every half-minute. SCHEDULE_POLL_MS env always wins.
const POLL_INTERVAL_MS = pollIntervalMs('SCHEDULE_POLL_MS', { prod: 30_000, dev: 5 * 60_000 })
const BATCH_SIZE = 200

export async function startSchedulePollerWorker() {
  const enabled = isPollerEnabled('SCHEDULE_POLLER')
  logGate('SCHEDULE_POLLER', enabled)
  if (!enabled) {
    // Scrub any prior repeat-schedule so it stops firing in Redis.
    await cleanRepeatablesByName(cronQueue, 'poll-scheduled-jobs')
    return STUB_WORKER
  }

  // 1. Ensure the singleton repeatable job exists.
  //    BullMQ dedupes by jobId so repeated calls are safe.
  await cronQueue.add(
    'poll-scheduled-jobs',
    {},
    {
      jobId: 'singleton-poll-scheduled-jobs',  // ensures only one repeat schedule exists
      repeat: { every: POLL_INTERVAL_MS },
      removeOnComplete: { count: 100 },
      removeOnFail:     { count: 100 },
    }
  )

  // 2. Worker that processes each tick.
  //    Note: Q.cron is shared with template-sync. Filter by job.name so we
  //    only handle our own kind and let the other worker pick up the rest.
  const worker = new Worker(
    Q.cron,
    async (job: Job) => {
      if (job.name !== 'poll-scheduled-jobs') return { skipped: `not for me: ${job.name}` }
      const nowIso = new Date().toISOString()
      const { data: due, error } = await supabase
        .from('scheduled_jobs')
        .select('id, kind, payload, tenant_id')
        .eq('status', 'pending')
        .lte('resume_at', nowIso)
        .order('resume_at', { ascending: true })
        .limit(BATCH_SIZE)
      if (error) throw new Error(`scheduled_jobs query: ${error.message}`)
      if (!due || due.length === 0) return { dispatched: 0 }

      let dispatched = 0
      for (const row of due) {
        try {
          if (row.kind === 'workflow_resume') {
            const p = row.payload as any
            if (p?.sessionId && p?.nodeId) {
              await enqueueWorkflowExecution({ sessionId: p.sessionId, nodeId: p.nodeId })
            }
          } else if (row.kind === 'broadcast_send') {
            const p = row.payload as any
            if (p?.broadcastId) await enqueueBroadcast(p.broadcastId)
          } else if (row.kind === 'campaign_step') {
            // Lightweight — execute inline. The step itself enqueues message.send
            // jobs and re-schedules the next step via scheduled_jobs.
            const p = row.payload as any
            if (p?.enrollmentId != null && p?.stepPosition != null) {
              const result = await executeCampaignStep({
                enrollmentId: p.enrollmentId,
                stepPosition: p.stepPosition,
              })
              console.log(`[campaign] step pos=${p.stepPosition} → ${result}`)
            }
          }

          await supabase.from('scheduled_jobs')
            .update({ status: 'dispatched', dispatched_at: nowIso })
            .eq('id', row.id)
          dispatched++
        } catch (err: any) {
          await supabase.from('scheduled_jobs').update({
            attempts: ((row as any).attempts ?? 0) + 1,
            last_error: err?.message ?? String(err),
          }).eq('id', row.id)
        }
      }

      console.log(`[poller] dispatched=${dispatched}/${due.length}`)
      return { dispatched, considered: due.length }
    },
    {
      connection,
      concurrency: 1,        // singleton — never run two ticks in parallel
    }
  )

  worker.on('failed', (job, err) => {
    console.warn(`[poller] tick failed: ${err.message}`)
  })

  console.log(`[worker:poller] started, interval=${POLL_INTERVAL_MS}ms`)
  return worker
}
