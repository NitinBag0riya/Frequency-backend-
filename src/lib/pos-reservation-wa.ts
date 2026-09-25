/**
 * Reservation WhatsApp confirm + reminder (POS Upgrade Phase 4, P4-INT-RES-WA).
 *
 * storefront-api's reservation routes (P4-BE-4.9, flowgpt-apex `storefront-api`)
 * POST here — the same shared-secret internal seam as `/api/internal/storefront-order`
 * and `/api/internal/pos-approval-request` (see src/index.ts) — on:
 *   kind='created'   → send the confirm now, schedule the reminder
 *   kind='cancelled' → best-effort cancel a still-pending reminder job
 *
 * ─── SEND PATH (why not sendWaNotification) ─────────────────────────────────
 * whatsapp-notifications.ts's `sendWaNotification` resolves its recipient from
 * `profiles.wa_number` by app-user `userId` (tenant staff with a Supabase auth
 * account). A reservation guest is a walk-in phone number with NO app user —
 * that function does not apply (see docs/state/pos-upgrade.md "4.9 WA-TEMPLATE
 * STATUS"). The real customer-facing path (storefront order confirmations,
 * feedback asks — everything that reaches a GUEST phone) is the `message.send`
 * queue: `enqueueMessageSend` → `workers/message-sender.ts`'s `sendWhatsApp()`
 * → the tenant's own WABA, `to` = any raw phone, no app-user/contact-row
 * requirement. That's what this module builds jobs for.
 *
 * ─── TEMPLATE ────────────────────────────────────────────────────────────────
 * Reuses the already-approved `frequency_notification` utility template
 * (`*{{1}}*\n{{2}}` — title bold, body under). No new Meta template authored
 * or submitted here. If the owner later wants a bespoke reservation template
 * (richer buttons/CTA), that is a genuine Meta-gated ask — flagged, not built.
 *
 * ─── REMINDER TIMING ─────────────────────────────────────────────────────────
 * No new scheduler/table. `message.send` already supports a BullMQ `delay`
 * (queue.ts's `enqueueMessageSend`, same mechanism `enqueueWorkflowExecution`
 * already uses) — durable/Redis-backed, survives a process restart, unlike
 * `setTimeout`. The reminder job's deterministic jobId lets a `cancelled`
 * event remove it before it fires.
 *
 * ─── DEPENDENCY INJECTION ────────────────────────────────────────────────────
 * `enqueue`/`removeJob` are passed in by the caller (index.ts, which already
 * imports the real queue at module scope) rather than imported here, so this
 * module — and its selfcheck — never open a Redis connection.
 */

const TEMPLATE_NAME = process.env.WA_NOTIFICATION_TEMPLATE_NAME || 'frequency_notification'
const TEMPLATE_LANG = process.env.WA_NOTIFICATION_TEMPLATE_LANG || 'en'

/** Default hold time if the reservation didn't carry one. Mirrors
 *  settings.pos.reservations.holdMins default in the storefront-api contract
 *  (P4-BE-CFG); ◆ owner default annotated 15m in the Phase-4 Gate-0 visual. */
const DEFAULT_HOLD_MINS = 15

export interface ReservationContext {
  reservationId: string
  guestName?: string | null
  partySize: number
  /** ISO datetime of the reserved slot. */
  at: string
  /** Best-effort human label, e.g. "Table 4 (Main)" — omit if not resolved. */
  tableLabel?: string | null
}

export interface ReservationEventBody {
  tenantId: string
  kind: 'created' | 'cancelled'
  phone?: string | null
  /** POS guests default WhatsApp opt-OUT (blueprint 6.4 / owner NOTE). An
   *  explicit `false` skips the send; anything else (true/undefined) sends —
   *  the caller (storefront-api) is the source of truth for consent state. */
  whatsappOptin?: boolean
  /** Minutes before `at` the reminder should fire. */
  holdMins?: number
  reservation: ReservationContext
}

/** Mirrors queue.ts's `MessageSendJob` shape (kind='template' branch only),
 *  duplicated narrowly so this module has zero import from '../queue'. */
export interface MessageSendJobLike {
  tenantId: string
  to: string
  channel: 'whatsapp'
  kind: 'template'
  template: { name: string; language: string; parameters: string[] }
}

export type EnqueueFn = (
  job: MessageSendJobLike,
  opts?: { delayMs?: number; jobId?: string },
) => Promise<unknown>

export type RemoveJobFn = (jobId: string) => Promise<void>

export function reminderJobId(reservationId: string): string {
  return `pos-reservation-reminder:${reservationId}`
}

function formatSlot(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short',
    hour: 'numeric', minute: '2-digit', hour12: true,
  })
}

/** Plain-word (R3) confirm copy: "Table for 4 (Table 4) — 25 Sep, 8:00 pm." */
export function buildConfirmMessage(ctx: ReservationContext): { title: string; body: string } {
  const table = ctx.partySize > 0 ? `Table for ${ctx.partySize}` : 'Your table'
  const label = ctx.tableLabel ? ` (${ctx.tableLabel})` : ''
  const greet = ctx.guestName ? `Hi ${ctx.guestName}, ` : ''
  return {
    title: 'Reservation confirmed',
    body: `${greet}${table}${label} is booked for ${formatSlot(ctx.at)}. See you soon!`,
  }
}

/** Plain-word reminder copy: "Table for 4 — 25 Sep, 8:00 pm (in 15 min)." */
export function buildReminderMessage(ctx: ReservationContext, holdMins: number): { title: string; body: string } {
  const table = ctx.partySize > 0 ? `Table for ${ctx.partySize}` : 'Your table'
  const label = ctx.tableLabel ? ` (${ctx.tableLabel})` : ''
  const greet = ctx.guestName ? `Hi ${ctx.guestName}, ` : ''
  return {
    title: 'Reservation reminder',
    body: `${greet}${table}${label} is at ${formatSlot(ctx.at)} — about ${holdMins} min from now.`,
  }
}

/** E.164-ish digits-only phone, 10-15 chars — same shape `sendWaNotification`
 *  (whatsapp-notifications.ts) enforces for the app-user path. */
export function normalizePhone(raw: string | null | undefined): string | null {
  if (!raw) return null
  const to = String(raw).replace(/^\+/, '').trim()
  return /^\d{10,15}$/.test(to) ? to : null
}

/**
 * ms from now until the reminder should fire (`at` - `holdMins`). `null` when
 * that instant has already passed, or `at` doesn't parse — the caller skips
 * scheduling rather than firing a "reminder" for a slot already underway/gone.
 */
export function reminderDelayMs(atIso: string, holdMins: number, now: number = Date.now()): number | null {
  const at = new Date(atIso).getTime()
  if (Number.isNaN(at)) return null
  const delay = at - holdMins * 60_000 - now
  return delay > 0 ? delay : null
}

function buildJob(tenantId: string, to: string, title: string, body: string): MessageSendJobLike {
  return {
    tenantId, to, channel: 'whatsapp', kind: 'template',
    template: { name: TEMPLATE_NAME, language: TEMPLATE_LANG, parameters: [title, body] },
  }
}

export interface DispatchResult {
  confirmed: boolean
  reminderScheduled: boolean
  skippedReason?: string
}

/**
 * Handle a `kind='created'` event: send the confirm now, schedule the
 * reminder for `at - holdMins` if that instant is still ahead. Never throws —
 * an opted-out guest, an unresolvable phone, or an enqueue failure is
 * reported back in `skippedReason`, matching the fail-soft posture of every
 * other notify seam in this file's neighbourhood (pos-approval-notify.ts,
 * whatsapp-notifications.ts).
 */
export async function dispatchReservationCreated(
  body: ReservationEventBody,
  enqueue: EnqueueFn,
): Promise<DispatchResult> {
  if (body.whatsappOptin === false) {
    return { confirmed: false, reminderScheduled: false, skippedReason: 'guest opted out of WhatsApp' }
  }
  const to = normalizePhone(body.phone)
  if (!to) {
    return { confirmed: false, reminderScheduled: false, skippedReason: 'no valid guest phone' }
  }

  const confirm = buildConfirmMessage(body.reservation)
  try {
    await enqueue(buildJob(body.tenantId, to, confirm.title, confirm.body))
  } catch (e: any) {
    console.warn(`[pos-reservation-wa] confirm enqueue failed for ${body.reservation.reservationId}: ${e?.message ?? e}`)
    return { confirmed: false, reminderScheduled: false, skippedReason: 'confirm send failed' }
  }

  const holdMins = body.holdMins ?? DEFAULT_HOLD_MINS
  const delayMs = reminderDelayMs(body.reservation.at, holdMins)
  if (delayMs == null) {
    return { confirmed: true, reminderScheduled: false, skippedReason: 'slot already within the hold window (or unparsable) — no reminder' }
  }

  const reminder = buildReminderMessage(body.reservation, holdMins)
  try {
    await enqueue(buildJob(body.tenantId, to, reminder.title, reminder.body), {
      delayMs, jobId: reminderJobId(body.reservation.reservationId),
    })
  } catch (e: any) {
    console.warn(`[pos-reservation-wa] reminder enqueue failed for ${body.reservation.reservationId}: ${e?.message ?? e}`)
    return { confirmed: true, reminderScheduled: false, skippedReason: 'reminder schedule failed' }
  }
  return { confirmed: true, reminderScheduled: true }
}

/**
 * Handle a `kind='cancelled'` event: best-effort remove the still-pending
 * reminder job so a cancelled reservation never pings the guest. A job that
 * already fired (or never existed, e.g. confirm-only path) is a silent
 * no-op — cancellation must never throw back at the caller.
 */
export async function cancelReservationReminder(
  reservationId: string,
  removeJob: RemoveJobFn,
): Promise<void> {
  try {
    await removeJob(reminderJobId(reservationId))
  } catch (e: any) {
    console.warn(`[pos-reservation-wa] reminder cancel failed for ${reservationId}: ${e?.message ?? e}`)
  }
}
