/**
 * seo-gsc — one-click "Connect Google Search Console" for a tenant's storefront.
 *
 * SHIP-DORMANT (mirrors the Razorpay gateway / Turnstile convention): every route
 * is inert until GOOGLE_OAUTH_CLIENT_ID + GOOGLE_OAUTH_CLIENT_SECRET are set. With
 * no creds, /connect returns 501 and the FE hides the button — the existing paste
 * field still works, so nothing breaks.
 *
 * FLOW (merchant clicks Connect):
 *   /connect  → signed OAuth state → Google consent (webmasters + siteverification,
 *               offline, prompt=consent)
 *   /callback → verify state → code→tokens → then, best-effort, PROVISION:
 *     (a) siteVerification.getToken(META) → a verification token
 *     (b) write it into the tenant storefront-api seo.googleVerification (X-Tenant +
 *         X-Admin-Secret) so the existing render layer serves it in the page <head>
 *     (c) siteVerification.verify(META) — Google fetches the page, sees the tag
 *     (d) Search Console sites.add(siteUrl) + sitemaps.submit(siteUrl, /sitemap.xml)
 *     (e) upsert tenant_gsc {verified, sitemap_submitted_at, refresh_token_enc}
 *   → 302 back to the dashboard storefront settings (?gsc=connected | ?gsc=error).
 *
 * SECRETS: the refresh token is encrypted at rest (app-secrets AES-256-GCM) and
 * never logged or returned to the browser. The client secret only ever leaves the
 * process to Google's token endpoint.
 *
 * WIRE(naruto): mounted in index.ts next to the storefront tenant routers:
 *   import { createSeoGscRouter } from './routes/seo-gsc'
 *   app.use(createSeoGscRouter({ supabase, requireAuth, identifyTenant }))
 */
import express from 'express'
import type { SupabaseClient } from '@supabase/supabase-js'
import { signOauthState, verifyOauthState } from '../lib/oauth-state'
import { encryptSecret, decryptSecret } from '../lib/app-secrets'

type Mw = (req: express.Request, res: express.Response, next: express.NextFunction) => void | Promise<void>
interface Deps { supabase: SupabaseClient; requireAuth: Mw; identifyTenant: Mw }

// ── Env (all optional; feature dormant if the pair is unset) ───────────────────
const CLIENT_ID = () => process.env.GOOGLE_OAUTH_CLIENT_ID || ''
const CLIENT_SECRET = () => process.env.GOOGLE_OAUTH_CLIENT_SECRET || ''
const REDIRECT_URI = () => process.env.GOOGLE_OAUTH_REDIRECT_URI || 'https://api.getfrequency.app/api/seo/gsc/callback'
const DASHBOARD_URL = () => (process.env.DASHBOARD_URL || 'https://getfrequency.app').replace(/\/$/, '')
/** Public storefront origin for slug-based stores (order.getfrequency.app/<slug>). */
const SF_PUBLIC_HOST = () => (process.env.STOREFRONT_PUBLIC_HOST || 'order.getfrequency.app').replace(/^https?:\/\//, '').replace(/\/$/, '')
const SF_API = () => process.env.STOREFRONT_API_URL || 'http://localhost:5181'
const SF_SECRET = () => process.env.STOREFRONT_ADMIN_SECRET || 'dev-admin'

const SCOPES = ['https://www.googleapis.com/auth/webmasters', 'https://www.googleapis.com/auth/siteverification']

/** True when the OAuth app is configured — the single dormant/live switch. */
export function gscConfigured(): boolean {
  return !!(CLIENT_ID() && CLIENT_SECRET())
}

// ── Pure helpers (self-checked in seo-gsc.selfcheck.ts) ────────────────────────

export interface TenantDomain { hostname: string; kind: string; verified: boolean }

/**
 * Canonical Search Console URL-prefix property + its sitemap, from the tenant's
 * slug and domains. A verified custom/subdomain storefront domain wins (that's
 * where render.js serves the meta tag + /sitemap.xml at the host root); otherwise
 * the path-based default order.getfrequency.app/<slug>/, where render.js also
 * serves the meta tag and /<slug>/sitemap.xml. Always trailing-slashed so it's a
 * valid URL-prefix property and sitemapUrl concatenation is unambiguous.
 */
export function resolveSiteUrl(slug: string, domains: TenantDomain[] = []): { siteUrl: string; sitemapUrl: string } {
  const primary = domains.find(d => d.verified && (d.kind === 'custom' || d.kind === 'subdomain') && !!d.hostname)
  const siteUrl = primary
    ? `https://${primary.hostname.toLowerCase()}/`
    : `https://${SF_PUBLIC_HOST()}/${encodeURIComponent(slug)}/`
  return { siteUrl, sitemapUrl: `${siteUrl}sitemap.xml` }
}

/**
 * The siteVerification.getToken META response carries the token in one of several
 * shapes depending on API/version. Pull out just the bare content value (what
 * storefront-api stores as seo.googleVerification and render.js re-wraps into
 * `<meta name="google-site-verification" content="…">`). Returns '' if nothing
 * usable was found.
 */
export function extractMetaToken(raw: string | null | undefined): string {
  if (!raw) return ''
  const s = String(raw).trim()
  // 1. Full meta tag → content="…"
  const attr = s.match(/content\s*=\s*["']([^"']+)["']/i)
  if (attr) return attr[1].trim()
  // 2. "google-site-verification: TOKEN" or "…=TOKEN"
  const kv = s.match(/google-site-verification\s*[:=]\s*(\S+)/i)
  if (kv) return kv[1].trim()
  // 3. Already a bare token (no angle brackets / whitespace)
  if (!/[<>\s]/.test(s)) return s
  return ''
}

// ── Google API calls (plain fetch, no SDK) ─────────────────────────────────────

interface GoogleTokens { access_token: string; refresh_token?: string; id_token?: string }

async function exchangeCode(code: string): Promise<GoogleTokens> {
  const body = new URLSearchParams({
    code, client_id: CLIENT_ID(), client_secret: CLIENT_SECRET(),
    redirect_uri: REDIRECT_URI(), grant_type: 'authorization_code',
  })
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body,
  })
  if (!r.ok) throw new Error(`token exchange ${r.status}`)
  return r.json() as Promise<GoogleTokens>
}

/** refresh_token → a fresh access_token (used by submit-sitemap and re-provision). */
async function accessTokenFromRefresh(refreshToken: string): Promise<string> {
  const body = new URLSearchParams({
    client_id: CLIENT_ID(), client_secret: CLIENT_SECRET(),
    refresh_token: refreshToken, grant_type: 'refresh_token',
  })
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body,
  })
  if (!r.ok) throw new Error(`token refresh ${r.status}`)
  const j = (await r.json()) as GoogleTokens
  if (!j.access_token) throw new Error('token refresh: no access_token')
  return j.access_token
}

/** Decode the email out of the id_token (no extra network call); fall back to userinfo. */
async function googleEmail(tokens: GoogleTokens): Promise<string | null> {
  try {
    if (tokens.id_token) {
      const payload = JSON.parse(Buffer.from(tokens.id_token.split('.')[1], 'base64').toString('utf8'))
      if (payload?.email) return String(payload.email)
    }
  } catch { /* fall through to userinfo */ }
  try {
    const r = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    })
    if (r.ok) { const j: any = await r.json(); return j?.email ?? null }
  } catch { /* best-effort */ }
  return null
}

const authHdr = (t: string) => ({ Authorization: `Bearer ${t}`, 'Content-Type': 'application/json' })
const siteBody = (siteUrl: string) => ({ site: { type: 'SITE', identifier: siteUrl } })

async function svGetToken(access: string, siteUrl: string): Promise<string> {
  const r = await fetch('https://www.googleapis.com/siteVerification/v1/token', {
    method: 'POST', headers: authHdr(access),
    body: JSON.stringify({ ...siteBody(siteUrl), verificationMethod: 'META' }),
  })
  if (!r.ok) throw new Error(`siteVerification.getToken ${r.status}`)
  const j: any = await r.json()
  return extractMetaToken(j?.token)
}

async function svVerify(access: string, siteUrl: string): Promise<void> {
  const r = await fetch('https://www.googleapis.com/siteVerification/v1/webResource?verificationMethod=META', {
    method: 'POST', headers: authHdr(access), body: JSON.stringify(siteBody(siteUrl)),
  })
  if (!r.ok) throw new Error(`siteVerification.verify ${r.status}: ${await r.text().catch(() => '')}`)
}

async function scAddSite(access: string, siteUrl: string): Promise<void> {
  const r = await fetch(`https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(siteUrl)}`, {
    method: 'PUT', headers: authHdr(access),
  })
  // 200 = added, 204 = already present. Anything else is a real failure.
  if (!r.ok && r.status !== 204) throw new Error(`searchConsole.sites.add ${r.status}`)
}

async function scSubmitSitemap(access: string, siteUrl: string, sitemapUrl: string): Promise<void> {
  const url = `https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(siteUrl)}/sitemaps/${encodeURIComponent(sitemapUrl)}`
  const r = await fetch(url, { method: 'PUT', headers: authHdr(access) })
  if (!r.ok && r.status !== 204) throw new Error(`searchConsole.sitemaps.submit ${r.status}`)
}

/** Write the verification token into the tenant's storefront seo config so render.js serves it. */
async function writeVerificationMeta(slug: string, token: string): Promise<void> {
  const r = await fetch(`${SF_API()}/admin/config`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', 'X-Tenant': slug, 'X-Admin-Secret': SF_SECRET() },
    body: JSON.stringify({ seo: { googleVerification: token } }),
  })
  if (!r.ok) throw new Error(`storefront-api config PATCH ${r.status}`)
}

async function revokeToken(token: string): Promise<void> {
  try {
    await fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(token)}`, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    })
  } catch { /* best-effort */ }
}

// ── Tenant resolution ──────────────────────────────────────────────────────────

async function tenantSlugAndDomains(supabase: SupabaseClient, tenantId: string): Promise<{ slug: string | null; domains: TenantDomain[] }> {
  const [{ data: t }, { data: d }] = await Promise.all([
    supabase.from('tenants').select('slug').eq('id', tenantId).maybeSingle(),
    supabase.from('tenant_domains').select('hostname, kind, verified').eq('tenant_id', tenantId),
  ])
  return {
    slug: (t as any)?.slug ?? null,
    domains: ((d ?? []) as any[]).map(x => ({ hostname: x.hostname, kind: x.kind, verified: !!x.verified })),
  }
}

export function createSeoGscRouter({ supabase, requireAuth, identifyTenant }: Deps): express.Router {
  const r = express.Router()

  // ── status ──────────────────────────────────────────────────────────────────
  r.get('/api/seo/gsc/status', requireAuth, identifyTenant, async (req, res) => {
    const tenantId = (req as any).tenantId
    if (!tenantId) { res.status(400).json({ error: 'no tenant' }); return }
    try {
      const { data } = await supabase.from('tenant_gsc')
        .select('site_url, verified, sitemap_submitted_at, google_email, refresh_token_enc')
        .eq('tenant_id', tenantId).maybeSingle()
      res.json({
        configured: gscConfigured(),
        connected: !!(data as any)?.refresh_token_enc,
        verified: !!(data as any)?.verified,
        siteUrl: (data as any)?.site_url ?? null,
        sitemapSubmittedAt: (data as any)?.sitemap_submitted_at ?? null,
        googleEmail: (data as any)?.google_email ?? null,
      })
    } catch (e: any) { res.status(500).json({ error: e?.message || 'status unavailable' }) }
  })

  // ── connect → return the Google consent URL ──────────────────────────────────
  r.get('/api/seo/gsc/connect', requireAuth, identifyTenant, async (req, res) => {
    if (!gscConfigured()) { res.status(501).json({ error: 'not configured' }); return }
    const tenantId = (req as any).tenantId
    const userId = (req as any).user?.id
    if (!tenantId || !userId) { res.status(400).json({ error: 'no tenant' }); return }
    const state = signOauthState({ userId, tenantId, connectorKey: 'gsc' })
    const url = 'https://accounts.google.com/o/oauth2/v2/auth?' + new URLSearchParams({
      client_id: CLIENT_ID(), redirect_uri: REDIRECT_URI(), response_type: 'code',
      scope: SCOPES.join(' '), access_type: 'offline', prompt: 'consent',
      include_granted_scopes: 'true', state,
    })
    res.json({ url })
  })

  // ── callback (NO auth middleware — the browser arrives from Google without our
  //    Bearer; the signed `state` is what authenticates the tenant) ─────────────
  r.get('/api/seo/gsc/callback', async (req, res) => {
    const backTo = (q: string) => `${DASHBOARD_URL()}/settings/storefront?${q}`
    const fail = (reason: string) => res.redirect(302, backTo(`gsc=error&reason=${encodeURIComponent(reason)}`))
    if (!gscConfigured()) { fail('not_configured'); return }
    const code = String(req.query.code || '')
    const payload = verifyOauthState(String(req.query.state || ''))
    if (!code || !payload || payload.k !== 'gsc' || !payload.t) { fail('bad_state'); return }
    const tenantId = String(payload.t)

    try {
      const tokens = await exchangeCode(code)
      // No refresh_token means the user previously consented without our seeing it;
      // prompt=consent should force one, but guard so we never store a useless row.
      if (!tokens.refresh_token) { fail('no_refresh_token'); return }

      const { slug, domains } = await tenantSlugAndDomains(supabase, tenantId)
      if (!slug) { fail('unknown_tenant'); return }
      const { siteUrl, sitemapUrl } = resolveSiteUrl(slug, domains)
      const email = await googleEmail(tokens)

      // Provision — each step best-effort so a partial success (e.g. verified but
      // sitemap submit hiccuped) is still recorded. verified flips only if verify OK.
      let verified = false
      let verificationMeta: string | null = null
      let sitemapAt: string | null = null
      try {
        const token = await svGetToken(tokens.access_token, siteUrl)
        if (token) {
          verificationMeta = token
          await writeVerificationMeta(slug, token)   // storefront render layer now serves the tag
          await svVerify(tokens.access_token, siteUrl)
          verified = true
          await scAddSite(tokens.access_token, siteUrl)
          await scSubmitSitemap(tokens.access_token, siteUrl, sitemapUrl)
          sitemapAt = new Date().toISOString()
        }
      } catch (e: any) {
        console.warn(`[seo-gsc] provision partial for tenant=${tenantId}: ${e?.message}`)
      }

      await supabase.from('tenant_gsc').upsert({
        tenant_id: tenantId,
        refresh_token_enc: encryptSecret(tokens.refresh_token),
        google_email: email,
        site_url: siteUrl,
        verified,
        verification_meta: verificationMeta,
        sitemap_url: sitemapUrl,
        sitemap_submitted_at: sitemapAt,
        updated_at: new Date().toISOString(),
      }, { onConflict: 'tenant_id' })

      res.redirect(302, backTo(verified ? 'gsc=connected' : 'gsc=error&reason=verify_failed'))
    } catch (e: any) {
      console.error(`[seo-gsc] callback failed tenant=${tenantId}: ${e?.message}`)
      fail('callback_failed')
    }
  })

  // ── re-submit sitemap (menu/catalog changed) ─────────────────────────────────
  r.post('/api/seo/gsc/submit-sitemap', requireAuth, identifyTenant, async (req, res) => {
    if (!gscConfigured()) { res.status(501).json({ error: 'not configured' }); return }
    const tenantId = (req as any).tenantId
    try {
      const { data } = await supabase.from('tenant_gsc')
        .select('refresh_token_enc, site_url, sitemap_url').eq('tenant_id', tenantId).maybeSingle()
      const enc = (data as any)?.refresh_token_enc
      const siteUrl = (data as any)?.site_url
      const sitemapUrl = (data as any)?.sitemap_url
      if (!enc || !siteUrl || !sitemapUrl) { res.status(409).json({ error: 'not connected' }); return }
      const access = await accessTokenFromRefresh(decryptSecret(enc))
      await scSubmitSitemap(access, siteUrl, sitemapUrl)
      const at = new Date().toISOString()
      await supabase.from('tenant_gsc').update({ sitemap_submitted_at: at, updated_at: at }).eq('tenant_id', tenantId)
      res.json({ ok: true, sitemapSubmittedAt: at })
    } catch (e: any) { res.status(502).json({ error: e?.message || 'sitemap submit failed' }) }
  })

  // ── disconnect (revoke + delete row) ─────────────────────────────────────────
  r.post('/api/seo/gsc/disconnect', requireAuth, identifyTenant, async (req, res) => {
    const tenantId = (req as any).tenantId
    try {
      const { data } = await supabase.from('tenant_gsc')
        .select('refresh_token_enc').eq('tenant_id', tenantId).maybeSingle()
      const enc = (data as any)?.refresh_token_enc
      if (enc && gscConfigured()) { try { await revokeToken(decryptSecret(enc)) } catch { /* best-effort */ } }
      await supabase.from('tenant_gsc').delete().eq('tenant_id', tenantId)
      res.json({ ok: true })
    } catch (e: any) { res.status(500).json({ error: e?.message || 'disconnect failed' }) }
  })

  return r
}
