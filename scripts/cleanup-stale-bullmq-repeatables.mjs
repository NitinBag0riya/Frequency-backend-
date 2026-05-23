#!/usr/bin/env node
/**
 * One-shot cleanup: remove BullMQ repeatable schedules that were
 * registered by the old daily-job workers (trial-ending,
 * agency-payout-aggregator, consent-expiry-sweep) before they were
 * migrated to the in-process daily scheduler in migration 104 + the
 * matching code change.
 *
 * Without this cleanup, those repeatables keep adding tick jobs to the
 * `system.cron` queue every 6h/24h. The 8 other (still-BullMQ) pollers'
 * workers pick them up, see job.name !== their-name, and short-circuit
 * with `{ skipped: "not for me" }`. So it's a small cost — a handful of
 * orphaned writes per day — but no reason to keep paying it.
 *
 * Usage:
 *   node --env-file=.env scripts/cleanup-stale-bullmq-repeatables.mjs
 *
 * Idempotent: safe to re-run; it just no-ops if the schedules are gone.
 */

import IORedis from 'ioredis'
import { Queue } from 'bullmq'

const STALE_JOB_NAMES = [
  'trial-ending-check',
  'agency-payout-aggregator',
  'consent-expiry-sweep',
]
const QUEUE_NAME = 'system.cron'

const REDIS_URL = process.env.REDIS_URL
if (!REDIS_URL) {
  console.error('REDIS_URL not set. Did you forget --env-file=.env?')
  process.exit(1)
}

const connection = new IORedis(REDIS_URL, {
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
})

const queue = new Queue(QUEUE_NAME, { connection })

try {
  const list = await queue.getRepeatableJobs()
  console.log(`Found ${list.length} repeatable(s) on ${QUEUE_NAME}:`)
  for (const r of list) {
    console.log(`  · name=${r.name}  every=${r.every}  next=${new Date(r.next).toISOString()}  key=${r.key}`)
  }

  let removed = 0
  for (const r of list) {
    if (!STALE_JOB_NAMES.includes(r.name)) continue
    console.log(`Removing stale repeatable: ${r.name}`)
    await queue.removeRepeatableByKey(r.key)
    removed++
  }
  console.log(`\nDone. Removed ${removed} stale repeatable(s).`)
} catch (err) {
  console.error('Cleanup failed:', err)
  process.exitCode = 1
} finally {
  await queue.close()
  await connection.quit()
}
