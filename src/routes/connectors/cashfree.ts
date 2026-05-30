/**
 * Cashfree connector — App ID + Secret Key (India payments + payouts, D2C).
 *
 * Cashfree is one of the top India payment rails (alongside Razorpay, already
 * live). It's a pure paste-key connect: each merchant copies their App ID +
 * Secret Key from the Cashfree dashboard (Developers → API Keys). Both a
 * SANDBOX and a PRODUCTION key set exist — the merchant picks the environment
 * on connect, so SMBs can wire + test a checkout/payment-link flow before going
 * live. No partner/BD agreement is required.
 *
 * Auth: two request headers on every call —
 *   x-client-id:     <App ID>
 *   x-client-secret: <Secret Key>
 *   x-api-version:   2023-08-01   (pinned PG API version)
 * Base URL is environment-dependent:
 *   production → https://api.cashfree.com/pg
 *   sandbox    → https://sandbox.cashfree.com/pg
 *
 * Capabilities (Cashfree PG v3):
 *   create_order         POST  /orders                         (start a payment / get session)
 *   get_order(:id)       GET   /orders/:order_id               (order + payment status)
 *   create_payment_link  POST  /links                          (shareable pay link — great for WhatsApp)
 *   create_refund(:id)   POST  /orders/:order_id/refunds       (issue a refund)
 */

import express from 'express'
import { z } from 'zod'
import { SupabaseClient } from '@supabase/supabase-js'
import { encrypt, decrypt } from '../../crypto'
import { validateBody } from '../../validation'

type Middleware = (req: express.Request, res: express.Response, next: express.NextFunction) => void | Promise<void>
interface Deps {
  supabase: SupabaseClient
  requireAuth: Middleware
  identifyTenant: Middleware
  checkPermission: (feature: string, action: 'view' | 'edit' | 'delete') => Middleware
}

const CF_API_VERSION = '2023-08-01'
const CF_BASE: Record<'production' | 'sandbox', string> = {
  production: 'https://api.cashfree.com/pg',
  sandbox:    'https://sandbox.cashfree.com/pg',
}

const TokenSchema = z.object({
  app_id:      z.string().min(6, 'App ID looks too short — copy it from Cashfree → Developers → API Keys'),
  secret_key:  z.string().min(6, 'Secret Key looks too short — copy the full key from the Cashfree dashboard'),
  environment: z.enum(['production', 'sandbox']).default('production'),
})

const OrderSchema = z.object({
  order_amount:   z.union([z.string(), z.number()]).transform(Number).refine(n => n > 0, 'order_amount must be > 0'),
  order_currency: z.string().default('INR'),
  customer_details: z.record(z.string(), z.any()).refine(
    v => !!v && (v.customer_id || v.customer_phone),
    'customer_details requires at least customer_id and customer_phone',
  ),
  order_id:   z.string().optional(),
  order_note: z.string().optional(),
}).passthrough()

const LinkSchema = z.object({
  link_amount:   z.union([z.string(), z.number()]).transform(Number).refine(n => n > 0, 'link_amount must be > 0'),
  link_currency: z.string().default('INR'),
  link_purpose:  z.string().min(1, 'link_purpose is required (shown to the payer)'),
  customer_details: z.record(z.string(), z.any()).refine(
    v => !!v && v.customer_phone,
    'customer_details.customer_phone is required for a payment link',
  ),
  link_id:     z.string().optional(),
  link_notify: z.record(z.string(), z.any()).optional(),
}).passthrough()

const RefundSchema = z.object({
  refund_amount: z.union([z.string(), z.number()]).transform(Number).refine(n => n > 0, 'refund_amount must be > 0'),
  refund_id:     z.string().min(1, 'refund_id is required (your unique idempotent id)'),
  refund_note:   z.string().optional(),
}).passthrough()

function cfHeaders(appId: string, secret: string): Record<string, string> {
  return {
    'x-client-id':     appId,
    'x-client-secret': secret,
    'x-api-version':   CF_API_VERSION,
    'Content-Type':    'application/json',
    Accept:            'application/json',
  }
}

function cfErr(r: Response, body: any): string {
  if (r.status === 429) return 'Cashfree rate limit exceeded — try again in a moment'
  if (body?.message) return String(body.message)
  if (body?.error_description) return String(body.error_description)
  return `Cashfree ${r.status}`
}

export function createCashfreeConnector(deps: Deps): express.Router {
  const r = express.Router()
  const { supabase, requireAuth, identifyTenant, checkPermission } = deps

  // ── Paste-key connect (verify, then persist) ──────────────────────────────
  r.post('/api/connectors/cashfree/connect-key',
    requireAuth, identifyTenant, checkPermission('integrations', 'edit'),
    validateBody(TokenSchema),
    async (req, res) => {
      const tenantId = (req as any).tenantId
      const userId = (req as any).user?.id as string | undefined
      if (!userId) { res.status(401).json({ error: 'auth missing user.id' }); return }

      const { app_id, secret_key, environment } = req.body as z.infer<typeof TokenSchema>
      const base = CF_BASE[environment]

      // Verify creds with a side-effect-free call: fetch a deliberately absent
      // order. Valid creds → 404 order_not_found. Bad creds → 401/403 with an
      // authentication_error. We never create anything during verification.
      let verify: Response
      let vbody: any = {}
      try {
        verify = await fetch(`${base}/orders/cfverify${Date.now()}`, { headers: cfHeaders(app_id, secret_key) })
        vbody = await verify.json().catch(() => ({}))
      } catch (e: any) {
        res.status(400).json({ error: `Could not reach Cashfree (${e?.message ?? 'network error'})` })
        return
      }
      const authBad =
        verify.status === 401 || verify.status === 403 ||
        vbody?.type === 'authentication_error' ||
        /authentication/i.test(String(vbody?.message ?? vbody?.code ?? ''))
      if (authBad) {
        res.status(400).json({ error: `Cashfree rejected these credentials (check App ID + Secret and that they match the "${environment}" environment).` })
        return
      }

      const { error: upsertErr } = await supabase.from('tenant_integrations').upsert({
        tenant_id:    tenantId,
        user_id:      userId,
        key:          'cashfree',
        status:       'active',
        access_token: encrypt(secret_key),
        scope:        'payments',
        brand_label:  `Cashfree (${environment})`,
        metadata:     { auth_mode: 'api_key', app_id, environment },
      }, { onConflict: 'tenant_id,key' })
      if (upsertErr) {
        console.error(`[cashfree connect] DB upsert failed: ${upsertErr.message}`)
        res.status(500).json({ error: 'Failed to persist connection: ' + upsertErr.message }); return
      }
      res.json({ success: true, environment })
    })

  // ── Capabilities ──────────────────────────────────────────────────────────
  const guardView = [requireAuth, identifyTenant, checkPermission('integrations', 'view')]
  const guardEdit = [requireAuth, identifyTenant, checkPermission('integrations', 'edit')]

  r.post('/api/connectors/cashfree/orders', ...guardEdit,
    validateBody(OrderSchema),
    async (req, res) => {
      try {
        const { appId, secret, base } = await loadCreds(supabase, (req as any).tenantId)
        const r2 = await fetch(`${base}/orders`, { method: 'POST', headers: cfHeaders(appId, secret), body: JSON.stringify(req.body) })
        const body = await r2.json().catch(() => ({})) as any
        if (!r2.ok) { res.status(r2.status).json({ error: cfErr(r2, body) }); return }
        res.json(body)
      } catch (err: any) { res.status(500).json({ error: err.message }) }
    })

  r.get('/api/connectors/cashfree/orders/:order_id', ...guardView, async (req, res) => {
    try {
      const { appId, secret, base } = await loadCreds(supabase, (req as any).tenantId)
      const id = encodeURIComponent(String(req.params.order_id))
      const r2 = await fetch(`${base}/orders/${id}`, { headers: cfHeaders(appId, secret) })
      const body = await r2.json().catch(() => ({})) as any
      if (!r2.ok) { res.status(r2.status).json({ error: cfErr(r2, body) }); return }
      res.json(body)
    } catch (err: any) { res.status(500).json({ error: err.message }) }
  })

  r.post('/api/connectors/cashfree/links', ...guardEdit,
    validateBody(LinkSchema),
    async (req, res) => {
      try {
        const { appId, secret, base } = await loadCreds(supabase, (req as any).tenantId)
        const r2 = await fetch(`${base}/links`, { method: 'POST', headers: cfHeaders(appId, secret), body: JSON.stringify(req.body) })
        const body = await r2.json().catch(() => ({})) as any
        if (!r2.ok) { res.status(r2.status).json({ error: cfErr(r2, body) }); return }
        res.json(body)
      } catch (err: any) { res.status(500).json({ error: err.message }) }
    })

  r.post('/api/connectors/cashfree/orders/:order_id/refunds', ...guardEdit,
    validateBody(RefundSchema),
    async (req, res) => {
      try {
        const { appId, secret, base } = await loadCreds(supabase, (req as any).tenantId)
        const id = encodeURIComponent(String(req.params.order_id))
        const r2 = await fetch(`${base}/orders/${id}/refunds`, { method: 'POST', headers: cfHeaders(appId, secret), body: JSON.stringify(req.body) })
        const body = await r2.json().catch(() => ({})) as any
        if (!r2.ok) { res.status(r2.status).json({ error: cfErr(r2, body) }); return }
        res.json(body)
      } catch (err: any) { res.status(500).json({ error: err.message }) }
    })

  return r
}

/**
 * Exported so engine/connector-ops.ts can call Cashfree from workflow nodes.
 * Returns the App ID, decrypted Secret Key, and the environment-specific base.
 */
export async function loadCreds(
  supabase: SupabaseClient, tenantId: string,
): Promise<{ appId: string; secret: string; base: string; environment: 'production' | 'sandbox' }> {
  const { data: row } = await supabase.from('tenant_integrations')
    .select('access_token, metadata')
    .eq('tenant_id', tenantId).eq('key', 'cashfree').maybeSingle()
  if (!row?.access_token) throw new Error('Cashfree not connected')
  const md = (row.metadata as any) ?? {}
  if (!md.app_id) throw new Error('Cashfree connection missing App ID — please reconnect')
  const environment: 'production' | 'sandbox' = md.environment === 'sandbox' ? 'sandbox' : 'production'
  return { appId: String(md.app_id), secret: decrypt(row.access_token), base: CF_BASE[environment], environment }
}
