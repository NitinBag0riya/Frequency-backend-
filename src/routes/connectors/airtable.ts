/**
 * Airtable connector — OAuth 2.0 with PKCE + 5 capability endpoints.
 *
 * Why PKCE: Airtable is a public client (no secret on confidential channel),
 * so the spec requires PKCE (code_verifier/challenge). Self-serve registration
 * at https://airtable.com/create/oauth — no approval queue.
 *
 * Required env vars:
 *   AIRTABLE_CLIENT_ID    — from Airtable's "Create new OAuth integration"
 *   AIRTABLE_REDIRECT_URI — must match exactly what's registered (we use
 *                          ${PUBLIC_API_URL}/api/auth/airtable/callback)
 *   PUBLIC_API_URL        — base URL of THIS server (https://api.frequency.app)
 *
 * Capabilities (from https://airtable.com/developers/web/api/introduction):
 *   list_bases                                 GET /v0/meta/bases
 *   list_tables(:baseId)                       GET /v0/meta/bases/:baseId/tables
 *   list_records(:baseId, :tableId)            GET /v0/:baseId/:tableId
 *   create_record(:baseId, :tableId)           POST /v0/:baseId/:tableId
 *   update_record(:baseId, :tableId, :recId)   PATCH /v0/:baseId/:tableId/:recId
 *
 * Token expiry: access_token = 60min, refresh_token = 60d (sliding).
 * We refresh transparently before each capability call when expiry is < 60s.
 */

import express from 'express'
import { SupabaseClient } from '@supabase/supabase-js'
import { encrypt, decrypt, randomToken, sha256base64url } from '../../crypto'

type Middleware = (req: express.Request, res: express.Response, next: express.NextFunction) => void | Promise<void>

interface Deps {
  supabase: SupabaseClient
  requireAuth: Middleware
  identifyTenant: Middleware
  checkPermission: (feature: string, action: 'view' | 'edit' | 'delete') => Middleware
}

const SCOPES = [
  'data.records:read',
  'data.records:write',
  'schema.bases:read',
].join(' ')

export function createAirtableConnector(deps: Deps): express.Router {
  const r = express.Router()
  const { supabase, requireAuth, identifyTenant, checkPermission } = deps

  // ── 1. OAuth start: redirect popup to Airtable's consent screen ───────────
  r.get('/api/auth/airtable/start',
    requireAuth, identifyTenant,
    async (req, res) => {
      const clientId    = process.env.AIRTABLE_CLIENT_ID
      const redirectUri = process.env.AIRTABLE_REDIRECT_URI
      if (!clientId || !redirectUri) {
        res.status(503).type('html').send(envMissingHtml('Airtable',
          ['AIRTABLE_CLIENT_ID', 'AIRTABLE_REDIRECT_URI'],
          'https://airtable.com/create/oauth'))
        return
      }
      const tenantId = (req as any).tenantId as string
      const userId   = (req as any).user.id    as string

      const state    = randomToken(24)
      const verifier = randomToken(48)
      const challenge = sha256base64url(verifier)
      const origin = (req.headers.origin as string) || (req.headers.referer as string) || ''

      await supabase.from('oauth_states').insert({
        tenant_id: tenantId, user_id: userId,
        connector_key: 'airtable',
        state, pkce_verifier: verifier,
        redirect_origin: origin,
      })

      const params = new URLSearchParams({
        client_id:             clientId,
        redirect_uri:          redirectUri,
        response_type:         'code',
        scope:                 SCOPES,
        state,
        code_challenge:        challenge,
        code_challenge_method: 'S256',
      })
      res.redirect(`https://airtable.com/oauth2/v1/authorize?${params.toString()}`)
    })

  // ── 2. OAuth callback: exchange code → tokens, store, close popup ─────────
  r.get('/api/auth/airtable/callback', async (req, res) => {
    const { code, state, error: oauthErr, error_description } = req.query as Record<string, string>
    if (oauthErr) { res.status(400).type('html').send(closePopupHtml({ ok: false, error: error_description ?? oauthErr })); return }
    if (!code || !state) { res.status(400).type('html').send(closePopupHtml({ ok: false, error: 'Missing code or state' })); return }

    const { data: stateRow } = await supabase.from('oauth_states')
      .select('*').eq('state', state).maybeSingle()
    if (!stateRow) { res.status(400).type('html').send(closePopupHtml({ ok: false, error: 'Unknown state — link expired?' })); return }

    const clientId    = process.env.AIRTABLE_CLIENT_ID!
    const redirectUri = process.env.AIRTABLE_REDIRECT_URI!
    // Airtable uses HTTP Basic auth ONLY when there's a client_secret. Public
    // clients (PKCE) post code_verifier in the body and no Authorization header.
    const tokenRes = await fetch('https://airtable.com/oauth2/v1/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id:     clientId,
        code_verifier: stateRow.pkce_verifier,
        redirect_uri:  redirectUri,
        grant_type:    'authorization_code',
        code,
      }),
    })
    const tokenBody = await tokenRes.json() as any
    if (!tokenRes.ok) {
      res.status(400).type('html').send(closePopupHtml({ ok: false, error: tokenBody.error_description ?? tokenBody.error ?? `HTTP ${tokenRes.status}` }))
      return
    }

    // Get user metadata so we can show a friendly label
    let label = 'Airtable account'
    try {
      const whoami = await fetch('https://api.airtable.com/v0/meta/whoami', {
        headers: { Authorization: `Bearer ${tokenBody.access_token}` },
      })
      const j = await whoami.json() as any
      if (j?.email) label = j.email
    } catch { /* swallow — label is cosmetic */ }

    const expiresAt = new Date(Date.now() + (tokenBody.expires_in ?? 3600) * 1000).toISOString()
    await supabase.from('tenant_integrations').upsert({
      tenant_id:        stateRow.tenant_id,
      key:              'airtable',
      status:           'active',
      access_token:     encrypt(tokenBody.access_token),
      refresh_token:    encrypt(tokenBody.refresh_token),
      token_expires_at: expiresAt,
      scope:            tokenBody.scope ?? SCOPES,
      brand_label:      label,
      metadata:         { token_type: tokenBody.token_type ?? 'Bearer' },
    }, { onConflict: 'tenant_id,key' })

    // Clean up state row
    await supabase.from('oauth_states').delete().eq('state', state)

    res.type('html').send(closePopupHtml({ ok: true, connector: 'airtable', label }))
  })

  // ── 3. Capability endpoints ───────────────────────────────────────────────
  // All require an active connection; getValidToken() refreshes if expired.
  const guard = [requireAuth, identifyTenant, checkPermission('integrations', 'view')]

  r.get('/api/connectors/airtable/bases', ...guard, async (req, res) => {
    try {
      const token = await getValidToken(supabase, (req as any).tenantId)
      const r2 = await fetch('https://api.airtable.com/v0/meta/bases', {
        headers: { Authorization: `Bearer ${token}` },
      })
      const body = await r2.json() as any
      if (!r2.ok) { res.status(r2.status).json({ error: body.error?.message ?? body.error ?? 'Airtable error' }); return }
      res.json({ bases: body.bases ?? [] })
    } catch (err: any) { res.status(500).json({ error: err.message }) }
  })

  r.get('/api/connectors/airtable/bases/:baseId/tables', ...guard, async (req, res) => {
    try {
      const token = await getValidToken(supabase, (req as any).tenantId)
      const r2 = await fetch(`https://api.airtable.com/v0/meta/bases/${String(req.params.baseId)}/tables`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      const body = await r2.json() as any
      if (!r2.ok) { res.status(r2.status).json({ error: body.error?.message ?? body.error ?? 'Airtable error' }); return }
      res.json({ tables: body.tables ?? [] })
    } catch (err: any) { res.status(500).json({ error: err.message }) }
  })

  r.get('/api/connectors/airtable/bases/:baseId/tables/:tableId', ...guard, async (req, res) => {
    try {
      const token = await getValidToken(supabase, (req as any).tenantId)
      const params = new URLSearchParams()
      if (req.query.pageSize) params.set('pageSize', String(req.query.pageSize))
      if (req.query.offset)   params.set('offset', String(req.query.offset))
      if (req.query.view)     params.set('view', String(req.query.view))
      const r2 = await fetch(`https://api.airtable.com/v0/${String(req.params.baseId)}/${encodeURIComponent(String(req.params.tableId))}?${params}`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      const body = await r2.json() as any
      if (!r2.ok) { res.status(r2.status).json({ error: body.error?.message ?? body.error ?? 'Airtable error' }); return }
      res.json({ records: body.records ?? [], offset: body.offset ?? null })
    } catch (err: any) { res.status(500).json({ error: err.message }) }
  })

  r.post('/api/connectors/airtable/bases/:baseId/tables/:tableId',
    requireAuth, identifyTenant, checkPermission('integrations', 'edit'),
    async (req, res) => {
      try {
        const token = await getValidToken(supabase, (req as any).tenantId)
        const r2 = await fetch(`https://api.airtable.com/v0/${String(req.params.baseId)}/${encodeURIComponent(String(req.params.tableId))}`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ fields: req.body?.fields ?? req.body ?? {} }),
        })
        const body = await r2.json() as any
        if (!r2.ok) { res.status(r2.status).json({ error: body.error?.message ?? body.error ?? 'Airtable error' }); return }
        res.json({ record: body })
      } catch (err: any) { res.status(500).json({ error: err.message }) }
    })

  r.patch('/api/connectors/airtable/bases/:baseId/tables/:tableId/:recordId',
    requireAuth, identifyTenant, checkPermission('integrations', 'edit'),
    async (req, res) => {
      try {
        const token = await getValidToken(supabase, (req as any).tenantId)
        const r2 = await fetch(`https://api.airtable.com/v0/${String(req.params.baseId)}/${encodeURIComponent(String(req.params.tableId))}/${String(req.params.recordId)}`, {
          method: 'PATCH',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ fields: req.body?.fields ?? req.body ?? {} }),
        })
        const body = await r2.json() as any
        if (!r2.ok) { res.status(r2.status).json({ error: body.error?.message ?? body.error ?? 'Airtable error' }); return }
        res.json({ record: body })
      } catch (err: any) { res.status(500).json({ error: err.message }) }
    })

  return r
}

// ─────────────────────────────────────────────────────────────────────────────
// Token refresh — refresh_token rotates on every refresh per spec, so we
// upsert the new pair atomically.
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Returns a valid Airtable access token for the tenant, refreshing if the
 * stored one is within 60s of expiring. Exported so the data-sources router
 * (mirror endpoint) and the data-source-sync worker can reuse the refresh
 * logic without re-implementing it.
 *
 * RACE PROTECTION: Airtable rotates `refresh_token` on every refresh. If two
 * callers simultaneously hit this with an expiring token, they'll both POST
 * with the same refresh_token; the first wins, the second gets `invalid_grant`
 * and (with the previous implementation) overwrote the just-stored fresh
 * tokens with garbage — bricking the connection until manual reconnect.
 *
 * The fix is a compare-and-swap: include `eq('token_expires_at', oldExpiry)`
 * in the UPDATE. Only the racer that read first lands its write; the second
 * racer's UPDATE matches zero rows. We then re-read and use whatever the
 * winner stored. No advisory lock needed.
 */
export async function getValidToken(supabase: SupabaseClient, tenantId: string): Promise<string> {
  const { data: row } = await supabase.from('tenant_integrations')
    .select('access_token, refresh_token, token_expires_at')
    .eq('tenant_id', tenantId).eq('key', 'airtable').maybeSingle()
  if (!row?.access_token) throw new Error('Airtable not connected for this tenant')

  const oldExpiresAtIso = row.token_expires_at as string | null
  const expiresAt = oldExpiresAtIso ? new Date(oldExpiresAtIso).getTime() : 0
  if (expiresAt > Date.now() + 60_000) {
    return decrypt(row.access_token)
  }

  // Need to refresh
  const clientId = process.env.AIRTABLE_CLIENT_ID
  if (!clientId) throw new Error('AIRTABLE_CLIENT_ID not configured')
  const refreshToken = decrypt(row.refresh_token)
  if (!refreshToken) throw new Error('No refresh_token on file — please reconnect Airtable')

  const r2 = await fetch('https://airtable.com/oauth2/v1/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id:     clientId,
      grant_type:    'refresh_token',
      refresh_token: refreshToken,
    }),
  })
  const body = await r2.json() as any
  if (!r2.ok) {
    // Could be that ANOTHER caller raced ahead, refreshed, and our refresh_token
    // is now stale (Airtable returns 'invalid_grant'). Re-read the row; if a
    // newer expiry is now stored, the winner left a fresh access_token we can use.
    const { data: refreshed } = await supabase.from('tenant_integrations')
      .select('access_token, token_expires_at')
      .eq('tenant_id', tenantId).eq('key', 'airtable').maybeSingle()
    const refreshedExpiry = refreshed?.token_expires_at ? new Date(refreshed.token_expires_at).getTime() : 0
    if (refreshed?.access_token && refreshedExpiry > Date.now() + 60_000) {
      return decrypt(refreshed.access_token)
    }
    throw new Error(`Airtable refresh failed: ${body.error_description ?? body.error ?? r2.status}`)
  }

  const newExpiresAt = new Date(Date.now() + (body.expires_in ?? 3600) * 1000).toISOString()
  // Compare-and-swap: only land the write if the row's expiry hasn't changed
  // since we read it. If a parallel call already refreshed, our update affects
  // 0 rows and we re-read to use the winner's token instead of clobbering it
  // with our (also-valid-but-different) tokens — which would lose 50% of the
  // refresh window and kill the OTHER caller's pending requests.
  const { data: updated } = await supabase.from('tenant_integrations').update({
    access_token:     encrypt(body.access_token),
    refresh_token:    encrypt(body.refresh_token),
    token_expires_at: newExpiresAt,
    last_used_at:     new Date().toISOString(),
  })
    .eq('tenant_id', tenantId)
    .eq('key', 'airtable')
    .eq('token_expires_at', oldExpiresAtIso ?? '')   // CAS predicate
    .select('access_token').maybeSingle()

  if (updated) return body.access_token

  // Lost the race — re-read and use the winner's token.
  const { data: winner } = await supabase.from('tenant_integrations')
    .select('access_token').eq('tenant_id', tenantId).eq('key', 'airtable').maybeSingle()
  if (!winner?.access_token) throw new Error('Airtable token lost in concurrent refresh — please retry')
  return decrypt(winner.access_token)
}

// ─────────────────────────────────────────────────────────────────────────────
// HTML helpers — popup close + env-missing screen
// ─────────────────────────────────────────────────────────────────────────────
function closePopupHtml(payload: { ok: boolean; connector?: string; label?: string; error?: string }) {
  // B10: pin postMessage targetOrigin to FRONTEND_URL.
  const FRONTEND_ORIGIN = process.env.FRONTEND_URL || 'http://localhost:5173'
  return `<!doctype html><html><head><meta charset="utf-8"><title>${payload.ok ? 'Connected' : 'Connection failed'}</title>
<style>body{font:14px/1.5 -apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;padding:32px;max-width:420px;margin:48px auto;text-align:center;color:#1a1a1a}h2{font-size:18px;margin:8px 0}.icon{font-size:42px;margin-bottom:8px}.muted{color:#6b7280;font-size:13px;margin-top:16px}</style>
</head><body>
<div class="icon">${payload.ok ? '✅' : '⚠️'}</div>
<h2>${payload.ok ? `Connected to ${payload.connector ?? 'app'}` : 'Couldn\'t connect'}</h2>
<p>${payload.ok ? (payload.label ?? '') : escapeHtml(payload.error ?? 'Unknown error')}</p>
<p class="muted">${payload.ok ? 'You can close this window.' : 'You can close this window and try again.'}</p>
<script>
  try { window.opener?.postMessage(${JSON.stringify(payload)}, ${JSON.stringify(FRONTEND_ORIGIN)}); } catch(e){}
  setTimeout(() => { try { window.close(); } catch(e){} }, 1200);
</script>
</body></html>`
}

function envMissingHtml(name: string, vars: string[], registerUrl: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${name} not configured</title>
<style>body{font:14px/1.5 -apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;padding:32px;max-width:520px;margin:48px auto;color:#1a1a1a}h2{font-size:18px;margin:0 0 8px}code{background:#f4f4f5;padding:1px 5px;border-radius:3px;font-family:ui-monospace,monospace;font-size:12.5px}.muted{color:#6b7280}a{color:#0070f3}</style>
</head><body>
<h2>⚙️ ${name} OAuth not yet configured</h2>
<p class="muted">An admin needs to register a ${name} app and set these env vars on the server:</p>
<ul>${vars.map(v => `<li><code>${v}</code></li>`).join('')}</ul>
<p>Self-serve registration: <a href="${registerUrl}" target="_blank">${registerUrl}</a></p>
<script>setTimeout(() => { try { window.close(); } catch(e){} }, 8000);</script>
</body></html>`
}

function escapeHtml(s: string): string {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' } as any)[c])
}
