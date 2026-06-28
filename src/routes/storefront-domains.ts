/**
 * storefront-domains — operator endpoints to connect a custom domain to a
 * tenant's storefront. The dashboard calls these (authenticated) instead of
 * writing tenant_domains directly, so the Vercel registration (which needs a
 * privileged token) happens SERVER-SIDE — the token never reaches the browser.
 *
 *   POST   /api/storefront/domains      { hostname }  → register on Vercel + record + return DNS config
 *   DELETE /api/storefront/domains/:id                → remove from Vercel + record
 *
 * Env (fly secrets on the API app):
 *   VERCEL_API_TOKEN          — a Vercel token with access to the storefront project
 *   VERCEL_TEAM_ID            — the Vercel team/scope id
 *   VERCEL_STOREFRONT_PROJECT — project name (default "frequency-storefront")
 */
import express from 'express'
import { SupabaseClient } from '@supabase/supabase-js'
import { sendStorefrontOtp } from '../lib/storefront-otp.js'
import { sendMsg91Otp, sendMsg91Sms } from '../lib/storefront-msg91.js'
import { provisionCatalog, materializeCatalog, getCatalogConfig, catalogUpsertItem, catalogDeleteItem, catalogAddCategory, catalogDeleteCategory, catalogDecrementStock, syncOrderRow, syncCartRow, syncCustomerRow, syncOutletRow } from '../lib/catalog.js'

type Mw = (req: express.Request, res: express.Response, next: express.NextFunction) => void | Promise<void>
interface Deps { supabase: SupabaseClient; requireAuth: Mw; identifyTenant: Mw }

const VTOKEN = process.env.VERCEL_API_TOKEN
const VTEAM = process.env.VERCEL_TEAM_ID
const VPROJECT = process.env.VERCEL_STOREFRONT_PROJECT || 'frequency-storefront'
const vercelConfigured = !!(VTOKEN && VTEAM)

// The customer storefront's admin API (db-backed) + its shared secret. The
// dashboard never holds this secret — it calls our authenticated proxy below,
// and we attach the secret + the active tenant's slug server-side.
const SF_API = process.env.STOREFRONT_API_URL || 'http://localhost:5181'
const SF_SECRET = process.env.STOREFRONT_ADMIN_SECRET || 'dev-admin'
// Fail closed: never run in prod with the dev-default shared secret.
if (process.env.NODE_ENV === 'production' && (!process.env.STOREFRONT_ADMIN_SECRET || SF_SECRET === 'dev-admin')) {
  throw new Error('[security] STOREFRONT_ADMIN_SECRET must be set to a strong value in production')
}

// Sliding-window guard on OUTBOUND OTP delivery, independent of the upstream
// caller — a leaked secret or a retry loop can't drive unbounded paid WhatsApp
// sends. Caps: 3 per phone / 10 min, and 200 per tenant / day.
const otpHits = new Map<string, number[]>()
function otpRateOk(key: string, max: number, windowMs: number): boolean {
  const now = Date.now()
  const arr = (otpHits.get(key) || []).filter(t => now - t < windowMs)
  if (arr.length >= max) { otpHits.set(key, arr); return false }
  arr.push(now); otpHits.set(key, arr)
  return true
}

async function vercel(method: string, path: string, body?: unknown): Promise<{ ok: boolean; status: number; json: any }> {
  const sep = path.includes('?') ? '&' : '?'
  const r = await fetch(`https://api.vercel.com${path}${sep}teamId=${VTEAM}`, {
    method,
    headers: { Authorization: `Bearer ${VTOKEN}`, 'Content-Type': 'application/json' },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  const json = await r.json().catch(() => ({}))
  return { ok: r.ok, status: r.status, json }
}

function normalizeHostname(raw: string): string {
  return String(raw || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/\.$/, '')
}
function isValidHostname(h: string): boolean {
  return /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(h) && h.length <= 253
}

export function createStorefrontDomainsRouter(deps: Deps): express.Router {
  const r = express.Router()
  const { supabase, requireAuth, identifyTenant } = deps

  // Server-to-server: storefront-api asks us to deliver a login OTP over
  // WhatsApp (tenant's WABA, else Frequency fallback). Authenticated by the
  // shared admin secret — NOT a user session — and the slug comes from the body
  // (storefront-api already knows which tenant). Returns 502 on delivery failure
  // so storefront-api can fall back to its on-screen demo code.
  r.post('/api/storefront/send-otp', async (req, res) => {
    if ((req.header('X-Admin-Secret') || '') !== SF_SECRET) return res.status(401).json({ ok: false, error: 'unauthorized' })
    const { slug, phone, code } = (req.body || {}) as { slug?: string; phone?: string; code?: string }
    if (!slug || !phone || !code) return res.status(400).json({ ok: false, error: 'slug, phone, code required' })
    const ph = String(phone).replace(/\D/g, '').slice(-10)
    if (!otpRateOk(`otp-ph:${ph}`, 3, 10 * 60_000) || !otpRateOk(`otp-tenant:${String(slug)}`, 200, 24 * 60 * 60_000)) {
      return res.status(429).json({ ok: false, error: 'rate_limited' })
    }
    // Channel order: MSG91 SMS is the primary OTP gateway (tenant's own key →
    // Frequency platform key). If it's not configured or fails, fall back to the
    // WhatsApp authentication template; if BOTH fail, storefront-api shows the
    // on-screen demo code so login never breaks.
    try {
      const m = await sendMsg91Otp(supabase, { slug: String(slug), phone: String(phone), code: String(code) })
      return res.json({ ok: true, channel: 'sms', via: m.via })
    } catch (smsErr: any) {
      try {
        const out = await sendStorefrontOtp(supabase, { slug: String(slug), phone: String(phone), code: String(code) })
        return res.json({ ok: true, channel: 'whatsapp', via: out.via })
      } catch (waErr: any) {
        console.warn(`[send-otp] sms+wa both failed: sms="${smsErr?.message}" wa="${waErr?.message}"`)
        return res.status(502).json({ ok: false, error: smsErr?.message || waErr?.message || 'send failed' })
      }
    }
  })

  // Server-to-server: storefront-api asks us to deliver a transactional order-update
  // SMS over MSG91 (tenant key → Frequency platform key). storefront-api only calls
  // this when the customer has NOT opted into web/native push — SMS is the fallback
  // channel. `vars` are the DLT template's variables (e.g. var1=order#, var2=status).
  r.post('/api/storefront/send-sms', async (req, res) => {
    if ((req.header('X-Admin-Secret') || '') !== SF_SECRET) return res.status(401).json({ ok: false, error: 'unauthorized' })
    const { slug, phone, vars, templateId } = (req.body || {}) as { slug?: string; phone?: string; vars?: Record<string, string>; templateId?: string }
    if (!slug || !phone) return res.status(400).json({ ok: false, error: 'slug and phone required' })
    const ph = String(phone).replace(/\D/g, '').slice(-10)
    // Coarser cap than OTP — transactional, but still guard against loops/abuse.
    if (!otpRateOk(`sms-ph:${ph}`, 6, 10 * 60_000) || !otpRateOk(`sms-tenant:${String(slug)}`, 500, 24 * 60 * 60_000)) {
      return res.status(429).json({ ok: false, error: 'rate_limited' })
    }
    try {
      const m = await sendMsg91Sms(supabase, { slug: String(slug), phone: String(phone), vars: vars || {}, templateId })
      res.json({ ok: true, via: m.via })
    } catch (e: any) {
      res.status(502).json({ ok: false, error: e?.message || 'send failed' })
    }
  })

  // Server-to-server: storefront-api mirrors an order into the tenant's Orders
  // table on create/pay/status-change. Authenticated by the shared admin secret
  // (not a user session); slug comes from the body. Best-effort.
  r.post('/api/storefront/order-sync', async (req, res) => {
    if ((req.header('X-Admin-Secret') || '') !== SF_SECRET) return res.status(401).json({ ok: false, error: 'unauthorized' })
    const { slug, order } = (req.body || {}) as { slug?: string; order?: any }
    if (!slug || !order?.id) return res.status(400).json({ ok: false, error: 'slug and order.id required' })
    try {
      const { data: t } = await supabase.from('tenants').select('id').eq('slug', slug).maybeSingle()
      const tenantId = (t as any)?.id
      if (!tenantId) return res.status(404).json({ ok: false, error: 'unknown tenant' })
      await syncOrderRow(supabase, tenantId, String(slug), order)
      res.json({ ok: true })
    } catch (e: any) { res.status(500).json({ ok: false, error: e?.message || 'sync failed' }) }
  })

  // Server-to-server: storefront-api decrements D2C product inventory on a new order.
  // No-op for verticals without a stock column. Shared admin secret; best-effort.
  r.post('/api/storefront/inventory-decrement', async (req, res) => {
    if ((req.header('X-Admin-Secret') || '') !== SF_SECRET) return res.status(401).json({ ok: false, error: 'unauthorized' })
    const { slug, lines, restock } = (req.body || {}) as { slug?: string; lines?: Array<{ itemId?: string; qty?: number }>; restock?: boolean }
    if (!slug || !Array.isArray(lines)) return res.status(400).json({ ok: false, error: 'slug and lines[] required' })
    try {
      const { data: t } = await supabase.from('tenants').select('id').eq('slug', slug).maybeSingle()
      const tenantId = (t as any)?.id
      if (!tenantId) return res.status(404).json({ ok: false, error: 'unknown tenant' })
      await catalogDecrementStock(supabase, tenantId, String(slug), lines, !!restock)
      res.json({ ok: true })
    } catch (e: any) { res.status(500).json({ ok: false, error: e?.message || 'decrement failed' }) }
  })

  // Server-to-server: storefront-api mirrors an in-progress/abandoned cart into the
  // tenant's Carts table (status open | converted). Shared admin secret; best-effort.
  r.post('/api/storefront/cart-sync', async (req, res) => {
    if ((req.header('X-Admin-Secret') || '') !== SF_SECRET) return res.status(401).json({ ok: false, error: 'unauthorized' })
    const { slug, cart } = (req.body || {}) as { slug?: string; cart?: any }
    if (!slug || !cart?.guestKey) return res.status(400).json({ ok: false, error: 'slug and cart.guestKey required' })
    try {
      const { data: t } = await supabase.from('tenants').select('id').eq('slug', slug).maybeSingle()
      const tenantId = (t as any)?.id
      if (!tenantId) return res.status(404).json({ ok: false, error: 'unknown tenant' })
      await syncCartRow(supabase, tenantId, String(slug), cart)
      res.json({ ok: true })
    } catch (e: any) { res.status(500).json({ ok: false, error: e?.message || 'sync failed' }) }
  })

  // Server-to-server: storefront-api mirrors a signed-in guest → Customers table.
  r.post('/api/storefront/customer-sync', async (req, res) => {
    if ((req.header('X-Admin-Secret') || '') !== SF_SECRET) return res.status(401).json({ ok: false, error: 'unauthorized' })
    const { slug, customer } = (req.body || {}) as { slug?: string; customer?: any }
    if (!slug || !(customer?.key)) return res.status(400).json({ ok: false, error: 'slug and customer.key required' })
    try {
      const { data: t } = await supabase.from('tenants').select('id').eq('slug', slug).maybeSingle()
      const tenantId = (t as any)?.id
      if (!tenantId) return res.status(404).json({ ok: false, error: 'unknown tenant' })
      await syncCustomerRow(supabase, tenantId, String(slug), customer)
      res.json({ ok: true })
    } catch (e: any) { res.status(500).json({ ok: false, error: e?.message || 'sync failed' }) }
  })

  // Server-to-server: storefront-api mirrors an outlet → Outlets table.
  r.post('/api/storefront/outlet-sync', async (req, res) => {
    if ((req.header('X-Admin-Secret') || '') !== SF_SECRET) return res.status(401).json({ ok: false, error: 'unauthorized' })
    const { slug, outlet } = (req.body || {}) as { slug?: string; outlet?: any }
    if (!slug || !(outlet?.id)) return res.status(400).json({ ok: false, error: 'slug and outlet.id required' })
    try {
      const { data: t } = await supabase.from('tenants').select('id').eq('slug', slug).maybeSingle()
      const tenantId = (t as any)?.id
      if (!tenantId) return res.status(404).json({ ok: false, error: 'unknown tenant' })
      await syncOutletRow(supabase, tenantId, String(slug), outlet)
      res.json({ ok: true })
    } catch (e: any) { res.status(500).json({ ok: false, error: e?.message || 'sync failed' }) }
  })

  r.post('/api/storefront/domains', requireAuth, identifyTenant, async (req, res) => {
    const tenantId = (req as any).tenantId
    const hostname = normalizeHostname((req.body as any)?.hostname)
    if (!isValidHostname(hostname)) { res.status(400).json({ error: 'Enter a valid domain, e.g. order.yourbrand.com' }); return }

    // 1. Register on Vercel so it serves the storefront + issues TLS. 409 = the
    //    domain is already on the project → fine (idempotent).
    if (vercelConfigured) {
      const add = await vercel('POST', `/v10/projects/${VPROJECT}/domains`, { name: hostname })
      if (!add.ok && add.status !== 409) {
        const msg = add.json?.error?.message || `Couldn't register the domain (${add.status}).`
        // 403/forbidden often means the domain belongs to another Vercel account.
        res.status(502).json({ error: msg }); return
      }
    }

    // 2. Record against the tenant. Unique on hostname → a domain can belong to
    //    exactly one storefront.
    const verification_token = `freq-verify-${Math.random().toString(36).slice(2, 10)}`
    const { data, error } = await supabase.from('tenant_domains')
      .insert({ tenant_id: tenantId, hostname, kind: 'custom', verification_token })
      .select('*').single()
    if (error) {
      const dup = (error as any).code === '23505'
      res.status(dup ? 409 : 500).json({ error: dup ? 'That domain is already connected.' : error.message })
      return
    }

    // 3. Ask Vercel what DNS records are required (so the UI can show the exact ones).
    let dns: any = null
    if (vercelConfigured) {
      const cfg = await vercel('GET', `/v9/projects/${VPROJECT}/domains/${encodeURIComponent(hostname)}/config`)
      if (cfg.ok) dns = cfg.json
    }
    res.json({ domain: data, dns })
  })

  r.delete('/api/storefront/domains/:id', requireAuth, identifyTenant, async (req, res) => {
    const tenantId = (req as any).tenantId
    const { data: row } = await supabase.from('tenant_domains')
      .select('hostname').eq('id', req.params.id).eq('tenant_id', tenantId).maybeSingle()
    if (row?.hostname && vercelConfigured) {
      await vercel('DELETE', `/v9/projects/${VPROJECT}/domains/${encodeURIComponent(row.hostname)}`) // best-effort
    }
    const { error } = await supabase.from('tenant_domains').delete().eq('id', req.params.id).eq('tenant_id', tenantId)
    if (error) { res.status(500).json({ error: error.message }); return }
    res.json({ ok: true })
  })

  // ── catalog: back the menu with the Database→Tables feature ──────────────────
  // Resolve the active workspace's slug, then provision/sync the tenant's catalog
  // tables. The dashboard never holds the admin secret — same trust model as the
  // proxy below. See lib/catalog.ts for the architecture.
  async function slugOf(req: express.Request, res: express.Response): Promise<string | null> {
    const tenantId = (req as any).tenantId
    const { data, error } = await supabase.from('tenants').select('slug').eq('id', tenantId).maybeSingle()
    if (error) { res.status(500).json({ error: error.message }); return null }
    const slug = (data as any)?.slug
    if (!slug) { res.status(404).json({ error: 'No storefront is set up for this workspace yet.' }); return null }
    return slug
  }

  // Is the menu Tables-backed yet?
  r.get('/api/storefront/catalog/status', requireAuth, identifyTenant, async (req, res) => {
    const slug = await slugOf(req, res); if (!slug) return
    try {
      const config = await getCatalogConfig(slug)
      res.json({
        provisioned: !!config,
        catalogSource: config ? 'tables' : 'file',
        categoriesTableId: config?.categoriesTableId || null,
        itemsTableId: config?.itemsTableId || null,
        // Vertical drives the dashboard editor (product fields vs dish fields).
        // Derived from the map: a `stock` role means this is a D2C product catalog.
        vertical: (config?.map?.item as any)?.stock ? 'd2c' : 'horeca',
      })
    } catch (e: any) { res.status(502).json({ error: e?.message || 'Storefront service is unreachable.' }) }
  })

  // Move this workspace's menu onto Tables: create the tables, backfill from the
  // current menu, wire the mapping, and materialize. Idempotent.
  r.post('/api/storefront/catalog/provision', requireAuth, identifyTenant, async (req, res) => {
    const tenantId = (req as any).tenantId
    const userId = (req as any).user?.id
    const slug = await slugOf(req, res); if (!slug) return
    try {
      const out = await provisionCatalog(supabase, tenantId, userId, slug)
      res.json({ ok: true, ...out })
    } catch (e: any) { res.status(500).json({ error: e?.message || 'Provisioning failed' }) }
  })

  // Re-compose the live menu snapshot from the Tables rows (manual trigger; the
  // row handlers also auto-sync on edit).
  r.post('/api/storefront/catalog/sync', requireAuth, identifyTenant, async (req, res) => {
    const tenantId = (req as any).tenantId
    const slug = await slugOf(req, res); if (!slug) return
    try {
      const counts = await materializeCatalog(supabase, tenantId, slug)
      if (!counts) return res.status(400).json({ error: 'This menu is not backed by Tables yet — provision it first.' })
      res.json({ ok: true, ...counts })
    } catch (e: any) { res.status(502).json({ error: e?.message || 'Sync failed' }) }
  })

  // Catalog item/category edits (UI→Table) — the dashboard's rich dish editor
  // writes through here when the menu is Tables-backed, so add-ons get the proper
  // group editor and each save re-materializes the storefront snapshot.
  r.post('/api/storefront/catalog/item', requireAuth, identifyTenant, async (req, res) => {
    const tenantId = (req as any).tenantId, userId = (req as any).user?.id
    const slug = await slugOf(req, res); if (!slug) return
    try { await catalogUpsertItem(supabase, tenantId, userId, slug, (req.body || {}) as any); res.json({ ok: true }) }
    catch (e: any) { res.status(400).json({ error: e?.message || 'Could not save dish' }) }
  })
  r.patch('/api/storefront/catalog/item/:rowId', requireAuth, identifyTenant, async (req, res) => {
    const tenantId = (req as any).tenantId, userId = (req as any).user?.id
    const slug = await slugOf(req, res); if (!slug) return
    try { await catalogUpsertItem(supabase, tenantId, userId, slug, (req.body || {}) as any, String(req.params.rowId)); res.json({ ok: true }) }
    catch (e: any) { res.status(400).json({ error: e?.message || 'Could not save dish' }) }
  })
  r.delete('/api/storefront/catalog/item/:rowId', requireAuth, identifyTenant, async (req, res) => {
    const tenantId = (req as any).tenantId
    const slug = await slugOf(req, res); if (!slug) return
    try { await catalogDeleteItem(supabase, tenantId, slug, String(req.params.rowId)); res.json({ ok: true }) }
    catch (e: any) { res.status(400).json({ error: e?.message || 'Could not delete dish' }) }
  })
  r.post('/api/storefront/catalog/category', requireAuth, identifyTenant, async (req, res) => {
    const tenantId = (req as any).tenantId, userId = (req as any).user?.id
    const slug = await slugOf(req, res); if (!slug) return
    const name = String((req.body || {}).name || '').trim()
    if (!name) { res.status(400).json({ error: 'Category name required' }); return }
    try { await catalogAddCategory(supabase, tenantId, userId, slug, name); res.json({ ok: true }) }
    catch (e: any) { res.status(400).json({ error: e?.message || 'Could not add category' }) }
  })
  r.delete('/api/storefront/catalog/category/:rowId', requireAuth, identifyTenant, async (req, res) => {
    const tenantId = (req as any).tenantId
    const slug = await slugOf(req, res); if (!slug) return
    try { await catalogDeleteCategory(supabase, tenantId, slug, String(req.params.rowId)); res.json({ ok: true }) }
    catch (e: any) { res.status(400).json({ error: e?.message || 'Could not delete category' }) }
  })

  // ── menu / orders admin proxy ────────────────────────────────────────────────
  // The dashboard's menu + orders editors hit /api/storefront/admin/*. We resolve
  // the ACTIVE tenant's slug (from the authed X-Tenant-ID → tenants.slug) and
  // forward to the storefront-api's /admin/* with that slug + the admin secret,
  // both attached SERVER-SIDE. Result: each workspace edits its OWN storefront,
  // and no slug/secret is hardcoded or shipped in the browser bundle.
  r.all(/^\/api\/storefront\/admin(\/.*)?$/, requireAuth, identifyTenant, async (req, res) => {
    const tenantId = (req as any).tenantId
    const { data: t, error: tErr } = await supabase
      .from('tenants').select('slug').eq('id', tenantId).maybeSingle()
    if (tErr) { res.status(500).json({ error: tErr.message }); return }
    const slug = (t as any)?.slug
    if (!slug) { res.status(404).json({ error: 'No storefront is set up for this workspace yet.' }); return }

    const upstreamPath = req.originalUrl.replace(/^\/api\/storefront/, '') // → /admin/... (keeps query string)
    const method = req.method.toUpperCase()
    const hasBody = method !== 'GET' && method !== 'HEAD' && method !== 'DELETE'
    try {
      const up = await fetch(`${SF_API}${upstreamPath}`, {
        method,
        headers: { 'Content-Type': 'application/json', 'X-Tenant': slug, 'X-Admin-Secret': SF_SECRET },
        body: hasBody ? JSON.stringify(req.body ?? {}) : undefined,
      })
      const text = await up.text()
      res.status(up.status)
      try { res.json(JSON.parse(text)) } catch { res.send(text) }
    } catch (e: any) {
      res.status(502).json({ error: e?.message || 'Storefront service is unreachable.' })
    }
  })

  return r
}
