/**
 * Poller gate — single decision point for whether a repeatable BullMQ poller
 * should actually run. The goal is to keep Redis cost down in environments
 * where the user isn't actively driving the polled feature (dev, preview,
 * staging, low-traffic prod tenants).
 *
 * Resolution order (per poller name, e.g. "SCHEDULE_POLLER"):
 *   1. Per-poller env override: `<NAME>_ENABLED=1|0` (always wins).
 *   2. Global env override:     `POLLERS_ENABLED=1|0`.
 *   3. Default:                 ON in production, OFF everywhere else.
 *
 * Why this matters: each repeatable BullMQ job at a 30s interval generates
 * ~290k jobs/month per tenant before any user activity, and each job is
 * 5-10 Redis ops. Across 11 pollers that's millions of Redis commands per
 * month JUST from heartbeat polling — which is precisely the bill we're
 * trying to cut.
 *
 * For gated-off pollers we ALSO scrub the existing repeatable entry from
 * Redis on startup. Otherwise a previous deploy that registered the
 * repeatable would keep firing forever — BullMQ schedules outlive the
 * Worker process. See `cleanRepeatablesByName`.
 */

import type { Queue } from 'bullmq'

/**
 * Pick a poll-interval default based on NODE_ENV. Production gets the
 * tight cadence the feature actually needs; dev/staging fall back to a
 * relaxed cadence so a developer who explicitly enables a poller doesn't
 * still hammer Redis every 30 seconds. The env var name (if set) always
 * wins over both — so a CI/integration suite can pin a specific tick.
 *
 *   pollIntervalMs('SCHEDULE_POLL_MS', { prod: 30_000, dev: 300_000 })
 *
 * If the env var is set to a numeric string, that wins. Otherwise:
 *   NODE_ENV === 'production' → prod
 *   anything else             → dev
 */
export function pollIntervalMs(envName: string, opts: { prod: number; dev: number }): number {
  const raw = process.env[envName]
  if (raw && /^\d+$/.test(raw)) return Number(raw)
  return process.env.NODE_ENV === 'production' ? opts.prod : opts.dev
}

export function isPollerEnabled(name: string): boolean {
  const perPoller = process.env[`${name.toUpperCase()}_ENABLED`]
  if (perPoller === '1' || perPoller === 'true')  return true
  if (perPoller === '0' || perPoller === 'false') return false

  const global = process.env.POLLERS_ENABLED
  if (global === '1' || global === 'true')  return true
  if (global === '0' || global === 'false') return false

  return process.env.NODE_ENV === 'production'
}

/**
 * Remove any previously-registered repeatable BullMQ jobs matching `jobName`
 * on the given queue. Safe to call even if no matching repeatable exists.
 * Used by gated-off pollers on startup so stale schedules from earlier
 * deploys stop firing.
 *
 * Returns the number of repeatables removed (for logging).
 */
export async function cleanRepeatablesByName(queue: Queue, jobName: string): Promise<number> {
  let removed = 0
  try {
    const list = await queue.getRepeatableJobs()
    for (const r of list) {
      if (r.name !== jobName) continue
      await queue.removeRepeatableByKey(r.key).catch(() => {})
      removed++
    }
  } catch {
    // queue.getRepeatableJobs can throw if Redis is unreachable — that's
    // OK, there's nothing we can do at startup anyway.
  }
  return removed
}

/**
 * Stub Worker shape returned by gated-off `start*Worker()` calls. Matches
 * the close()-only surface that worker.ts uses during graceful shutdown so
 * the main entry point doesn't need conditional null checks.
 */
export type WorkerLike = { close: () => Promise<unknown> }
export const STUB_WORKER: WorkerLike = { close: async () => undefined }

/**
 * Convenience wrapper: log the gate decision once per poller in a uniform
 * format so it's easy to scan `[poller:NAME] disabled (set ...)` lines in
 * boot logs and decide what to flip on for a given environment.
 */
export function logGate(name: string, enabled: boolean) {
  if (enabled) {
    console.log(`[poller:${name}] enabled`)
  } else {
    console.log(`[poller:${name}] disabled (set ${name.toUpperCase()}_ENABLED=1 to enable, or POLLERS_ENABLED=1)`)
  }
}
