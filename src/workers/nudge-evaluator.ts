/**
 * Worker: nudge-evaluator (Naruto §6/§16) — in-process daily scheduler, 6h cadence.
 *
 * Reuses the EXISTING daily-scheduler (lib/daily-scheduler) — NOT a new worker
 * loop, no new Redis/BullMQ. Each tick calls runNudgeTick(supabase), which:
 *   • fires cooldown-gated onboarding nudges (email/WhatsApp) via the existing
 *     send paths, and
 *   • emits platform_notifications for onboarding stalls, plan-limit breaches and
 *     payment-failure spikes (deduped).
 *
 * Gated by the shared poller flag (NUDGE_EVALUATOR) like every other daily job,
 * so it's a no-op when the flag is off — same contract as trial-ending.
 *
 * WIRE(naruto) — register in flowgpt-server/src/worker.ts alongside the other
 * daily workers (mirror startTrialEndingWorker):
 *     import { startNudgeEvaluatorWorker } from './workers/nudge-evaluator'
 *     const nudge = await startNudgeEvaluatorWorker()      // in main()
 *     // add `nudge.close()` to the Promise.allSettled([...]) in shutdown()
 */

import '../env'
import { createClient } from '@supabase/supabase-js'
import { isPollerEnabled, logGate } from '../lib/poller-gate'
import { scheduleDaily, SCHEDULE_STUB, type ScheduleHandle } from '../lib/daily-scheduler'
import { runNudgeTick } from '../lib/nudge-engine'

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://yiicpndeggaedxobyopu.supabase.co'
const supabase = createClient(SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
  auth: { persistSession: false, autoRefreshToken: false },
})

const TICK_INTERVAL_MS = Number(process.env.NUDGE_EVALUATOR_INTERVAL_MS ?? 6 * 60 * 60 * 1000)

export async function startNudgeEvaluatorWorker(): Promise<ScheduleHandle> {
  const enabled = isPollerEnabled('NUDGE_EVALUATOR')
  logGate('NUDGE_EVALUATOR', enabled)
  if (!enabled) return SCHEDULE_STUB
  return scheduleDaily('nudge-evaluator', TICK_INTERVAL_MS, async () => {
    const r = await runNudgeTick(supabase)
    console.log(`[nudge-evaluator] rules=${r.rulesEvaluated} sent=${r.sent} skipped=${r.skipped} failed=${r.failed} notified=${r.notified}`)
    return r
  })
}
