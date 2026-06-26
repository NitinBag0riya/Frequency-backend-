/**
 * storefront-app — operator endpoints for the per-tenant native app (Mobile App
 * section in the dashboard). Connect a store account (App Store Connect / Google
 * Play), then trigger builds + version publishes from the dashboard.
 *
 *   GET    /api/storefront/app/status                 → app info + per-platform connection + latest build
 *   POST   /api/storefront/app/connect   {platform, credentials}  → encrypt + store
 *   POST   /api/storefront/app/disconnect {platform}
 *   POST   /api/storefront/app/build     {platform}   → queue a build / version publish
 *
 * Credentials are encrypted at rest (app-secrets.ts) and never returned to the
 * browser — only a non-secret display summary + connection status are exposed.
 * The actual build runs in the EAS pipeline (platform-level EAS_TOKEN); until
 * that's wired, a build is recorded as `queued` so the UI reflects intent.
 */
import express from 'express'
import crypto from 'crypto'
import { SupabaseClient } from '@supabase/supabase-js'
import { z } from 'zod'
import { validateBody } from '../validation'
import { apiError } from '../lib/api-error'
import { encryptSecret } from '../lib/app-secrets'

type Mw = express.RequestHandler
interface Deps { supabase: SupabaseClient; requireAuth: Mw; identifyTenant: Mw }

// Wake the on-demand build runner (scale-to-zero Fly app). Fire-and-forget: the
// runner holds the request ~1 min while it uploads to EAS, but the dashboard must
// not wait on that — so we don't await. No RUNNER_URL set → builds stay queued.
function wakeRunner(): void {
  const url = process.env.RUNNER_URL
  if (!url) return
  fetch(`${url.replace(/\/$/, '')}/run`, { method: 'POST', headers: { 'x-runner-secret': process.env.RUNNER_SECRET || '' } })
    .catch(() => { /* the runner also self-heals queued rows on its next wake */ })
}

const ConnectSchema = z.object({
  platform: z.enum(['ios', 'android']),
  credentials: z.record(z.string(), z.any()),
})
const PlatformSchema = z.object({ platform: z.enum(['ios', 'android']) })

// Pull a non-secret display summary out of each credential type.
function summarize(platform: string, c: any): Record<string, string> {
  if (platform === 'android') {
    let j = c.serviceAccountJson
    try { if (typeof j === 'string') j = JSON.parse(j) } catch { /* leave */ }
    return { project_id: j?.project_id || '', client_email: j?.client_email || '' }
  }
  return { keyId: String(c.keyId || ''), issuerId: String(c.issuerId || '') }
}
function validShape(platform: string, c: any): boolean {
  if (platform === 'android') {
    let j = c?.serviceAccountJson
    try { if (typeof j === 'string') j = JSON.parse(j) } catch { return false }
    return !!(j && j.private_key && j.client_email)
  }
  return !!(c?.keyId && c?.issuerId && String(c?.p8 || '').includes('PRIVATE KEY'))
}

export function createStorefrontAppRouter(deps: Deps): express.Router {
  const { supabase, requireAuth, identifyTenant } = deps
  const r = express.Router()

  r.get('/api/storefront/app/status', requireAuth, identifyTenant, async (req, res) => {
    const tenantId = (req as any).tenantId
    const [{ data: creds }, { data: builds }, { data: tenant }] = await Promise.all([
      supabase.from('storefront_app_credentials').select('platform, status, meta, connected_at').eq('tenant_id', tenantId),
      supabase.from('storefront_app_builds').select('platform, version, status, store_url, error, created_at').eq('tenant_id', tenantId).order('created_at', { ascending: false }).limit(20),
      supabase.from('tenants').select('slug, business_name').eq('id', tenantId).maybeSingle(),
    ])
    const latest = (p: string) => (builds ?? []).find(b => b.platform === p) ?? null
    const platform = (p: string) => {
      const c = (creds ?? []).find(x => x.platform === p)
      return { connected: !!c, status: c?.status ?? 'not_connected', meta: c?.meta ?? null, connectedAt: c?.connected_at ?? null, lastBuild: latest(p) }
    }
    res.json({
      slug: (tenant as any)?.slug ?? null,
      name: (tenant as any)?.business_name ?? null,
      builds: builds ?? [],
      platforms: { ios: platform('ios'), android: platform('android') },
    })
  })

  r.post('/api/storefront/app/connect', requireAuth, identifyTenant, validateBody(ConnectSchema), async (req, res) => {
    const tenantId = (req as any).tenantId
    const { platform, credentials } = req.body as z.infer<typeof ConnectSchema>
    if (!validShape(platform, credentials)) {
      apiError(res, 422, 'invalid_credentials', platform === 'android'
        ? 'That doesn’t look like a Google Play service-account JSON (needs client_email + private_key).'
        : 'Need a Key ID, Issuer ID, and the .p8 private key.')
      return
    }
    const enc = encryptSecret(JSON.stringify(credentials))
    const { error } = await supabase.from('storefront_app_credentials').upsert({
      tenant_id: tenantId, platform, enc, status: 'connected', meta: summarize(platform, credentials),
      connected_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    }, { onConflict: 'tenant_id,platform' })
    if (error) { apiError(res, 500, 'connect_failed', error.message); return }
    res.json({ ok: true, platform, connected: true, meta: summarize(platform, credentials) })
  })

  r.post('/api/storefront/app/disconnect', requireAuth, identifyTenant, validateBody(PlatformSchema), async (req, res) => {
    const tenantId = (req as any).tenantId
    const { platform } = req.body as z.infer<typeof PlatformSchema>
    const { error } = await supabase.from('storefront_app_credentials').delete().eq('tenant_id', tenantId).eq('platform', platform)
    if (error) { apiError(res, 500, 'disconnect_failed', error.message); return }
    res.json({ ok: true, platform, connected: false })
  })

  r.post('/api/storefront/app/build', requireAuth, identifyTenant, validateBody(PlatformSchema), async (req, res) => {
    const tenantId = (req as any).tenantId
    const { platform } = req.body as z.infer<typeof PlatformSchema>
    const { data: cred } = await supabase.from('storefront_app_credentials').select('id').eq('tenant_id', tenantId).eq('platform', platform).maybeSingle()
    if (!cred) { apiError(res, 409, 'not_connected', `Connect your ${platform === 'android' ? 'Google Play' : 'App Store'} account first.`); return }
    // Queue the build, then wake the on-demand runner to pick it up.
    const { data: build, error } = await supabase.from('storefront_app_builds').insert({
      tenant_id: tenantId, platform, status: 'queued',
      profile: platform === 'ios' ? 'preview-ios-sim' : 'preview',
    }).select('id, platform, status, created_at').single()
    if (error) { apiError(res, 500, 'build_failed', error.message); return }
    wakeRunner()
    res.json({ ok: true, build, pipelineReady: !!process.env.RUNNER_URL })
  })

  // EAS build webhook — Expo POSTs here when a build finishes; we flip the matching
  // row to ready (+ install URL) or failed. Body HMAC-verified (rawBody captured in
  // index.ts). Not tenant-scoped: matched by the globally-unique eas_build_id.
  r.post('/api/storefront/app/eas-webhook', async (req, res) => {
    const secret = process.env.EAS_WEBHOOK_SECRET
    const sig = String(req.headers['expo-signature'] || '')
    const raw = (req as any).rawBody as Buffer | undefined
    if (secret && raw && sig) {
      const expected = 'sha1=' + crypto.createHmac('sha1', secret).update(raw).digest('hex')
      const ok = sig.length === expected.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))
      if (!ok) { apiError(res, 401, 'bad_signature', 'signature mismatch'); return }
    }
    const body = (req.body || {}) as any
    const easId = body.id
    if (!easId) { res.json({ ok: true, ignored: 'no build id' }); return }
    const artifact = body.artifacts?.applicationArchiveUrl || body.artifacts?.buildUrl || null
    const patch: Record<string, any> = { updated_at: new Date().toISOString() }
    if (body.status === 'finished') { patch.status = 'ready'; patch.store_url = artifact; patch.error = null }
    else if (body.status === 'errored' || body.status === 'canceled') { patch.status = 'failed'; patch.error = String(body.error?.message || body.status).slice(0, 400) }
    else { res.json({ ok: true, status: body.status }); return }
    await supabase.from('storefront_app_builds').update(patch).eq('eas_build_id', easId)
    res.json({ ok: true })
  })

  return r
}
