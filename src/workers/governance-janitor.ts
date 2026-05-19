/**
 * Worker: governance-janitor (singleton repeatable, runs hourly)
 *
 * Calls `commerce_governance_expire_stale()` (migration 100) to flip
 * any commerce_governance_actions rows whose `expires_at < now()` from
 * status='pending' to status='expired'. Idempotent SQL — running the
 * RPC twice in close succession is a no-op for the second call.
 *
 * Audit finding H5: the RPC existed but nothing was calling it, so
 * stale proposals accumulated forever — and combined with
 * `proposed_by ON DELETE SET NULL`, an offboarded employee's pending
 * proposal could become single-approver. Migration 102 also added a
 * NULL-proposer refusal inside commerce_governance_apply; this worker
 * closes the loop by ensuring pending rows don't linger.
 */

import '../env'
import { Worker, type Job } from 'bullmq'
import { createClient } from '@supabase/supabase-js'
import { Q, connection, cronQueue } from '../queue'
import { logger } from '../lib/logger'

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://yiicpndeggaedxobyopu.supabase.co'
const supabase = createClient(SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY!)

const TICK_INTERVAL_MS = Number(process.env.GOVERNANCE_JANITOR_INTERVAL_MS ?? 60 * 60 * 1000) // 1h

export async function startGovernanceJanitorWorker() {
  await cronQueue.add(
    'governance-janitor',
    {},
    {
      jobId: 'singleton-governance-janitor',
      repeat: { every: TICK_INTERVAL_MS },
      removeOnComplete: { count: 50 },
      removeOnFail:     { count: 50 },
    },
  )

  const worker = new Worker(
    Q.cron,
    async (job: Job) => {
      if (job.name !== 'governance-janitor') return { skipped: 'not for me' }
      return runTick()
    },
    { connection, concurrency: 1 },
  )

  worker.on('failed', (job, err) => {
    if (job?.name === 'governance-janitor') {
      logger.warn(`[governance-janitor] tick failed: ${err.message}`)
    }
  })

  console.log(`[worker:governance-janitor] started, interval=${TICK_INTERVAL_MS}ms`)
  return worker
}

async function runTick(): Promise<{ expired: number }> {
  const { data, error } = await supabase.rpc('commerce_governance_expire_stale')
  if (error) {
    logger.warn(`[governance-janitor] rpc failed: ${error.message}`)
    return { expired: 0 }
  }
  // The RPC returns an int (count of rows expired).
  const expired = typeof data === 'number' ? data : 0
  if (expired > 0) {
    logger.info(`[governance-janitor] expired=${expired}`)
  }
  return { expired }
}
