/**
 * Shopify OAuth (P1 #11).
 *
 * Two endpoints, deliberately separated from the webhook handler so the
 * signature-verified write path can never be reached by a logged-in tenant
 * crafting an OAuth replay.
 *
 *   GET /api/shopify/install?shop=<>.myshopify.com
 *     Tenant-authenticated. Signs a state blob via lib/oauth-state, then
 *     302-redirects to Shopify's authorize URL with the standard D2C scope
 *     bundle. If SHOPIFY_API_KEY / SHOPIFY_API_SECRET / SHOPIFY_APP_URL is
 *     unset we return a clear 503 ("Shopify integration not configured")
 *     instead of crashing — this is the dev experience for envs without a
 *     Partner app yet.
 *
 *   GET /api/shopify/callback?shop=&code=&hmac=&state=
 *     PUBLIC (called by Shopify, not the tenant browser). Verifies:
 *       1. state HMAC signature (10-min TTL, signed by lib/oauth-state)
 *       2. shop hostname matches /^[a-z0-9-]+\.myshopify\.com$/i
 *       3. Shopify's own HMAC over the query params using SHOPIFY_API_SECRET
 *     If any step fails → 400, log, drop. If all pass:
 *       - POST shop/admin/oauth/access_token to exchange code for permanent token
 *       - encrypt(token) via src/crypto.ts
 *       - upsert shopify_stores row (service-role, RLS-bypass)
 *       - register the seven webhooks (orders/create|paid|cancelled|fulfilled,
 *         checkouts/create|update, app/uninstalled) pointing at this app's
 *         /api/webhooks/shopify, with the per-store webhook_secret as the
 *         filter — Shopify lets us specify our own secret per topic via the
 *         Webhook GraphQL mutation; we use the REST API for simplicity and
 *         rely on the shared store secret instead.
 *     Returns a tiny HTML page that closes itself + posts to its opener
 *     window (parity with the existing FE openShopifyOAuthPopup helper).
 *
 * Hardening notes:
 *   - We DO NOT trust the `shop` param verbatim — every use is regex-gated.
 *     Shopify itself will reject mis-quoted shops but we don't want to
 *     proxy attacker-controlled hostnames to Meta-style abuse.
 *   - Access token is encrypted before persistence; the decrypted token
 *     NEVER leaves the BE process.
 *   - Webhook secret is a fresh 32-byte hex per install, NOT derived from
 *     the access token (so a leaked DB row can't reconstruct the token).
 */

import express from 'express'
import crypto from 'crypto'
import { SupabaseClient } from '@supabase/supabase-js'
import { encrypt } from '../crypto'
import { signOauthState, verifyOauthState } from '../lib/oauth-state'

type Middleware = (req: express.Request, res: express.Response, next: express.NextFunction) => void | Promise<void>

interface Deps {
  supabase: SupabaseClient
  requireAuth: Middleware
  identifyTenant: Middleware
}

const SHOP_DOMAIN_RE = /^[a-z0-9][a-z0-9-]{0,59}\.myshopify\.com$/i

const SCOPES = [
  'read_orders',
  'write_orders',
  'read_customers',
  'read_checkouts',
  'read_fulfillments',
].join(',')

const WEBHOOK_TOPICS = [
  'orders/create',
  'orders/paid',
  'orders/cancelled',
  'orders/fulfilled',
  'checkouts/create',
  'checkouts/update',
  'app/uninstalled',
] as const

interface ShopifyEnv {
  apiKey: string
  apiSecret: string
  appUrl: string
}

function readShopifyEnv(): ShopifyEnv | null {
  const apiKey    = process.env.SHOPIFY_API_KEY
  const apiSecret = process.env.SHOPIFY_API_SECRET
  const appUrl    = process.env.SHOPIFY_APP_URL
  if (!apiKey || !apiSecret || !appUrl) return null
  return { apiKey, apiSecret, appUrl }
}

/**
 * Verify Shopify's HMAC over the OAuth callback query params.
 * Shopify spec: sort params alphabetically (excluding `hmac` and `signature`),
 * join as `k=v&k=v`, HMAC-SHA256 with the app secret, compare hex to the
 * `hmac` query param via timingSafeEqual.
 */
function verifyShopifyHmac(query: Record<string, any>, secret: string): boolean {
  const provided = String(query.hmac ?? '')
  if (!provided) return false
  const message = Object.keys(query)
    .filter(k => k !== 'hmac' && k !== 'signature')
    .sort()
    .map(k => `${k}=${query[k]}`)
    .join('&')
  const expected = crypto.createHmac('sha256', secret).update(message).digest('hex')
  if (provided.length !== expected.length) return false
  try {
    return crypto.timingSafeEqual(Buffer.from(provided, 'utf8'), Buffer.from(expected, 'utf8'))
  } catch {
    return false
  }
}

async function shopifyAdminCall<T = any>(
  shop: string,
  accessToken: string,
  path: string,
  init: RequestInit = {},
): Promise<{ ok: boolean; status: number; data: T | null; error?: string }> {
  const url = `https://${shop}/admin/api/2024-10/${path.replace(/^\//, '')}`
  const headers = new Headers(init.headers)
  headers.set('X-Shopify-Access-Token', accessToken)
  headers.set('Accept', 'application/json')
  if (init.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json')
  try {
    const r = await fetch(url, { ...init, headers })
    const text = await r.text()
    let data: any = null
    try { data = text ? JSON.parse(text) : null } catch { /* non-JSON */ }
    if (!r.ok) {
      return { ok: false, status: r.status, data, error: data?.errors ? JSON.stringify(data.errors) : text.slice(0, 200) }
    }
    return { ok: true, status: r.status, data: data as T }
  } catch (err: any) {
    return { ok: false, status: 0, data: null, error: err?.message ?? 'fetch failed' }
  }
}

export function createShopifyOAuthRouter(deps: Deps): express.Router {
  const r = express.Router()
  const { supabase, requireAuth, identifyTenant } = deps

  // ── GET /api/shopify/install?shop=<>.myshopify.com ──────────────────────
  // Tenant-authenticated. Builds the Shopify authorize URL + redirects.
  r.get('/api/shopify/install', requireAuth, identifyTenant, async (req, res) => {
    const env = readShopifyEnv()
    if (!env) {
      res.status(503).json({
        error: 'Shopify integration not configured',
        detail: 'SHOPIFY_API_KEY, SHOPIFY_API_SECRET, and SHOPIFY_APP_URL must be set on the server before tenants can connect a store.',
      })
      return
    }
    const shop = String(req.query.shop ?? '').trim().toLowerCase()
    if (!SHOP_DOMAIN_RE.test(shop)) {
      res.status(400).json({ error: 'Invalid shop. Expected something like acme-store.myshopify.com.' })
      return
    }
    const userId   = (req as any).user?.id as string | undefined
    const tenantId = (req as any).tenantId as string | undefined
    if (!userId || !tenantId) {
      res.status(401).json({ error: 'Authentication required' })
      return
    }
    const state = signOauthState({ userId, tenantId, connectorKey: `shopify:${shop}` })
    const redirectUri = `${env.appUrl.replace(/\/$/, '')}/api/shopify/callback`
    const authorizeUrl =
      `https://${shop}/admin/oauth/authorize` +
      `?client_id=${encodeURIComponent(env.apiKey)}` +
      `&scope=${encodeURIComponent(SCOPES)}` +
      `&redirect_uri=${encodeURIComponent(redirectUri)}` +
      `&state=${encodeURIComponent(state)}` +
      `&grant_options[]=`
    res.redirect(302, authorizeUrl)
  })

  // ── GET /api/shopify/callback ──────────────────────────────────────────
  // Called by Shopify after the merchant clicks "Install". UNAUTHENTICATED
  // — we authenticate the call via the signed `state` blob + Shopify's HMAC.
  r.get('/api/shopify/callback', async (req, res) => {
    const env = readShopifyEnv()
    if (!env) {
      res.status(503).send('Shopify integration not configured on this environment.')
      return
    }
    const shop = String(req.query.shop ?? '').trim().toLowerCase()
    const code = String(req.query.code ?? '')
    if (!SHOP_DOMAIN_RE.test(shop) || !code) {
      res.status(400).send('Invalid OAuth callback')
      return
    }
    // Shopify HMAC over query params (defense against forged callback URLs).
    if (!verifyShopifyHmac(req.query as Record<string, any>, env.apiSecret)) {
      console.warn(`[shopify-oauth] HMAC mismatch for shop=${shop} — rejecting callback`)
      res.status(400).send('Invalid signature')
      return
    }
    // Our own state blob (CSRF + user/tenant binding + 10-min TTL).
    const statePayload = verifyOauthState(String(req.query.state ?? ''))
    if (!statePayload || !statePayload.t || !statePayload.k?.startsWith('shopify:')) {
      console.warn(`[shopify-oauth] state verify failed for shop=${shop}`)
      res.status(400).send('OAuth state invalid or expired. Please try again from the Apps page.')
      return
    }
    const tenantId = statePayload.t

    // Exchange code → permanent access token.
    let tokenJson: { access_token?: string; scope?: string }
    try {
      const tr = await fetch(`https://${shop}/admin/oauth/access_token`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body:    JSON.stringify({ client_id: env.apiKey, client_secret: env.apiSecret, code }),
      })
      tokenJson = await tr.json() as any
      if (!tr.ok || !tokenJson.access_token) {
        console.error(`[shopify-oauth] token exchange failed for shop=${shop}: ${tr.status}`)
        res.status(502).send('Could not exchange code with Shopify')
        return
      }
    } catch (err: any) {
      console.error(`[shopify-oauth] token exchange error for shop=${shop}: ${err?.message}`)
      res.status(502).send('Could not exchange code with Shopify')
      return
    }

    const accessToken    = tokenJson.access_token!
    const grantedScope   = tokenJson.scope ?? SCOPES
    const webhookSecret  = crypto.randomBytes(32).toString('hex')
    const encryptedToken = encrypt(accessToken)
    if (!encryptedToken) {
      res.status(500).send('Token encryption failed')
      return
    }

    // Best-effort shop name (display label in the FE card). Failure is non-fatal.
    let shopName: string | null = null
    try {
      const meta = await shopifyAdminCall<{ shop: { name: string } }>(shop, accessToken, 'shop.json')
      if (meta.ok && meta.data?.shop?.name) shopName = meta.data.shop.name
    } catch { /* swallow */ }

    // Upsert the store row.
    const { data: storeRow, error: upsertErr } = await supabase.from('shopify_stores').upsert({
      tenant_id:              tenantId,
      shop_domain:            shop,
      shop_name:              shopName,
      access_token_encrypted: encryptedToken,
      scope:                  grantedScope,
      installed_at:           new Date().toISOString(),
      uninstalled_at:         null,
      webhook_secret:         webhookSecret,
      updated_at:             new Date().toISOString(),
    }, { onConflict: 'tenant_id,shop_domain' }).select('id').single()
    if (upsertErr || !storeRow) {
      console.error(`[shopify-oauth] shopify_stores upsert failed for shop=${shop}: ${upsertErr?.message}`)
      res.status(500).send('Could not persist Shopify connection')
      return
    }

    // Register webhooks. Each topic gets its own POST /webhooks.json. We do
    // not abort the whole install on a single failure — log + continue, the
    // merchant can re-run from Apps if needed.
    const webhookAddress = `${env.appUrl.replace(/\/$/, '')}/api/webhooks/shopify`
    for (const topic of WEBHOOK_TOPICS) {
      try {
        const reg = await shopifyAdminCall(shop, accessToken, 'webhooks.json', {
          method: 'POST',
          body:   JSON.stringify({ webhook: { topic, address: webhookAddress, format: 'json' } }),
        })
        if (!reg.ok) {
          console.warn(`[shopify-oauth] webhook register failed (${topic}) shop=${shop} status=${reg.status} err=${reg.error}`)
        }
      } catch (err: any) {
        console.warn(`[shopify-oauth] webhook register threw (${topic}) shop=${shop}: ${err?.message}`)
      }
    }

    // Mirror into tenant_integrations so the existing /api/connectors/connections
    // surface shows Shopify as connected.
    try {
      await supabase.from('tenant_integrations').upsert({
        tenant_id:    tenantId,
        user_id:      statePayload.u,
        key:          'shopify',
        status:       'active',
        brand_label:  shopName ? shopName : shop,
        connected_at: new Date().toISOString(),
      }, { onConflict: 'tenant_id,key' })
    } catch (err: any) {
      console.warn(`[shopify-oauth] tenant_integrations mirror failed: ${err?.message}`)
    }

    // Tiny HTML page that talks to the opener (matches the existing
    // openShopifyOAuthPopup contract in src/lib/api.ts).
    res.status(200).type('html').send(`<!doctype html><html><body><script>
      try {
        if (window.opener) {
          window.opener.postMessage({ type: 'shopify_oauth_result', ok: true, label: ${JSON.stringify(shopName ?? shop)} }, '*');
        }
      } catch (e) {}
      document.title = 'Shopify connected';
      document.body.innerText = 'Shopify connected. You can close this window.';
      window.close();
    </script></body></html>`)
  })

  return r
}
