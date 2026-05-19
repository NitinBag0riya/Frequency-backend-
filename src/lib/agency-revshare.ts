/**
 * Agency revshare settlement — credit-as-refund mechanic (hardened).
 *
 * Architecture (decided 2026-05-18, hardened after security audit
 * 2026-05-19, no RazorpayX):
 *
 *   Tenant pays platform fee  → invoice.paid webhook fires
 *                              → agency_revshare_entries row inserted
 *                                (status='accrued') by billing.ts:683-715
 *
 *   Agency pays platform fee  → invoice.paid webhook fires for the agency's
 *                                OWN subscription (handleAgencyWebhookEvent)
 *                              → handler calls applyAccruedRevshareAsCredit()
 *                              → we issue a PARTIAL REFUND on the agency's
 *                                captured payment equal to the sum of their
 *                                accrued revshare entries (capped at the
 *                                payment's REMAINING refundable balance)
 *                              → revshare entries flip 'accrued' → 'paid'
 *                              → one agency_payouts row carries the refund id
 *
 * The agency's bank statement shows two lines for one billing cycle:
 *   "Frequency platform fee     —₹3499.00"
 *   "Frequency revshare credit  +₹1498.50"
 *
 * ── HARDENING vs the original implementation ─────────────────────────
 *
 * The first version had three race / double-refund risks (all P0):
 *
 *   • TOCTOU: idempotency check used `ILIKE '%payment:<id>%'` BEFORE
 *     the row insert. Concurrent webhook deliveries (Razorpay retries
 *     are common; the queue handoff at billing.ts ack-then-process
 *     made this likely) could BOTH pass and both call createRefund.
 *
 *   • Refund-first ordering: if the post-refund DB writes (entry mark
 *     as 'paid' + payout row insert) failed, the next webhook retry
 *     re-issued the refund — silent double-spend.
 *
 *   • Stale amount cap: used the webhook's `payment.amount` as the
 *     refundable ceiling. If anyone else (manual dashboard refund,
 *     customer 14-day window) had already refunded part of the same
 *     payment, the ceiling was wrong → Razorpay error AND inconsistent
 *     state on retry.
 *
 * Fix architecture (this file):
 *
 *   1. **Structural uniqueness** — migration 092 adds a column
 *      `agency_payouts.razorpay_payment_id` and a PARTIAL UNIQUE INDEX
 *      `(agency_id, razorpay_payment_id) WHERE razorpay_payment_id IS NOT NULL`.
 *
 *   2. **Insert-first protocol** — we INSERT the agency_payouts row
 *      BEFORE calling Razorpay, with status='pending' +
 *      razorpay_payout_id=NULL + razorpay_payment_id=<paymentId>.
 *      ON CONFLICT DO NOTHING: a concurrent caller's insert silently
 *      no-ops, and we detect that case via insert-returned row count
 *      and short-circuit without re-refunding.
 *
 *   3. **Refundable-balance cap** — fetch the payment from Razorpay's
 *      detail endpoint (which populates `amount_refunded`) BEFORE
 *      computing the credit amount. Use `amount - amount_refunded` as
 *      the ceiling. If the remaining balance is ≤ 0, we mark the
 *      pending payout row 'failed' and return without calling refund.
 *
 *   4. **Update-not-insert on success** — after createRefund succeeds,
 *      UPDATE the existing payout row to status='paid' +
 *      razorpay_payout_id=refund.id. Preserves the dedup key.
 *
 *   5. **Failure recovery** — if createRefund throws, mark the pending
 *      payout row 'failed' so the next webhook retry sees the existing
 *      row, hits the conflict on insert, and no-ops. Operators can
 *      re-drive by deleting the failed payout row + replaying the
 *      webhook (audited).
 *
 * ── FIFO under cap ──────────────────────────────────────────────────
 *
 *   Oldest accrued entries credited first. If their sum exceeds the
 *   refundable balance, we cover as many WHOLE entries as fit and
 *   leave the rest 'accrued' to roll forward. We do NOT split entries
 *   to chase the exact cap; the residual <= one entry rolls cleanly
 *   to the next billing cycle, keeping the ledger audit-safe.
 *
 * ── Failure-mode honesty ───────────────────────────────────────────
 *
 *   All errors are caught + logged warn. Revshare credit is a
 *   bookkeeping convenience; failing it MUST NOT break the agency's
 *   GST invoice generation or subscription status flip. The webhook
 *   responds 200 either way so Razorpay stops retrying.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { createRefund, fetchPayment } from './razorpay'
import { logger } from './logger'

export interface ApplyCreditResult {
  /** Total paise actually refunded to the agency. 0 if nothing to do. */
  credited_paise: number
  /** Razorpay refund id. null if no refund was issued. */
  refund_id: string | null
  /** IDs of revshare entries settled by this credit (flipped to 'paid'). */
  revshare_entry_ids: string[]
  /** ID of the agency_payouts row we wrote (null if no credit). */
  payout_row_id: string | null
  /** Best-effort reason string when credited_paise=0 (helps log forensics). */
  reason?: string
}

/**
 * Apply accrued revshare as a partial refund on the agency's just-captured
 * platform-fee payment.
 *
 * Safe to call multiple times for the same payment — second call is a
 * no-op because the partial unique index (agency_id, razorpay_payment_id)
 * rejects the duplicate insert and we detect that via the returned row.
 *
 * @param supabase           Service-role client
 * @param agencyId           The agency that just paid us
 * @param paymentId          Razorpay payment id from invoice.paid payload
 * @param paymentAmountPaise Captured-payment amount in paise. Treated as a
 *                            HINT only — the authoritative ceiling is
 *                            fetched live from Razorpay (`amount -
 *                            amount_refunded`) to defend against the case
 *                            where someone else already partially refunded.
 */
export async function applyAccruedRevshareAsCredit(
  supabase: SupabaseClient,
  agencyId: string,
  paymentId: string,
  paymentAmountPaise: number,
): Promise<ApplyCreditResult> {
  const empty: ApplyCreditResult = { credited_paise: 0, refund_id: null, revshare_entry_ids: [], payout_row_id: null }

  if (!paymentId || paymentAmountPaise <= 0) {
    return { ...empty, reason: 'no payment_id or zero amount hint' }
  }

  // ─── 1. RESERVATION: insert a 'pending' payout row claiming this
  //        payment id, race-safely. The partial unique index on
  //        (agency_id, razorpay_payment_id) rejects duplicates.
  //        Postgres returns 0 rows when the conflict fires; we use that
  //        as the "another worker already claimed this" signal.
  //
  // Period dates are placeholders (now-30d, now) — they get refined to
  // the actual oldest/newest covered entry's window once we know which
  // entries we're covering. We seed them now so the row passes the NOT
  // NULL constraints; an UPDATE in step 5 supplies the final values.
  const nowIso = new Date().toISOString()
  const placeholderStartIso = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()

  const { data: claimRows, error: claimErr } = await supabase
    .from('agency_payouts')
    .insert({
      agency_id:           agencyId,
      razorpay_payment_id: paymentId,
      period_start:        placeholderStartIso,
      period_end:          nowIso,
      amount_inr_paise:    0,
      status:              'pending',
      notes:               `Revshare credit reservation. payment:${paymentId}`,
    }, { count: 'exact' })
    .select('id')

  // Postgres-via-PostgREST: an ON CONFLICT collision returns the
  // duplicate-key error code. We translate that to "already claimed →
  // no-op idempotent return". Anything else is a real error.
  if (claimErr) {
    const code = (claimErr as any)?.code
    if (code === '23505') {
      // Another delivery is processing this same payment. Look up the
      // existing row so the caller knows what was credited.
      const { data: existing } = await supabase.from('agency_payouts')
        .select('id, amount_inr_paise, razorpay_payout_id, status')
        .eq('agency_id', agencyId)
        .eq('razorpay_payment_id', paymentId)
        .maybeSingle()
      logger.info(`[agency.revshare] payment ${paymentId} already claimed (status=${existing?.status ?? 'unknown'}) — skipping`)
      return {
        credited_paise:     Number(existing?.amount_inr_paise ?? 0),
        refund_id:          existing?.razorpay_payout_id ?? null,
        revshare_entry_ids: [],
        payout_row_id:      existing?.id ?? null,
        reason:             'already claimed (race-safe no-op)',
      }
    }
    logger.warn(`[agency.revshare] reservation insert failed agency=${agencyId} payment=${paymentId}: ${claimErr.message}`)
    return { ...empty, reason: `reservation failed: ${claimErr.message}` }
  }
  const payoutRowId = claimRows?.[0]?.id
  if (!payoutRowId) {
    return { ...empty, reason: 'reservation returned no row id' }
  }

  // From this point onward: any failure path must mark the reservation
  // 'failed' so the row stays as a dedup tombstone but doesn't masquerade
  // as a successful credit.
  const markFailed = async (reason: string) => {
    await supabase.from('agency_payouts')
      .update({ status: 'failed', notes: `Failed: ${reason}. payment:${paymentId}`, updated_at: new Date().toISOString() })
      .eq('id', payoutRowId)
  }

  // ─── 2. AUTHORITATIVE CEILING: fetch the live payment record so we
  //        know the actual refundable balance (= amount - amount_refunded).
  //        Defends against stale paymentAmountPaise from webhook payload.
  let refundableCapPaise = paymentAmountPaise
  try {
    const live = await fetchPayment(paymentId)
    const refunded = Number(live.amount_refunded ?? 0)
    refundableCapPaise = Math.max(0, Number(live.amount) - refunded)
  } catch (e: any) {
    logger.warn(`[agency.revshare] fetchPayment failed agency=${agencyId} payment=${paymentId}: ${e?.message ?? e}`)
    await markFailed(`fetchPayment: ${e?.message ?? 'unknown'}`)
    return { ...empty, payout_row_id: payoutRowId, reason: `fetchPayment failed: ${e?.message ?? 'unknown'}` }
  }
  if (refundableCapPaise <= 0) {
    await markFailed('no refundable balance left on payment')
    return { ...empty, payout_row_id: payoutRowId, reason: 'payment fully refunded already' }
  }

  // ─── 3. SELECT ENTRIES: pull oldest accrued entries first (FIFO).
  const { data: entries, error: qErr } = await supabase
    .from('agency_revshare_entries')
    .select('id, revshare_amount_inr_paise, period_start, period_end')
    .eq('agency_id', agencyId)
    .eq('status',    'accrued')
    .order('created_at', { ascending: true })

  if (qErr) {
    logger.warn(`[agency.revshare] query failed agency=${agencyId}: ${qErr.message}`)
    await markFailed(`entry query: ${qErr.message}`)
    return { ...empty, payout_row_id: payoutRowId, reason: 'query failed' }
  }
  if (!entries || entries.length === 0) {
    await markFailed('no accrued entries to credit')
    return { ...empty, payout_row_id: payoutRowId, reason: 'no accrued entries' }
  }

  // ─── 4. GREEDY WHOLE-ENTRY FIFO under the LIVE cap (not webhook hint).
  let creditTotal = 0
  const toCover: typeof entries = []
  for (const e of entries) {
    const amt = Number(e.revshare_amount_inr_paise ?? 0)
    if (amt <= 0) continue
    if (creditTotal + amt > refundableCapPaise) continue
    creditTotal += amt
    toCover.push(e)
  }

  if (creditTotal <= 0 || toCover.length === 0) {
    await markFailed('no entry fits under refundable cap')
    return { ...empty, payout_row_id: payoutRowId, reason: 'no entry fits under refundable cap' }
  }

  // ─── 5. ISSUE REFUND. If this throws, mark the reservation 'failed'.
  let refundId: string
  try {
    const refund = await createRefund({
      payment_id:   paymentId,
      amount_paise: creditTotal,
      notes: {
        agency_id:   agencyId,
        kind:        'revshare_credit',
        entry_count: String(toCover.length),
      },
    })
    refundId = refund.id
  } catch (e: any) {
    logger.warn(`[agency.revshare] refund failed agency=${agencyId} payment=${paymentId}: ${e?.message ?? e}`)
    await markFailed(`refund: ${e?.message ?? 'unknown'}`)
    return { ...empty, payout_row_id: payoutRowId, reason: `refund failed: ${e?.message ?? 'unknown'}` }
  }

  // ─── 6. MARK ENTRIES PAID. Critical: refund is already issued. A
  // failure here means the agency was refunded but our ledger still
  // shows 'accrued'. We log loud (CRITICAL) and continue — the dedup
  // index protects against a second refund on retry. Operators can
  // reconcile by directly updating the entry rows.
  const coveredIds = toCover.map(e => e.id)
  const nowIso2 = new Date().toISOString()
  const { error: upErr } = await supabase
    .from('agency_revshare_entries')
    .update({ status: 'paid', paid_at: nowIso2 })
    .in('id', coveredIds)
  if (upErr) {
    // Code-review P1: the previous "manual reconciliation" plan had no
    // surfacing mechanism beyond grepping `logger.error`. Emit a single
    // line with a stable [ALERT_REVSHARE_PARTIAL_FAILURE] grep token so
    // log-based alerting (Vercel/Fly drain → PagerDuty / Slack) can fire
    // on real money inconsistency. Include enough JSON for operators to
    // run the manual fix straight from the alert payload.
    logger.error(
      `[ALERT_REVSHARE_PARTIAL_FAILURE] ${JSON.stringify({
        agency_id:      agencyId,
        payment_id:     paymentId,
        refund_id:      refundId,
        amount_paise:   creditTotal,
        entry_ids:      coveredIds,
        db_error:       upErr.message,
        instructions:   'Razorpay refund SUCCEEDED but DB entry mark-paid FAILED. Manually run: UPDATE agency_revshare_entries SET status=\'paid\', paid_at=NOW() WHERE id = ANY (entry_ids);',
      })}`
    )
    // Don't return early — still finalize the payout row so the dedup
    // anchor is correct. Operators will see status='paid' + refund_id
    // even though some entries are still 'accrued'.
  }

  // ─── 7. FINALIZE PAYOUT ROW. Update placeholder period dates to the
  // actual covered range, attach the Razorpay refund id, flip status.
  const periodStarts = toCover.map(e => new Date(e.period_start).getTime())
  const periodEnds   = toCover.map(e => new Date(e.period_end).getTime())
  const periodStartIso = new Date(Math.min(...periodStarts)).toISOString()
  const periodEndIso   = new Date(Math.max(...periodEnds)).toISOString()

  const { error: finErr } = await supabase
    .from('agency_payouts')
    .update({
      period_start:       periodStartIso,
      period_end:         periodEndIso,
      amount_inr_paise:   creditTotal,
      status:             'paid',
      paid_at:            nowIso2,
      razorpay_payout_id: refundId,
      notes:              `Revshare credit (${toCover.length} entries). payment:${paymentId}`,
      updated_at:         nowIso2,
    })
    .eq('id', payoutRowId)

  if (finErr) {
    logger.error(
      `[ALERT_REVSHARE_PARTIAL_FAILURE] ${JSON.stringify({
        agency_id:      agencyId,
        payment_id:     paymentId,
        refund_id:      refundId,
        amount_paise:   creditTotal,
        payout_row_id:  payoutRowId,
        db_error:       finErr.message,
        instructions:   'Razorpay refund SUCCEEDED but agency_payouts UPDATE failed. Manually run: UPDATE agency_payouts SET status=\'paid\', razorpay_payout_id=$refund_id WHERE id=$payout_row_id;',
      })}`
    )
  }

  logger.info(`[agency.revshare] credited agency=${agencyId} amount=₹${(creditTotal/100).toFixed(2)} refund=${refundId} entries=${coveredIds.length} cap=${refundableCapPaise}`)

  return {
    credited_paise:     creditTotal,
    refund_id:          refundId,
    revshare_entry_ids: coveredIds,
    payout_row_id:      payoutRowId,
  }
}
