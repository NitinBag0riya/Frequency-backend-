/**
 * smoke-bullmq-jobids.ts
 *
 * Verifies that every enqueue helper in src/queue.ts produces a jobId
 * that BullMQ 5.76+ accepts. Background: BullMQ 5.x rejects custom jobIds
 * containing `:` because the Lua scripts use `:` as a Redis-key
 * delimiter — the previous separator (`call.dispatch:<id>` etc.) was
 * silently broken on the deployed version. This script asserts each
 * helper now uses the `--` separator and that BullMQ accepts the add.
 *
 * Each enqueue creates one real BullMQ job in the queue. We clean up
 * by calling `.remove()` on the returned Job and `.obliterate({ force })`
 * on each queue at the end so no orphan jobs are left behind.
 *
 * Usage:
 *   cd flowgpt-server
 *   npx tsx scripts/smoke-bullmq-jobids.ts
 *
 * Requires:
 *   - REDIS_URL or REDIS_HOST in .env (loaded by src/env import below)
 *   - No deploy / push side effects — pure enqueue + immediate remove.
 */

import '../src/env'
import { randomUUID } from 'node:crypto'
import {
  enqueueCallDispatch,
  enqueueCallEventIngest,
  enqueueCallRecordingArchive,
  enqueueCallTranscribe,
  enqueueBreachNotification,
  callDispatchQueue,
  callEventIngestQueue,
  callRecordingArchiveQueue,
  callTranscribeQueue,
  breachNotificationQueue,
  closeQueues,
} from '../src/queue'

interface Result {
  helper:    string
  jobId:     string | null
  accepted:  boolean
  containsColon: boolean
  error?:    string
}

async function tryEnqueue<T>(
  helper: string,
  fn: () => Promise<T>,
): Promise<Result> {
  try {
    const job = await fn() as unknown as { id?: string; remove?: () => Promise<void> }
    const jobId = job?.id ?? null
    const containsColon = typeof jobId === 'string' && jobId.includes(':')
    // Eagerly remove so we don't leave smoke jobs sitting in the queue.
    try { await job?.remove?.() } catch { /* ignore — obliterate at the end will sweep */ }
    return { helper, jobId, accepted: true, containsColon }
  } catch (err: any) {
    const msg = String(err?.message ?? err)
    return { helper, jobId: null, accepted: false, containsColon: false, error: msg }
  }
}

async function main() {
  const callSessionId = randomUUID()
  const callEventId   = randomUUID()
  const messageId     = randomUUID()
  const breachId      = randomUUID()

  const results: Result[] = []

  results.push(await tryEnqueue('enqueueCallDispatch', () =>
    enqueueCallDispatch({ callSessionId } as any),
  ))

  results.push(await tryEnqueue('enqueueCallEventIngest', () =>
    enqueueCallEventIngest({ callEventId, payload: {} } as any),
  ))

  results.push(await tryEnqueue('enqueueCallRecordingArchive', () =>
    enqueueCallRecordingArchive({ callSessionId } as any),
  ))

  results.push(await tryEnqueue('enqueueCallTranscribe', () =>
    enqueueCallTranscribe({ callSessionId } as any),
  ))

  // voiceNoteTranscribe is the helper that already used `--` from day one,
  // included here as a positive control.
  // dynamically import to dodge a circular-init hiccup in some local envs
  const { enqueueVoiceNoteTranscribe } = await import('../src/queue')
  results.push(await tryEnqueue('enqueueVoiceNoteTranscribe', () =>
    enqueueVoiceNoteTranscribe({ messageId, tenantId: randomUUID() } as any),
  ))

  results.push(await tryEnqueue('enqueueBreachNotification', () =>
    enqueueBreachNotification({ breachId }),
  ))

  console.log('\n=== BullMQ jobId smoke results ===')
  let bad = 0
  for (const r of results) {
    const flag = r.accepted && !r.containsColon ? 'PASS' : 'FAIL'
    if (flag === 'FAIL') bad++
    const idStr = r.jobId ?? '(null)'
    const err   = r.error ? ` err="${r.error.slice(0, 120)}"` : ''
    console.log(`[${flag}] ${r.helper.padEnd(36)} jobId=${idStr}${err}`)
  }

  // Clean up — obliterate each queue so no orphans linger. This is safe
  // because the queues are short-lived (we only added jobs in this run).
  await Promise.allSettled([
    callDispatchQueue.obliterate({ force: true }),
    callEventIngestQueue.obliterate({ force: true }),
    callRecordingArchiveQueue.obliterate({ force: true }),
    callTranscribeQueue.obliterate({ force: true }),
    breachNotificationQueue.obliterate({ force: true }),
  ])

  await closeQueues()
  console.log('\n=== Summary ===')
  console.log(`pass=${results.length - bad}  fail=${bad}  total=${results.length}`)
  if (bad > 0) {
    process.exit(1)
  }
}

main().catch((err) => {
  console.error('[smoke-bullmq-jobids] fatal:', err)
  process.exit(2)
})
