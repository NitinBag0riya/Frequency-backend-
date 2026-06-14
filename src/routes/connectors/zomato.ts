/**
 * Zomato connector — Order Management integration (restaurant partner).
 *
 * Built against the real endpoint contract documented at
 *   https://www.zomato.com/developer/integration/docs/api-documentation/order-management
 * Base path: /online-ordering/v1
 *
 *   Partner → Zomato (we call):
 *     order/confirm  order/reject  order/ready  order/pickedup
 *     order/assigned order/delivered
 *     order-analytics/get_orders_rating   complaints/update
 *     mac/update     order/get-contact-details
 *   Zomato → Partner (we host a webhook):
 *     orders/relay (new order) · vendor-order-status-update · fetch-order-status
 *     order-rider-status-update · push-rating-to-client · complaints-relay · mac-relay
 *
 * SCAFFOLD STATUS — what is real vs. pending:
 *   ✓ Real: endpoint paths, lifecycle, connect + per-tenant webhook URL,
 *           credential storage, outbound client, order ingestion table.
 *   ⚠ Pending the partner OpenAPI spec + sandbox credentials (the field-level
 *     schemas are JS-gated and the API is provisioned per restaurant partner):
 *       - exact AUTH header name/scheme           → ZOMATO_AUTH_HEADER
 *       - exact request body fields per action     → see TODO(zomato-spec)
 *       - exact webhook payload field names + the  → mapZomatoOrder()
 *         signature header/algorithm               → verifySignature()
 *   Every such spot is marked `TODO(zomato-spec)`. Until they're filled in
 *   against the partner docs and tested in Zomato's sandbox, this connector is
 *   registered as `beta` and must NOT be presented to customers as live.
 */

import express from 'express'
import { z } from 'zod'
import { SupabaseClient } from '@supabase/supabase-js'
import crypto from 'crypto'
import { encrypt, decrypt } from '../../crypto'
import { validateBody } from '../../validation'

type Middleware = (req: express.Request, res: express.Response, next: express.NextFunction) => void | Promise<void>
interface Deps {
  supabase: SupabaseClient
  requireAuth: Middleware
  identifyTenant: Middleware
  checkPermission: (feature: string, action: 'view' | 'edit' | 'delete') => Middleware
}

const ZOMATO_BASE = (process.env.ZOMATO_API_BASE ?? 'https://api.zomato.com').replace(/\/+$/, '')
// TODO(zomato-spec): confirm the auth header — partner POS integrations vary
// between an `access-token` header and `Authorization: Bearer`. Overridable so
// we don't have to redeploy to correct it once the spec is confirmed.
const ZOMATO_AUTH_HEADER = process.env.ZOMATO_AUTH_HEADER ?? 'access-token'
const PUBLIC_BASE_URL = (process.env.PUBLIC_API_URL ?? 'http://localhost:3001').replace(/\/+$/, '')

// Real Order-Management endpoints (base path /online-ordering/v1).
const EP = {
  confirm:         '/online-ordering/v1/order/confirm',
  reject:          '/online-ordering/v1/order/reject',
  ready:           '/online-ordering/v1/order/ready',
  pickedup:        '/online-ordering/v1/order/pickedup',
  assigned:        '/online-ordering/v1/order/assigned',
  delivered:       '/online-ordering/v1/order/delivered',
  getRatings:      '/online-ordering/v1/order-analytics/get_orders_rating',
  updateComplaint: '/online-ordering/v1/complaints/update',
  macUpdate:       '/online-ordering/v1/mac/update',
  contactDetails:  '/online-ordering/v1/order/get-contact-details',
} as const

// Outbound actions an operator can take on a relayed order, surfaced as
// capabilities. Each is a POST that carries at least the Zomato order id.
const ACTIONS: { key: string; path: string }[] = [
  { key: 'confirm',   path: EP.confirm },
  { key: 'reject',    path: EP.reject },
  { key: 'ready',     path: EP.ready },
  { key: 'pickedup',  path: EP.pickedup },
  { key: 'assigned',  path: EP.assigned },
  { key: 'delivered', path: EP.delivered },
]

// Zomato webhook event → our normalised lifecycle status.
// TODO(zomato-spec): align the left-hand keys with the exact `type`/event
// discriminator Zomato sends; these are the documented webhook names.
const EVENT_STATUS: Record<string, string> = {
  'orders/relay':                 'placed',
  'orders.relay':                 'placed',
  'order_relay':                  'placed',
  'vendor-order-status-update':   'rejected',
  'order-rider-status-update':    'assigned',
  'push-rating-to-client':        'delivered',
  'mac-relay':                    'cancelled',
}

const ConnectSchema = z.object({
  apiKey:    z.string().min(1, 'Zomato partner API key is required'),
  apiSecret: z.string().min(1, 'Zomato partner API secret is required'),
  baseUrl:   z.string().url().optional(),       // sandbox vs prod override
  outletId:  z.string().optional(),             // Zomato res_id / outlet id
})

type Creds = { apiKey: string; apiSecret: string; baseUrl: string; metadata: any }

/** Load + decrypt this tenant's Zomato partner credentials. */
export async function loadCreds(supabase: SupabaseClient, tenantId: string): Promise<Creds> {
  const { data: row } = await supabase.from('tenant_integrations')
    .select('access_token, metadata')
    .eq('tenant_id', tenantId).eq('key', 'zomato').maybeSingle()
  if (!row?.access_token) throw Object.assign(new Error('Zomato not connected'), { status: 424 })
  const md = (row.metadata as any) ?? {}
  if (!md.api_secret) throw Object.assign(new Error('Zomato connection missing secret — please reconnect'), { status: 424 })
  return {
    apiKey:    decrypt(row.access_token),
    apiSecret: decrypt(md.api_secret),
    baseUrl:   (md.base_url as string) || ZOMATO_BASE,
    metadata:  md,
  }
}

/** Authenticated POST to a Zomato Order-Management endpoint. */
async function zomatoPost(creds: Creds, path: string, body: any): Promise<{ ok: boolean; status: number; body: any }> {
  const r = await fetch(`${creds.baseUrl}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      // TODO(zomato-spec): confirm header name + whether a `Bearer ` prefix applies.
      [ZOMATO_AUTH_HEADER]: creds.apiKey,
    },
    body: JSON.stringify(body),
  })
  const respBody = await r.json().catch(() => ({})) as any
  return { ok: r.ok, status: r.status, body: respBody }
}

/**
 * Normalise a Zomato webhook payload into a zomato_orders row.
 * TODO(zomato-spec): the field names below are best-effort against the
 * documented lifecycle — replace with the exact keys from the orders/relay
 * schema. The full raw payload is always retained in `payload`.
 */
function mapZomatoOrder(tenantId: string, eventType: string, payload: any): Record<string, any> {
  const o = payload?.order ?? payload ?? {}
  const items = Array.isArray(o.items) ? o.items : Array.isArray(o.order_items) ? o.order_items : []
  const zomatoOrderId = String(o.order_id ?? o.id ?? o.zomato_order_id ?? payload?.order_id ?? '')
  return {
    tenant_id:             tenantId,
    zomato_order_id:       zomatoOrderId,
    status:                EVENT_STATUS[eventType] ?? 'placed',
    outlet_ref:            o.res_id != null ? String(o.res_id) : (o.outlet_id != null ? String(o.outlet_id) : null),
    customer_name:         o.customer?.name ?? o.customer_name ?? null,
    customer_phone_masked: o.customer?.phone ?? o.customer_phone ?? null,   // Zomato masks this
    item_count:            items.reduce((n: number, it: any) => n + (Number(it.quantity ?? it.qty ?? 1) || 1), 0),
    gross_amount:          o.total_cost ?? o.net_amount ?? o.order_total ?? null,
    rating:                o.rating ?? null,
    placed_at:             o.created_at ?? o.order_date ?? null,
    last_event_type:       eventType,
    payload,
  }
}

/**
 * Verify the webhook signature. The per-tenant URL token is the primary
 * authenticator (same model as the lead-ingest webhooks); the HMAC is
 * defence-in-depth.
 * TODO(zomato-spec): confirm the signature header name + algorithm + whether
 * it's computed over the raw body. Until then this is best-effort and never
 * the sole gate.
 */
function verifySignature(secret: string, rawBody: string, header: string | undefined): boolean {
  if (!header) return false
  const computed = crypto.createHmac('sha256', secret).update(rawBody).digest('hex')
  try {
    return computed.length === header.length &&
      crypto.timingSafeEqual(Buffer.from(computed), Buffer.from(header))
  } catch { return false }
}

export function createZomatoConnector(deps: Deps): express.Router {
  const r = express.Router()
  const { supabase, requireAuth, identifyTenant, checkPermission } = deps

  // ── Connect: paste partner key/secret, mint the inbound webhook URL ────────
  r.post('/api/connectors/zomato/connect-key',
    requireAuth, identifyTenant, checkPermission('integrations', 'edit'),
    validateBody(ConnectSchema),
    async (req, res) => {
      const tenantId = (req as any).tenantId
      const userId = (req as any).user?.id as string | undefined
      if (!userId) { res.status(401).json({ error: 'auth missing user.id' }); return }
      const { apiKey, apiSecret, baseUrl, outletId } = req.body as z.infer<typeof ConnectSchema>

      // Reuse an existing webhook token so the operator's pasted URL stays stable
      // across reconnects.
      const { data: existing } = await supabase.from('tenant_integrations')
        .select('metadata').eq('tenant_id', tenantId).eq('key', 'zomato').maybeSingle()
      const ingestToken = (existing?.metadata as any)?.ingest_token ?? crypto.randomBytes(24).toString('hex')

      // TODO(zomato-spec): once a partner "ping"/health endpoint is known, verify
      // the credentials here (like the Shiprocket login does) before persisting.
      const { error } = await supabase.from('tenant_integrations').upsert({
        tenant_id:    tenantId,
        user_id:      userId,
        key:          'zomato',
        status:       'active',
        access_token: encrypt(apiKey),
        scope:        'order_management',
        brand_label:  outletId ? `Zomato · ${outletId}` : 'Zomato',
        metadata: {
          auth_mode:    'api_key',
          api_secret:   encrypt(apiSecret),
          base_url:     baseUrl ? baseUrl.replace(/\/+$/, '') : ZOMATO_BASE,
          outlet_id:    outletId ?? null,
          ingest_token: ingestToken,
          verified:     false,   // flips true once we can ping the partner API
        },
      }, { onConflict: 'tenant_id,key' })
      if (error) { res.status(500).json({ error: 'Failed to persist connection: ' + error.message }); return }

      res.json({
        success: true,
        account: outletId ? `Zomato · ${outletId}` : 'Zomato',
        webhookUrl: `${PUBLIC_BASE_URL}/api/connectors/zomato/webhook/${ingestToken}`,
        note: 'Paste this webhook URL into your Zomato partner portal (Order Relay + status webhooks). Connection is in beta until the partner spec + sandbox are wired.',
      })
    })

  // ── Inbound webhook (public; tenant resolved by the URL token) ─────────────
  // Zomato → us: new orders + status/rider/rating/complaint/cancellation events.
  // Optional :event segment lets each webhook type post to its own path; we
  // also fall back to inferring the type from the payload.
  const onWebhook = async (req: express.Request, res: express.Response) => {
    const token = String(req.params.token || '')
    const eventType = String(req.params.event || req.body?.type || req.body?.event || 'orders/relay')
    const { data: conn } = await supabase.from('tenant_integrations')
      .select('tenant_id, metadata')
      .eq('key', 'zomato').eq('metadata->>ingest_token', token).maybeSingle()
    if (!conn?.tenant_id) { res.status(404).json({ error: 'Unknown webhook token' }); return }

    // Defence-in-depth signature check (token is the primary auth).
    const md = (conn.metadata as any) ?? {}
    if (md.api_secret) {
      const sig = req.header('x-zomato-signature') || req.header('x-signature') || undefined
      const ok = verifySignature(decrypt(md.api_secret), JSON.stringify(req.body ?? {}), sig)
      if (sig && !ok) console.warn('[zomato webhook] signature mismatch (processing on token auth) — TODO confirm scheme')
    }

    try {
      const row = mapZomatoOrder(conn.tenant_id as string, eventType, req.body ?? {})
      if (row.zomato_order_id) {
        const { error } = await supabase.from('zomato_orders')
          .upsert({ ...row, updated_at: new Date().toISOString() }, { onConflict: 'tenant_id,zomato_order_id' })
        if (error) console.error(`[zomato webhook] upsert failed: ${error.message}`)
      } else {
        console.warn(`[zomato webhook] ${eventType} had no resolvable order id — stored event only`)
      }
    } catch (e: any) {
      console.error(`[zomato webhook] processing error: ${e?.message}`)
    }
    // Always ack 2xx fast so Zomato doesn't retry/penalise.
    res.json({ received: true })
  }
  r.post('/api/connectors/zomato/webhook/:token', onWebhook)
  r.post('/api/connectors/zomato/webhook/:token/:event', onWebhook)

  // ── Outbound order actions (operator advances the order on Zomato) ─────────
  const guardEdit = [requireAuth, identifyTenant, checkPermission('integrations', 'edit')]
  const guardView = [requireAuth, identifyTenant, checkPermission('integrations', 'view')]
  const ActionBody = z.object({ orderId: z.union([z.string(), z.number()]).transform(String) }).passthrough()

  for (const action of ACTIONS) {
    r.post(`/api/connectors/zomato/order/${action.key}`, ...guardEdit,
      validateBody(ActionBody),
      async (req, res) => {
        try {
          const creds = await loadCreds(supabase, (req as any).tenantId)
          const { orderId, ...rest } = req.body as any
          // TODO(zomato-spec): confirm the exact body shape per action (some take
          // rider details / rejection reason / prep time). We forward order_id +
          // any extra fields the caller supplied.
          const out = await zomatoPost(creds, action.path, { order_id: orderId, ...rest })
          if (!out.ok) { res.status(out.status).json({ error: out.body?.message || `Zomato ${out.status}` }); return }
          res.json(out.body)
        } catch (err: any) { res.status(err?.status ?? 500).json({ error: err.message }) }
      })
  }

  // Masked customer / rider contact details for a relayed order.
  r.post('/api/connectors/zomato/order/contact-details', ...guardView,
    validateBody(ActionBody),
    async (req, res) => {
      try {
        const creds = await loadCreds(supabase, (req as any).tenantId)
        const out = await zomatoPost(creds, EP.contactDetails, { order_id: (req.body as any).orderId })
        if (!out.ok) { res.status(out.status).json({ error: out.body?.message || `Zomato ${out.status}` }); return }
        res.json(out.body)
      } catch (err: any) { res.status(err?.status ?? 500).json({ error: err.message }) }
    })

  // Order ratings (by order id or date) — POST per the documented endpoint.
  r.post('/api/connectors/zomato/ratings', ...guardView, async (req, res) => {
    try {
      const creds = await loadCreds(supabase, (req as any).tenantId)
      const out = await zomatoPost(creds, EP.getRatings, req.body ?? {})
      if (!out.ok) { res.status(out.status).json({ error: out.body?.message || `Zomato ${out.status}` }); return }
      res.json(out.body)
    } catch (err: any) { res.status(err?.status ?? 500).json({ error: err.message }) }
  })

  // Operator's view of ingested Zomato orders (reads our normalised table).
  r.get('/api/connectors/zomato/orders', ...guardView, async (req, res) => {
    try {
      const { data, error } = await supabase.from('zomato_orders')
        .select('zomato_order_id, status, outlet_ref, customer_name, item_count, gross_amount, currency, rating, placed_at, last_event_type, updated_at')
        .eq('tenant_id', (req as any).tenantId)
        .order('placed_at', { ascending: false, nullsFirst: false })
        .limit(Math.min(Number(req.query.limit ?? 100), 200))
      if (error) { res.status(500).json({ error: error.message }); return }
      res.json(data ?? [])
    } catch (err: any) { res.status(err?.status ?? 500).json({ error: err.message }) }
  })

  return r
}
