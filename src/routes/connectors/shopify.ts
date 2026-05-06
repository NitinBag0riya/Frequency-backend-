/**
 * Shopify connector — OAuth + custom-app admin-token fallback + capabilities.
 *
 *   1. **Custom app token (works today)** — Shopify lets store owners create
 *      a "custom app" inside their admin → Apps → Develop apps → install →
 *      copy Admin API token. Paste into our UI with the shop domain.
 *      No partner-account needed.
 *   2. **OAuth (needs Shopify Partner)** — public Shopify app installation.
 *      Mounts /api/auth/shopify/start?shop=<shop> and /api/auth/shopify/callback.
 *      Endpoints exist; flip the env switch to enable.
 *
 * Required env vars (OAuth path):
 *   SHOPIFY_API_KEY
 *   SHOPIFY_API_SECRET
 *   SHOPIFY_REDIRECT_URI
 *   SHOPIFY_API_VERSION (defaults to 2024-04)
 *
 * Capabilities (https://shopify.dev/docs/api/admin-rest):
 *   list_orders            GET    /admin/api/<v>/orders.json
 *   get_order(:id)         GET    /admin/api/<v>/orders/:id.json
 *   list_products          GET    /admin/api/<v>/products.json
 *   list_customers         GET    /admin/api/<v>/customers.json
 *   create_draft_order     POST   /admin/api/<v>/draft_orders.json
 */

import express from 'express'
import crypto from 'crypto'
import { z } from 'zod'
import { SupabaseClient } from '@supabase/supabase-js'
import { encrypt, decrypt, randomToken } from '../../crypto'
import { validateBody } from '../../validation'

type Middleware = (req: express.Request, res: express.Response, next: express.NextFunction) => void | Promise<void>
interface Deps {
  supabase: SupabaseClient
  requireAuth: Middleware
  identifyTenant: Middleware
  checkPermission: (feature: string, action: 'view' | 'edit' | 'delete') => Middleware
}

const API_VERSION = process.env.SHOPIFY_API_VERSION ?? '2024-04'
const SCOPES = 'read_orders,read_customers,read_products,read_inventory,write_draft_orders'

const TokenSchema = z.object({
  shop_domain:  z.string().regex(/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/i, 'Must be a *.myshopify.com domain'),
  admin_token:  z.string().regex(/^shpat_/, 'Custom-app tokens start with shpat_'),
})

const DraftOrderSchema = z.object({
  line_items:    z.array(z.any()).min(1),
  customer:      z.object({ email: z.string().email().optional(), id: z.number().optional() }).optional(),
  use_customer_default_address: z.boolean().optional(),
  note:          z.string().optional(),
  tags:          z.string().optional(),
}).passthrough()

export function createShopifyConnector(deps: Deps): express.Router {
  const r = express.Router()
  const { supabase, requireAuth, identifyTenant, checkPermission } = deps

  // ── Token-paste connect (works today, no Partner reg) ────────────────────
  r.post('/api/connectors/shopify/connect-token',
    requireAuth, identifyTenant, checkPermission('integrations', 'edit'),
    validateBody(TokenSchema),
    async (req, res) => {
      const tenantId = (req as any).tenantId
      const { shop_domain, admin_token } = req.body as z.infer<typeof TokenSchema>

      // Verify with a real call to GET /shop.json
      const verify = await fetch(`https://${shop_domain}/admin/api/${API_VERSION}/shop.json`, {
        headers: { 'X-Shopify-Access-Token': admin_token, 'Content-Type': 'application/json' },
      })
      if (!verify.ok) {
        const text = await verify.text()
        const detail = verify.status === 401 ? 'Token rejected by Shopify (check scopes + reinstall the app)' : `Shopify returned ${verify.status}`
        res.status(400).json({ error: detail, body: text.slice(0, 200) })
        return
      }
      const shopBody = await verify.json() as any
      const label = shopBody?.shop?.name ?? shop_domain

      await supabase.from('tenant_integrations').upsert({
        tenant_id:     tenantId,
        key:           'shopify',
        status:        'active',
        access_token:  encrypt(admin_token),
        scope:         SCOPES,
        brand_label:   label,
        metadata:      { auth_mode: 'custom_app', shop_domain, shop_id: shopBody?.shop?.id },
      }, { onConflict: 'tenant_id,key' })
      res.json({ success: true, shop: label })
    })

  // ── OAuth start ───────────────────────────────────────────────────────────
  r.get('/api/auth/shopify/start',
    requireAuth, identifyTenant,
    async (req, res) => {
      const apiKey      = process.env.SHOPIFY_API_KEY
      const redirectUri = process.env.SHOPIFY_REDIRECT_URI
      const shop = String(req.query.shop ?? '')
      if (!apiKey || !redirectUri) {
        res.status(503).type('html').send(envMissingHtml('Shopify (OAuth)',
          ['SHOPIFY_API_KEY', 'SHOPIFY_API_SECRET', 'SHOPIFY_REDIRECT_URI'],
          'https://partners.shopify.com/',
          'Or paste a custom-app admin token (works today, no Partner reg).'))
        return
      }
      if (!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/i.test(shop)) {
        res.status(400).json({ error: 'Pass ?shop=<store>.myshopify.com' })
        return
      }
      const state = randomToken(24)
      await supabase.from('oauth_states').insert({
        tenant_id:     (req as any).tenantId,
        user_id:       (req as any).user.id,
        connector_key: 'shopify',
        state,
        metadata:      { shop_domain: shop },
      })
      const params = new URLSearchParams({
        client_id:    apiKey,
        scope:        SCOPES,
        redirect_uri: redirectUri,
        state,
      })
      res.redirect(`https://${shop}/admin/oauth/authorize?${params}`)
    })

  // ── OAuth callback ────────────────────────────────────────────────────────
  r.get('/api/auth/shopify/callback', async (req, res) => {
    const { code, state, shop, hmac } = req.query as Record<string, string>
    if (!code || !state || !shop) { res.status(400).type('html').send(closePopupHtml({ ok: false, error: 'Missing code/state/shop' })); return }

    // Verify HMAC per Shopify spec
    const apiSecret = process.env.SHOPIFY_API_SECRET!
    if (!verifyShopifyHmac(req.query as Record<string, string>, apiSecret)) {
      res.status(400).type('html').send(closePopupHtml({ ok: false, error: 'HMAC check failed (request tampered)' }))
      return
    }
    const { data: stateRow } = await supabase.from('oauth_states')
      .select('*').eq('state', state).maybeSingle()
    if (!stateRow) { res.status(400).type('html').send(closePopupHtml({ ok: false, error: 'Unknown state' })); return }

    const tokenRes = await fetch(`https://${shop}/admin/oauth/access_token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id:     process.env.SHOPIFY_API_KEY,
        client_secret: apiSecret,
        code,
      }),
    })
    const body = await tokenRes.json() as any
    if (!tokenRes.ok) { res.status(400).type('html').send(closePopupHtml({ ok: false, error: body.error_description ?? body.error ?? 'Shopify token exchange failed' })); return }

    await supabase.from('tenant_integrations').upsert({
      tenant_id:    stateRow.tenant_id,
      key:          'shopify',
      status:       'active',
      access_token: encrypt(body.access_token),
      scope:        body.scope,
      brand_label:  shop,
      metadata:     { auth_mode: 'oauth', shop_domain: shop },
    }, { onConflict: 'tenant_id,key' })
    await supabase.from('oauth_states').delete().eq('state', state)
    res.type('html').send(closePopupHtml({ ok: true, connector: 'shopify', label: shop }))
  })

  // ── Capabilities ──────────────────────────────────────────────────────────
  const guardView = [requireAuth, identifyTenant, checkPermission('integrations', 'view')]

  r.get('/api/connectors/shopify/orders', ...guardView, async (req, res) => {
    try {
      const { token, shop } = await loadCreds(supabase, (req as any).tenantId)
      const params = new URLSearchParams()
      params.set('limit',  String(Math.min(Number(req.query.limit ?? 50), 250)))
      params.set('status', String(req.query.status ?? 'any'))
      const r2 = await fetch(`https://${shop}/admin/api/${API_VERSION}/orders.json?${params}`, {
        headers: { 'X-Shopify-Access-Token': token },
      })
      const body = await r2.json() as any
      if (!r2.ok) { res.status(r2.status).json({ error: shopifyErr(r2, body) }); return }
      res.json(body)
    } catch (err: any) { res.status(500).json({ error: err.message }) }
  })

  r.get('/api/connectors/shopify/orders/:id', ...guardView, async (req, res) => {
    try {
      const { token, shop } = await loadCreds(supabase, (req as any).tenantId)
      const r2 = await fetch(`https://${shop}/admin/api/${API_VERSION}/orders/${req.params.id}.json`, {
        headers: { 'X-Shopify-Access-Token': token },
      })
      const body = await r2.json() as any
      if (!r2.ok) { res.status(r2.status).json({ error: shopifyErr(r2, body) }); return }
      res.json(body)
    } catch (err: any) { res.status(500).json({ error: err.message }) }
  })

  r.get('/api/connectors/shopify/products', ...guardView, async (req, res) => {
    try {
      const { token, shop } = await loadCreds(supabase, (req as any).tenantId)
      const params = new URLSearchParams()
      params.set('limit', String(Math.min(Number(req.query.limit ?? 50), 250)))
      const r2 = await fetch(`https://${shop}/admin/api/${API_VERSION}/products.json?${params}`, {
        headers: { 'X-Shopify-Access-Token': token },
      })
      const body = await r2.json() as any
      if (!r2.ok) { res.status(r2.status).json({ error: shopifyErr(r2, body) }); return }
      res.json(body)
    } catch (err: any) { res.status(500).json({ error: err.message }) }
  })

  r.get('/api/connectors/shopify/customers', ...guardView, async (req, res) => {
    try {
      const { token, shop } = await loadCreds(supabase, (req as any).tenantId)
      const params = new URLSearchParams()
      params.set('limit', String(Math.min(Number(req.query.limit ?? 50), 250)))
      if (req.query.query) params.set('query', String(req.query.query))
      const r2 = await fetch(`https://${shop}/admin/api/${API_VERSION}/customers.json?${params}`, {
        headers: { 'X-Shopify-Access-Token': token },
      })
      const body = await r2.json() as any
      if (!r2.ok) { res.status(r2.status).json({ error: shopifyErr(r2, body) }); return }
      res.json(body)
    } catch (err: any) { res.status(500).json({ error: err.message }) }
  })

  r.post('/api/connectors/shopify/draft-orders',
    requireAuth, identifyTenant, checkPermission('integrations', 'edit'),
    validateBody(DraftOrderSchema),
    async (req, res) => {
      try {
        const { token, shop } = await loadCreds(supabase, (req as any).tenantId)
        const r2 = await fetch(`https://${shop}/admin/api/${API_VERSION}/draft_orders.json`, {
          method: 'POST',
          headers: { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' },
          body: JSON.stringify({ draft_order: req.body }),
        })
        const body = await r2.json() as any
        if (!r2.ok) { res.status(r2.status).json({ error: shopifyErr(r2, body) }); return }
        res.json(body)
      } catch (err: any) { res.status(500).json({ error: err.message }) }
    })

  return r
}

async function loadCreds(supabase: SupabaseClient, tenantId: string) {
  const { data: row } = await supabase.from('tenant_integrations')
    .select('access_token, metadata')
    .eq('tenant_id', tenantId).eq('key', 'shopify').maybeSingle()
  if (!row?.access_token) throw new Error('Shopify not connected')
  const md = (row.metadata as any) ?? {}
  if (!md.shop_domain) throw new Error('Shopify connection missing shop_domain — please reconnect')
  return { token: decrypt(row.access_token), shop: md.shop_domain as string }
}

function shopifyErr(r: Response, body: any): string {
  if (r.status === 429) return 'Shopify rate limit exceeded — try again in a moment'
  if (body?.errors) return typeof body.errors === 'string' ? body.errors : JSON.stringify(body.errors)
  return `Shopify ${r.status}`
}

/** Verify Shopify's HMAC on the OAuth callback per
 *  https://shopify.dev/docs/apps/build/authentication-authorization/access-tokens/authorization-code-grant */
function verifyShopifyHmac(query: Record<string, string>, secret: string): boolean {
  const { hmac, ...rest } = query
  if (!hmac) return false
  const sortedQs = Object.keys(rest).sort().map(k => `${k}=${rest[k]}`).join('&')
  const computed = crypto.createHmac('sha256', secret).update(sortedQs).digest('hex')
  // Constant-time compare
  if (computed.length !== hmac.length) return false
  return crypto.timingSafeEqual(Buffer.from(computed), Buffer.from(hmac))
}

// ─────────────────────────────────────────────────────────────────────────────
function closePopupHtml(payload: { ok: boolean; connector?: string; error?: string; label?: string }) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${payload.ok ? 'Connected' : 'Failed'}</title>
<style>body{font:14px/1.5 -apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;padding:32px;max-width:420px;margin:48px auto;text-align:center;color:#1a1a1a}h2{font-size:18px;margin:8px 0}.icon{font-size:42px;margin-bottom:8px}.muted{color:#6b7280;font-size:13px;margin-top:16px}</style>
</head><body>
<div class="icon">${payload.ok ? '✅' : '⚠️'}</div>
<h2>${payload.ok ? `Connected to ${payload.connector ?? 'app'}` : 'Couldn\'t connect'}</h2>
<p>${payload.ok ? (payload.label ?? '') : escapeHtml(payload.error ?? 'Unknown error')}</p>
<p class="muted">${payload.ok ? 'You can close this window.' : 'You can close this window and try again.'}</p>
<script>
  try { window.opener?.postMessage(${JSON.stringify(payload)}, '*'); } catch(e){}
  setTimeout(() => { try { window.close(); } catch(e){} }, 1200);
</script>
</body></html>`
}
function envMissingHtml(name: string, vars: string[], registerUrl: string, hint?: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${name} not configured</title>
<style>body{font:14px/1.5 -apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;padding:32px;max-width:520px;margin:48px auto;color:#1a1a1a}h2{font-size:18px;margin:0 0 8px}code{background:#f4f4f5;padding:1px 5px;border-radius:3px;font-family:ui-monospace,monospace;font-size:12.5px}.muted{color:#6b7280}a{color:#0070f3}</style>
</head><body>
<h2>⚙️ ${name} not yet configured</h2>
<p class="muted">An admin needs to register and set these env vars on the server:</p>
<ul>${vars.map(v => `<li><code>${v}</code></li>`).join('')}</ul>
<p>Reference: <a href="${registerUrl}" target="_blank">${registerUrl}</a></p>
${hint ? `<p class="muted">${hint}</p>` : ''}
<script>setTimeout(() => { try { window.close(); } catch(e){} }, 8000);</script>
</body></html>`
}
function escapeHtml(s: string): string {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' } as any)[c])
}
