/**
 * Razorpay webhook payload processor — shared between the live route
 * (routes/billing.ts) and the queue worker (workers/webhook-retry.ts).
 *
 * The route used to inline all of this. When WEBHOOK_QUEUE_ENABLED=1 the
 * route hands off to the queue, which calls this helper. When the flag is
 * off, the route calls this directly. Same code path either way, so we
 * can flip the flag mid-flight without regressing behaviour.
 *
 * Input: the ALREADY-PARSED webhook body (signature verified upstream).
 * Output: void on success, throws on retryable failure. Unknown event
 * types are silently ignored (Razorpay sends ~50 event kinds; we only
 * action a handful).
 */

import type { SupabaseClient } from '@supabase/supabase-js'

export async function processRazorpayWebhookPayload(
  supabase: SupabaseClient,
  payload: any,
): Promise<void> {
  const event = String(payload?.event ?? '')
  const sub   = payload?.payload?.subscription?.entity
  const pay   = payload?.payload?.payment?.entity
  const inv   = payload?.payload?.invoice?.entity
  const ref   = payload?.payload?.refund?.entity
  const subscriptionId = sub?.id ?? pay?.subscription_id ?? inv?.subscription_id

  // Refund events: keyed by refund.id (we stashed refund_razorpay_id at
  // refund-initiation). Mirror the inline route's branch.
  if (event === 'refund.processed' || event === 'refund.failed') {
    if (ref?.id) {
      const { data: subRow } = await supabase.from('tenant_subscriptions')
        .select('tenant_id, refund_amount_inr').eq('refund_razorpay_id', ref.id).maybeSingle()
      if (subRow) {
        await supabase.from('tenant_subscriptions').update({
          refund_completed_at: event === 'refund.processed' ? new Date().toISOString() : null,
          updated_at:          new Date().toISOString(),
        }).eq('tenant_id', subRow.tenant_id)
      }
    }
    return
  }

  if (!subscriptionId) {
    // Other events without a subscription_id — ack and ignore.
    return
  }

  const { data: row } = await supabase.from('tenant_subscriptions')
    .select('tenant_id, plan_id')
    .eq('razorpay_subscription_id', subscriptionId).maybeSingle()
  if (!row) {
    // Webhook arrived before the checkout INSERT landed. The route used to
    // ack here so Razorpay didn't loop; with the queue we treat it as
    // retryable so the late-arriving INSERT gets a chance.
    throw new Error(`tenant_subscription not yet found for ${subscriptionId}`)
  }

  switch (event) {
    case 'subscription.activated':
    case 'subscription.charged':
      await supabase.from('tenant_subscriptions').update({
        status:               'active',
        current_period_start: sub?.current_start ? new Date(sub.current_start * 1000).toISOString() : undefined,
        current_period_end:   sub?.current_end   ? new Date(sub.current_end   * 1000).toISOString() : undefined,
        updated_at:           new Date().toISOString(),
      }).eq('tenant_id', row.tenant_id)
      break

    case 'subscription.halted':
    case 'subscription.cancelled':
    case 'subscription.completed': {
      const newStatus =
        event === 'subscription.halted'    ? 'past_due'  :
        event === 'subscription.cancelled' ? 'cancelled' :
        /* completed */                      'cancelled'
      await supabase.from('tenant_subscriptions').update({
        status:       newStatus,
        cancelled_at: newStatus === 'cancelled' ? new Date().toISOString() : undefined,
        updated_at:   new Date().toISOString(),
      }).eq('tenant_id', row.tenant_id)
      break
    }

    case 'subscription.paused':
      await supabase.from('tenant_subscriptions').update({
        status:     'suspended',
        updated_at: new Date().toISOString(),
      }).eq('tenant_id', row.tenant_id)
      break

    case 'subscription.resumed':
      await supabase.from('tenant_subscriptions').update({
        status:     'active',
        updated_at: new Date().toISOString(),
      }).eq('tenant_id', row.tenant_id)
      break

    case 'payment.captured':
      if (pay?.id && pay.invoice_id) {
        const paidAt = pay.created_at && Number.isFinite(pay.created_at)
          ? new Date(pay.created_at * 1000).toISOString()
          : new Date().toISOString()
        await supabase.from('invoices').upsert({
          tenant_id:       row.tenant_id,
          amount_paise:    pay.amount,
          gst_paise:       0,
          currency:        pay.currency ?? 'INR',
          status:          'paid',
          razorpay_inv_id: pay.invoice_id,
          paid_at:         paidAt,
        }, { onConflict: 'razorpay_inv_id', ignoreDuplicates: true })
      }
      break

    case 'payment.failed':
      console.warn(`[razorpay.processor] payment.failed for tenant ${row.tenant_id}: ${pay?.error_description}`)
      break

    default:
      // Non-actionable; ack.
      break
  }
}
