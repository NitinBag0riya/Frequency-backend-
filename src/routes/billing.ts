/**
 * Billing routes — Razorpay-backed subscription lifecycle.
 *
 *   POST /api/billing/checkout         — create subscription, return Razorpay
 *                                        subscription_id + key_id for the FE
 *                                        Razorpay Checkout.js modal.
 *   POST /api/billing/cancel           — schedule cancel at period end.
 *   POST /api/billing/razorpay/webhook — Razorpay → us. Updates
 *                                        tenant_subscriptions.status when
 *                                        Razorpay confirms the lifecycle event.
 *   GET  /api/billing/invoices         — invoice list for the current tenant.
 *
 * Auth model:
 *   - checkout / cancel / invoices: requireAuth + identifyTenant + billing role
 *   - webhook: PUBLIC (HMAC verified instead) — Razorpay can't sign in
 */

import express from 'express'
import type { SupabaseClient } from '@supabase/supabase-js'
import { z } from 'zod'
import { validateBody } from '../validation'
import {
  ensureCustomer, createSubscription, cancelSubscription, verifyWebhookSignature,
  createPlan, listSubscriptionPayments, createRefund,
} from '../lib/razorpay'
import { emitNotification } from './notifications'
import { withIdempotency } from '../lib/idempotency'

type Middleware = (req: express.Request, res: express.Response, next: express.NextFunction) => void | Promise<void>

interface Deps {
  supabase: SupabaseClient
  requireAuth: Middleware
  identifyTenant: Middleware
  checkPermission: (feature: string, action: 'view' | 'edit' | 'delete') => Middleware
}

// Backwards-compat: `billing_cycle` (monthly/annual) maps to the existing
// plans.razorpay_plan_id_monthly/_yearly columns. The NEW `period` field is
// the SMB-facing rhythm (monthly/quarterly/annual) and drives discount math.
// When period='quarterly' we treat cycle as monthly (the Razorpay plan is
// created on the fly with interval=3 months), but tenant_subscriptions.
// billing_period stores 'quarterly' so the FE can render the right copy.
const CheckoutSchema = z.object({
  plan_id:       z.enum(['starter', 'growth', 'scale']),  // free + enterprise don't go through self-serve checkout
  billing_cycle: z.enum(['monthly', 'annual']).default('monthly'),
  period:        z.enum(['monthly', 'quarterly', 'annual']).optional(),
}).strict()

const CancelSchema = z.object({
  at_cycle_end: z.boolean().default(true),
}).strict()

const RefundSchema = z.object({
  reason: z.string().max(500).optional(),
}).strict()

/** Quarterly subscriptions get a 10% discount vs paying 3 monthlies. */
const QUARTERLY_DISCOUNT_PCT = 0.10

export function createBillingRouter(deps: Deps): express.Router {
  const r = express.Router()
  const { supabase, requireAuth, identifyTenant, checkPermission } = deps

  // ── Checkout ──────────────────────────────────────────────────────────
  // Creates the Razorpay subscription server-side, returns the subscription_id
  // for the FE to pass to Razorpay Checkout.js. The FE then collects payment
  // details inside Razorpay's modal — card data NEVER touches our server.
  r.post('/api/billing/checkout',
    requireAuth, identifyTenant, checkPermission('billing', 'edit'),
    validateBody(CheckoutSchema),
    async (req, res) => {
      // F4: idempotency wrap. Without this, a network retry on this endpoint
      // could create a duplicate Razorpay subscription and double-charge the
      // tenant. Replay returns the original subscription_id + short_url so
      // the FE picks up exactly where it left off.
      return withIdempotency(supabase, req, res, 'POST /api/billing/checkout', async () => {
        const tenantId = (req as any).tenantId as string
        const userId   = (req as any).user.id as string
        const userEmail = (req as any).user.email as string | undefined
        const { plan_id, billing_cycle, period: periodIn } =
          req.body as z.infer<typeof CheckoutSchema>

        // Resolve the canonical billing rhythm. If the FE sends `period`,
        // that's the new SMB-facing concept; map it back to billing_cycle
        // for legacy compat (quarterly → cycle:monthly with interval:3).
        const period: 'monthly' | 'quarterly' | 'annual' =
          periodIn ?? (billing_cycle === 'annual' ? 'annual' : 'monthly')
        const effectiveCycle: 'monthly' | 'annual' =
          period === 'annual' ? 'annual' : 'monthly'

        // 1. Look up the plan row + the appropriate Razorpay plan_id column.
        //    For quarterly we use a separate column populated lazily here.
        const planCol =
          period === 'annual'    ? 'razorpay_plan_id_yearly' :
          period === 'quarterly' ? 'razorpay_plan_id_quarterly' :
                                   'razorpay_plan_id_monthly'
        const { data: plan, error: planErr } = await supabase.from('plans')
          .select(`id, name, razorpay_plan_id_monthly, razorpay_plan_id_yearly, razorpay_plan_id_quarterly, price_inr_mo, price_inr_yr`)
          .eq('id', plan_id).maybeSingle()
        if (planErr || !plan) return { status: 404, body: { error: 'plan not found' } }

        let razorpayPlanId = (plan as any)[planCol] as string | null

        // Quarterly auto-provisioning: if the plan row has no quarterly
        // Razorpay plan_id yet, create one on the fly via POST /v1/plans and
        // cache the returned id back to plans.razorpay_plan_id_quarterly so
        // subsequent quarterly checkouts on this tier reuse it. Monthly +
        // annual still require pre-provisioning via the admin dashboard
        // (migration 026 contract) — they fail with a clear 503 if absent.
        if (!razorpayPlanId && period === 'quarterly') {
          try {
            // 3× monthly × (1 - 10% discount), rounded to nearest paise.
            const monthlyPaise = Number(plan.price_inr_mo ?? 0)
            if (monthlyPaise <= 0) {
              return { status: 503, body: { error: `${plan.name} has no monthly price configured — cannot derive quarterly.` } }
            }
            const quarterlyPaise = Math.round(monthlyPaise * 3 * (1 - QUARTERLY_DISCOUNT_PCT))
            const created = await createPlan({
              period:   'monthly',
              interval: 3,
              amount_paise: quarterlyPaise,
              name:        `Frequency ${plan.name} — Quarterly`,
              description: `${plan.name} plan, billed every 3 months (10% off monthly)`,
              notes:       { tier: plan_id, period: 'quarterly' },
            })
            razorpayPlanId = created.id
            await supabase.from('plans')
              .update({ razorpay_plan_id_quarterly: razorpayPlanId })
              .eq('id', plan_id)
          } catch (e: any) {
            console.error('[billing.checkout] quarterly plan creation failed', e?.message ?? e)
            return { status: 502, body: { error: `Could not provision quarterly plan with Razorpay: ${e?.message ?? 'unknown error'}` } }
          }
        }

        if (!razorpayPlanId) {
          return {
            status: 503,
            body: { error: `${plan.name} (${period}) isn't configured for online checkout yet — contact support to set it up.` },
          }
        }

        try {
          // 2. Look up or create the Razorpay customer for this tenant.
          const { data: existingSub } = await supabase.from('tenant_subscriptions')
            .select('razorpay_customer_id').eq('tenant_id', tenantId).maybeSingle()
          let customerId = existingSub?.razorpay_customer_id ?? null
          if (!customerId) {
            const { data: tenant } = await supabase.from('tenants')
              .select('business_name, display_phone').eq('id', tenantId).maybeSingle()
            const cust = await ensureCustomer({
              email:   userEmail ?? `tenant-${tenantId}@frequency.in`,
              name:    tenant?.business_name ?? undefined,
              contact: tenant?.display_phone ?? undefined,
              notes:   { tenant_id: tenantId, user_id: userId },
            })
            customerId = cust.id
          }

          // 3. Create the Razorpay subscription. The FE will pass subscription_id
          // to Razorpay Checkout.js to collect card / UPI details.
          //
          // total_count: 120 default = "until cancelled" for monthly. For
          // annual we cap at 10 (10 years). For quarterly we use 40 (10
          // years × 4 quarters) for the same effect.
          const totalCount =
            period === 'annual'    ? 10  :
            period === 'quarterly' ? 40  :
                                     120
          const sub = await createSubscription({
            plan_id:     razorpayPlanId,
            customer_id: customerId,
            notes:       { tenant_id: tenantId, plan_id, billing_cycle: effectiveCycle, period },
            total_count: totalCount,
          })

          // 4. Persist what we know so the webhook can later flip status to active.
          await supabase.from('tenant_subscriptions').upsert({
            tenant_id:                tenantId,
            plan_id,                  // our internal plan id, not Razorpay's
            billing_cycle:            effectiveCycle,
            billing_period:           period,
            razorpay_customer_id:     customerId,
            razorpay_subscription_id: sub.id,
            status:                   'trial',
            // Reset refund tracking on a fresh subscribe — protects the 14-day
            // window starting from this new sub.
            refund_initiated_at:      null,
            refund_completed_at:      null,
            refund_amount_inr:        null,
            refund_razorpay_id:       null,
            cancellation_reason:      null,
            updated_at:               new Date().toISOString(),
          }, { onConflict: 'tenant_id' })

          // 5. Return what the FE needs. key_id is the public key (NOT the secret).
          return {
            status: 200,
            body: {
              razorpay_key_id:        process.env.RAZORPAY_KEY_ID,
              razorpay_subscription_id: sub.id,
              short_url:              sub.short_url,
              period,
            },
          }
        } catch (e: any) {
          console.error('[billing.checkout]', e?.message ?? e)
          return { status: 500, body: { error: e?.message ?? 'Checkout failed' } }
        }
      })
    })

  // ── Cancel (schedules at period end by default) ───────────────────────
  r.post('/api/billing/cancel',
    requireAuth, identifyTenant, checkPermission('billing', 'edit'),
    validateBody(CancelSchema),
    async (req, res) => {
      // F4: idempotency wrap. Cancel is naturally near-idempotent at Razorpay
      // (cancelling an already-cancelled sub is a no-op), but a retry could
      // race with the cancellation webhook and overwrite cancel_reason in
      // tenant_subscriptions. Cached replay keeps the original timestamp.
      return withIdempotency(supabase, req, res, 'POST /api/billing/cancel', async () => {
        const tenantId = (req as any).tenantId as string
        const { at_cycle_end } = req.body as z.infer<typeof CancelSchema>

        const { data: sub } = await supabase.from('tenant_subscriptions')
          .select('razorpay_subscription_id').eq('tenant_id', tenantId).maybeSingle()
        if (!sub?.razorpay_subscription_id) {
          return { status: 404, body: { error: 'No active subscription to cancel' } }
        }

        try {
          await cancelSubscription(sub.razorpay_subscription_id, { atCycleEnd: at_cycle_end })
          await supabase.from('tenant_subscriptions').update({
            cancelled_at:  new Date().toISOString(),
            cancel_reason: 'user_initiated',
            updated_at:    new Date().toISOString(),
          }).eq('tenant_id', tenantId)
          return { status: 200, body: { success: true, scheduled_at_cycle_end: at_cycle_end } }
        } catch (e: any) {
          console.error('[billing.cancel]', e?.message ?? e)
          return { status: 500, body: { error: e?.message ?? 'Cancel failed' } }
        }
      })
    })

  // ── Refund (14-day no-questions in-product flow) ──────────────────────
  // The brief: "no email chains". User clicks Cancel & request refund in the
  // BillingPage, we (a) call Razorpay's refund API on the most recent
  // captured payment for this subscription, (b) flag the subscription as
  // cancelled with reason='refund_within_14d', (c) emit notifications to
  // billing roles + super_admin. The refund.processed webhook later
  // confirms the bank settlement.
  //
  // Window enforcement: server-side, double-checks tenant_subscriptions.
  // created_at >= now() - interval '14 days'. The FE hides the CTA outside
  // the window but defense in depth — never trust the client.
  r.post('/api/billing/refund',
    requireAuth, identifyTenant, checkPermission('billing', 'edit'),
    validateBody(RefundSchema),
    async (req, res) => {
      return withIdempotency(supabase, req, res, 'POST /api/billing/refund', async () => {
        const tenantId = (req as any).tenantId as string
        const userId   = (req as any).user.id as string
        const { reason } = req.body as z.infer<typeof RefundSchema>

        const { data: sub } = await supabase.from('tenant_subscriptions')
          .select('id, razorpay_subscription_id, status, created_at, refund_initiated_at, refund_amount_inr')
          .eq('tenant_id', tenantId).maybeSingle()
        if (!sub?.razorpay_subscription_id) {
          return { status: 404, body: { error: 'No active subscription to refund' } }
        }
        if (sub.refund_initiated_at) {
          return { status: 409, body: { error: 'A refund has already been initiated for this subscription' } }
        }
        if (sub.status !== 'active' && sub.status !== 'trial') {
          return { status: 400, body: { error: `Subscription is ${sub.status} — refund only available for active subscriptions` } }
        }
        const ageMs = Date.now() - new Date(sub.created_at).getTime()
        const FOURTEEN_DAYS_MS = 14 * 24 * 60 * 60 * 1000
        if (ageMs > FOURTEEN_DAYS_MS) {
          return {
            status: 400,
            body: { error: 'Subscription is past the 14-day refund window. Please contact support to discuss options.' },
          }
        }

        try {
          // 1. Find the most recent captured payment to refund.
          const payments = await listSubscriptionPayments(sub.razorpay_subscription_id)
          const captured = payments.find(p => p.status === 'captured')
          if (!captured) {
            // No payment yet (still in trial / payment failed) — there's
            // nothing to refund; cancel immediately at Razorpay and mark
            // status='cancelled' so the user doesn't get charged.
            try {
              await cancelSubscription(sub.razorpay_subscription_id, { atCycleEnd: false })
            } catch (e: any) {
              console.warn(`[billing.refund] no payment + cancel failed (non-fatal): ${e?.message ?? e}`)
            }
            await supabase.from('tenant_subscriptions').update({
              status:              'cancelled',
              cancelled_at:        new Date().toISOString(),
              cancellation_reason: 'refund_within_14d',
              refund_initiated_at: new Date().toISOString(),
              refund_amount_inr:   0,
              updated_at:          new Date().toISOString(),
            }).eq('tenant_id', tenantId)
            await notifyBillingRoles(supabase, tenantId, 'billing.refund_initiated', {
              amount: '0',
              reason: reason ?? 'within_14d',
            })
            return {
              status: 200,
              body: {
                success: true,
                refunded_paise: 0,
                message: 'Subscription cancelled — no payment had been captured yet, so there\'s nothing to refund.',
              },
            }
          }

          // 2. Initiate the refund at Razorpay (full amount).
          const refund = await createRefund({
            payment_id: captured.id,
            notes: {
              tenant_id:  tenantId,
              user_id:    userId,
              reason:     reason ?? 'within_14d_no_questions',
              source:     'in_app_billing_page',
            },
          })

          // 3. Schedule cancel-at-now (not at_cycle_end — refund implies
          //    immediate termination of access, otherwise the user keeps
          //    using the product they just got back money for).
          try {
            await cancelSubscription(sub.razorpay_subscription_id, { atCycleEnd: false })
          } catch (e: any) {
            console.warn(`[billing.refund] sub cancel failed (refund succeeded, status flip continues): ${e?.message ?? e}`)
          }

          // 4. Persist the refund record + cancellation reason.
          await supabase.from('tenant_subscriptions').update({
            status:              'cancelled',
            cancelled_at:        new Date().toISOString(),
            cancellation_reason: 'refund_within_14d',
            refund_initiated_at: new Date().toISOString(),
            refund_amount_inr:   captured.amount,
            refund_razorpay_id:  refund.id,
            updated_at:          new Date().toISOString(),
          }).eq('tenant_id', tenantId)

          // 5. Notify billing roles. The amount is in rupees for display;
          // refund.processed webhook will fire later to update the "completed".
          const amountDisplay = (captured.amount / 100).toLocaleString('en-IN')
          await notifyBillingRoles(supabase, tenantId, 'billing.refund_initiated', {
            amount: amountDisplay,
            reason: reason ?? 'within_14d',
          })

          return {
            status: 200,
            body: {
              success: true,
              refund_id: refund.id,
              refunded_paise: captured.amount,
              status: refund.status,
              message: `Refund initiated. ₹${amountDisplay} will be returned to your card within 5–7 business days.`,
            },
          }
        } catch (e: any) {
          console.error('[billing.refund]', e?.message ?? e)
          return { status: 500, body: { error: e?.message ?? 'Refund failed' } }
        }
      })
    })

  // ── Invoices ──────────────────────────────────────────────────────────
  r.get('/api/billing/invoices',
    requireAuth, identifyTenant, checkPermission('billing', 'view'),
    async (req, res) => {
      const tenantId = (req as any).tenantId
      const { data, error } = await supabase.from('invoices')
        .select(
          'id, amount_paise, gst_paise, currency, status, razorpay_inv_id, pdf_url, paid_at, created_at, ' +
          'invoice_number, cgst_paise, sgst_paise, igst_paise, gst_rate_pct, buyer_gstin, place_of_supply, emailed_at',
        )
        .eq('tenant_id', tenantId)
        .order('created_at', { ascending: false })
        .limit(50)
      if (error) { res.status(500).json({ error: error.message }); return }
      res.json({ invoices: data ?? [] })
    })

  // ── Usage ─────────────────────────────────────────────────────────────
  // Computed live from canonical tables, NOT from the (currently unwritten)
  // usage_counters table from migration 021. This trades a little query cost
  // (4 cheap COUNT queries) for always-correct numbers; once a usage-counter
  // worker exists this can switch to reading the cached table.
  //
  // Returns the four metrics the BillingPage shows in its limit cards:
  //   - contacts (lifetime)
  //   - active_workflows (status in 'live' / 'active')
  //   - messages_this_month (sent or received)
  //   - agent_seats (non-disabled team members)
  r.get('/api/billing/usage',
    requireAuth, identifyTenant, checkPermission('billing', 'view'),
    async (req, res) => {
      const tenantId = (req as any).tenantId
      // First of the current month in IST (UTC+5:30). Billing periods are
      // calendar months in India per PRICING_SPEC §3.1, so a UTC midnight
      // would undercount messages sent 00:00–05:29 IST on the 1st (they'd
      // attribute to the previous month).
      //
      // Approach: get "now" in IST, take its year+month, then back-shift the
      // 1st-of-month-IST to its UTC equivalent (-5h30m).
      const IST_OFFSET_MIN = 5 * 60 + 30
      const nowIstMs = Date.now() + IST_OFFSET_MIN * 60_000
      const nowIst = new Date(nowIstMs)
      const monthStartUtcMs = Date.UTC(nowIst.getUTCFullYear(), nowIst.getUTCMonth(), 1) - IST_OFFSET_MIN * 60_000
      const monthStartIso = new Date(monthStartUtcMs).toISOString()

      // Four parallel head-only counts — fixed cost regardless of tenant size.
      // head:true returns just the count + minimal headers (no row payload).
      const [contactsRes, workflowsRes, messagesRes, seatsRes] = await Promise.all([
        supabase.from('contacts')
          .select('id', { count: 'exact', head: true })
          .eq('tenant_id', tenantId),
        // workflows.status enum is ('draft','live','paused','archived') per
        // migration 001 — only 'live' counts as "active" for the billing
        // limit. (`'active'` was previously listed too but is not a valid
        // enum value, so it was a no-op masking the real intent.)
        supabase.from('workflows')
          .select('id', { count: 'exact', head: true })
          .eq('tenant_id', tenantId)
          .eq('status', 'live'),
        supabase.from('messages')
          .select('id', { count: 'exact', head: true })
          .eq('tenant_id', tenantId)
          .gte('created_at', monthStartIso),
        supabase.from('user_role_assignments')
          .select('id', { count: 'exact', head: true })
          .eq('tenant_id', tenantId)
          .is('disabled_at', null),
      ])

      res.json({
        contacts:            contactsRes.count  ?? 0,
        active_workflows:    workflowsRes.count ?? 0,
        messages_this_month: messagesRes.count  ?? 0,
        agent_seats:         seatsRes.count     ?? 0,
        period_start:        monthStartIso,
      })
    })

  // ── Webhook ───────────────────────────────────────────────────────────
  // Public endpoint — Razorpay calls us on subscription / payment lifecycle
  // events. Authenticated via X-Razorpay-Signature HMAC, NOT by user JWT.
  //
  // CRITICAL: the HMAC is computed over the raw request bytes. The
  // express.raw() body parser for this exact path is mounted at the app
  // level in index.ts BEFORE express.json(), so by the time we reach this
  // handler, req.body is a Buffer (not a parsed object).
  r.post('/api/billing/razorpay/webhook',
    async (req, res) => {
      const sig = req.headers['x-razorpay-signature'] as string | undefined
      const raw = req.body as Buffer
      if (!verifyWebhookSignature(raw, sig)) {
        console.warn('[billing.webhook] HMAC verification failed')
        res.status(401).json({ error: 'invalid signature' }); return
      }

      // ── Webhook queue handoff (migration 064) ─────────────────────────
      // Razorpay retries on >2s timeout. Same flag-gated cutover pattern as
      // Meta WA / IG: enqueue verified bytes, 200 OK, worker processes with
      // retry + DLQ. Falls back to inline on Redis failure.
      if (process.env.WEBHOOK_QUEUE_ENABLED === '1') {
        try {
          const { enqueueWebhookInbound } = await import('../queue')
          await enqueueWebhookInbound({
            source:     'razorpay',
            rawBodyB64: raw.toString('base64'),
            receivedAt: new Date().toISOString(),
          })
          res.json({ received: true, queued: true })
          return
        } catch (e: any) {
          console.warn(`[billing.webhook] queue enqueue failed, running inline: ${e?.message ?? e}`)
        }
      }

      let payload: any
      try { payload = JSON.parse(raw.toString('utf8')) }
      catch { res.status(400).json({ error: 'invalid json' }); return }

      const event = String(payload?.event ?? '')
      const sub   = payload?.payload?.subscription?.entity
      const pay   = payload?.payload?.payment?.entity
      const inv   = payload?.payload?.invoice?.entity
      const ref   = payload?.payload?.refund?.entity
      const subscriptionId = sub?.id ?? pay?.subscription_id ?? inv?.subscription_id

      // ── Refund webhooks (no subscription_id on payload — keyed by refund.id)
      // We stash refund_razorpay_id at refund-initiation time so this lookup
      // succeeds. If we don't recognise the refund id, ack and ignore (a
      // refund issued outside our flow — e.g. manual from Razorpay
      // dashboard — shouldn't loop forever).
      if (event === 'refund.processed' || event === 'refund.failed') {
        if (ref?.id) {
          const { data: subRow } = await supabase.from('tenant_subscriptions')
            .select('tenant_id, refund_amount_inr')
            .eq('refund_razorpay_id', ref.id).maybeSingle()
          if (subRow) {
            const completed = event === 'refund.processed'
            await supabase.from('tenant_subscriptions').update({
              refund_completed_at: completed ? new Date().toISOString() : null,
              updated_at:          new Date().toISOString(),
            }).eq('tenant_id', subRow.tenant_id)
            if (completed) {
              const amountDisplay = ((subRow.refund_amount_inr ?? 0) / 100).toLocaleString('en-IN')
              void notifyBillingRoles(supabase, subRow.tenant_id, 'billing.refund_completed', {
                amount: amountDisplay,
              })
            }
          } else {
            // Also try the agency_subscriptions table — agencies have their own
            // refund flow with the same 14-day window pattern.
            const { data: aSub } = await supabase.from('agency_subscriptions')
              .select('id').eq('refund_razorpay_id', ref.id).maybeSingle()
            if (aSub) {
              const completed = event === 'refund.processed'
              await supabase.from('agency_subscriptions').update({
                refund_completed_at: completed ? new Date().toISOString() : null,
              }).eq('id', aSub.id)
            }
          }
        }
        res.json({ received: true, kind: 'refund' }); return
      }

      if (!subscriptionId) {
        // Some events don't carry a subscription_id — ack and ignore for the MVP.
        res.json({ received: true, ignored: true }); return
      }

      // Resolve the tenant from the Razorpay subscription_id we stashed at checkout.
      const { data: row } = await supabase.from('tenant_subscriptions')
        .select('tenant_id, plan_id').eq('razorpay_subscription_id', subscriptionId).maybeSingle()
      if (!row) {
        // Not a tenant subscription. Try the agency subscriptions table —
        // migration 088 added a parallel billing path for the agency's
        // platform fee (independent from tenant plans). If it matches there,
        // run the dedicated agency branch + ack.
        const { data: agencyRow } = await supabase.from('agency_subscriptions')
          .select('id, agency_id, plan_id, plans:plan_id ( id, name )')
          .eq('razorpay_subscription_id', subscriptionId).maybeSingle()
        if (agencyRow) {
          await handleAgencyWebhookEvent(supabase, event, agencyRow, sub, pay, inv)
          res.json({ received: true, kind: 'agency' }); return
        }
        // Razorpay delivered before we wrote the row — could happen with very
        // fast webhooks. Ack so Razorpay doesn't retry indefinitely; the
        // checkout endpoint's INSERT will land momentarily.
        res.json({ received: true, unknown_subscription: true }); return
      }

      try {
        switch (event) {
          case 'subscription.activated':
          case 'subscription.charged':       // recurring renewal payment captured
            await supabase.from('tenant_subscriptions').update({
              status:                'active',
              current_period_start:  sub?.current_start ? new Date(sub.current_start * 1000).toISOString() : undefined,
              current_period_end:    sub?.current_end   ? new Date(sub.current_end   * 1000).toISOString() : undefined,
              updated_at:            new Date().toISOString(),
            }).eq('tenant_id', row.tenant_id)
            break
          case 'subscription.halted':         // 3 failed retries → access removed
          case 'subscription.cancelled':
          case 'subscription.completed': {
            // halted    → past_due  (payments failed, retry exhausted)
            // cancelled → cancelled (user-initiated, scheduled or immediate)
            // completed → cancelled (Razorpay end-of-total_count; same UX as cancelled)
            // Mapping `completed → past_due` would have shown the user a red
            // "Payment failed" banner even after a clean run — wrong UX.
            const newStatus =
              event === 'subscription.halted'    ? 'past_due'  :
              event === 'subscription.cancelled' ? 'cancelled' :
              /* completed */                      'cancelled'
            await supabase.from('tenant_subscriptions').update({
              status:        newStatus,
              cancelled_at:  newStatus === 'cancelled' ? new Date().toISOString() : undefined,
              updated_at:    new Date().toISOString(),
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
            // Insert an invoice row so the FE invoices list shows the payment.
            // Razorpay subscription invoices come through `invoice.paid` separately;
            // we use payment.captured for the lightweight log entry.
            //
            // Idempotency: Razorpay retries on any non-2xx, so without a unique
            // key on razorpay_inv_id we'd insert the same row repeatedly. The
            // unique partial index from migration 027 makes the insert no-op
            // on duplicate. We require razorpay_inv_id to be present — without
            // it we have no dedup key, so log + skip rather than risk dupes.
            if (pay?.id && pay.invoice_id) {
              const paidAt = pay.created_at && Number.isFinite(pay.created_at)
                ? new Date(pay.created_at * 1000).toISOString()
                : new Date().toISOString()
              const { error: invErr } = await supabase.from('invoices').upsert({
                tenant_id:       row.tenant_id,
                amount_paise:    pay.amount,
                gst_paise:       0,  // computed at invoice generation time, not payment
                currency:        pay.currency ?? 'INR',
                status:          'paid',
                razorpay_inv_id: pay.invoice_id,
                paid_at:         paidAt,
              }, { onConflict: 'razorpay_inv_id', ignoreDuplicates: true })
              if (invErr) console.warn('[billing.webhook] invoice upsert failed (non-fatal)', invErr.message)
            } else if (pay?.id) {
              console.info(`[billing.webhook] payment.captured ${pay.id} has no invoice_id — skipping invoice row`)
            }
            // Notify billing-eligible team members. Fetched from
            // user_role_assignments → role_definitions where the role grants
            // billing:view (owner, workspace_admin, finance — see seeds in
            // migration 018).
            await notifyBillingRoles(supabase, row.tenant_id, 'payment.received', {
              amount: ((pay?.amount ?? 0) / 100).toLocaleString('en-IN'),
              customer_name: pay?.email ?? 'Customer',
            })
            break
          case 'invoice.paid': {
            // Razorpay subscription invoices fire `invoice.paid` once the
            // payment is captured + the invoice marked paid. This is where
            // we generate the India-compliant GST invoice (computing
            // CGST+SGST vs IGST from buyer state), persist the rendered
            // HTML, and email it to the billing contact.
            //
            // Idempotency: keyed by razorpay_inv_id. If the row already
            // exists with invoice_number set, we skip regeneration (defensive
            // against double-fire by Razorpay).
            const rzInvId = inv?.id ?? pay?.invoice_id
            if (!rzInvId) {
              console.info('[billing.webhook] invoice.paid with no invoice id — skipping')
              break
            }
            const amountPaise = Number(inv?.amount_paid ?? pay?.amount ?? 0)
            if (amountPaise <= 0) {
              console.info('[billing.webhook] invoice.paid amount=0 — skipping GST gen')
              break
            }
            await generateAndEmailGstInvoice(supabase, {
              tenant_id:      row.tenant_id,
              razorpay_inv_id: rzInvId,
              amount_paise:   amountPaise,
              currency:       String(inv?.currency ?? pay?.currency ?? 'INR'),
              paid_at_unix:   Number(inv?.paid_at ?? pay?.created_at ?? 0),
              plan_id:        row.plan_id,
            })

            // P1 #12 — Agency revshare accrual. Best-effort: a failure here
            // MUST NOT break invoice.paid (the tenant's GST invoice is the
            // primary obligation; revshare is internal accounting that can
            // be reconciled later). Wrapped in its own try/catch with a
            // non-fatal log. Idempotency relies on the unique index
            // (agency_id, tenant_id, period_start, period_end, invoice_id).
            try {
              const { data: link } = await supabase
                .from('agency_sub_accounts')
                .select('agency_id, revshare_pct_override, agencies:agency_id ( default_revshare_pct )')
                .eq('tenant_id', row.tenant_id)
                .is('removed_at', null)
                .maybeSingle()
              if (link?.agency_id) {
                const agencyRow = Array.isArray((link as any).agencies) ? (link as any).agencies[0] : (link as any).agencies
                const pct = link.revshare_pct_override ?? agencyRow?.default_revshare_pct ?? 30
                const revAmount = Math.floor(amountPaise * (Number(pct) / 100))
                // Period derived from the Razorpay invoice payload when
                // available; otherwise fall back to a 30-day window ending
                // at paid_at so the unique constraint can still anchor.
                const paidAtIso = inv?.paid_at && Number.isFinite(inv.paid_at)
                  ? new Date(inv.paid_at * 1000).toISOString()
                  : new Date().toISOString()
                const periodStart = inv?.billing_start && Number.isFinite(inv.billing_start)
                  ? new Date(inv.billing_start * 1000).toISOString()
                  : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()
                const periodEnd = inv?.billing_end && Number.isFinite(inv.billing_end)
                  ? new Date(inv.billing_end * 1000).toISOString()
                  : paidAtIso
                await supabase.from('agency_revshare_entries').upsert({
                  agency_id:                 link.agency_id,
                  tenant_id:                 row.tenant_id,
                  invoice_id:                rzInvId,
                  period_start:              periodStart,
                  period_end:                periodEnd,
                  base_amount_inr_paise:     amountPaise,
                  revshare_pct:              Number(pct),
                  revshare_amount_inr_paise: revAmount,
                  status:                    'accrued',
                }, { onConflict: 'agency_id,tenant_id,period_start,period_end,invoice_id', ignoreDuplicates: false })
              }
            } catch (e) {
              console.warn('[revshare] accrual failed (non-fatal):', (e as Error)?.message ?? e)
            }
            break
          }
          case 'payment.failed':
            // Don't change subscription status here — Razorpay will retry and
            // eventually fire subscription.halted if all retries fail.
            console.warn(`[billing.webhook] payment.failed for tenant ${row.tenant_id}: ${pay?.error_description}`)
            await notifyBillingRoles(supabase, row.tenant_id, 'payment.failed', {
              amount: ((pay?.amount ?? 0) / 100).toLocaleString('en-IN'),
              customer_name: pay?.email ?? 'Customer',
              reason: pay?.error_description ?? 'Card declined',
            })
            break
          default:
            // Unknown / non-actionable event — ack so Razorpay stops retrying.
            break
        }
        res.json({ received: true })
      } catch (e: any) {
        console.error(`[billing.webhook] handler error event=${event}`, e?.message ?? e)
        // 500 makes Razorpay retry with backoff. Only do that for things we
        // genuinely want retried (DB outage, network blip). For known
        // application errors (data shape we don't understand) ack with 200
        // so we don't loop indefinitely on a malformed payload.
        const transient = e?.code === 'PGRST301' || e?.message?.includes('fetch') || e?.message?.includes('timeout')
        if (transient) {
          res.status(500).json({ error: 'handler error (will retry)' })
        } else {
          res.status(200).json({ received: true, handled: false, error: e?.message ?? 'unknown' })
        }
      }
    })

  return r
}

/**
 * Send a billing-related notification to every team member with a role that
 * grants `billing:view`. Fetched from user_role_assignments + role_definitions
 * — covers owner, workspace_admin, finance per the seed in migration 018,
 * plus any custom role a tenant has created with billing access.
 *
 * Fire-and-forget: notification failure should never block a Razorpay webhook
 * retry-decision. Caller should NOT await as a hard dep.
 */
async function notifyBillingRoles(
  supabase: SupabaseClient,
  tenantId: string,
  eventKey:
    | 'payment.received'
    | 'payment.failed'
    | 'billing.refund_initiated'
    | 'billing.refund_completed'
    | 'billing.invoice_emailed',
  data: Record<string, string>,
): Promise<void> {
  try {
    // Resolve users: any user_role_assignment in this tenant whose role
    // permissions object has billing.view = true. permissions is jsonb so
    // we can't simply filter in PostgREST — fetch the assignments, check
    // role.permissions in code. Bounded by team size (typically <50).
    const { data: rows } = await supabase.from('user_role_assignments')
      .select('user_id, role_definitions!inner(permissions)')
      .eq('tenant_id', tenantId)
      .is('disabled_at', null)
    // Supabase returns the joined `role_definitions` as either an OBJECT or
    // an ARRAY depending on the FK metadata interpretation (array for
    // many-to-one when not declared 1:1 in the schema). Defend against both
    // shapes — without this, the `?.permissions` chain bails on arrays and
    // the recipient set silently collapses to just the tenant owner.
    const getPerms = (rd: any): any => {
      if (!rd) return null
      if (Array.isArray(rd)) return rd[0]?.permissions
      return rd.permissions
    }
    const recipients = Array.from(new Set(
      (rows ?? [])
        .filter((r: any) => getPerms(r.role_definitions)?.billing?.view === true)
        .map((r: any) => r.user_id as string),
    ))
    // Always include the tenant owner (they may not have a user_role_assignment row).
    const { data: tenant } = await supabase.from('tenants')
      .select('user_id').eq('id', tenantId).maybeSingle()
    if (tenant?.user_id && !recipients.includes(tenant.user_id)) {
      recipients.push(tenant.user_id)
    }
    if (recipients.length === 0) return

    await emitNotification(supabase, {
      tenant_id: tenantId,
      event_key: eventKey,
      recipient_user_ids: recipients,
      data,
      link: '/settings/billing',
    })
  } catch (e: any) {
    console.warn(`[billing.notify] failed (non-fatal):`, e?.message ?? e)
  }
}

/**
 * Generate a GST-compliant invoice for an `invoice.paid` Razorpay webhook
 * and email it to the tenant's billing contact.
 *
 * Strategy:
 *   1. Snapshot the tenant's billing info (gstin, address, state) at issue
 *      time so historical invoices stay immutable even if the tenant edits
 *      their info later (GST law: invoices are non-editable after issue).
 *   2. Compute CGST/SGST (intra-state) vs IGST (inter-state) from buyer
 *      state code. Math is owned by lib/gst-invoice.ts (one source of truth).
 *   3. Assign a sequential FY invoice number (FREQ/2026-27/00001). The
 *      unique index races safely — second insert fails, caller can retry
 *      with seq+1 (but for v1 we just bubble the error; in practice the
 *      collision window is microseconds).
 *   4. Render HTML via lib/gst-invoice.ts, persist row, send email via
 *      lib/email.ts. If Resend isn't configured, queue to
 *      pending_invoice_emails for later replay.
 *   5. Notify billing roles "Invoice sent".
 *
 * Idempotency: keyed by razorpay_inv_id. If the row already exists with an
 * invoice_number set, we no-op (the email was already sent).
 *
 * Fail-soft: any error inside this function is caught and logged. We do NOT
 * throw — that would push the outer webhook to retry, which Razorpay would
 * re-fire ad infinitum even though the payment is genuinely captured. The
 * pending_invoice_emails table is the audit trail for "this needs human
 * follow-up".
 */
async function generateAndEmailGstInvoice(
  supabase: SupabaseClient,
  args: {
    tenant_id:       string
    razorpay_inv_id: string
    amount_paise:    number
    currency:        string
    paid_at_unix:    number
    plan_id:         string | null
  },
): Promise<void> {
  try {
    if (args.currency !== 'INR') {
      // GST applies to INR billings. If Razorpay ever sends a non-INR
      // invoice (international card), skip GST gen + ship a plain invoice
      // path later. For now log + bail.
      console.info(`[billing.gst-invoice] non-INR currency=${args.currency} — skipping GST gen`)
      return
    }

    // 1. Check idempotency: existing row with invoice_number → already emitted.
    const { data: existing } = await supabase.from('invoices')
      .select('id, invoice_number, emailed_at')
      .eq('razorpay_inv_id', args.razorpay_inv_id)
      .maybeSingle()
    if (existing?.invoice_number && existing.emailed_at) {
      console.info(`[billing.gst-invoice] ${args.razorpay_inv_id} already invoiced + emailed — skipping`)
      return
    }

    // 2. Snapshot tenant billing info.
    const { data: tenant } = await supabase.from('tenants')
      .select('id, user_id, business_name, legal_name, gstin, billing_email, billing_address, billing_state, billing_state_code, billing_pincode')
      .eq('id', args.tenant_id).maybeSingle()
    if (!tenant) {
      console.warn(`[billing.gst-invoice] tenant ${args.tenant_id} not found`)
      return
    }

    // Resolve billing email: tenants.billing_email → tenant owner auth email.
    let recipient: string | null = tenant.billing_email ?? null
    if (!recipient && tenant.user_id) {
      const { data: u } = await supabase.auth.admin.getUserById(tenant.user_id)
      recipient = u?.user?.email ?? null
    }

    // 3. Compute GST split + assign invoice number.
    const { computeGst, formatInvoiceNumber, renderInvoiceHtml, nextInvoiceNumber } =
      await import('../lib/gst-invoice')

    const issueDate = args.paid_at_unix > 0 ? new Date(args.paid_at_unix * 1000) : new Date()
    const gst = computeGst(args.amount_paise, tenant.billing_state_code, 18)
    const invoiceNumber = existing?.invoice_number
      ?? (await nextInvoiceNumber(supabase, issueDate))

    // 4. Render HTML.
    const planLabel = args.plan_id ? args.plan_id.charAt(0).toUpperCase() + args.plan_id.slice(1) : 'Subscription'
    const html = renderInvoiceHtml({
      invoiceNumber,
      issueDate,
      buyerName:     tenant.legal_name ?? tenant.business_name ?? 'Customer',
      buyerAddress:  tenant.billing_address ?? 'Address on file',
      buyerStateName: tenant.billing_state ?? null,
      buyerStateCode: tenant.billing_state_code ?? null,
      buyerGstin:    tenant.gstin ?? null,
      description:   `Frequency ${planLabel} Plan — subscription period ending ${issueDate.toLocaleDateString('en-IN', { month: 'short', year: 'numeric' })}`,
      gst,
    })

    // 5. Upsert the invoice row with GST fields.
    const { error: invErr } = await supabase.from('invoices').upsert({
      tenant_id:       args.tenant_id,
      amount_paise:    args.amount_paise,
      gst_paise:       Number(gst.gst_total_paise),
      cgst_paise:      Number(gst.cgst_paise),
      sgst_paise:      Number(gst.sgst_paise),
      igst_paise:      Number(gst.igst_paise),
      gst_rate_pct:    gst.gst_rate_pct,
      currency:        'INR',
      status:          'paid',
      razorpay_inv_id: args.razorpay_inv_id,
      paid_at:         issueDate.toISOString(),
      invoice_number:  invoiceNumber,
      hsn_sac:         '998314',
      place_of_supply: tenant.billing_state_code ?? null,
      buyer_gstin:     tenant.gstin ?? null,
      seller_gstin:    process.env.SELLER_GSTIN ?? null,
      invoice_html:    html,
    }, { onConflict: 'razorpay_inv_id' })
    if (invErr) {
      console.warn(`[billing.gst-invoice] invoice upsert failed: ${invErr.message}`)
      return
    }

    // 6. Email it. If Resend isn't configured or sending fails, queue.
    const subjectLine = `Tax Invoice ${invoiceNumber} — ₹${(Number(gst.total_paise) / 100).toLocaleString('en-IN')}`
    let emailedTo: string | null = null
    let emailFailReason: string | null = null

    if (!recipient) {
      emailFailReason = 'no_recipient_email_on_file'
    } else if (!process.env.RESEND_API_KEY || !process.env.RESEND_FROM_EMAIL) {
      emailFailReason = 'email_provider_not_configured'
    } else {
      try {
        const { sendEmail } = await import('../lib/email')
        await sendEmail({
          to:      recipient,
          subject: subjectLine,
          html,
          text:    `Tax Invoice ${invoiceNumber} for ₹${(Number(gst.total_paise) / 100).toLocaleString('en-IN')} attached. Open in a browser for the full HTML invoice.`,
          idempotency_key: `inv_email_${args.razorpay_inv_id}`,
        })
        emailedTo = recipient
        await supabase.from('invoices').update({
          emailed_at: new Date().toISOString(),
          emailed_to: recipient,
        }).eq('razorpay_inv_id', args.razorpay_inv_id)
      } catch (e: any) {
        emailFailReason = `send_failed: ${e?.message ?? e}`
      }
    }

    if (emailFailReason) {
      // Queue for retry / human follow-up.
      await supabase.from('pending_invoice_emails').insert({
        tenant_id:       args.tenant_id,
        invoice_id:      existing?.id ?? null,
        recipient_email: recipient ?? 'unknown@unknown',
        reason:          emailFailReason,
        last_error:      emailFailReason,
        attempts:        1,
        last_attempt_at: new Date().toISOString(),
      })
      console.warn(`[billing.gst-invoice] invoice ${invoiceNumber} email queued: ${emailFailReason}`)
    } else if (emailedTo) {
      // Notify billing roles "invoice sent".
      void notifyBillingRoles(supabase, args.tenant_id, 'billing.invoice_emailed', {
        invoice_number: invoiceNumber,
        amount:         (Number(gst.total_paise) / 100).toLocaleString('en-IN'),
        recipient:      emailedTo,
      })
    }
  } catch (e: any) {
    console.error(`[billing.gst-invoice] unhandled error: ${e?.message ?? e}`)
  }
}

/**
 * Razorpay webhook branch for agency subscriptions (migration 088).
 *
 * Tenant subs and agency subs share the same Razorpay webhook stream — we
 * disambiguate by which table the subscription_id resolves to. Mirrors the
 * tenant case for status flips + payment.captured + invoice.paid (with GST
 * invoice gen + email).
 *
 * Best-effort: any error inside is caught + logged; we never throw out so
 * the outer webhook responds 200 and Razorpay stops retrying.
 */
async function handleAgencyWebhookEvent(
  supabase: SupabaseClient,
  event: string,
  agencyRow: { id: string; agency_id: string; plan_id: string; plans?: any },
  sub: any,
  pay: any,
  inv: any,
): Promise<void> {
  try {
    switch (event) {
      case 'subscription.activated':
      case 'subscription.charged':
        await supabase.from('agency_subscriptions').update({
          status:               'active',
          current_period_start: sub?.current_start ? new Date(sub.current_start * 1000).toISOString() : undefined,
          current_period_end:   sub?.current_end   ? new Date(sub.current_end   * 1000).toISOString() : undefined,
        }).eq('id', agencyRow.id)
        break

      case 'subscription.halted':
      case 'subscription.cancelled':
      case 'subscription.completed': {
        const newStatus =
          event === 'subscription.halted'    ? 'past_due'  :
          event === 'subscription.cancelled' ? 'cancelled' :
          /* completed */                      'cancelled'
        await supabase.from('agency_subscriptions').update({
          status:       newStatus,
          cancelled_at: newStatus === 'cancelled' ? new Date().toISOString() : undefined,
        }).eq('id', agencyRow.id)
        break
      }

      case 'subscription.paused':
        await supabase.from('agency_subscriptions').update({ status: 'paused' }).eq('id', agencyRow.id)
        break

      case 'subscription.resumed':
        await supabase.from('agency_subscriptions').update({ status: 'active' }).eq('id', agencyRow.id)
        break

      case 'invoice.paid': {
        // Generate GST invoice for the agency. We use the tenants table as the
        // billing-info source if the agency_owner happens to own a tenant —
        // else fall back to a minimal invoice keyed off the agency name. The
        // primary invoices table is shared (same India FY numbering pool).
        const rzInvId = inv?.id ?? pay?.invoice_id
        if (!rzInvId) { console.info('[agency.webhook] invoice.paid no rzInvId'); break }
        const amountPaise = Number(inv?.amount_paid ?? pay?.amount ?? 0)
        if (amountPaise <= 0)   { console.info('[agency.webhook] invoice.paid amount=0'); break }

        // Idempotency: skip if invoice already exists for this razorpay_inv_id.
        const { data: existing } = await supabase.from('invoices')
          .select('id, invoice_number, emailed_at')
          .eq('razorpay_inv_id', rzInvId).maybeSingle()
        if (existing?.invoice_number && existing?.emailed_at) { break }

        // Refresh status + amount on the agency subscription row.
        await supabase.from('agency_subscriptions').update({
          status:           'active',
          amount_inr_paise: amountPaise,
          current_period_start: sub?.current_start ? new Date(sub.current_start * 1000).toISOString() : undefined,
          current_period_end:   sub?.current_end   ? new Date(sub.current_end   * 1000).toISOString() : undefined,
        }).eq('id', agencyRow.id)

        // Resolve a billing email for the invoice: agency owner's auth email.
        let recipient: string | null = null
        try {
          const { data: agency } = await supabase.from('agencies')
            .select('id, name, owner_user_id').eq('id', agencyRow.agency_id).maybeSingle()
          if (agency?.owner_user_id) {
            const { data: u } = await supabase.auth.admin.getUserById(agency.owner_user_id)
            recipient = u?.user?.email ?? null
          }
          const planLabel = (Array.isArray(agencyRow.plans) ? agencyRow.plans[0]?.name : agencyRow.plans?.name)
                            ?? agencyRow.plan_id
          const { computeGst, renderInvoiceHtml, nextInvoiceNumber } = await import('../lib/gst-invoice')
          const issueDate = inv?.paid_at && Number.isFinite(inv.paid_at)
            ? new Date(inv.paid_at * 1000)
            : new Date()
          // Default to inter-state (IGST) since agencies don't carry a state
          // code at this stage. Future: collect a billing address on the agency.
          const gst = computeGst(amountPaise, null, 18)
          const invoiceNumber = existing?.invoice_number ?? (await nextInvoiceNumber(supabase, issueDate))
          const html = renderInvoiceHtml({
            invoiceNumber,
            issueDate,
            buyerName:     agency?.name ?? 'Agency',
            buyerAddress:  'Address on file',
            buyerStateName: null,
            buyerStateCode: null,
            buyerGstin:    null,
            description:   `Frequency ${planLabel} (Agency platform fee)`,
            gst,
          })
          // Note: invoices.tenant_id is NOT NULL — we don't have a tenant for an
          // agency-only invoice. Insertion is skipped; instead we send the HTML
          // by email so the agency has a record. If the agency owner also owns
          // a tenant we use that tenant_id for the row. Otherwise the email is
          // the audit trail until a future migration adds invoices.agency_id.
          let invoiceTenantId: string | null = null
          if (agency?.owner_user_id) {
            const { data: ownedTenant } = await supabase.from('tenants')
              .select('id').eq('user_id', agency.owner_user_id).limit(1).maybeSingle()
            invoiceTenantId = ownedTenant?.id ?? null
          }
          if (invoiceTenantId) {
            await supabase.from('invoices').upsert({
              tenant_id:       invoiceTenantId,
              amount_paise:    amountPaise,
              gst_paise:       Number(gst.gst_total_paise),
              cgst_paise:      Number(gst.cgst_paise),
              sgst_paise:      Number(gst.sgst_paise),
              igst_paise:      Number(gst.igst_paise),
              gst_rate_pct:    gst.gst_rate_pct,
              currency:        'INR',
              status:          'paid',
              razorpay_inv_id: rzInvId,
              paid_at:         issueDate.toISOString(),
              invoice_number:  invoiceNumber,
              hsn_sac:         '998314',
              invoice_html:    html,
            }, { onConflict: 'razorpay_inv_id' })
          }

          if (recipient && process.env.RESEND_API_KEY && process.env.RESEND_FROM_EMAIL) {
            const { sendEmail } = await import('../lib/email')
            await sendEmail({
              to:      recipient,
              subject: `Tax Invoice ${invoiceNumber} — ₹${(Number(gst.total_paise) / 100).toLocaleString('en-IN')}`,
              html,
              text:    `Tax Invoice ${invoiceNumber} attached.`,
              idempotency_key: `agency_inv_email_${rzInvId}`,
            })
            if (invoiceTenantId) {
              await supabase.from('invoices').update({
                emailed_at: new Date().toISOString(),
                emailed_to: recipient,
              }).eq('razorpay_inv_id', rzInvId)
            }
          } else if (invoiceTenantId) {
            await supabase.from('pending_invoice_emails').insert({
              tenant_id:       invoiceTenantId,
              invoice_id:      existing?.id ?? null,
              recipient_email: recipient ?? 'unknown@unknown',
              reason:          recipient ? 'email_provider_not_configured' : 'no_recipient_email_on_file',
              last_error:      'agency_invoice',
              attempts:        1,
              last_attempt_at: new Date().toISOString(),
            })
          }
        } catch (e: any) {
          console.warn(`[agency.webhook] invoice.paid handling failed (non-fatal): ${e?.message ?? e}`)
        }

        // ── Revshare credit-as-refund settlement ──────────────────────
        // After the GST invoice is generated, settle any accrued revshare
        // for this agency by issuing a partial refund on the captured
        // payment. The refund amount = min(sum_accrued, payment_amount).
        // See src/lib/agency-revshare.ts for the full rationale.
        //
        // Best-effort: failure inside the helper is logged but never
        // throws out. The agency's subscription stays active either way.
        try {
          if (pay?.id && amountPaise > 0) {
            const { applyAccruedRevshareAsCredit } = await import('../lib/agency-revshare')
            await applyAccruedRevshareAsCredit(
              supabase,
              agencyRow.agency_id,
              String(pay.id),
              amountPaise,
            )
          } else {
            console.info(`[agency.webhook] invoice.paid for agency=${agencyRow.agency_id} skipped revshare credit (no pay.id or amount=0)`)
          }
        } catch (e: any) {
          console.warn(`[agency.webhook] revshare credit failed (non-fatal): ${e?.message ?? e}`)
        }
        break
      }

      case 'payment.captured':
      case 'payment.failed':
      default:
        // Nothing extra to do beyond the status flips above.
        break
    }
  } catch (e: any) {
    console.error(`[agency.webhook] handler error event=${event}: ${e?.message ?? e}`)
  }
}
