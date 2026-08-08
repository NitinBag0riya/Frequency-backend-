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
import crypto from 'node:crypto'
import { SupabaseClient } from '@supabase/supabase-js'
import { sendStorefrontOtp } from '../lib/storefront-otp.js'
import { sendSmsOtp, sendSmsOrderUpdate } from '../lib/storefront-sms.js'
import { provisionCatalog, materializeCatalog, getCatalogConfig, catalogUpsertItem, catalogDeleteItem, catalogAddCategory, catalogDeleteCategory, catalogDecrementStock, syncOrderRow, syncCartRow, syncCustomerRow, syncOutletRow } from '../lib/catalog.js'
import { emitNotification, tenantNotifyRecipients } from './notifications.js'

type Mw = (req: express.Request, res: express.Response, next: express.NextFunction) => void | Promise<void>
interface Deps { supabase: SupabaseClient; requireAuth: Mw; identifyTenant: Mw }

const VTOKEN = process.env.VERCEL_API_TOKEN
const VTEAM = process.env.VERCEL_TEAM_ID
const VPROJECT = process.env.VERCEL_STOREFRONT_PROJECT || 'frequency-storefront'
// White-label operator dashboard lives on a DIFFERENT Vercel project than the storefront,
// so a `dashboard`-purpose custom domain registers there instead.
const VDASH_PROJECT = process.env.VERCEL_DASHBOARD_PROJECT || 'frequency-fe'
const vercelConfigured = !!(VTOKEN && VTEAM)
// tenant_domains.kind: 'custom'/'subdomain' → storefront; 'dashboard' → white-label admin.
const projectFor = (kind?: string) => (kind === 'dashboard' ? VDASH_PROJECT : VPROJECT)

// The customer storefront's admin API (db-backed) + its shared secret. The
// dashboard never holds this secret — it calls our authenticated proxy below,
// and we attach the secret + the active tenant's slug server-side.
const SF_API = process.env.STOREFRONT_API_URL || 'http://localhost:5181'
const SF_SECRET = process.env.STOREFRONT_ADMIN_SECRET || 'dev-admin'

// Resolve a tenant's STOREFRONT DISPLAY NAME (what the customer sees on the
// storefront) for the DLT-branded OTP/order SMS templates. storefront-api's
// /v1/config already computes exactly display_name || business_name || slug, so
// reuse it as the single source of truth; fall back to the slug if the service
// is slow/down so SMS never blocks on it. Cached briefly — names change rarely,
// OTPs are frequent.
const storeNameCache = new Map<string, { name: string; at: number }>()
async function resolveStoreName(slug: string): Promise<string> {
  const hit = storeNameCache.get(slug)
  if (hit && Date.now() - hit.at < 5 * 60_000) return hit.name
  let name = slug
  try {
    const cfg = await fetch(`${SF_API}/v1/config`, { headers: { 'X-Tenant': slug }, signal: AbortSignal.timeout(2500) })
    if (cfg.ok) { const j: any = await cfg.json(); if (j?.name) name = String(j.name) }
  } catch { /* keep slug — never block SMS on the config lookup */ }
  storeNameCache.set(slug, { name, at: Date.now() })
  return name
}

// Emit a realtime order notification so the operator's boards update instantly:
//   • FIRST sight of an order → order.new  (OrderAlertProvider rings + banners)
//   • a later STATUS change   → order.status (no ring — the FE relays it to refetch
//     the KDS / Orders boards, so an accepted order appears on a SEPARATE KDS screen
//     live, not on its next poll).
// Deduped by the LAST notification's status for this order → a re-sync of the same
// status is a no-op, so we never double-fire. Recipients = owner ∪ members (solo
// owners aren't in user_role_assignments). Best-effort: logged, never thrown.
async function notifyStorefrontOrder(supabase: SupabaseClient, tenantId: string, slug: string, order: any): Promise<void> {
  try {
    const orderId = String(order?.id ?? '')
    if (!orderId) return
    const status = String(order?.status ?? 'placed')
    // What did we last tell operators about this order? (newest order.* for it)
    const { data: last } = await supabase.from('notifications')
      .select('data').eq('tenant_id', tenantId).eq('data->>order_id', orderId)
      .order('created_at', { ascending: false }).limit(1).maybeSingle()
    if (last && (last as any)?.data?.status === status) return   // status unchanged → don't re-fire
    const isNew = !last
    const recipients = await tenantNotifyRecipients(supabase, tenantId)
    if (!recipients.length) return
    const where = order?.table ? `Table ${order.table}` : (order?.mode === 'dinein' ? 'Dine-in' : 'Pickup')
    const items = Array.isArray(order?.lines) ? order.lines.reduce((n: number, l: any) => n + (Number(l?.qty) || 1), 0) : 0
    await emitNotification(supabase, {
      tenant_id: tenantId,
      event_key: isNew ? 'order.new' : 'order.status',
      recipient_user_ids: recipients,
      link: '/settings/orders',   // canonical orders board (matches aggregator + OrderAlertProvider silence-on-view)
      data: {
        channel: 'storefront', channel_label: 'Storefront',
        order_id: orderId, status, status_label: status,
        summary: isNew ? `New order · ${where} · ${items} item${items === 1 ? '' : 's'} — accept now` : `${where} · ${status}`,
        priority: isNew ? 'high' : 'normal',
      },
    })
  } catch (e: any) { console.warn(`[storefront] order notify failed (non-fatal): ${e?.message}`) }
}
// Fail closed: never run in prod with the dev-default shared secret.
if (process.env.NODE_ENV === 'production' && (!process.env.STOREFRONT_ADMIN_SECRET || SF_SECRET === 'dev-admin')) {
  throw new Error('[security] STOREFRONT_ADMIN_SECRET must be set to a strong value in production')
}
// Constant-time compare of the shared admin secret — avoids a remote timing side-channel
// on the static STOREFRONT_ADMIN_SECRET, matching the timingSafeEqual checks used by the
// rest of the codebase's webhook/secret verifications.
function adminOk(req: express.Request): boolean {
  const a = Buffer.from(req.header('X-Admin-Secret') || '', 'utf8')
  const b = Buffer.from(SF_SECRET, 'utf8')
  return a.length === b.length && crypto.timingSafeEqual(a, b)
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

  // Platform-scope check (a role assignment with tenant_id IS NULL = /naruto console
  // user). Used to gate white-label dashboard-domain connects. Mirrors the platform
  // branch of the FE useRole resolver; kept local to avoid re-wiring Deps.
  const isPlatformUser = async (userId?: string): Promise<boolean> => {
    if (!userId) return false
    const { data: assign } = await supabase.from('user_role_assignments')
      .select('id').eq('user_id', userId).is('tenant_id', null).maybeSingle()
    if ((assign as any)?.id) return true
    const { data: legacy } = await supabase.from('user_roles')
      .select('role').eq('user_id', userId).is('tenant_id', null).eq('role', 'super_admin').limit(1)
    return !!legacy?.[0]
  }

  // Boot-time self-test: confirm the Vercel creds can actually see the storefront
  // project. If this logs a failure, custom-domain adds will 502 — the token/team
  // is wrong. Runs once, best-effort, never blocks startup.
  if (vercelConfigured) {
    vercel('GET', `/v9/projects/${VPROJECT}`)
      .then(res => console.log(`[storefront-domains] vercel self-test: project "${VPROJECT}" → ${res.status} ${res.ok ? 'OK ✓' : 'FAIL ✗ (' + (res.json?.error?.message || 'creds/team wrong') + ')'}`))
      .catch(e => console.warn('[storefront-domains] vercel self-test threw:', e?.message))
  } else {
    console.warn('[storefront-domains] VERCEL_API_TOKEN / VERCEL_TEAM_ID not set — custom domains will record only, no Vercel registration.')
  }

  // Server-to-server: storefront-api asks us to deliver a login OTP over
  // WhatsApp (tenant's WABA, else Frequency fallback). Authenticated by the
  // shared admin secret — NOT a user session — and the slug comes from the body
  // (storefront-api already knows which tenant). Returns 502 on delivery failure
  // so storefront-api can fall back to its on-screen demo code.
  r.post('/api/storefront/send-otp', async (req, res) => {
    if (!adminOk(req)) return res.status(401).json({ ok: false, error: 'unauthorized' })
    const { slug, phone, code } = (req.body || {}) as { slug?: string; phone?: string; code?: string }
    if (!slug || !phone || !code) return res.status(400).json({ ok: false, error: 'slug, phone, code required' })
    const ph = String(phone).replace(/\D/g, '').slice(-10)
    if (!otpRateOk(`otp-ph:${ph}`, 3, 10 * 60_000) || !otpRateOk(`otp-tenant:${String(slug)}`, 200, 24 * 60 * 60_000)) {
      return res.status(429).json({ ok: false, error: 'rate_limited' })
    }
    // Channel order: MSG91 SMS is the primary OTP gateway (Frequency's platform
    // MSG91 account + DLT header). If it's not configured or fails, fall back to
    // the WhatsApp authentication template; if BOTH fail, storefront-api shows
    // the on-screen demo code so login never breaks.
    try {
      const storeName = await resolveStoreName(String(slug))
      const m = await sendSmsOtp(supabase, { slug: String(slug), phone: String(phone), code: String(code), storeName })
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
  // SMS over MSG91 (Frequency's platform account + DLT order flow). storefront-api
  // only calls this when the customer has NOT opted into web/native push — SMS is
  // the fallback channel. `vars` carry the message fields (var1=order#, var2=status,
  // var3=name), passed straight through as MSG91 flow variables.
  r.post('/api/storefront/send-sms', async (req, res) => {
    if (!adminOk(req)) return res.status(401).json({ ok: false, error: 'unauthorized' })
    const { slug, phone, vars, templateId } = (req.body || {}) as { slug?: string; phone?: string; vars?: Record<string, string>; templateId?: string }
    if (!slug || !phone) return res.status(400).json({ ok: false, error: 'slug and phone required' })
    const ph = String(phone).replace(/\D/g, '').slice(-10)
    // Coarser cap than OTP — transactional, but still guard against loops/abuse.
    if (!otpRateOk(`sms-ph:${ph}`, 6, 10 * 60_000) || !otpRateOk(`sms-tenant:${String(slug)}`, 500, 24 * 60 * 60_000)) {
      return res.status(429).json({ ok: false, error: 'rate_limited' })
    }
    try {
      // storefront-api usually supplies var3=name; backfill from the resolved
      // store display name when it doesn't (the DLT template needs all 3 vars).
      const vv = { ...(vars || {}) }
      if (!vv.var3) vv.var3 = await resolveStoreName(String(slug))
      const m = await sendSmsOrderUpdate(supabase, { slug: String(slug), phone: String(phone), vars: vv, templateId })
      res.json({ ok: true, via: m.via })
    } catch (e: any) {
      res.status(502).json({ ok: false, error: e?.message || 'send failed' })
    }
  })

  // Server-to-server: storefront-api mirrors an order into the tenant's Orders
  // table on create/pay/status-change. Authenticated by the shared admin secret
  // (not a user session); slug comes from the body. Best-effort.
  r.post('/api/storefront/order-sync', async (req, res) => {
    if (!adminOk(req)) return res.status(401).json({ ok: false, error: 'unauthorized' })
    const { slug, order } = (req.body || {}) as { slug?: string; order?: any }
    if (!slug || !order?.id) return res.status(400).json({ ok: false, error: 'slug and order.id required' })
    try {
      const { data: t } = await supabase.from('tenants').select('id').eq('slug', slug).maybeSingle()
      const tenantId = (t as any)?.id
      if (!tenantId) return res.status(404).json({ ok: false, error: 'unknown tenant' })
      await syncOrderRow(supabase, tenantId, String(slug), order)
      // Ring the operator's bell in REAL TIME on the first sight of an order.
      // Storefront/POS/app orders used to only surface via the dashboard's 8s/30s
      // poll — this emits the same order.new notification the aggregator path does,
      // so OrderAlertProvider chimes instantly. Idempotent (deduped by order_id) so
      // later status re-syncs never re-ring. Fire-and-forget; never blocks the sync.
      void notifyStorefrontOrder(supabase, tenantId, String(slug), order)
      res.json({ ok: true })
    } catch (e: any) { res.status(500).json({ ok: false, error: e?.message || 'sync failed' }) }
  })

  // Server-to-server: storefront-api decrements D2C product inventory on a new order.
  // No-op for verticals without a stock column. Shared admin secret; best-effort.
  r.post('/api/storefront/inventory-decrement', async (req, res) => {
    if (!adminOk(req)) return res.status(401).json({ ok: false, error: 'unauthorized' })
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
    if (!adminOk(req)) return res.status(401).json({ ok: false, error: 'unauthorized' })
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
    if (!adminOk(req)) return res.status(401).json({ ok: false, error: 'unauthorized' })
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
    if (!adminOk(req)) return res.status(401).json({ ok: false, error: 'unauthorized' })
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
    // 'dashboard' → white-label the operator app (frequency-fe project); else the storefront.
    const kind = (req.body as any)?.purpose === 'dashboard' ? 'dashboard' : 'custom'
    // White-labeling the operator dashboard is a PLATFORM capability (the /naruto
    // console), not tenant self-serve. Hiding the UI isn't access control — enforce
    // it here too: only a platform-scoped user (role assignment with tenant_id IS NULL)
    // may connect a dashboard domain. Mirrors the FE `isSuper` gate + useRole.
    if (kind === 'dashboard' && !(await isPlatformUser((req as any).user?.id))) {
      res.status(403).json({ error: 'Platform Console access required to connect an admin-dashboard domain.' }); return
    }
    const project = projectFor(kind)
    try {
      // 1. Register on Vercel so it serves the app + issues TLS. 409 = already on the
      //    project → fine (idempotent).
      if (vercelConfigured) {
        const add = await vercel('POST', `/v10/projects/${project}/domains`, { name: hostname })
        if (!add.ok && add.status !== 409) {
          const msg = add.json?.error?.message || `Couldn't register the domain (${add.status}).`
          console.warn(`[storefront-domains] vercel add "${hostname}" (${kind}) → ${add.status}: ${msg}`)
          // 403/forbidden often means the domain belongs to another Vercel account.
          res.status(502).json({ error: msg }); return
        }
      }

      // 2. Record against the tenant. Unique on hostname → a domain belongs to exactly
      //    one tenant, and its `kind` decides storefront vs white-label dashboard.
      const verification_token = `freq-verify-${Math.random().toString(36).slice(2, 10)}`
      const { data, error } = await supabase.from('tenant_domains')
        .insert({ tenant_id: tenantId, hostname, kind, verification_token })
        .select('*').single()
      if (error) {
        const dup = (error as any).code === '23505'
        console.warn(`[storefront-domains] insert "${hostname}" tenant=${tenantId} → ${(error as any).code}: ${error.message}`)
        res.status(dup ? 409 : 500).json({ error: dup ? 'That domain is already connected.' : error.message })
        return
      }

      // 3. Ask Vercel what DNS records are required (so the UI can show the exact ones).
      let dns: any = null
      if (vercelConfigured) {
        const cfg = await vercel('GET', `/v9/projects/${project}/domains/${encodeURIComponent(hostname)}/config`)
        if (cfg.ok) dns = cfg.json
      }
      console.log(`[storefront-domains] connected "${hostname}" (${kind}) → tenant ${tenantId}`)
      res.json({ domain: data, dns })
    } catch (e: any) {
      console.error(`[storefront-domains] add "${hostname}" threw:`, e?.message, e?.stack?.split('\n')[1]?.trim())
      res.status(500).json({ error: e?.message || 'Could not connect the domain. Please try again.' })
    }
  })

  r.delete('/api/storefront/domains/:id', requireAuth, identifyTenant, async (req, res) => {
    const tenantId = (req as any).tenantId
    const { data: row } = await supabase.from('tenant_domains')
      .select('hostname, kind').eq('id', req.params.id).eq('tenant_id', tenantId).maybeSingle()
    if (row?.hostname && vercelConfigured) {
      await vercel('DELETE', `/v9/projects/${projectFor(row.kind as string)}/domains/${encodeURIComponent(row.hostname)}`) // best-effort
    }
    const { error } = await supabase.from('tenant_domains').delete().eq('id', req.params.id).eq('tenant_id', tenantId)
    if (error) { res.status(500).json({ error: error.message }); return }
    res.json({ ok: true })
  })

  // Re-poll Vercel for a pending domain's DNS/verification state and persist it.
  // The UI calls this from a "Recheck status" button — there is no background poller.
  r.post('/api/storefront/domains/:id/recheck', requireAuth, identifyTenant, async (req, res) => {
    const tenantId = (req as any).tenantId
    try {
      const { data: row } = await supabase.from('tenant_domains')
        .select('*').eq('id', req.params.id).eq('tenant_id', tenantId).maybeSingle()
      if (!row) { res.status(404).json({ error: 'Domain not found' }); return }
      if (!vercelConfigured) { res.json({ domain: row, dns: null, misconfigured: null }); return }

      const hostname = row.hostname as string
      // verified = Vercel confirms ownership AND the DNS records are correctly set.
      const [dom, cfg] = await Promise.all([
        vercel('GET', `/v9/projects/${projectFor(row.kind as string)}/domains/${encodeURIComponent(hostname)}`),
        vercel('GET', `/v6/domains/${encodeURIComponent(hostname)}/config`),
      ])
      const ownershipOk = dom.ok && dom.json?.verified === true
      const dnsOk = cfg.ok && cfg.json?.misconfigured === false
      const verified = ownershipOk && dnsOk
      // ssl_status is CHECK-constrained to 'pending' | 'issued' (+ error states) —
      // NOT 'active'. Vercel auto-issues the cert once DNS verifies.
      const ssl_status = verified ? 'issued' : 'pending'

      const { data: updated, error } = await supabase.from('tenant_domains')
        .update({ verified, ssl_status }).eq('id', row.id).eq('tenant_id', tenantId).select('*').single()
      if (error) { res.status(500).json({ error: error.message }); return }
      console.log(`[storefront-domains] recheck "${hostname}" → verified=${verified} dnsOk=${dnsOk} ownershipOk=${ownershipOk}`)
      res.json({ domain: updated, dns: cfg.ok ? cfg.json : null, misconfigured: cfg.json?.misconfigured ?? null })
    } catch (e: any) {
      console.error(`[storefront-domains] recheck threw:`, e?.message)
      res.status(500).json({ error: e?.message || 'Could not check the domain status.' })
    }
  })

  // Public white-label resolver — NO auth (the dashboard needs it BEFORE login) and
  // CORS-open (it's non-sensitive public branding, and the caller is an unknown custom
  // domain). Maps a 'dashboard'-kind custom domain → the tenant it white-labels, with
  // just enough branding for the pre-login screen. Storefront domains never resolve here.
  r.get('/api/whitelabel', async (req, res) => {
    res.set('Access-Control-Allow-Origin', '*')
    res.set('Cache-Control', 'public, max-age=60')
    const host = normalizeHostname(String(req.query.host || ''))
    if (!host) { res.json({ whitelabel: null }); return }
    try {
      const { data: dom } = await supabase.from('tenant_domains')
        .select('tenant_id, verified').eq('hostname', host).eq('kind', 'dashboard').maybeSingle()
      if (!dom?.tenant_id) { res.json({ whitelabel: null }); return }
      const [{ data: t }, { data: b }] = await Promise.all([
        supabase.from('tenants').select('*').eq('id', dom.tenant_id).maybeSingle(),
        supabase.from('tenant_branding').select('*').eq('tenant_id', dom.tenant_id).maybeSingle(),
      ])
      const br = (b || {}) as any
      const slug = (t as any)?.slug || null
      let name = br.name || (t as any)?.name || null
      let logoUrl = br.logo_url || br.logoUrl || null
      let accent = br.accent || br.primary_color || br.primaryColor || null
      // tenant_branding is often empty — the real storefront brand lives in the
      // storefront-api's public config (resolved by slug). Fall back to it so a
      // white-label dashboard shows the tenant's actual logo/name/accent.
      if (slug && (!name || !logoUrl)) {
        try {
          const cfg = await fetch(`${SF_API}/v1/config`, { headers: { 'X-Tenant': slug } })
          if (cfg.ok) {
            const j: any = await cfg.json()
            name = name || j?.name || null
            logoUrl = logoUrl || j?.logoUrl || null
            accent = accent || j?.tokens?.accent || j?.tokens?.primary || null
          }
        } catch (e: any) { console.warn('[whitelabel] storefront config fallback failed:', e?.message) }
      }
      res.json({ whitelabel: { slug, name, logoUrl, accent, verified: !!(dom as any).verified } })
    } catch (e: any) {
      console.error('[whitelabel] resolve threw:', e?.message)
      res.json({ whitelabel: null })
    }
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
        headers: { 'Content-Type': 'application/json', 'X-Tenant': slug, 'X-Admin-Secret': SF_SECRET, 'X-Operator-Email': String((req as any).user?.email || '') },
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
