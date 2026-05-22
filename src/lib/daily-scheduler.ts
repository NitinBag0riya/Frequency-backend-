/**
 * In-process daily scheduler — replaces BullMQ repeatables for jobs that
 * tick at 6h/24h cadence. Those intervals don't benefit from BullMQ's
 * retry/visibility/DLQ machinery, and each repeatable cost ~30 Redis ops
 * per tick + a permanent Worker connection that idled on BRPOPLPUSH.
 *
 * Coordination model:
 *   - Every replica that calls scheduleDaily() starts its own setInterval.
 *   - On each check tick, it asks Postgres (via try_claim_job_tick RPC,
 *     migration 104) "has more than <interval> elapsed since the last
 *     run?". Postgres does an atomic upsert that only one caller can
 *     win → exactly one replica runs the handler per logical interval.
 *   - Check cadence is the smaller of (interval, 5 min). At 5 min checks
 *     a 24h job costs ~288 Postgres RPCs/day across all replicas — orders
 *     of magnitude cheaper than the equivalent BullMQ Redis traffic.
 *
 * Trade-offs vs BullMQ:
 *   ✓ Zero Redis ops for the schedule itself
 *   ✓ No Worker connection needed
 *   ✓ Idempotent — claim arbitration is atomic in Postgres
 *   ✗ No automatic retry/backoff — the handler is responsible
 *   ✗ No "queued jobs" UI — fine, these are heartbeat sweeps, not requeueable
 *
 * Usage:
 *   import { scheduleDaily, type ScheduleHandle } from '../lib/daily-scheduler'
 *
 *   export function startTrialEndingWorker(): ScheduleHandle {
 *     if (!isPollerEnabled('TRIAL_ENDING')) return SCHEDULE_STUB
 *     return scheduleDaily('trial-ending', 6 * 60 * 60 * 1000, runTick)
 *   }
 */

import '../env'
import { createClient } from '@supabase/supabase-js'

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://yiicpndeggaedxobyopu.supabase.co'
const supabase = createClient(SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
  auth: { persistSession: false, autoRefreshToken: false },
})

export interface ScheduleHandle {
  /** Match the WorkerLike close() shape that worker.ts uses on shutdown. */
  close: () => Promise<void>
}

/** No-op handle returned when a daily job is gated off by env. */
export const SCHEDULE_STUB: ScheduleHandle = { close: async () => undefined }

/**
 * Register a recurring job that fires at most once per `intervalMs` window
 * across the entire fleet. The handler may take longer than the check
 * cadence — overlap is prevented by the table claim, not by an in-process
 * lock, so even a long-running tick on one replica won't double-fire on
 * another.
 *
 * @param name       Stable identifier (logged + used as the claim key).
 * @param intervalMs Minimum gap between successive runs.
 * @param handler    Idempotent async function. Errors are caught + logged
 *                   and recorded in system_job_runs.last_error.
 */
export function scheduleDaily(
  name: string,
  intervalMs: number,
  handler: () => Promise<unknown>,
): ScheduleHandle {
  // Check at most every 5 min; for sub-5min intervals we just check on the
  // interval. The check itself is one cheap RPC. A short check cadence
  // means restarts recover within minutes rather than waiting up to a
  // full interval for the next tick.
  const CHECK_MS = Math.min(intervalMs, 5 * 60_000)
  const intervalSql = `${Math.max(1, Math.floor(intervalMs / 1000))} seconds`

  let stopped = false
  let inflight = false

  async function tick() {
    if (stopped || inflight) return
    inflight = true
    try {
      const { data: claimed, error } = await supabase.rpc('try_claim_job_tick', {
        p_name:         name,
        p_min_interval: intervalSql,
      })
      if (error) {
        console.warn(`[scheduler:${name}] claim RPC failed: ${error.message}`)
        return
      }
      if (claimed !== true) return  // another replica owns this tick

      const startedAt = Date.now()
      console.log(`[scheduler:${name}] tick running`)
      let errMsg: string | null = null
      try {
        await handler()
      } catch (e: any) {
        errMsg = e?.message ?? String(e)
        console.error(`[scheduler:${name}] handler failed:`, e)
      }
      const ms = Date.now() - startedAt
      // Best-effort completion record. If this fails the next tick still
      // works — try_claim_job_tick keys off last_run_at, not last_completed.
      try {
        const { error: markErr } = await supabase.rpc('mark_job_tick_complete', {
          p_name:  name,
          p_error: errMsg,
        })
        if (markErr) console.warn(`[scheduler:${name}] mark_complete failed: ${markErr.message}`)
      } catch (e: any) {
        console.warn(`[scheduler:${name}] mark_complete threw: ${e?.message ?? e}`)
      }
      console.log(`[scheduler:${name}] tick done in ${ms}ms${errMsg ? ` (with error)` : ''}`)
    } catch (e: any) {
      console.warn(`[scheduler:${name}] tick wrapper error: ${e?.message ?? e}`)
    } finally {
      inflight = false
    }
  }

  // Kick off immediately so the first run lands within the check window
  // on boot rather than waiting `CHECK_MS` for the first setInterval fire.
  // Inflight + table claim still gate against concurrent replicas.
  void tick()
  const timer = setInterval(tick, CHECK_MS)
  console.log(`[scheduler:${name}] registered (interval=${intervalMs}ms, check=${CHECK_MS}ms)`)

  return {
    close: async () => {
      stopped = true
      clearInterval(timer)
    },
  }
}
