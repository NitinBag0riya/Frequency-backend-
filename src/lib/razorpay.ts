/**
 * Razorpay client — thin HTTP wrapper around the Razorpay Subscriptions /
 * Customers / Webhooks API.
 *
 * No npm dependency on `razorpay` SDK to keep the surface tiny + auditable.
 * Razorpay's REST API is straightforward (Basic auth with key_id:key_secret),
 * and rolling our own means we control retries, error shapes, and timeouts.
 *
 * Env vars (set on the platform owner's Razorpay account, NOT per-tenant —
 * tenants subscribe to OUR plans):
 *   RAZORPAY_KEY_ID         — pk_live_… or pk_test_…
 *   RAZORPAY_KEY_SECRET     — corresponding secret
 *   RAZORPAY_WEBHOOK_SECRET — for verifying webhook HMAC
 *
 * For BYO Razorpay (per-tenant payment-collection use cases like Razorpay
 * Payment Pages, Smart Collect etc.), see src/connectors/razorpay.ts —
 * those credentials live on tenant_integrations and are independent of
 * the platform's billing account.
 */

import { createHmac, timingSafeEqual } from 'crypto'

const BASE = 'https://api.razorpay.com/v1'

function authHeader(): string {
  const key = process.env.RAZORPAY_KEY_ID
  const secret = process.env.RAZORPAY_KEY_SECRET
  if (!key || !secret) {
    throw new Error('Razorpay billing not configured: set RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET')
  }
  return 'Basic ' + Buffer.from(`${key}:${secret}`).toString('base64')
}

async function rpFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      'Authorization': authHeader(),
      'Content-Type':  'application/json',
      ...(init.headers ?? {}),
    },
  })
  const text = await res.text()
  if (!res.ok) {
    let detail = text
    try { detail = JSON.stringify(JSON.parse(text)?.error ?? text) } catch {}
    throw new Error(`Razorpay ${path} → ${res.status}: ${detail}`)
  }
  return text ? JSON.parse(text) : ({} as T)
}

// ─── Customers ───────────────────────────────────────────────────────────

export interface RpCustomer {
  id: string                      // 'cust_XXX'
  email: string
  contact?: string
  name?: string
  notes?: Record<string, string>
  created_at: number
}

/** Create or retrieve a Razorpay customer. Idempotent on email per Razorpay's
 *  `fail_existing=0` flag — if a customer with this email already exists,
 *  Razorpay returns the existing record instead of erroring. */
export async function ensureCustomer(args: {
  email: string
  name?: string
  contact?: string
  notes?: Record<string, string>
}): Promise<RpCustomer> {
  return rpFetch<RpCustomer>('/customers', {
    method: 'POST',
    body: JSON.stringify({
      email:   args.email,
      name:    args.name,
      contact: args.contact,
      notes:   args.notes,
      fail_existing: 0,        // returns existing record instead of 400
    }),
  })
}

// ─── Subscriptions ───────────────────────────────────────────────────────

export interface RpSubscription {
  id: string                     // 'sub_XXX'
  entity: 'subscription'
  plan_id: string
  customer_id?: string
  status: 'created' | 'authenticated' | 'active' | 'pending' | 'halted' | 'cancelled' | 'completed' | 'expired' | 'paused'
  current_start: number | null
  current_end:   number | null
  ended_at:      number | null
  charge_at:     number
  start_at:      number
  end_at?:       number | null
  total_count:   number
  paid_count:    number
  short_url:     string         // hosted page URL — fallback if FE Checkout fails
  notes?:        Record<string, string>
  created_at:    number
}

/** Create a Razorpay subscription. Customer is created server-side by
 *  Razorpay using the `customer_notify` + customer details we pass. The
 *  returned `short_url` is a hosted Razorpay page; we prefer the embedded
 *  Checkout flow but `short_url` is a graceful fallback. */
export async function createSubscription(args: {
  plan_id: string
  customer_id?: string
  total_count?: number          // 12 = annual recurring; 0 = until cancelled
  notes?: Record<string, string>
}): Promise<RpSubscription> {
  return rpFetch<RpSubscription>('/subscriptions', {
    method: 'POST',
    body: JSON.stringify({
      plan_id:        args.plan_id,
      customer_id:    args.customer_id,
      total_count:    args.total_count ?? 120, // 10 years of monthly billing — effectively "until cancelled"
      customer_notify: 1,
      notes:          args.notes,
    }),
  })
}

// ─── Plans (created on the fly for quarterly billing) ──────────────────
//
// Razorpay docs: POST /v1/plans accepts period ∈ ('daily','weekly','monthly','yearly')
// and an `interval` multiplier. Quarterly = period:'monthly' + interval:3 OR
// period:'quarterly' on newer accounts. We use monthly+interval:3 because
// the explicit 'quarterly' period isn't enabled on every Razorpay account
// and monthly+interval:3 is universally supported with identical effect.
export interface RpPlan {
  id: string                    // 'plan_XXX'
  entity: 'plan'
  interval: number
  period: 'daily' | 'weekly' | 'monthly' | 'yearly'
  item: { name: string; amount: number; currency: 'INR'; description?: string }
  notes?: Record<string, string>
  created_at: number
}

/** Create a Razorpay Plan. `amount_paise` is per-period (per-quarter for
 *  monthly×3). Idempotency: Razorpay doesn't dedup plan creates — caller is
 *  responsible for caching the returned id so we don't multi-create. */
export async function createPlan(args: {
  period: 'monthly' | 'yearly'
  interval: number               // 3 for quarterly when period=monthly
  amount_paise: number           // per-period charge in paise
  name: string                   // human label e.g. "Frequency Growth — Quarterly"
  description?: string
  notes?: Record<string, string>
}): Promise<RpPlan> {
  return rpFetch<RpPlan>('/plans', {
    method: 'POST',
    body: JSON.stringify({
      period:   args.period,
      interval: args.interval,
      item: {
        name:        args.name,
        amount:      args.amount_paise,
        currency:    'INR',
        description: args.description,
      },
      notes: args.notes,
    }),
  })
}

// ─── Payments / Refunds ────────────────────────────────────────────────

export interface RpPayment {
  id: string
  entity: 'payment'
  amount: number                // paise
  currency: 'INR'
  status: 'created' | 'authorized' | 'captured' | 'refunded' | 'failed'
  invoice_id?: string
  subscription_id?: string
  email?: string
  contact?: string
  /** Sum of all refunds against this payment, in paise. Razorpay only
   *  populates this on the GET /payments/:id detail endpoint — list
   *  variants may not include it. Treat undefined as 0 for safety. */
  amount_refunded?: number
  refund_status?: 'null' | 'partial' | 'full' | null
  created_at: number
}

/** List payments for a subscription. Used by the refund flow to find the
 *  most recent captured payment to refund. Razorpay returns newest-first. */
export async function listSubscriptionPayments(subscriptionId: string): Promise<RpPayment[]> {
  const r = await rpFetch<{ items: RpPayment[]; count: number }>(
    `/subscriptions/${subscriptionId}/payments?count=10`,
  )
  return r.items ?? []
}

/** Fetch a single payment by id. Returns the authoritative `amount`
 *  and (critically) the current `amount_refunded` — both needed to
 *  compute the *remaining* refundable balance before issuing another
 *  partial refund. Security audit 2026-05-19 flagged that revshare
 *  credit was using the webhook-supplied payment.amount as the cap,
 *  which is stale if anyone else (manual ops, customer-initiated
 *  refund) has already partially refunded the same payment. */
export async function fetchPayment(paymentId: string): Promise<RpPayment> {
  return rpFetch<RpPayment>(`/payments/${paymentId}`)
}

export interface RpRefund {
  id: string                    // 'rfnd_XXX'
  entity: 'refund'
  amount: number                // paise
  currency: 'INR'
  payment_id: string
  status: 'pending' | 'processed' | 'failed'
  speed_processed?: 'normal' | 'instant'
  notes?: Record<string, string>
  created_at: number
}

/** Initiate a refund on a captured payment. Omit `amount_paise` to refund
 *  the full payment. Razorpay processes refunds in 5-7 business days unless
 *  speed='optimum' (which requires opt-in on the account). */
export async function createRefund(args: {
  payment_id: string
  amount_paise?: number           // omit for full refund
  notes?: Record<string, string>
}): Promise<RpRefund> {
  const body: any = { speed: 'normal' }
  if (args.amount_paise) body.amount = args.amount_paise
  if (args.notes)        body.notes  = args.notes
  return rpFetch<RpRefund>(`/payments/${args.payment_id}/refund`, {
    method: 'POST',
    body: JSON.stringify(body),
  })
}

/** Schedule cancellation at the end of the current billing period. Razorpay
 *  passes `cancel_at_cycle_end=1` to defer the actual cancel until period_end,
 *  so the user keeps access until the renewal date they already paid for. */
export async function cancelSubscription(subscriptionId: string, opts: { atCycleEnd?: boolean } = {}): Promise<RpSubscription> {
  return rpFetch<RpSubscription>(`/subscriptions/${subscriptionId}/cancel`, {
    method: 'POST',
    body: JSON.stringify({ cancel_at_cycle_end: opts.atCycleEnd === false ? 0 : 1 }),
  })
}

export async function fetchSubscription(subscriptionId: string): Promise<RpSubscription> {
  return rpFetch<RpSubscription>(`/subscriptions/${subscriptionId}`)
}

// ─── Webhooks ────────────────────────────────────────────────────────────

/**
 * Verify the X-Razorpay-Signature header on an incoming webhook payload.
 * Returns true if the signature matches the HMAC-SHA256 of the raw body
 * keyed by RAZORPAY_WEBHOOK_SECRET. Uses timing-safe comparison to avoid
 * a side-channel oracle.
 *
 * IMPORTANT: pass the RAW request body (Buffer / string), not the parsed
 * JSON — Razorpay computes the HMAC on bytes, and JSON.stringify can
 * reorder keys.
 */
export function verifyWebhookSignature(rawBody: string | Buffer, signature: string | undefined): boolean {
  const secret = process.env.RAZORPAY_WEBHOOK_SECRET
  if (!secret || !signature) return false
  const expected = createHmac('sha256', secret).update(rawBody).digest('hex')
  // Timing-safe compare. Both must be same byte length for timingSafeEqual,
  // so guard with a length check first; an attacker can already see length
  // via response timing, so this isn't a leak.
  if (expected.length !== signature.length) return false
  try {
    return timingSafeEqual(Buffer.from(expected), Buffer.from(signature))
  } catch {
    return false
  }
}
