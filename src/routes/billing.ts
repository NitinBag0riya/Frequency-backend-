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
import { ensureCustomer, createSubscription, cancelSubscription, verifyWebhookSignature } from '../lib/razorpay'
import { emitNotification } from './notifications'
import { withIdempotency } from '../lib/idempotency'

type Middleware = (req: express.Request, res: express.Response, next: express.NextFunction) => void | Promise<void>

interface Deps {
  supabase: SupabaseClient
  requireAuth: Middleware
  identifyTenant: Middleware
  checkPermission: (feature: string, action: 'view' | 'edit' | 'delete') => Middleware
}

const CheckoutSchema = z.object({
  plan_id:       z.enum(['starter', 'growth', 'scale']),  // free + enterprise don't go through self-serve checkout
  billing_cycle: z.enum(['monthly', 'annual']).default('monthly'),
}).strict()

const CancelSchema = z.object({
  at_cycle_end: z.boolean().default(true),
}).strict()

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
        const { plan_id, billing_cycle } = req.body as z.infer<typeof CheckoutSchema>

        // 1. Look up the Razorpay plan_id for this tier+cycle.
        const planCol = billing_cycle === 'annual' ? 'razorpay_plan_id_yearly' : 'razorpay_plan_id_monthly'
        const { data: plan, error: planErr } = await supabase.from('plans')
          .select(`id, name, ${planCol}, price_inr_mo, price_inr_yr`)
          .eq('id', plan_id).maybeSingle()
        if (planErr || !plan) return { status: 404, body: { error: 'plan not found' } }
        const razorpayPlanId = (plan as any)[planCol] as string | null
        if (!razorpayPlanId) {
          return {
            status: 503,
            body: { error: `${plan.name} (${billing_cycle}) isn't configured for online checkout yet — contact support to set it up.` },
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
          const sub = await createSubscription({
            plan_id:     razorpayPlanId,
            customer_id: customerId,
            notes:       { tenant_id: tenantId, plan_id, billing_cycle },
            // total_count: 120 default = "until cancelled" for monthly. For annual
            // we use 10 to cap explicitly (Razorpay prefers a number).
            total_count: billing_cycle === 'annual' ? 10 : 120,
          })

          // 4. Persist what we know so the webhook can later flip status to active.
          await supabase.from('tenant_subscriptions').upsert({
            tenant_id:                tenantId,
            plan_id,                  // our internal plan id, not Razorpay's
            billing_cycle,
            razorpay_customer_id:     customerId,
            razorpay_subscription_id: sub.id,
            status:                   'trial',
            updated_at:               new Date().toISOString(),
          }, { onConflict: 'tenant_id' })

          // 5. Return what the FE needs. key_id is the public key (NOT the secret).
          return {
            status: 200,
            body: {
              razorpay_key_id:        process.env.RAZORPAY_KEY_ID,
              razorpay_subscription_id: sub.id,
              short_url:              sub.short_url,
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

  // ── Invoices ──────────────────────────────────────────────────────────
  r.get('/api/billing/invoices',
    requireAuth, identifyTenant, checkPermission('billing', 'view'),
    async (req, res) => {
      const tenantId = (req as any).tenantId
      const { data, error } = await supabase.from('invoices')
        .select('id, amount_paise, gst_paise, currency, status, razorpay_inv_id, pdf_url, paid_at, created_at')
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
      const subscriptionId = sub?.id ?? pay?.subscription_id

      if (!subscriptionId) {
        // Some events (refund.processed etc.) don't carry a subscription_id —
        // ack and ignore for the MVP.
        res.json({ received: true, ignored: true }); return
      }

      // Resolve the tenant from the Razorpay subscription_id we stashed at checkout.
      const { data: row } = await supabase.from('tenant_subscriptions')
        .select('tenant_id, plan_id').eq('razorpay_subscription_id', subscriptionId).maybeSingle()
      if (!row) {
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
  eventKey: 'payment.received' | 'payment.failed',
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
