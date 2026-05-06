/**
 * Google connector — OAuth 2.0 start/callback for all four Google app keys:
 *   google_drive, google_sheets, google_calendar, google_gmail
 *
 * All four keys share the same combined Google OAuth scope (one token covers
 * all Google APIs), so they all redirect to the same authorization URL and
 * write the same token to the tenants table.
 *
 * Routes added:
 *   GET /api/auth/google_drive/start
 *   GET /api/auth/google_sheets/start
 *   GET /api/auth/google_calendar/start
 *   GET /api/auth/google_gmail/start
 *   GET /api/auth/google_drive/callback   ← (alias; only one callback needed)
 *
 * The popup flow:
 *   1. openOAuthPopup('google_gmail') → opens /api/auth/google_gmail/start?token=<jwt>&tenant_id=<id>
 *   2. Server validates JWT via requireAuth (supports ?token= query param)
 *   3. Redirects to Google consent screen
 *   4. Callback receives code, exchanges for tokens, saves to tenants table
 *   5. Sends window.postMessage({ ok: true, connector: 'google', label: email })
 *   6. Popup closes; parent resolves the Promise
 */

import express from 'express'
import { SupabaseClient } from '@supabase/supabase-js'
import { encrypt } from '../../crypto'

type Middleware = (req: express.Request, res: express.Response, next: express.NextFunction) => void | Promise<void>

interface Deps {
  supabase: SupabaseClient
  requireAuth: Middleware
  identifyTenant: Middleware
  checkPermission: (feature: string, action: 'view' | 'edit' | 'delete') => Middleware
}

// All four Google app keys share combined scope
const GOOGLE_SCOPES = [
  'https://www.googleapis.com/auth/calendar',
  'https://www.googleapis.com/auth/spreadsheets',
  'https://www.googleapis.com/auth/drive.readonly',
  'https://www.googleapis.com/auth/drive.file',
  'https://www.googleapis.com/auth/gmail.modify',
  'email', 'profile',
].join(' ')

const GOOGLE_KEYS = ['google_drive', 'google_sheets', 'google_calendar', 'google_gmail'] as const

export function createGoogleConnector(deps: Deps): express.Router {
  const r = express.Router()
  const { supabase, requireAuth, identifyTenant } = deps

  const GOOGLE_CLIENT_ID     = () => process.env.GOOGLE_CLIENT_ID
  const GOOGLE_CLIENT_SECRET = () => process.env.GOOGLE_CLIENT_SECRET
  // Callback URL — use the generic /api/auth/google/callback that already exists,
  // OR a dedicated one. We use a new path to keep old Onboarding flow working.
  const REDIRECT_URI = () =>
    process.env.GOOGLE_REDIRECT_URI || 'http://localhost:3001/api/auth/google/callback'

  // ── Start routes — one per connector key ─────────────────────────────────
  for (const key of GOOGLE_KEYS) {
    r.get(`/api/auth/${key}/start`,
      requireAuth, identifyTenant,
      (req, res) => {
        const clientId = GOOGLE_CLIENT_ID()
        if (!clientId) {
          res.status(503).type('html').send(envMissingHtml())
          return
        }

        const userId   = (req as any).user.id   as string
        const tenantId = (req as any).tenantId  as string
        const redirectUri = REDIRECT_URI()

        // Encode userId + tenantId + initiating key into state param
        const statePayload = Buffer.from(JSON.stringify({ userId, tenantId, connectorKey: key })).toString('base64')

        const params = new URLSearchParams({
          client_id:     clientId,
          redirect_uri:  redirectUri,
          response_type: 'code',
          scope:         GOOGLE_SCOPES,
          access_type:   'offline',
          prompt:        'consent',
          state:         statePayload,
        })

        console.log(`[google-connector] Starting OAuth for key=${key} tenant=${tenantId}`)
        res.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`)
      })
  }

  // ── Shared callback ───────────────────────────────────────────────────────
  // The callback URL registered with Google is GOOGLE_REDIRECT_URI which is
  // /api/auth/google/callback — that route already exists in index.ts.
  // We patch its postMessage to also send { ok: true } so the popup resolves.
  //
  // However, if the old callback is still the one registered, we need to
  // ensure it sends the right postMessage shape. We add an ALIAS callback
  // here under /api/auth/google_connector/callback for new registrations.
  // The RECOMMENDED fix is to update the existing callback in index.ts —
  // see the comment added there.
  //
  // For now, we also mount /api/auth/google_drive/callback etc. pointing
  // to the same handler, in case the admin wants to register a per-key URI.
  for (const key of GOOGLE_KEYS) {
    r.get(`/api/auth/${key}/callback`, async (req, res) => {
      await handleGoogleCallback(req, res, supabase, GOOGLE_CLIENT_ID()!, GOOGLE_CLIENT_SECRET()!, REDIRECT_URI())
    })
  }

  return r
}

// ── Shared OAuth callback handler ─────────────────────────────────────────────
async function handleGoogleCallback(
  req: express.Request,
  res: express.Response,
  supabase: SupabaseClient,
  clientId: string,
  clientSecret: string,
  redirectUri: string,
) {
  const { code, state, error: oauthErr } = req.query as Record<string, string>

  if (oauthErr) {
    res.type('html').send(closePopupHtml({ ok: false, error: oauthErr }))
    return
  }
  if (!code || !state) {
    res.type('html').send(closePopupHtml({ ok: false, error: 'Missing code or state' }))
    return
  }

  try {
    const { userId, tenantId, connectorKey } = JSON.parse(Buffer.from(state, 'base64').toString())

    // Exchange code for tokens
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id:     clientId,
        client_secret: clientSecret,
        redirect_uri:  redirectUri,
        grant_type:    'authorization_code',
      }),
    })
    const tokens = await tokenRes.json() as any
    if (tokens.error) throw new Error(tokens.error_description ?? tokens.error)

    // Get user email for the brand_label
    const profileRes = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    })
    const profile = await profileRes.json() as any

    const expiry = new Date(Date.now() + (tokens.expires_in ?? 3600) * 1000).toISOString()

    // Resolve tenant — prefer state-provided tenantId, fallback to user lookup
    let resolvedTenantId = tenantId
    if (!resolvedTenantId) {
      const { data: role } = await supabase.from('user_roles')
        .select('tenant_id').eq('user_id', userId).not('tenant_id', 'is', null)
        .order('created_at', { ascending: true }).limit(1).maybeSingle()
      resolvedTenantId = role?.tenant_id
      if (!resolvedTenantId) {
        const { data: owned } = await supabase.from('tenants')
          .select('id').eq('user_id', userId).eq('status', 'active')
          .order('created_at', { ascending: true }).limit(1).maybeSingle()
        resolvedTenantId = owned?.id
      }
    }
    if (!resolvedTenantId) throw new Error('No tenant found — complete WhatsApp onboarding first.')

    // Save tokens on tenants table (same schema as old /api/auth/google flow)
    const { error: updErr } = await supabase.from('tenants').update({
      google_email:         profile.email,
      google_access_token:  encrypt(tokens.access_token),
      google_refresh_token: encrypt(tokens.refresh_token),
      google_token_expiry:  expiry,
      updated_at:           new Date().toISOString(),
    }).eq('id', resolvedTenantId)

    if (updErr) throw new Error(`DB update failed: ${updErr.message}`)

    console.log(`[google-connector] OAuth success key=${connectorKey ?? 'google'} tenant=${resolvedTenantId} email=${profile.email}`)

    // Send postMessage shape that openOAuthPopup() listens for: { ok: true }
    res.type('html').send(closePopupHtml({
      ok: true,
      connector: connectorKey ?? 'google',
      label: profile.email,
    }))
  } catch (err: any) {
    console.error('[google-connector] callback error:', err.message)
    res.type('html').send(closePopupHtml({ ok: false, error: err.message }))
  }
}

// ── HTML helpers ──────────────────────────────────────────────────────────────
function closePopupHtml(payload: { ok: boolean; connector?: string; label?: string; error?: string }) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${payload.ok ? 'Connected' : 'Connection failed'}</title>
<style>body{font:14px/1.5 -apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;padding:32px;max-width:420px;margin:48px auto;text-align:center;color:#1a1a1a}h2{font-size:18px;margin:8px 0}.icon{font-size:42px;margin-bottom:8px}.muted{color:#6b7280;font-size:13px;margin-top:16px}</style>
</head><body>
<div class="icon">${payload.ok ? '✅' : '⚠️'}</div>
<h2>${payload.ok ? `Connected to Google` : "Couldn't connect"}</h2>
<p>${payload.ok ? escapeHtml(payload.label ?? '') : escapeHtml(payload.error ?? 'Unknown error')}</p>
<p class="muted">${payload.ok ? 'You can close this window.' : 'You can close this window and try again.'}</p>
<script>
  try { window.opener?.postMessage(${JSON.stringify(payload)}, '*'); } catch(e){}
  setTimeout(() => { try { window.close(); } catch(e){} }, 1200);
</script>
</body></html>`
}

function envMissingHtml() {
  return `<!doctype html><html><head><meta charset="utf-8"><title>Google not configured</title>
<style>body{font:14px/1.5 -apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;padding:32px;max-width:520px;margin:48px auto;color:#1a1a1a}code{background:#f4f4f5;padding:1px 5px;border-radius:3px;font-size:12.5px}.muted{color:#6b7280}</style>
</head><body>
<h2>⚙️ Google OAuth not yet configured</h2>
<p class="muted">Set these env vars on the server:</p>
<ul><li><code>GOOGLE_CLIENT_ID</code></li><li><code>GOOGLE_CLIENT_SECRET</code></li><li><code>GOOGLE_REDIRECT_URI</code></li></ul>
<script>setTimeout(() => { try { window.close(); } catch(e){} }, 8000);</script>
</body></html>`
}

function escapeHtml(s: string): string {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' } as any)[c])
}
