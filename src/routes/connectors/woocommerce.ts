/**
 * WooCommerce connector — REST API consumer key/secret + capabilities.
 *
 * WooCommerce is the dominant D2C storefront for Indian SMBs on WordPress.
 * Unlike Shopify there is NO central app/partner registration: each store
 * owner generates a REST API key pair inside their own WP admin
 * (WooCommerce → Settings → Advanced → REST API → Add key, Read/Write).
 * That makes this a pure paste-key connect — no OAuth, works today for any
 * tenant the moment they paste credentials. Mirrors the Shopify connector.
 *
 * Auth: HTTP Basic over HTTPS — consumer_key as username, consumer_secret as
 * password (the documented primary method;
 * https://woocommerce.github.io/woocommerce-rest-api-docs/#authentication).
 *
 * Capabilities (WC REST v3):
 *   list_products      GET   /wp-json/wc/v3/products
 *   list_orders        GET   /wp-json/wc/v3/orders
 *   get_order(:id)     GET   /wp-json/wc/v3/orders/:id
 *   list_customers     GET   /wp-json/wc/v3/customers
 *   create_order       POST  /wp-json/wc/v3/orders
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

const WC_PATH = '/wp-json/wc/v3'

const TokenSchema = z.object({
  store_url:       z.string().url('Must be a full URL, e.g. https://shop.example.com'),
  consumer_key:    z.string().regex(/^ck_/, 'Consumer keys start with ck_'),
  consumer_secret: z.string().regex(/^cs_/, 'Consumer secrets start with cs_'),
})

const OrderSchema = z.object({
  line_items:     z.array(z.any()).min(1, 'At least one line item is required'),
  billing:        z.record(z.string(), z.any()).optional(),
  shipping:       z.record(z.string(), z.any()).optional(),
  customer_id:    z.number().optional(),
  payment_method: z.string().optional(),
  payment_method_title: z.string().optional(),
  set_paid:       z.boolean().optional(),
  status:         z.string().optional(),
  customer_note:  z.string().optional(),
}).passthrough()

/** Strip trailing slash + force https so the saved base URL is canonical. */
function normalizeStoreUrl(raw: string): string {
  let u = raw.trim().replace(/\/+$/, '')
  if (u.startsWith('http://')) u = 'https://' + u.slice('http://'.length)
  return u
}

function basicAuth(ck: string, cs: string): string {
  return 'Basic ' + Buffer.from(`${ck}:${cs}`).toString('base64')
}

export function createWoocommerceConnector(deps: Deps): express.Router {
  const r = express.Router()
  const { supabase, requireAuth, identifyTenant, checkPermission } = deps

  // ── Paste-key connect (works today, no app registration) ──────────────────
  r.post('/api/connectors/woocommerce/connect-token',
    requireAuth, identifyTenant, checkPermission('integrations', 'edit'),
    validateBody(TokenSchema),
    async (req, res) => {
      const tenantId = (req as any).tenantId
      // tenant_integrations.user_id is NOT NULL — omitting it produces a silent
      // constraint violation surfaced as { error } (not a throw).
      const userId = (req as any).user?.id as string | undefined
      if (!userId) { res.status(401).json({ error: 'auth missing user.id' }); return }

      const { consumer_key, consumer_secret } = req.body as z.infer<typeof TokenSchema>
      const store = normalizeStoreUrl((req.body as any).store_url)

      // Verify with a real call before persisting (same contract as Shopify/Razorpay).
      let verify: Response
      try {
        verify = await fetch(`${store}${WC_PATH}/products?per_page=1`, {
          headers: { Authorization: basicAuth(consumer_key, consumer_secret) },
        })
      } catch (e: any) {
        res.status(400).json({ error: `Could not reach ${store} — check the store URL is public and uses HTTPS (${e?.message ?? 'network error'})` })
        return
      }
      if (!verify.ok) {
        const text = await verify.text().catch(() => '')
        const detail = verify.status === 401
          ? 'Keys rejected by WooCommerce (check the key has Read/Write access and was copied fully)'
          : verify.status === 404
            ? 'WooCommerce REST API not found at this URL — confirm WooCommerce is installed and permalinks are enabled'
            : `WooCommerce returned ${verify.status}`
        res.status(400).json({ error: detail, body: text.slice(0, 200) })
        return
      }

      // Pull store identity for a friendly brand_label (best-effort, non-fatal).
      let label = store.replace(/^https?:\/\//, '')
      try {
        const sysRes = await fetch(`${store}${WC_PATH}/system_status`, {
          headers: { Authorization: basicAuth(consumer_key, consumer_secret) },
        })
        if (sysRes.ok) {
          const sys = await sysRes.json() as any
          const name = sys?.settings?.title || sys?.environment?.site_url
          if (name) label = String(name).replace(/^https?:\/\//, '')
        }
      } catch { /* identity fetch must never block the connect */ }

      const { error: upsertErr } = await supabase.from('tenant_integrations').upsert({
        tenant_id:    tenantId,
        user_id:      userId,
        key:          'woocommerce',
        status:       'active',
        access_token: encrypt(consumer_secret),
        scope:        'read_write',
        brand_label:  label,
        metadata:     { auth_mode: 'rest_key', store_url: store, consumer_key },
      }, { onConflict: 'tenant_id,key' })
      if (upsertErr) {
        console.error(`[woocommerce connect] DB upsert failed: ${upsertErr.message}`)
        res.status(500).json({ error: 'Failed to persist connection: ' + upsertErr.message }); return
      }
      res.json({ success: true, store: label })
    })

  // ── Capabilities ──────────────────────────────────────────────────────────
  const guardView = [requireAuth, identifyTenant, checkPermission('integrations', 'view')]

  r.get('/api/connectors/woocommerce/products', ...guardView, async (req, res) => {
    try {
      const creds = await loadCreds(supabase, (req as any).tenantId)
      const params = new URLSearchParams()
      params.set('per_page', String(Math.min(Number(req.query.limit ?? 50), 100)))
      if (req.query.search) params.set('search', String(req.query.search))
      const r2 = await fetch(`${creds.store}${WC_PATH}/products?${params}`, { headers: { Authorization: creds.auth } })
      const body = await r2.json() as any
      if (!r2.ok) { res.status(r2.status).json({ error: wcErr(r2, body) }); return }
      res.json(body)
    } catch (err: any) { res.status(500).json({ error: err.message }) }
  })

  r.get('/api/connectors/woocommerce/orders', ...guardView, async (req, res) => {
    try {
      const creds = await loadCreds(supabase, (req as any).tenantId)
      const params = new URLSearchParams()
      params.set('per_page', String(Math.min(Number(req.query.limit ?? 50), 100)))
      if (req.query.status) params.set('status', String(req.query.status))
      const r2 = await fetch(`${creds.store}${WC_PATH}/orders?${params}`, { headers: { Authorization: creds.auth } })
      const body = await r2.json() as any
      if (!r2.ok) { res.status(r2.status).json({ error: wcErr(r2, body) }); return }
      res.json(body)
    } catch (err: any) { res.status(500).json({ error: err.message }) }
  })

  r.get('/api/connectors/woocommerce/orders/:id', ...guardView, async (req, res) => {
    try {
      const creds = await loadCreds(supabase, (req as any).tenantId)
      const r2 = await fetch(`${creds.store}${WC_PATH}/orders/${encodeURIComponent(String(req.params.id))}`, { headers: { Authorization: creds.auth } })
      const body = await r2.json() as any
      if (!r2.ok) { res.status(r2.status).json({ error: wcErr(r2, body) }); return }
      res.json(body)
    } catch (err: any) { res.status(500).json({ error: err.message }) }
  })

  r.get('/api/connectors/woocommerce/customers', ...guardView, async (req, res) => {
    try {
      const creds = await loadCreds(supabase, (req as any).tenantId)
      const params = new URLSearchParams()
      params.set('per_page', String(Math.min(Number(req.query.limit ?? 50), 100)))
      if (req.query.search) params.set('search', String(req.query.search))
      const r2 = await fetch(`${creds.store}${WC_PATH}/customers?${params}`, { headers: { Authorization: creds.auth } })
      const body = await r2.json() as any
      if (!r2.ok) { res.status(r2.status).json({ error: wcErr(r2, body) }); return }
      res.json(body)
    } catch (err: any) { res.status(500).json({ error: err.message }) }
  })

  r.post('/api/connectors/woocommerce/orders',
    requireAuth, identifyTenant, checkPermission('integrations', 'edit'),
    validateBody(OrderSchema),
    async (req, res) => {
      try {
        const creds = await loadCreds(supabase, (req as any).tenantId)
        const r2 = await fetch(`${creds.store}${WC_PATH}/orders`, {
          method: 'POST',
          headers: { Authorization: creds.auth, 'Content-Type': 'application/json' },
          body: JSON.stringify(req.body),
        })
        const body = await r2.json() as any
        if (!r2.ok) { res.status(r2.status).json({ error: wcErr(r2, body) }); return }
        res.json(body)
      } catch (err: any) { res.status(500).json({ error: err.message }) }
    })

  return r
}

/**
 * Exported so engine/connector-ops.ts can call WooCommerce from workflow nodes
 * without duplicating the auth lookup. Returns the canonical store base URL and
 * a ready-to-use Basic auth header.
 */
export async function loadCreds(supabase: SupabaseClient, tenantId: string) {
  const { data: row } = await supabase.from('tenant_integrations')
    .select('access_token, metadata')
    .eq('tenant_id', tenantId).eq('key', 'woocommerce').maybeSingle()
  if (!row?.access_token) throw new Error('WooCommerce not connected')
  const md = (row.metadata as any) ?? {}
  if (!md.store_url || !md.consumer_key) throw new Error('WooCommerce connection missing store_url/consumer_key — please reconnect')
  const auth = basicAuth(md.consumer_key as string, decrypt(row.access_token))
  return { store: md.store_url as string, auth }
}

function wcErr(r: Response, body: any): string {
  if (r.status === 429) return 'WooCommerce rate limit exceeded — try again in a moment'
  if (body?.message) return String(body.message)
  if (body?.code)    return `${body.code}`
  return `WooCommerce ${r.status}`
}
