/**
 * Google Business Profile connector — status, reviews, reply.
 *
 *   GET  /api/connectors/gbp/status          — connected? which locations?
 *   GET  /api/connectors/gbp/reviews?location=locations/456
 *   POST /api/connectors/gbp/reviews/reply   { reviewName, comment }
 *
 * OAuth start/callback are NOT here — google_business shares the Google consent
 * plumbing (start route in routes/connectors/index.ts, callback in index.ts),
 * which writes the tenant's gbp_refresh_token. This router only reads that token
 * and talks to the GBP API.
 *
 * Every route is tenant-scoped via identifyTenant. Unconnected tenants get a
 * clean { connected: false } rather than an error. A 403 from Google (the GBP
 * API allow-list not yet granted for the project) surfaces as apiAccess:'denied'
 * — never a 500, never fabricated data.
 */

import express from 'express'
import { z } from 'zod'
import { SupabaseClient } from '@supabase/supabase-js'
import { validateBody } from '../../validation'
import { signOauthState, verifyOauthState } from '../../lib/oauth-state'
import {
  getValidGbpToken, getFirstAccount, listLocations, listReviews, replyToReview,
  GbpPermissionDenied, type ApiAccess,
  gbpOauthConfigured, gbpConnectUrl, exchangeCodeForGbp, gbpEmailFromTokens, saveGbpToken,
} from '../../lib/gbp'

type Middleware = (req: express.Request, res: express.Response, next: express.NextFunction) => void | Promise<void>

interface Deps {
  supabase: SupabaseClient
  requireAuth: Middleware
  identifyTenant: Middleware
  checkPermission: (feature: string, action: 'view' | 'edit' | 'delete') => Middleware
}

const ReplySchema = z.object({
  reviewName: z.string().min(1, 'reviewName is required'),
  comment:    z.string().min(1, 'comment is required').max(4096),
})

export function createGbpConnector(deps: Deps): express.Router {
  const r = express.Router()
  const { supabase, requireAuth, identifyTenant, checkPermission } = deps

  async function loadTenant(tenantId: string) {
    const { data } = await supabase.from('tenants')
      .select('id, gbp_refresh_token, gbp_email')
      .eq('id', tenantId).maybeSingle()
    return data as { id: string; gbp_refresh_token?: string | null; gbp_email?: string | null } | null
  }

  // ── OAuth — under the GOOGLE_OAUTH / "Frequency Search Console" client ──────
  // GBP is its OWN connect (own scope=business.manage, own gbp_refresh_token
  // column) but shares the SAME OAuth client as the SEO/GSC connector. So it
  // must NOT ride the shared /api/auth/google/callback (that runs the Gmail
  // GOOGLE_CLIENT_ID). Start + callback both live here under GOOGLE_OAUTH_*.

  // openOAuthPopup() opens /api/auth/google_business/start?token=<jwt>; the
  // signed state carries userId+tenantId so the (unauthenticated) callback can
  // resolve the tenant. Popup closes via postMessage { ok, connector, label }.
  r.get('/api/auth/google_business/start',
    requireAuth, identifyTenant,
    (req, res) => {
      if (!gbpOauthConfigured()) { res.type('html').send(popupHtml({ ok: false, error: 'Google OAuth not configured (GOOGLE_OAUTH_CLIENT_ID / GOOGLE_OAUTH_CLIENT_SECRET missing)' })); return }
      const userId   = (req as any).user?.id as string
      const tenantId = (req as any).tenantId as string
      const state = signOauthState({ userId, tenantId, connectorKey: 'gbp' })
      console.log(`[gbp-connector] Starting OAuth (GOOGLE_OAUTH client) tenant=${tenantId}`)
      res.redirect(gbpConnectUrl(state))
    })

  // Callback — NO auth middleware (browser arrives from Google without our
  // Bearer; the signed `state` is what authenticates the tenant). Registered
  // redirect_uri on the GOOGLE_OAUTH client must match GBP_OAUTH_REDIRECT_URI.
  r.get('/api/connectors/gbp/callback', async (req, res) => {
    const { code, state, error: oauthErr } = req.query as Record<string, string>
    if (oauthErr) { res.type('html').send(popupHtml({ ok: false, error: oauthErr })); return }
    if (!gbpOauthConfigured()) { res.type('html').send(popupHtml({ ok: false, error: 'Google OAuth not configured' })); return }
    if (!code || !state) { res.type('html').send(popupHtml({ ok: false, error: 'Missing code or state' })); return }

    const verified = verifyOauthState(state)
    if (!verified || verified.k !== 'gbp') { res.type('html').send(popupHtml({ ok: false, error: 'Invalid or expired state' })); return }

    try {
      const tokens = await exchangeCodeForGbp(code)
      if (!tokens.refresh_token) { res.type('html').send(popupHtml({ ok: false, error: 'Google returned no refresh token — try again.' })); return }
      const email = await gbpEmailFromTokens(tokens)

      // Resolve tenant — prefer state-provided, fall back to user's active tenant.
      let tenantId = verified.t ?? null
      if (!tenantId) {
        const { data: role } = await supabase.from('user_roles')
          .select('tenant_id').eq('user_id', verified.u).not('tenant_id', 'is', null)
          .order('created_at', { ascending: true }).limit(1).maybeSingle()
        tenantId = (role as any)?.tenant_id ?? null
        if (!tenantId) {
          const { data: owned } = await supabase.from('tenants')
            .select('id').eq('user_id', verified.u).eq('status', 'active')
            .order('created_at', { ascending: true }).limit(1).maybeSingle()
          tenantId = (owned as any)?.id ?? null
        }
      }
      if (!tenantId) throw new Error('No tenant found — complete WhatsApp onboarding first.')

      await saveGbpToken(tenantId, tokens.refresh_token, email)
      console.log(`[gbp-connector] OAuth success tenant=${tenantId} email=${email}`)
      res.type('html').send(popupHtml({ ok: true, label: email ?? '' }))
    } catch (err: any) {
      console.error('[gbp-connector] callback error:', err?.message)
      res.type('html').send(popupHtml({ ok: false, error: err?.message ?? 'Connection failed' }))
    }
  })

  // ── Status ────────────────────────────────────────────────────────────────
  r.get('/api/connectors/gbp/status',
    requireAuth, identifyTenant, checkPermission('integrations', 'view'),
    async (req, res) => {
      const tenantId = (req as any).tenantId
      const tenant = await loadTenant(tenantId)
      if (!tenant?.gbp_refresh_token) { res.json({ connected: false }); return }

      let apiAccess: ApiAccess = 'unknown'
      try {
        const token = await getValidGbpToken(tenant)
        const account = await getFirstAccount(token)
        const locations = account ? await listLocations(token, account) : []
        apiAccess = 'ok'
        res.json({ connected: true, email: tenant.gbp_email ?? null, apiAccess, locations })
      } catch (err: any) {
        if (err instanceof GbpPermissionDenied) {
          res.json({ connected: true, email: tenant.gbp_email ?? null, apiAccess: 'denied' })
          return
        }
        console.error('[gbp] status error:', err?.message)
        res.json({ connected: true, email: tenant.gbp_email ?? null, apiAccess: 'unknown', error: err?.message })
      }
    })

  // ── Reviews ──────────────────────────────────────────────────────────────
  r.get('/api/connectors/gbp/reviews',
    requireAuth, identifyTenant, checkPermission('integrations', 'view'),
    async (req, res) => {
      const tenantId = (req as any).tenantId
      const location = String(req.query.location ?? '')
      if (!location) { res.status(400).json({ error: 'location query param is required' }); return }

      const tenant = await loadTenant(tenantId)
      if (!tenant?.gbp_refresh_token) { res.json({ connected: false }); return }

      try {
        const token = await getValidGbpToken(tenant)
        const account = await getFirstAccount(token)
        if (!account) { res.json({ reviews: [], averageRating: 0, totalCount: 0, apiAccess: 'ok' }); return }
        const { reviews, averageRating, totalReviewCount } = await listReviews(token, account, location)
        res.json({ reviews, averageRating, totalCount: totalReviewCount, apiAccess: 'ok' })
      } catch (err: any) {
        if (err instanceof GbpPermissionDenied) {
          res.json({ reviews: [], averageRating: 0, totalCount: 0, apiAccess: 'denied' })
          return
        }
        console.error('[gbp] reviews error:', err?.message)
        res.status(500).json({ error: err?.message ?? 'Failed to load reviews' })
      }
    })

  // ── Reply to a review ────────────────────────────────────────────────────
  r.post('/api/connectors/gbp/reviews/reply',
    requireAuth, identifyTenant, checkPermission('integrations', 'edit'),
    validateBody(ReplySchema),
    async (req, res) => {
      const tenantId = (req as any).tenantId
      const { reviewName, comment } = req.body as z.infer<typeof ReplySchema>

      const tenant = await loadTenant(tenantId)
      if (!tenant?.gbp_refresh_token) { res.json({ connected: false }); return }

      try {
        const token = await getValidGbpToken(tenant)
        await replyToReview(token, reviewName, comment)
        res.json({ ok: true })
      } catch (err: any) {
        if (err instanceof GbpPermissionDenied) {
          res.status(403).json({ ok: false, apiAccess: 'denied', error: 'GBP API access not granted' })
          return
        }
        console.error('[gbp] reply error:', err?.message)
        res.status(500).json({ ok: false, error: err?.message ?? 'Failed to post reply' })
      }
    })

  return r
}

// ── Popup close + postMessage (targetOrigin pinned to FRONTEND_URL, like the
//    other OAuth connectors — never '*', to avoid leaking the connected email).
function popupHtml(payload: { ok: boolean; label?: string; error?: string }): string {
  const FRONTEND_ORIGIN = process.env.FRONTEND_URL || 'http://localhost:5173'
  const msg = { ok: payload.ok, connector: 'gbp', label: payload.label ?? '', ...(payload.error ? { error: payload.error } : {}) }
  return `<!doctype html><html><head><meta charset="utf-8"><title>${payload.ok ? 'Connected' : 'Connection failed'}</title>
<style>body{font:14px/1.5 system-ui,sans-serif;text-align:center;padding:32px;color:#1a1a1a}</style>
</head><body>
<div style="font-size:42px">${payload.ok ? '✅' : '⚠️'}</div>
<h2 style="font-size:18px;margin:8px 0">${payload.ok ? 'Connected to Google Business Profile' : "Couldn't connect"}</h2>
<p>${escapeHtml(payload.ok ? (payload.label ?? '') : (payload.error ?? 'Unknown error'))}</p>
<p style="color:#6b7280;font-size:13px;margin-top:16px">You can close this window.</p>
<script>
  try { window.opener?.postMessage(${JSON.stringify(msg).replace(/</g, '\\u003c')}, ${JSON.stringify(FRONTEND_ORIGIN)}); } catch(e){}
  setTimeout(() => { try { window.close(); } catch(e){} }, 1200);
</script>
</body></html>`
}

function escapeHtml(s: string): string {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' } as any)[c])
}
