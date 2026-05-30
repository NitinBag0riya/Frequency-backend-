/**
 * Shiprocket connector — API-user email/password → JWT (India D2C shipping).
 *
 * Shiprocket is the dominant shipping aggregator for Indian D2C/e-commerce:
 * one account fans out to Delhivery, BlueDart, Ekart, XpressBees, etc. It pairs
 * naturally with the WooCommerce/Shopify order flow already shipped.
 *
 * Auth model (different from the pure paste-key connectors): Shiprocket has no
 * static API key. You create an *API user* (Shiprocket → Settings → API →
 * Configure → Create an API User) and then exchange that user's email+password
 * for a JWT via POST /auth/login. The JWT is valid ~10 days. So:
 *   - On connect we log in once (this verifies the creds) and store the
 *     password ENCRYPTED in access_token + the email in metadata.
 *   - loadToken() caches the JWT + its expiry in metadata; when it's near
 *     expiry it transparently re-logs-in with the stored email/password and
 *     refreshes the cache. Capability handlers + workflow nodes never see this.
 *
 * Capabilities (Shiprocket external v1):
 *   list_orders          GET   /orders
 *   create_order         POST  /orders/create/adhoc
 *   track_awb(:awb)      GET   /courier/track/awb/:awb
 *   check_serviceability GET   /courier/serviceability
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

const SR_BASE = 'https://apiv2.shiprocket.in/v1/external'
// Shiprocket JWTs live ~10 days; refresh a day early so a long-running job
// never trips an expiry mid-flight.
const TOKEN_TTL_MS = 9 * 24 * 60 * 60 * 1000

const TokenSchema = z.object({
  email:    z.string().email('Use the email of a Shiprocket API user'),
  password: z.string().min(1, 'Password is required'),
})

const OrderSchema = z.object({
  order_id:       z.union([z.string(), z.number()]).transform(String),
  order_items:    z.array(z.record(z.string(), z.any())).min(1, 'At least one order item is required'),
  payment_method: z.string().min(1, 'payment_method is required (e.g. "Prepaid" or "COD")'),
}).passthrough()

/** Log in to Shiprocket and return the raw login response (incl. token). */
async function shiprocketLogin(email: string, password: string): Promise<any> {
  const r = await fetch(`${SR_BASE}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ email, password }),
  })
  const body = await r.json().catch(() => ({})) as any
  if (!r.ok || !body?.token) {
    const msg = body?.message || `Shiprocket login failed (${r.status})`
    throw new Error(msg)
  }
  return body
}

function srErr(r: Response, body: any): string {
  if (r.status === 429) return 'Shiprocket rate limit exceeded — try again in a moment'
  if (body?.message) return String(body.message)
  if (body?.errors)  return JSON.stringify(body.errors).slice(0, 200)
  return `Shiprocket ${r.status}`
}

export function createShiprocketConnector(deps: Deps): express.Router {
  const r = express.Router()
  const { supabase, requireAuth, identifyTenant, checkPermission } = deps

  // ── Connect (verify by logging in, then persist) ──────────────────────────
  r.post('/api/connectors/shiprocket/connect-key',
    requireAuth, identifyTenant, checkPermission('integrations', 'edit'),
    validateBody(TokenSchema),
    async (req, res) => {
      const tenantId = (req as any).tenantId
      const userId = (req as any).user?.id as string | undefined
      if (!userId) { res.status(401).json({ error: 'auth missing user.id' }); return }

      const { email, password } = req.body as z.infer<typeof TokenSchema>

      // The login call IS the verification — a wrong API-user password fails here.
      let login: any
      try {
        login = await shiprocketLogin(email, password)
      } catch (e: any) {
        res.status(400).json({ error: `Shiprocket rejected these credentials: ${e?.message ?? 'login failed'} — confirm you created an API user (Settings → API → Configure) and used ITS password, not your dashboard password.` })
        return
      }

      const label = [login.first_name, login.last_name].filter(Boolean).join(' ').trim() || login.email || email
      const tokenExpires = new Date(Date.now() + TOKEN_TTL_MS).toISOString()

      const { error: upsertErr } = await supabase.from('tenant_integrations').upsert({
        tenant_id:    tenantId,
        user_id:      userId,
        key:          'shiprocket',
        status:       'active',
        access_token: encrypt(password),
        scope:        'shipping',
        brand_label:  String(label),
        metadata:     {
          auth_mode:        'login_token',
          email,
          sr_token:         login.token,
          sr_token_expires: tokenExpires,
          company_id:       login.company_id ?? null,
        },
      }, { onConflict: 'tenant_id,key' })
      if (upsertErr) {
        console.error(`[shiprocket connect] DB upsert failed: ${upsertErr.message}`)
        res.status(500).json({ error: 'Failed to persist connection: ' + upsertErr.message }); return
      }
      res.json({ success: true, account: String(label) })
    })

  // ── Capabilities ──────────────────────────────────────────────────────────
  const guardView = [requireAuth, identifyTenant, checkPermission('integrations', 'view')]
  const guardEdit = [requireAuth, identifyTenant, checkPermission('integrations', 'edit')]

  r.get('/api/connectors/shiprocket/orders', ...guardView, async (req, res) => {
    try {
      const token = await loadToken(supabase, (req as any).tenantId)
      const params = new URLSearchParams()
      params.set('per_page', String(Math.min(Number(req.query.limit ?? 50), 100)))
      if (req.query.page)   params.set('page', String(req.query.page))
      if (req.query.search) params.set('search', String(req.query.search))
      const r2 = await fetch(`${SR_BASE}/orders?${params}`, { headers: { Authorization: `Bearer ${token}` } })
      const body = await r2.json() as any
      if (!r2.ok) { res.status(r2.status).json({ error: srErr(r2, body) }); return }
      res.json(body)
    } catch (err: any) { res.status(500).json({ error: err.message }) }
  })

  r.post('/api/connectors/shiprocket/orders', ...guardEdit,
    validateBody(OrderSchema),
    async (req, res) => {
      try {
        const token = await loadToken(supabase, (req as any).tenantId)
        const r2 = await fetch(`${SR_BASE}/orders/create/adhoc`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(req.body),
        })
        const body = await r2.json() as any
        if (!r2.ok) { res.status(r2.status).json({ error: srErr(r2, body) }); return }
        res.json(body)
      } catch (err: any) { res.status(500).json({ error: err.message }) }
    })

  r.get('/api/connectors/shiprocket/track/:awb', ...guardView, async (req, res) => {
    try {
      const token = await loadToken(supabase, (req as any).tenantId)
      const awb = encodeURIComponent(String(req.params.awb))
      const r2 = await fetch(`${SR_BASE}/courier/track/awb/${awb}`, { headers: { Authorization: `Bearer ${token}` } })
      const body = await r2.json() as any
      if (!r2.ok) { res.status(r2.status).json({ error: srErr(r2, body) }); return }
      res.json(body)
    } catch (err: any) { res.status(500).json({ error: err.message }) }
  })

  r.get('/api/connectors/shiprocket/serviceability', ...guardView, async (req, res) => {
    try {
      const token = await loadToken(supabase, (req as any).tenantId)
      const params = new URLSearchParams()
      for (const k of ['pickup_postcode', 'delivery_postcode', 'weight', 'cod', 'order_id']) {
        if (req.query[k] != null) params.set(k, String(req.query[k]))
      }
      const r2 = await fetch(`${SR_BASE}/courier/serviceability/?${params}`, { headers: { Authorization: `Bearer ${token}` } })
      const body = await r2.json() as any
      if (!r2.ok) { res.status(r2.status).json({ error: srErr(r2, body) }); return }
      res.json(body)
    } catch (err: any) { res.status(500).json({ error: err.message }) }
  })

  return r
}

/**
 * Return a valid Shiprocket JWT for the tenant — exported so
 * engine/connector-ops.ts can call Shiprocket from workflow nodes.
 *
 * Caches the token in tenant_integrations.metadata and re-logs-in with the
 * stored API-user email/password when the cached token is missing or near
 * expiry. The refresh is transparent to callers.
 */
export async function loadToken(supabase: SupabaseClient, tenantId: string): Promise<string> {
  const { data: row } = await supabase.from('tenant_integrations')
    .select('access_token, metadata')
    .eq('tenant_id', tenantId).eq('key', 'shiprocket').maybeSingle()
  if (!row?.access_token) throw new Error('Shiprocket not connected')
  const md = (row.metadata as any) ?? {}
  if (!md.email) throw new Error('Shiprocket connection missing API-user email — please reconnect')

  const cached = md.sr_token as string | undefined
  const exp = md.sr_token_expires ? new Date(md.sr_token_expires).getTime() : 0
  // 1h safety margin so a token doesn't expire between this check and the call.
  if (cached && exp - Date.now() > 60 * 60 * 1000) return cached

  // Refresh: log in again with the stored credentials.
  const login = await shiprocketLogin(md.email as string, decrypt(row.access_token))
  const tokenExpires = new Date(Date.now() + TOKEN_TTL_MS).toISOString()
  // Merge so we don't drop company_id / auth_mode on the metadata write.
  const { error } = await supabase.from('tenant_integrations')
    .update({ metadata: { ...md, sr_token: login.token, sr_token_expires: tokenExpires } })
    .eq('tenant_id', tenantId).eq('key', 'shiprocket')
  if (error) console.warn(`[shiprocket] token cache update failed: ${error.message}`)
  return login.token
}
