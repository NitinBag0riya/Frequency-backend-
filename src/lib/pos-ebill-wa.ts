/**
 * E-bill WhatsApp API dispatch (POS Upgrade Phase 6, 6.5).
 *
 * storefront-api POSTs here on settle when `settings.pos.eBill` = 'always'
 * (or the operator confirms an 'ask' prompt) — the same shared-secret
 * internal seam as `/api/internal/pos-reservation-event` /
 * `/api/internal/pos-approval-request` (see src/index.ts).
 *
 * ─── wa.me STAYS THE FALLBACK ────────────────────────────────────────────────
 * Phase-0's `sendEBill` (dashboard POSPage) already opens wa.me with a
 * prefilled message + the `/track/<id>?t=<shareToken>` receipt link —
 * operator-initiated click-to-chat, no template, no consent needed, and it
 * ALREADY SHIPS today regardless of anything in this file. This module is
 * the upgrade: a server-side send at settle time (no manual tap) via the
 * WA-API, through the same customer-facing `message.send` queue the
 * reservation/advance-order work uses (never sendWaNotification — that
 * resolves recipients from `profiles.wa_number` by app-user, and a bill
 * guest is a walk-in phone number with no app-user row).
 *
 * ─── TEMPLATE GATE ────────────────────────────────────────────────────────────
 * A dedicated e-bill UTILITY template is NOT present in code/env today —
 * submitting/confirming one at Meta is `BLOCKED: needs research` (never
 * invent a template name/vars — CLAUDE.md rule 3). Until
 * WA_EBILL_TEMPLATE_NAME is set, `dispatchEBill` is a no-op that reports
 * `sent: false` — it never throws and never silently "succeeds"; the caller
 * (storefront-api) keeps relying on the wa.me fallback, which is unaffected
 * by anything here.
 *
 * ─── CONSENT ──────────────────────────────────────────────────────────────────
 * `whatsappOptin === false` (POS default-unticked consent checkbox, 6.4) skips
 * the send — the caller (storefront-api) is the source of truth for the
 * consent state captured at billing, same contract as
 * pos-reservation-wa.ts's ReservationEventBody.whatsappOptin.
 */

export interface EBillEventBody {
  tenantId: string
  orderId: string
  phone?: string | null
  /** POS consent checkbox state at THIS bill (6.4). An explicit `false`
   *  skips the send — anything else (true/undefined) is eligible, matching
   *  ReservationEventBody's contract in pos-reservation-wa.ts. */
  whatsappOptin?: boolean
  /** Guest-facing receipt link, e.g. `${storeUrl}/track/<id>?t=<shareToken>`
   *  (the same 0.17 link sendEBill's wa.me path already uses). */
  billUrl: string
  /** Total shown in the message, already formatted (e.g. "₹640"). */
  amountLabel?: string | null
}

/** Mirrors queue.ts's MessageSendJob (kind='template' branch only) — kept
 *  narrow so this module has zero import from '../queue', same DI reasoning
 *  as pos-reservation-wa.ts. */
export interface MessageSendJobLike {
  tenantId: string
  to: string
  channel: 'whatsapp'
  kind: 'template'
  template: { name: string; language: string; parameters: string[] }
}

export type EnqueueFn = (job: MessageSendJobLike) => Promise<unknown>

export interface EBillDispatchResult {
  sent: boolean
  skippedReason?: string
}

/** E.164-ish digits-only phone, 10-15 chars. */
export function normalizePhone(raw: string | null | undefined): string | null {
  if (!raw) return null
  const to = String(raw).replace(/^\+/, '').trim()
  return /^\d{10,15}$/.test(to) ? to : null
}

/**
 * Send the e-bill via the WA-API, gated on the approved template existing.
 * Never throws — an unset template, an opted-out guest, an unresolvable
 * phone, or an enqueue failure all come back as `sent: false` with a reason;
 * the wa.me path is unaffected either way.
 *
 * `templateName`/`templateLang` default to the env-configured values
 * (WA_EBILL_TEMPLATE_NAME / _LANG — empty = not configured = inert) but are
 * accepted as params so the self-check can exercise both the gated-off and
 * gated-on branches without a process restart.
 */
export async function dispatchEBill(
  body: EBillEventBody,
  enqueue: EnqueueFn,
  opts: { templateName?: string; templateLang?: string } = {},
): Promise<EBillDispatchResult> {
  const templateName = opts.templateName ?? (process.env.WA_EBILL_TEMPLATE_NAME || '')
  const templateLang = opts.templateLang ?? (process.env.WA_EBILL_TEMPLATE_LANG || 'en')
  if (!templateName) {
    return { sent: false, skippedReason: 'e-bill UTILITY template not configured (Meta-approval-gated) — wa.me fallback stays the only path' }
  }
  if (body.whatsappOptin === false) {
    return { sent: false, skippedReason: 'guest opted out of WhatsApp at billing' }
  }
  const to = normalizePhone(body.phone)
  if (!to) {
    return { sent: false, skippedReason: 'no valid guest phone' }
  }
  if (!body.billUrl) {
    return { sent: false, skippedReason: 'no bill link' }
  }
  const parameters = [body.amountLabel || '', body.billUrl]
  try {
    await enqueue({
      tenantId: body.tenantId, to, channel: 'whatsapp', kind: 'template',
      template: { name: templateName, language: templateLang, parameters },
    })
    return { sent: true }
  } catch (e: any) {
    console.warn(`[pos-ebill-wa] enqueue failed for order ${body.orderId}: ${e?.message ?? e}`)
    return { sent: false, skippedReason: 'send failed' }
  }
}
