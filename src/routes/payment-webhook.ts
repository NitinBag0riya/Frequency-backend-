/**
 * trigger_payment — tenant CUSTOMER payment events fire a workflow.
 *
 * NOT to be confused with Frequency's own billing webhook
 * (/api/billing/razorpay/webhook), which is keyed to a single global
 * RAZORPAY_WEBHOOK_SECRET. This is multi-tenant: each tenant connects their OWN
 * Razorpay / Cashfree account, so every webhook is verified against THAT
 * tenant's signing secret and routed by a per-tenant, per-provider token.
 *
 * Routing:   POST /api/webhooks/payment/:provider/:token
 *            :token is an unguessable per-tenant value stored in
 *            tenant_integrations.metadata.webhook_token. We resolve the tenant
 *            from it, then verify the provider signature before trusting a byte.
 *
 * Signing:
 *   • Razorpay — X-Razorpay-Signature = HMAC-SHA256(rawBody, webhook_secret) hex.
 *     The webhook secret is a SEPARATE value the merchant sets when creating the
 *     webhook in their Razorpay dashboard — captured via the config endpoint and
 *     stored encrypted (metadata.webhook_secret_enc).
 *   • Cashfree — x-webhook-signature = base64(HMAC-SHA256(timestamp + rawBody,
 *     client_secret)). Cashfree signs with the CLIENT SECRET we already hold
 *     (tenant_integrations.access_token), so no extra secret to capture.
 *
 * Cost shape: pure webhook — fires only on a real payment event, zero idle burn,
 * no poller. Mirrors the storefront-order receiver.
 *
 * Raw body: the HMAC is over the exact bytes, so index.ts mounts an
 * express.json({ verify }) on /api/webhooks/payment that stashes req.rawBody.
 */

import express from 'express'
import crypto from 'crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import { decrypt, randomToken } from '../crypto'

type Middleware = express.RequestHandler
interface Deps {
  supabase: SupabaseClient
  requireAuth: Middleware
  identifyTenant: Middleware
  checkPermission: (feature: string, action: 'view' | 'edit' | 'delete') => Middleware
}

const PUBLIC_BASE_URL = (process.env.PUBLIC_API_URL ?? 'http://localhost:3001').replace(/\/+$/, '')
const SUPPORTED = new Set(['razorpay', 'cashfree'])

// ── Signature verification ───────────────────────────────────────────────────

function timingSafe(expected: string, provided: string | undefined): boolean {
  if (!provided || expected.length !== provided.length) return false
  try { return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(provided)) } catch { return false }
}

function verifyRazorpay(rawBody: Buffer, signature: string | undefined, secret: string): boolean {
  if (!secret) return false
  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex')
  return timingSafe(expected, signature)
}

function verifyCashfree(rawBody: Buffer, timestamp: string | undefined, signature: string | undefined, secret: string): boolean {
  if (!secret || !timestamp) return false
  const expected = crypto.createHmac('sha256', secret).update(timestamp + rawBody.toString('utf8')).digest('base64')
  return timingSafe(expected, signature)
}

// ── Payload normalization → a common shape with a coarse outcome ─────────────

interface NormalizedPayment {
  event: string
  outcome: 'paid' | 'failed' | 'refunded' | 'other'
  status: string | null
  payment_id: string | null
  amount: number | null
  currency: string
  contact_phone: string | null
  email: string | null
}

function normalizeRazorpay(body: any): NormalizedPayment {
  const event = String(body?.event ?? 'unknown')
  const p = body?.payload?.payment?.entity ?? body?.payload?.refund?.entity ?? {}
  const outcome: NormalizedPayment['outcome'] =
    event.startsWith('refund.') ? 'refunded'
    : event === 'payment.captured' || event === 'order.paid' ? 'paid'
    : event === 'payment.failed' ? 'failed'
    : 'other'
  return {
    event, outcome,
    status:        p.status ?? null,
    payment_id:    p.id ?? null,
    amount:        p.amount != null ? Number(p.amount) / 100 : null,   // paise → ₹
    currency:      p.currency ?? 'INR',
    contact_phone: p.contact ?? null,
    email:         p.email ?? null,
  }
}

function normalizeCashfree(body: any): NormalizedPayment {
  const type = String(body?.type ?? 'unknown')
  const d = body?.data ?? {}
  const order = d.order ?? {}
  const pay = d.payment ?? {}
  const cust = d.customer_details ?? {}
  const outcome: NormalizedPayment['outcome'] =
    /REFUND/i.test(type) ? 'refunded'
    : /PAYMENT_SUCCESS|SUCCESS/i.test(type) || pay.payment_status === 'SUCCESS' ? 'paid'
    : /PAYMENT_FAILED|FAILED|USER_DROPPED/i.test(type) || pay.payment_status === 'FAILED' ? 'failed'
    : 'other'
  return {
    event:         type,
    outcome,
    status:        pay.payment_status ?? null,
    payment_id:    pay.cf_payment_id != null ? String(pay.cf_payment_id) : (order.order_id ?? null),
    amount:        pay.payment_amount ?? order.order_amount ?? null,
    currency:      order.order_currency ?? 'INR',
    contact_phone: cust.customer_phone ?? null,
    email:         cust.customer_email ?? null,
  }
}

// ── Router ───────────────────────────────────────────────────────────────────

export function createPaymentWebhookRouter(deps: Deps): express.Router {
  const { supabase, requireAuth, identifyTenant, checkPermission } = deps
  const r = express.Router()

  // ── Inbound webhook (public, signature-verified) ───────────────────────────
  r.post('/api/webhooks/payment/:provider/:token', async (req, res) => {
    const provider = String(req.params.provider ?? '').toLowerCase()
    const token = String(req.params.token ?? '')
    // Uniform error shape → no token-validity / provider oracle.
    const fail = () => res.status(401).json({ error: 'invalid request' })
    if (!SUPPORTED.has(provider) || !token) { fail(); return }

    const rawBody = (req as any).rawBody as Buffer | undefined
    if (!Buffer.isBuffer(rawBody)) { res.status(400).json({ error: 'raw body unavailable' }); return }

    const { data: integ } = await supabase.from('tenant_integrations')
      .select('tenant_id, access_token, metadata')
      .eq('key', provider)
      .contains('metadata', { webhook_token: token })
      .maybeSingle()
    if (!integ) { fail(); return }

    let ok = false
    if (provider === 'razorpay') {
      const secret = decrypt((integ.metadata as any)?.webhook_secret_enc)
      ok = verifyRazorpay(rawBody, req.header('x-razorpay-signature'), secret)
    } else {
      const secret = decrypt(integ.access_token)   // cashfree client secret
      ok = verifyCashfree(rawBody, req.header('x-webhook-timestamp'), req.header('x-webhook-signature'), secret)
    }
    if (!ok) { fail(); return }

    // Ack immediately (PSPs retry on non-2xx); fan out the trigger async so the
    // webhook response is never blocked on workflow start.
    res.json({ ok: true })

    const norm = provider === 'razorpay' ? normalizeRazorpay(req.body) : normalizeCashfree(req.body)
    const phone = norm.contact_phone ? String(norm.contact_phone).replace(/[^\d+]/g, '') : ''
    const contactId = phone || `payment:${provider}:${norm.payment_id ?? 'unknown'}`

    void import('../engine/inbound-router').then(({ fireWorkflowTrigger }) =>
      fireWorkflowTrigger(supabase, integ.tenant_id, 'trigger_payment', {
        contactId,
        payload: { provider, ...norm },
        match: (cfg: any) => {
          if (cfg.provider && String(cfg.provider) !== provider) return false
          if (cfg.on_event && String(cfg.on_event) !== 'any' && String(cfg.on_event) !== norm.outcome) return false
          if (cfg.min_amount && norm.amount != null && Number(norm.amount) < Number(cfg.min_amount)) return false
          return true
        },
      }),
    ).catch(() => {})
  })

  // ── Config: mint/read the per-tenant webhook URL (authed) ──────────────────
  // GET → { url, configured, needs_secret }. POST → mint token (+ store the
  // Razorpay webhook secret) and return the URL to paste into the PSP dashboard.
  const guardView = [requireAuth, identifyTenant, checkPermission('integrations', 'view')]
  const guardEdit = [requireAuth, identifyTenant, checkPermission('integrations', 'edit')]

  const urlFor = (provider: string, token: string) =>
    `${PUBLIC_BASE_URL}/api/webhooks/payment/${provider}/${token}`

  r.get('/api/connectors/:provider/payment-webhook', ...guardView, async (req, res) => {
    const provider = String(req.params.provider ?? '').toLowerCase()
    if (!SUPPORTED.has(provider)) { res.status(404).json({ error: 'unsupported provider' }); return }
    const tenantId = (req as any).tenantId
    const { data: integ } = await supabase.from('tenant_integrations')
      .select('metadata').eq('tenant_id', tenantId).eq('key', provider).maybeSingle()
    if (!integ) { res.status(409).json({ error: `Connect ${provider} first` }); return }
    const md = (integ.metadata as any) ?? {}
    const token = md.webhook_token as string | undefined
    res.json({
      url:          token ? urlFor(provider, token) : null,
      configured:   !!token,
      // Razorpay needs the separate signing secret; Cashfree reuses the client secret.
      needs_secret: provider === 'razorpay' && !md.webhook_secret_enc,
    })
  })

  r.post('/api/connectors/:provider/payment-webhook', ...guardEdit, async (req, res) => {
    const provider = String(req.params.provider ?? '').toLowerCase()
    if (!SUPPORTED.has(provider)) { res.status(404).json({ error: 'unsupported provider' }); return }
    const tenantId = (req as any).tenantId
    const { data: integ } = await supabase.from('tenant_integrations')
      .select('metadata').eq('tenant_id', tenantId).eq('key', provider).maybeSingle()
    if (!integ) { res.status(409).json({ error: `Connect ${provider} first` }); return }

    const md = { ...((integ.metadata as any) ?? {}) }
    if (!md.webhook_token) md.webhook_token = randomToken(24)   // mint once, stable thereafter
    // Razorpay: accept + encrypt the merchant's webhook signing secret.
    const secret = (req.body as any)?.webhook_secret
    if (provider === 'razorpay' && typeof secret === 'string' && secret.trim()) {
      md.webhook_secret_enc = (await import('../crypto')).encrypt(secret.trim())
    }

    const { error } = await supabase.from('tenant_integrations')
      .update({ metadata: md }).eq('tenant_id', tenantId).eq('key', provider)
    if (error) { res.status(500).json({ error: error.message }); return }

    res.json({
      url:          urlFor(provider, md.webhook_token),
      configured:   true,
      needs_secret: provider === 'razorpay' && !md.webhook_secret_enc,
    })
  })

  return r
}
