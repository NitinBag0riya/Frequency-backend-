/**
 * Advance-order KOT scheduling (POS Upgrade Phase 5, P5-INT-SCHED).
 *
 * storefront-api's advance-order route (P5-BE-5.3, flowgpt-apex
 * `storefront-api`) POSTs here — the same shared-secret internal seam as
 * `/api/internal/storefront-order` / `/api/internal/pos-approval-request` /
 * `/api/internal/pos-reservation-event` (see src/index.ts) — on:
 *   kind='created'   → schedule a one-shot callback at (scheduledAt - prepMins)
 *                      that tells storefront-api to fire the order's KOT round.
 *   kind='cancelled' → best-effort cancel a still-pending fire job.
 *
 * ─── WHY NOT schedule-trigger.ts / daily-scheduler.ts ───────────────────────
 * Those two are the WORKFLOW engine's scheduler: `schedule-trigger.ts` +
 * `workers/schedule-poller.ts` resolve `trigger_schedule` NODES inside a
 * tenant-authored automation graph (time+audience based; see
 * docs/state/pos-upgrade.md:1785 — "time+audience based, not date-in-contact-
 * field"), and `daily-scheduler.ts` is a fixed once-a-day sweep. An advance
 * order needs a single ad-hoc one-shot fire at an arbitrary future instant —
 * not a recurring workflow node and not a daily sweep. The already-proven fit
 * for that shape in this codebase is a durable BullMQ delayed job with a
 * deterministic jobId (exactly what P4-INT-RES-WA built for the reservation
 * reminder in pos-reservation-wa.ts) — reused here, not re-invented.
 *
 * ─── CALLBACK TRANSPORT (why webhookOutboundQueue, not messageQueue) ────────
 * The reservation reminder enqueues onto `messageQueue` because its payload
 * IS a WhatsApp template send. This job's payload is a plain internal HTTP
 * POST back into storefront-api — exactly the shape `webhookOutboundQueue` /
 * `workers/webhook-retry.ts` already runs for workflow HTTP nodes (generic
 * url/method/headers/body, retry schedule 1s/5s/30s/5m/30m, DLQ on
 * exhaustion). Reused via `enqueueWebhookOutbound`, extended (queue.ts) with
 * the same `delay` + custom `jobId` BullMQ mechanism `enqueueMessageSend`
 * already has — so a missed KOT fire actually retries instead of silently
 * dropping, unlike a bare `setTimeout`.
 *
 * ─── CALLBACK CONTRACT (named here for the storefront-api `backend` seat) ───
 *   POST {STOREFRONT_API_URL}/internal/pos-advance-kot
 *   Headers: x-internal-secret: <INTERNAL_TRIGGER_SECRET>
 *   Body:    { slug: string, orderId: string }
 * Mirrors the existing storefront-api inbound convention (unprefixed
 * `/internal/<name>`, same shared secret + header `complaints.ts`'s
 * `deliverStorefrontReply` already calls OUT with — this is the same seam,
 * reversed direction). Deliberately a TINY payload (slug + orderId only, no
 * order snapshot) — storefront-api re-reads the order at fire time, so a
 * stale job (order was re-priced, or prep time changed after scheduling)
 * still fires against the CURRENT order, and a job that arrives after the
 * order was already cancelled/fired is storefront-api's to no-op idempotently
 * (same "tiny payload, re-read, no stale-job drift" posture as
 * `BreachNotificationJob` in queue.ts). storefront-api owns: fail-closed on a
 * bad/missing secret, idempotent no-op if the order has no `scheduledFor`, is
 * already fired, or was cancelled, and the actual KOT-round fire. NOT invented
 * here — named for the backend seat to build against.
 */

const STOREFRONT_API_URL = process.env.STOREFRONT_API_URL || process.env.MAIN_STOREFRONT_API_URL
const INTERNAL_SECRET = process.env.INTERNAL_TRIGGER_SECRET
const CALLBACK_PATH = '/internal/pos-advance-kot'

export interface AdvanceOrderContext {
  orderId: string
  /** ISO datetime of the scheduled pickup/delivery slot ("Schedule for"). */
  scheduledAt: string
  /** Minutes of kitchen prep to subtract from `scheduledAt` for the fire time. */
  prepMins: number
}

export interface AdvanceOrderEventBody {
  /** storefront-api's own tenant slug — required: the callback re-enters
   *  storefront-api's slug-keyed JSON store, not flowgpt-server's Supabase
   *  tenant uuid. */
  slug: string
  kind: 'created' | 'cancelled'
  order: AdvanceOrderContext
}

/** Narrow, import-free duplicate of queue.ts's `WebhookOutboundJob` (POST
 *  branch only) — same reasoning as pos-reservation-wa.ts's
 *  `MessageSendJobLike`: keeps this module (and its selfcheck) free of any
 *  import that would open a Redis connection. */
export interface WebhookOutboundJobLike {
  tenantId: string | null
  source: string
  url: string
  method: 'POST'
  headers?: Record<string, string>
  body?: string
}

export type EnqueueFn = (
  job: WebhookOutboundJobLike,
  opts?: { delayMs?: number; jobId?: string },
) => Promise<unknown>

export type RemoveJobFn = (jobId: string) => Promise<void>

export function advanceKotJobId(orderId: string): string {
  return `pos-advance-kot:${orderId}`
}

/**
 * ms from now until the KOT should fire (`scheduledAt` - `prepMins`). Unlike
 * the reservation reminder (which SKIPS a reminder for a slot already
 * underway), an advance order's KOT must always eventually fire — clamped to
 * 0 (fire on the next tick) rather than skipped, so an order scheduled for
 * "in 5 min" with a 15 min prep window still reaches the kitchen instead of
 * silently never firing. Only a genuinely unparsable `scheduledAt` returns
 * `null` (caller skips scheduling — nothing sane to compute).
 */
export function fireDelayMs(scheduledAtIso: string, prepMins: number, now: number = Date.now()): number | null {
  const at = new Date(scheduledAtIso).getTime()
  if (Number.isNaN(at)) return null
  const delay = at - prepMins * 60_000 - now
  return Math.max(0, delay)
}

export interface DispatchResult {
  scheduled: boolean
  skippedReason?: string
}

/**
 * Handle a `kind='created'` event: schedule the fire-KOT callback for
 * `scheduledAt - prepMins`. Never throws — an unconfigured callback base/
 * secret, an unparsable `scheduledAt`, or an enqueue failure is reported back
 * in `skippedReason`, matching the fail-soft posture of every other notify/
 * schedule seam in this file's neighbourhood (pos-reservation-wa.ts,
 * pos-approval-notify.ts). Deliberately does NOT fire immediately on a normal
 * future slot — only a slot already inside (or past) its prep window collapses
 * to a near-zero delay (see `fireDelayMs`).
 */
export async function dispatchAdvanceOrderCreated(
  body: AdvanceOrderEventBody,
  enqueue: EnqueueFn,
): Promise<DispatchResult> {
  if (!STOREFRONT_API_URL || !INTERNAL_SECRET) {
    return { scheduled: false, skippedReason: 'STOREFRONT_API_URL/INTERNAL_TRIGGER_SECRET not configured' }
  }
  if (!body.slug || !body.order?.orderId) {
    return { scheduled: false, skippedReason: 'slug and order.orderId are required' }
  }

  const delayMs = fireDelayMs(body.order.scheduledAt, body.order.prepMins)
  if (delayMs == null) {
    return { scheduled: false, skippedReason: 'unparsable scheduledAt' }
  }

  const job: WebhookOutboundJobLike = {
    tenantId: null, // storefront-api resolves its own tenant via `slug` in the body
    source: 'pos_advance_kot',
    url: `${STOREFRONT_API_URL.replace(/\/$/, '')}${CALLBACK_PATH}`,
    method: 'POST',
    headers: { 'x-internal-secret': INTERNAL_SECRET },
    body: JSON.stringify({ slug: body.slug, orderId: body.order.orderId }),
  }

  try {
    await enqueue(job, { delayMs, jobId: advanceKotJobId(body.order.orderId) })
  } catch (e: any) {
    console.warn(`[pos-advance-kot] schedule failed for ${body.order.orderId}: ${e?.message ?? e}`)
    return { scheduled: false, skippedReason: 'enqueue failed' }
  }
  return { scheduled: true }
}

/**
 * Handle a `kind='cancelled'` event: best-effort remove the still-pending
 * fire job so a cancelled advance order never fires a KOT the kitchen never
 * asked for. A job that already fired (or never existed) is a silent no-op —
 * cancellation must never throw back at the caller.
 */
export async function cancelAdvanceKotFire(orderId: string, removeJob: RemoveJobFn): Promise<void> {
  try {
    await removeJob(advanceKotJobId(orderId))
  } catch (e: any) {
    console.warn(`[pos-advance-kot] cancel failed for ${orderId}: ${e?.message ?? e}`)
  }
}
