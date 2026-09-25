/**
 * Runnable self-check for the POS reservation WhatsApp confirm+reminder seam
 * (Phase 4, P4-INT-RES-WA: POST /api/internal/pos-reservation-event).
 * Run:  npx tsx src/lib/pos-reservation-wa.selfcheck.ts
 * No framework — plain asserts, no network/Redis (enqueue/removeJob are
 * injected fakes, per this module's DI contract). Exits non-zero on failure.
 *
 * Covers:
 *   1. Created reservation with a valid opted-in phone → confirm enqueued
 *      immediately (delay-less) AND a reminder enqueued with a positive delay
 *      keyed to a deterministic jobId, targeting the same phone, reusing the
 *      `frequency_notification` template — never a new one.
 *   2. reminderDelayMs is exactly (slot - holdMins) minus now, and returns
 *      null (no reminder scheduled) once that instant has passed.
 *   3. Opt-out (`whatsappOptin: false`) skips BOTH sends — proven by fail-on-old:
 *      the guard is asserted directly, not just "nothing crashed".
 *   4. An unresolvable/invalid phone is skipped, not thrown.
 *   5. Cancelling a reservation calls removeJob with the SAME deterministic
 *      jobId the reminder was enqueued under, so a cancelled table's reminder
 *      job is actually the one pulled — and never throws even if removeJob itself fails.
 */
import assert from 'node:assert/strict'
import {
  dispatchReservationCreated, cancelReservationReminder, reminderDelayMs, reminderJobId,
  normalizePhone, buildConfirmMessage, buildReminderMessage,
  type MessageSendJobLike, type ReservationEventBody,
} from './pos-reservation-wa'

// ── 2. reminderDelayMs — pure timing math ────────────────────────────────────
{
  const now = Date.UTC(2026, 8, 25, 12, 0, 0) // 2026-09-25T12:00:00Z
  const slotIn90Min = new Date(now + 90 * 60_000).toISOString()
  assert.equal(reminderDelayMs(slotIn90Min, 15, now), 75 * 60_000, 'delay = (slot - holdMins) - now')
  // Slot is 10 min out, hold is 15 min → fire instant already passed → null (skip).
  const slotIn10Min = new Date(now + 10 * 60_000).toISOString()
  assert.equal(reminderDelayMs(slotIn10Min, 15, now), null, 'already-past fire instant → no reminder scheduled')
  assert.equal(reminderDelayMs('not-a-date', 15, now), null, 'unparsable `at` → no reminder scheduled, not a throw')
}

// ── normalizePhone — same digits-only 10-15 shape as the app-user path ──────
assert.equal(normalizePhone('+919876543210'), '919876543210', 'strips leading +')
assert.equal(normalizePhone('98765'), null, 'too short → invalid')
assert.equal(normalizePhone(null), null, 'absent phone → invalid')
assert.equal(normalizePhone(undefined), null, 'undefined phone → invalid')

// ── copy: plain words (R3), no jargon ────────────────────────────────────────
{
  const { title, body } = buildConfirmMessage({ reservationId: 'r1', guestName: 'Asha', partySize: 4, at: '2026-09-25T20:00:00+05:30', tableLabel: 'Table 4 (Main)' })
  assert.equal(title, 'Reservation confirmed')
  assert.match(body, /Table for 4 \(Table 4 \(Main\)\)/)
  assert.match(body, /Hi Asha/)
  const r = buildReminderMessage({ reservationId: 'r1', partySize: 2, at: '2026-09-25T20:00:00+05:30' }, 15)
  assert.equal(r.title, 'Reservation reminder')
  assert.match(r.body, /about 15 min/)
}

async function main() {
  const now = Date.UTC(2026, 8, 25, 12, 0, 0)
  const slotIn90Min = new Date(now + 90 * 60_000).toISOString()

  // ── 1. created + opted-in valid phone → confirm now + reminder delayed ─────
  {
    const calls: { job: MessageSendJobLike; opts?: { delayMs?: number; jobId?: string } }[] = []
    const enqueue = async (job: MessageSendJobLike, opts?: { delayMs?: number; jobId?: string }) => {
      calls.push({ job, opts }); return { id: 'job-1' }
    }
    const body: ReservationEventBody = {
      tenantId: 'tenant-1', kind: 'created', phone: '+919876543210', whatsappOptin: true, holdMins: 15,
      reservation: { reservationId: 'res-42', guestName: 'Asha', partySize: 4, at: slotIn90Min, tableLabel: 'Table 4' },
    }
    // Inject `now` via reminderDelayMs's default param isn't reachable here, so
    // this call uses real Date.now() — assert on SHAPE (positive delay, right
    // jobId/template/recipient), not an exact ms value (covered above already).
    const out = await dispatchReservationCreated(body, enqueue)
    assert.equal(out.confirmed, true)
    assert.equal(out.reminderScheduled, true)
    assert.equal(calls.length, 2, 'exactly one confirm + one reminder job — never more than one channel per event (owner rule)')

    const [confirmCall, reminderCall] = calls
    assert.equal(confirmCall.job.to, '919876543210')
    assert.equal(confirmCall.job.channel, 'whatsapp')
    assert.equal(confirmCall.job.kind, 'template')
    assert.equal(confirmCall.job.template.name, 'frequency_notification', 'reuses the approved template, never a new one')
    assert.equal(confirmCall.opts?.delayMs, undefined, 'confirm fires now, no delay')

    assert.equal(reminderCall.job.to, '919876543210')
    assert.equal(reminderCall.job.template.name, 'frequency_notification')
    assert.ok((reminderCall.opts?.delayMs ?? 0) > 0, 'reminder is enqueued with a positive delay')
    assert.equal(reminderCall.opts?.jobId, reminderJobId('res-42'), 'deterministic jobId so a cancel can find it')
  }

  // ── 3. opt-out skips BOTH sends ─────────────────────────────────────────────
  {
    const calls: any[] = []
    const enqueue = async (job: MessageSendJobLike, opts?: any) => { calls.push({ job, opts }) }
    const out = await dispatchReservationCreated({
      tenantId: 'tenant-1', kind: 'created', phone: '+919876543210', whatsappOptin: false,
      reservation: { reservationId: 'res-43', partySize: 2, at: slotIn90Min },
    }, enqueue)
    assert.equal(out.confirmed, false)
    assert.equal(out.reminderScheduled, false)
    assert.match(out.skippedReason ?? '', /opted out/)
    assert.equal(calls.length, 0, 'opt-out guard actually prevents the enqueue call, not just the reported result')
  }

  // ── 4. unresolvable/invalid phone skipped, not thrown ───────────────────────
  {
    const calls: any[] = []
    const enqueue = async (job: MessageSendJobLike, opts?: any) => { calls.push({ job, opts }) }
    const out = await dispatchReservationCreated({
      tenantId: 'tenant-1', kind: 'created', phone: '123', whatsappOptin: true,
      reservation: { reservationId: 'res-44', partySize: 2, at: slotIn90Min },
    }, enqueue)
    assert.equal(out.confirmed, false)
    assert.match(out.skippedReason ?? '', /phone/)
    assert.equal(calls.length, 0)

    const outNoPhone = await dispatchReservationCreated({
      tenantId: 'tenant-1', kind: 'created', phone: null, whatsappOptin: true,
      reservation: { reservationId: 'res-45', partySize: 2, at: slotIn90Min },
    }, enqueue)
    assert.equal(outNoPhone.confirmed, false, 'missing phone never throws')
  }

  // ── slot already within the hold window → confirm still sends, no reminder ──
  {
    const calls: any[] = []
    const enqueue = async (job: MessageSendJobLike, opts?: any) => { calls.push({ job, opts }) }
    const slotIn5Min = new Date(Date.now() + 5 * 60_000).toISOString()
    const out = await dispatchReservationCreated({
      tenantId: 'tenant-1', kind: 'created', phone: '+919876543210', whatsappOptin: true, holdMins: 15,
      reservation: { reservationId: 'res-46', partySize: 2, at: slotIn5Min },
    }, enqueue)
    assert.equal(out.confirmed, true, 'confirm still fires even when it is too late for a reminder')
    assert.equal(out.reminderScheduled, false)
    assert.equal(calls.length, 1, 'exactly the confirm, no reminder job queued')
  }

  // ── 5. cancel pulls the SAME deterministic jobId, never throws on failure ───
  {
    const removedIds: string[] = []
    const removeJob = async (jobId: string) => { removedIds.push(jobId) }
    await cancelReservationReminder('res-42', removeJob)
    assert.deepEqual(removedIds, [reminderJobId('res-42')])

    const removeJobThrows = async (_jobId: string) => { throw new Error('bullmq down') }
    await assert.doesNotReject(cancelReservationReminder('res-42', removeJobThrows), 'cancel never throws back at the caller')
  }

  console.log('pos-reservation-wa.selfcheck: OK')
  console.log('  reminderDelayMs = (slot-holdMins)-now, null once past · confirm+reminder enqueued once each with the ' +
    'right phone/frequency_notification template/jobId · opt-out and invalid-phone actually prevent the enqueue call ' +
    '(not just the reported result) · cancel pulls the matching jobId and never throws')
}

main().catch((e) => { console.error('pos-reservation-wa self-check FAILED:', e); process.exit(1) })
