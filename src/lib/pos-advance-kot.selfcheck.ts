/**
 * Runnable self-check for the POS advance-order KOT scheduler
 * (Phase 5, P5-INT-SCHED: POST /api/internal/pos-advance-order-event).
 * Run:  npx tsx src/lib/pos-advance-kot.selfcheck.ts
 * No framework — plain asserts, no network/Redis (enqueue/removeJob are
 * injected fakes, per this module's DI contract). Exits non-zero on failure.
 *
 * Covers (the task's "prove it, don't just build it" asks):
 *   1. A created advance order enqueues EXACTLY ONE job (never immediately —
 *      a real positive delay), targeting storefront-api's named callback URL
 *      with the shared secret header and a tiny {slug,orderId} body, keyed to
 *      a deterministic jobId.
 *   2. fireDelayMs is exactly (scheduledAt - prepMins) - now, clamped to 0
 *      (never negative, never skipped) once that instant has already passed —
 *      an advance order's KOT must always eventually fire.
 *   3. Cancelling an advance order calls removeJob with the SAME deterministic
 *      jobId the fire was enqueued under — proving a cancel actually finds and
 *      pulls the right job, not just "nothing crashed" — and never throws even
 *      if removeJob itself fails.
 *   4. A missing `order.orderId` skips without throwing and without ever
 *      calling enqueue — proven directly on the injected fake, not inferred
 *      from the reported result. (Missing STOREFRONT_API_URL/secret takes the
 *      same first guard in `dispatchAdvanceOrderCreated`, but those are read
 *      once at module load — not worth a second dynamic import under a
 *      different env for one more early-return already covered by that guard.)
 */
import assert from 'node:assert/strict'
import type { WebhookOutboundJobLike } from './pos-advance-kot'

async function main() {
  process.env.STOREFRONT_API_URL = 'https://storefront-api.test'
  process.env.INTERNAL_TRIGGER_SECRET = 'test-secret'
  // Imported AFTER env is set — the module reads STOREFRONT_API_URL/
  // INTERNAL_TRIGGER_SECRET once at module scope.
  const {
    dispatchAdvanceOrderCreated, cancelAdvanceKotFire, fireDelayMs, advanceKotJobId,
  } = await import('./pos-advance-kot')

  const now = Date.UTC(2026, 8, 25, 12, 0, 0) // 2026-09-25T12:00:00Z
  const slotIn90Min = new Date(now + 90 * 60_000).toISOString()

  // ── 2. fireDelayMs — pure timing math, always fires, never skips ──────────
  {
    assert.equal(fireDelayMs(slotIn90Min, 15, now), 75 * 60_000, 'delay = (scheduledAt - prepMins) - now')
    // Slot is 5 min out, prep is 15 min → fire instant already passed → clamp to 0, NEVER skip.
    const slotIn5Min = new Date(now + 5 * 60_000).toISOString()
    assert.equal(fireDelayMs(slotIn5Min, 15, now), 0, 'already-past fire instant → clamp to 0, KOT must still fire')
    assert.equal(fireDelayMs('not-a-date', 15, now), null, 'unparsable scheduledAt → skip scheduling, not a throw')
  }

  // ── 1. created advance order → exactly one delayed job, right target/body ──
  {
    const calls: { job: WebhookOutboundJobLike; opts?: { delayMs?: number; jobId?: string } }[] = []
    const enqueue = async (job: WebhookOutboundJobLike, opts?: { delayMs?: number; jobId?: string }) => {
      calls.push({ job, opts }); return { id: 'job-1' }
    }
    const out = await dispatchAdvanceOrderCreated(
      { slug: 'maplemortar', kind: 'created', order: { orderId: 'ord-1', scheduledAt: slotIn90Min, prepMins: 20 } },
      enqueue,
    )
    assert.equal(out.scheduled, true)
    assert.equal(calls.length, 1, 'exactly one fire job — never double-fired, never fired immediately')

    const [{ job, opts }] = calls
    assert.equal(job.method, 'POST')
    assert.equal(job.url, 'https://storefront-api.test/internal/pos-advance-kot', 'named callback contract')
    assert.equal(job.headers?.['x-internal-secret'], 'test-secret')
    assert.deepEqual(JSON.parse(job.body ?? '{}'), { slug: 'maplemortar', orderId: 'ord-1' }, 'tiny re-read payload, no order snapshot')
    assert.ok((opts?.delayMs ?? 0) > 0, 'fired via a real delay, not immediately')
    assert.equal(opts?.jobId, advanceKotJobId('ord-1'), 'deterministic jobId so a cancel can find it')
  }

  // ── 3. cancel pulls the SAME deterministic jobId, never throws on failure ──
  {
    const removedIds: string[] = []
    const removeJob = async (jobId: string) => { removedIds.push(jobId) }
    await cancelAdvanceKotFire('ord-1', removeJob)
    assert.deepEqual(removedIds, [advanceKotJobId('ord-1')])

    const removeJobThrows = async (_jobId: string) => { throw new Error('bullmq down') }
    await assert.doesNotReject(cancelAdvanceKotFire('ord-1', removeJobThrows), 'cancel never throws back at the caller')
  }

  // ── 4. missing orderId → skipped, enqueue never called ─────────────────────
  {
    const calls: any[] = []
    const enqueue = async (job: any, opts?: any) => { calls.push({ job, opts }) }
    const out = await dispatchAdvanceOrderCreated(
      { slug: 'maplemortar', kind: 'created', order: { orderId: '', scheduledAt: slotIn90Min, prepMins: 20 } },
      enqueue,
    )
    assert.equal(out.scheduled, false)
    assert.match(out.skippedReason ?? '', /orderId/)
    assert.equal(calls.length, 0, 'guard actually prevents the enqueue call, not just the reported result')
  }

  console.log('pos-advance-kot.selfcheck: OK')
  console.log('  fireDelayMs = (scheduledAt-prepMins)-now, clamped to 0 (never skipped, never negative) once past · ' +
    'created enqueues exactly one delayed job at the named /internal/pos-advance-kot callback with the secret header ' +
    'and a tiny {slug,orderId} body, keyed to a deterministic jobId · cancel pulls the matching jobId and never throws ' +
    '· a missing orderId is skipped without ever calling enqueue')
}

main().catch((e) => { console.error('pos-advance-kot self-check FAILED:', e); process.exit(1) })
