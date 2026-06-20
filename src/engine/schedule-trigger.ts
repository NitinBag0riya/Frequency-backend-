/**
 * trigger_schedule — recurring/cron workflow starts WITHOUT an always-on worker.
 *
 * Cost model (deliberate): there is no per-minute "scan every workflow" loop.
 * Instead a live workflow that owns a trigger_schedule node parks exactly ONE
 * pending `scheduled_jobs` row at its next occurrence. The existing 30s
 * schedule-poller (already running for workflow_resume / broadcast_send) fires
 * it, and the fire re-enqueues the next occurrence. So compute scales with the
 * number of scheduled workflows and how often they fire — exactly the "heavy
 * worker = chargeable" boundary — not with wall-clock idle time.
 *
 * Lifecycle:
 *   workflow PATCH/create  → syncScheduleTrigger()  (enqueue next, or cancel)
 *   poller tick (due row)  → fireScheduledWorkflow() + enqueue next
 *   workflow paused/deleted → next fire returns false → no re-enqueue (self-cleans)
 *
 * Node config (trigger_schedule.config):
 *   frequency:        'interval' | 'daily' | 'weekly'
 *   interval_minutes: number     (frequency='interval'; floored to >= MIN_INTERVAL_MINUTES)
 *   time:             'HH:MM'     (frequency='daily'|'weekly'; wall-clock in `timezone`)
 *   weekday:          0..6        (frequency='weekly'; 0=Sunday)
 *   timezone:         IANA tz     (default 'Asia/Kolkata')
 *   contact_id:       string?     (1:1 reminders; absent → audience fan-out)
 *   segment_id:       string?     (audience schedule — saved segment to message)
 *   audience:         { tags?: string[]; exclude_tags?: string[] }?  (audience by tag)
 *                                 When contact_id is absent, fireScheduledWorkflow
 *                                 resolves segment_id/audience → one session per
 *                                 contact (see engine/inbound-router.ts).
 */

import type { SupabaseClient } from '@supabase/supabase-js'

export const SCHEDULE_TRIGGER_TYPE = 'trigger_schedule'

/** Floor on interval cadence — a 1-minute schedule would hammer the poller and
 *  the workflow executor. 15 min is the smallest cadence we let through. */
export const MIN_INTERVAL_MINUTES = 15
const DEFAULT_TZ = 'Asia/Kolkata'

/** Offset (ms) between the given tz's wall clock and UTC at instant `utcMs`.
 *  offset = (wall time read as if UTC) − actual UTC. IST → +19800000. */
function tzOffsetMs(tz: string, utcMs: number): number {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  })
  const parts = dtf.formatToParts(new Date(utcMs))
  const get = (t: string) => Number(parts.find(p => p.type === t)?.value)
  // 'hour' can come back as 24 at midnight in some engines — normalise.
  const hour = get('hour') % 24
  const asUTC = Date.UTC(get('year'), get('month') - 1, get('day'), hour, get('minute'), get('second'))
  return asUTC - utcMs
}

/** UTC ms for a wall-clock (Y/M/D H:M) in `tz`. Corrects the offset twice so a
 *  candidate that crosses a DST boundary still lands on the intended wall time.
 *  (India has no DST, so the second pass is a no-op there.) */
function zonedWallToUtc(tz: string, y: number, mo: number, d: number, h: number, mi: number): number {
  const guess = Date.UTC(y, mo, d, h, mi)
  let utc = guess - tzOffsetMs(tz, guess)
  utc = guess - tzOffsetMs(tz, utc)
  return utc
}

/** Wall-clock calendar parts (in `tz`) for instant `utcMs`. */
function zonedParts(tz: string, utcMs: number) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour12: false, weekday: 'short',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit',
  })
  const parts = dtf.formatToParts(new Date(utcMs))
  const get = (t: string) => parts.find(p => p.type === t)?.value ?? ''
  const wkMap: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }
  return {
    year: Number(get('year')), month: Number(get('month')) - 1, day: Number(get('day')),
    hour: Number(get('hour')) % 24, minute: Number(get('minute')),
    weekday: wkMap[get('weekday')] ?? 0,
  }
}

function parseHHMM(time: unknown): { h: number; m: number } | null {
  const mm = /^(\d{1,2}):(\d{2})$/.exec(String(time ?? '').trim())
  if (!mm) return null
  const h = Number(mm[1]), m = Number(mm[2])
  if (h < 0 || h > 23 || m < 0 || m > 59) return null
  return { h, m }
}

/**
 * Next firing instant (ISO string) for a schedule config, strictly AFTER
 * `fromMs`. Returns null for an unusable config (so a malformed schedule simply
 * never parks a job rather than throwing on the live-transition path).
 */
export function computeNextRun(cfg: any, fromMs: number): string | null {
  const frequency = String(cfg?.frequency ?? 'daily')
  const tz = String(cfg?.timezone ?? DEFAULT_TZ)

  if (frequency === 'interval') {
    const mins = Math.max(MIN_INTERVAL_MINUTES, Math.floor(Number(cfg?.interval_minutes) || 0))
    if (!Number.isFinite(mins) || mins <= 0) return null
    return new Date(fromMs + mins * 60_000).toISOString()
  }

  const hm = parseHHMM(cfg?.time)
  if (!hm) return null

  if (frequency === 'daily') {
    const p = zonedParts(tz, fromMs)
    let utc = zonedWallToUtc(tz, p.year, p.month, p.day, hm.h, hm.m)
    if (utc <= fromMs) utc = zonedWallToUtc(tz, p.year, p.month, p.day + 1, hm.h, hm.m)
    return new Date(utc).toISOString()
  }

  if (frequency === 'weekly') {
    const targetDow = Number(cfg?.weekday)
    if (!Number.isInteger(targetDow) || targetDow < 0 || targetDow > 6) return null
    const p = zonedParts(tz, fromMs)
    let addDays = (targetDow - p.weekday + 7) % 7
    let utc = zonedWallToUtc(tz, p.year, p.month, p.day + addDays, hm.h, hm.m)
    if (utc <= fromMs) utc = zonedWallToUtc(tz, p.year, p.month, p.day + addDays + 7, hm.h, hm.m)
    return new Date(utc).toISOString()
  }

  return null
}

/** The trigger_schedule node on a workflow, or undefined. */
export function findScheduleNode(workflow: any): any | undefined {
  return (workflow?.nodes as any[] | undefined)?.find(n => n?.type === SCHEDULE_TRIGGER_TYPE)
}

/**
 * Reconcile a workflow's parked schedule job to its current state. Idempotent:
 * cancels any existing pending workflow_schedule row for this workflow, then —
 * only if it's LIVE and still owns a schedule node with a usable cadence —
 * parks exactly one fresh row at the next occurrence. Paused/test/deleted or a
 * removed schedule node leaves it cancelled. Call after create + every PATCH.
 * Fire-and-forget: never throws into the request path.
 */
export async function syncScheduleTrigger(
  supabase: SupabaseClient,
  tenantId: string,
  workflow: any,
): Promise<void> {
  const wfId = workflow?.id
  if (!wfId) return
  try {
    await supabase.from('scheduled_jobs')
      .update({ status: 'cancelled' })
      .eq('tenant_id', tenantId)
      .eq('kind', 'workflow_schedule')
      .eq('status', 'pending')
      .contains('payload', { workflowId: wfId })

    const node = findScheduleNode(workflow)
    if (!node || workflow?.status !== 'live') return

    const cfg = node.config ?? {}
    const nextRun = computeNextRun(cfg, Date.now())
    if (!nextRun) return

    await supabase.from('scheduled_jobs').insert({
      tenant_id: tenantId,
      kind: 'workflow_schedule',
      resume_at: nextRun,
      status: 'pending',
      payload: { workflowId: wfId, contactId: cfg.contact_id ?? null, schedule: cfg },
    })
  } catch {
    // best-effort — a scheduling hiccup must never block the workflow save
  }
}
