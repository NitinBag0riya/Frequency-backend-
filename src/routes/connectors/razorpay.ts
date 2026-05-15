/**
 * Razorpay connector — OAuth (Partner program) + API-key fallback + 5
 * capability endpoints hitting the real Razorpay API.
 *
 * Two auth paths:
 *   1. **API-key (works today)** — POST /api/connectors/razorpay/connect-key
 *      with { key_id, key_secret }. We hit GET /v1/payments?count=1 to verify
 *      the keys before saving — green-check on paste, red-error otherwise.
 *      Backwards-compat with the existing AppsModal RazorpayForm.
 *   2. **OAuth (after Partner approval)** — /api/auth/razorpay/start
 *      redirects to https://auth.razorpay.com/authorize. Approval takes
 *      1-3 days — code already wired so flipping the env switch is enough.
 *
 * Required env vars (OAuth path only):
 *   RAZORPAY_PARTNER_CLIENT_ID
 *   RAZORPAY_PARTNER_CLIENT_SECRET
 *   RAZORPAY_PARTNER_REDIRECT_URI
 *
 * Capabilities (https://razorpay.com/docs/api/):
 *   create_payment_link  POST /v1/payment_links
 *   list_payments        GET  /v1/payments?count=N&from=X&to=Y
 *   get_payment          GET  /v1/payments/:id
 *   refund_payment       POST /v1/payments/:id/refund
 *   list_subscriptions   GET  /v1/subscriptions
 *
 * Auth on outbound calls: HTTP Basic with key_id : key_secret
 *   (or Bearer access_token on OAuth Partner mode — same shape, different header).
 */

import express from 'express'
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

const RZP = 'https://api.razorpay.com/v1'

const KeySchema = z.object({
  key_id:     z.string().regex(/^rzp_(live|test)_/, 'Must start with rzp_live_ or rzp_test_'),
  key_secret: z.string().min(8, 'Secret looks too short'),
})

// Flat-shape schema matching `connectors/registry.ts` create_payment_link
// inputSchema. The registry's `Amount (INR)` field sends rupees; we convert
// to paise before forwarding to Razorpay. The workflow-builder engine and a
// future capability form will both POST this exact shape.
//
// Example successful payload from the FE / workflow node:
//   {
//     "amount": 1499,                       // rupees (INR)
//     "description": "Plan upgrade",
//     "customer_phone": "+919876543210",
//     "customer_name":  "Asha Patel",
//     "customer_email": "asha@example.com"  // optional
//   }
//
// Sent to Razorpay as:
//   {
//     "amount": 149900,                     // paise
//     "currency": "INR",
//     "description": "Plan upgrade",
//     "customer": { name, email, contact }
//   }
//
// Coerce numeric strings to numbers (FE form inputs return strings even on
// type='number' fields). z.coerce.number lets workflow interpolators that
// produce "1499" continue to work without per-callsite Number() casts.
const PaymentLinkSchema = z.object({
  amount:          z.coerce.number().positive(),                       // rupees (INR), converted to paise in handler
  currency:        z.string().length(3).default('INR'),
  description:     z.string().max(2048).optional(),
  customer_name:   z.string().min(1).max(100).optional(),
  customer_email:  z.string().email().optional(),
  customer_phone:  z.string().min(6).max(20).optional(),
  notify_sms:      z.boolean().optional(),
  notify_email:    z.boolean().optional(),
  reminder_enable: z.boolean().optional(),
  notes:           z.record(z.string(), z.string()).optional(),
  callback_url:    z.string().url().optional(),
  callback_method: z.enum(['get']).optional(),
  expire_by:       z.number().int().optional(),                        // unix ts
}).strict()

const RefundSchema = z.object({
  amount:    z.number().int().positive().optional(),                           // partial refund
  speed:     z.enum(['normal', 'optimum']).optional(),
  notes:     z.record(z.string(), z.string()).optional(),
  receipt:   z.string().optional(),
})

export function createRazorpayConnector(deps: Deps): express.Router {
  const r = express.Router()
  const { supabase, requireAuth, identifyTenant, checkPermission } = deps

  // ── 1a. API-key connect (works today; verifies keys with a real API call) ──
  r.post('/api/connectors/razorpay/connect-key',
    requireAuth, identifyTenant, checkPermission('integrations', 'edit'),
    validateBody(KeySchema),
    async (req, res) => {
      const tenantId = (req as any).tenantId
      // user_id is required by tenant_integrations.user_id NOT NULL (migration
      // 005). requireAuth populates (req as any).user from supabase.auth.getUser,
      // so .id is always present after the middleware runs — but we guard
      // explicitly so a misconfigured route ordering surfaces with a clean 401
      // instead of a silent constraint violation.
      const userId = (req as any).user?.id as string | undefined
      if (!userId) { res.status(401).json({ error: 'auth missing user.id' }); return }
      const { key_id, key_secret } = req.body as z.infer<typeof KeySchema>

      // Verify with a real Razorpay call before persisting — if the keys are
      // wrong, fail loudly NOW instead of silently storing junk.
      const verify = await fetch(`${RZP}/payments?count=1`, {
        headers: { Authorization: 'Basic ' + Buffer.from(`${key_id}:${key_secret}`).toString('base64') },
      })
      if (!verify.ok) {
        const body = await verify.text()
        const detail = body.includes('authentication') ? 'Keys rejected by Razorpay (authentication failed)' : `Razorpay returned ${verify.status}`
        res.status(400).json({ error: detail }); return
      }

      const live = key_id.startsWith('rzp_live_')
      // supabase-js does NOT throw on DB errors — it returns { data, error }.
      // The previous version ignored `error`, so a NOT NULL constraint
      // violation (missing user_id) silently produced a misleading 200 with
      // nothing persisted. Always check `error` and surface it.
      const { error: upsertErr } = await supabase.from('tenant_integrations').upsert({
        tenant_id:   tenantId,
        user_id:     userId,
        key:         'razorpay',
        status:      'active',
        scope:       live ? 'live_keys' : 'test_keys',
        brand_label: live ? 'Live keys' : 'Test keys',
        // We reuse access_token to store the key_id (public-ish) and refresh_token
        // for key_secret (encrypted). Same shape as OAuth so capability code is uniform.
        access_token:  encrypt(key_id),
        refresh_token: encrypt(key_secret),
        metadata:      { auth_mode: 'api_key', mode: live ? 'live' : 'test' },
      }, { onConflict: 'tenant_id,key' })
      if (upsertErr) {
        console.error(`[razorpay connect] DB upsert failed: ${upsertErr.message}`)
        res.status(500).json({ error: 'Failed to persist connection: ' + upsertErr.message }); return
      }
      res.json({ success: true, mode: live ? 'live' : 'test' })
    })

  // ── 1b. OAuth start (after Partner approval) ──────────────────────────────
  r.get('/api/auth/razorpay/start',
    requireAuth, identifyTenant,
    async (req, res) => {
      const clientId    = process.env.RAZORPAY_PARTNER_CLIENT_ID
      const redirectUri = process.env.RAZORPAY_PARTNER_REDIRECT_URI
      if (!clientId || !redirectUri) {
        res.status(503).type('html').send(envMissingHtml('Razorpay (OAuth)',
          ['RAZORPAY_PARTNER_CLIENT_ID', 'RAZORPAY_PARTNER_CLIENT_SECRET', 'RAZORPAY_PARTNER_REDIRECT_URI'],
          'https://razorpay.com/docs/partners/applications/oauth/',
          'Or use API-key paste (working today).'))
        return
      }
      const state = randomToken(24)
      await supabase.from('oauth_states').insert({
        tenant_id:     (req as any).tenantId,
        user_id:       (req as any).user.id,
        connector_key: 'razorpay',
        state,
      })
      const params = new URLSearchParams({
        client_id:     clientId,
        redirect_uri:  redirectUri,
        response_type: 'code',
        scope:         'read_write',
        state,
      })
      res.redirect(`https://auth.razorpay.com/authorize?${params}`)
    })

  // ── 1c. OAuth callback ────────────────────────────────────────────────────
  r.get('/api/auth/razorpay/callback', async (req, res) => {
    const { code, state, error: oauthErr } = req.query as Record<string, string>
    if (oauthErr) { res.status(400).type('html').send(closePopupHtml({ ok: false, error: oauthErr })); return }
    if (!code || !state) { res.status(400).type('html').send(closePopupHtml({ ok: false, error: 'Missing code or state' })); return }

    const { data: stateRow } = await supabase.from('oauth_states')
      .select('*').eq('state', state).maybeSingle()
    if (!stateRow) { res.status(400).type('html').send(closePopupHtml({ ok: false, error: 'Unknown state — link expired?' })); return }

    const tokenRes = await fetch('https://auth.razorpay.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id:     process.env.RAZORPAY_PARTNER_CLIENT_ID!,
        client_secret: process.env.RAZORPAY_PARTNER_CLIENT_SECRET!,
        redirect_uri:  process.env.RAZORPAY_PARTNER_REDIRECT_URI!,
        grant_type:    'authorization_code',
        code,
      }),
    })
    const tokenBody = await tokenRes.json() as any
    if (!tokenRes.ok) {
      res.status(400).type('html').send(closePopupHtml({ ok: false, error: tokenBody.error_description ?? tokenBody.error ?? 'Razorpay token exchange failed' }))
      return
    }

    const expiresAt = tokenBody.expires_in
      ? new Date(Date.now() + tokenBody.expires_in * 1000).toISOString()
      : null
    // tenant_integrations.user_id is NOT NULL. The OAuth start endpoint
    // persisted user_id on the oauth_states row — use it here so the upsert
    // doesn't fail the constraint and leave the popup showing "connected"
    // while nothing was written.
    if (!stateRow.user_id) {
      res.status(400).type('html').send(closePopupHtml({ ok: false, error: 'oauth_states row missing user_id — please retry the connect flow' }))
      return
    }
    const { error: upsertErr } = await supabase.from('tenant_integrations').upsert({
      tenant_id:        stateRow.tenant_id,
      user_id:          stateRow.user_id,
      key:              'razorpay',
      status:           'active',
      access_token:     encrypt(tokenBody.access_token),
      refresh_token:    encrypt(tokenBody.refresh_token),
      token_expires_at: expiresAt,
      scope:            tokenBody.scope ?? 'read_write',
      brand_label:      tokenBody.razorpay_account_id ?? 'OAuth',
      metadata:         { auth_mode: 'oauth' },
    }, { onConflict: 'tenant_id,key' })
    if (upsertErr) {
      console.error(`[razorpay oauth callback] DB upsert failed: ${upsertErr.message}`)
      res.status(500).type('html').send(closePopupHtml({ ok: false, error: 'Failed to persist connection: ' + upsertErr.message }))
      return
    }
    await supabase.from('oauth_states').delete().eq('state', state)
    res.type('html').send(closePopupHtml({ ok: true, connector: 'razorpay' }))
  })

  // ── 2. Capabilities ───────────────────────────────────────────────────────
  // create_payment_link
  // Accepts the flat shape declared by the registry inputSchema (amount in INR,
  // flat customer_* fields) and translates it to Razorpay's wire format
  // (amount in paise, nested `customer` object). Keeps schema drift across
  // registry ↔ handler at zero — the registry stays the single source of
  // truth for what the FE sends.
  r.post('/api/connectors/razorpay/payment-links',
    requireAuth, identifyTenant, checkPermission('integrations', 'edit'),
    validateBody(PaymentLinkSchema),
    async (req, res) => {
      try {
        const auth = await getRazorpayAuthHeader(supabase, (req as any).tenantId)
        const input = req.body as z.infer<typeof PaymentLinkSchema>

        // INR (rupees) → paise. Razorpay rejects non-integer amounts, so round
        // defensively for any fractional-rupee input that slipped past Zod.
        const amountPaise = Math.round(input.amount * 100)

        // Build nested customer only if at least one sub-field is present —
        // Razorpay 400s on an empty {} customer object.
        const customer: Record<string, string> = {}
        if (input.customer_name)  customer.name    = input.customer_name
        if (input.customer_email) customer.email   = input.customer_email
        if (input.customer_phone) customer.contact = input.customer_phone

        // Same for notify — only emit if explicitly set.
        const notify: Record<string, boolean> = {}
        if (typeof input.notify_sms   === 'boolean') notify.sms   = input.notify_sms
        if (typeof input.notify_email === 'boolean') notify.email = input.notify_email

        const wirePayload: Record<string, unknown> = {
          amount:   amountPaise,
          currency: input.currency,
        }
        if (input.description)              wirePayload.description     = input.description
        if (Object.keys(customer).length)   wirePayload.customer        = customer
        if (Object.keys(notify).length)     wirePayload.notify          = notify
        if (input.reminder_enable !== undefined) wirePayload.reminder_enable = input.reminder_enable
        if (input.notes)                    wirePayload.notes           = input.notes
        if (input.callback_url)             wirePayload.callback_url    = input.callback_url
        if (input.callback_method)          wirePayload.callback_method = input.callback_method
        if (input.expire_by)                wirePayload.expire_by       = input.expire_by

        const r2 = await fetch(`${RZP}/payment_links`, {
          method: 'POST',
          headers: { Authorization: auth, 'Content-Type': 'application/json' },
          body: JSON.stringify(wirePayload),
        })
        const body = await r2.json() as any
        if (!r2.ok) { res.status(r2.status).json({ error: body.error?.description ?? `Razorpay ${r2.status}` }); return }
        res.json(body)
      } catch (err: any) { res.status(500).json({ error: err.message }) }
    })

  // list_payments
  r.get('/api/connectors/razorpay/payments',
    requireAuth, identifyTenant, checkPermission('integrations', 'view'),
    async (req, res) => {
      try {
        const auth = await getRazorpayAuthHeader(supabase, (req as any).tenantId)
        const params = new URLSearchParams()
        params.set('count', String(Math.min(Number(req.query.count ?? 25), 100)))
        if (req.query.from) params.set('from', String(req.query.from))
        if (req.query.to)   params.set('to',   String(req.query.to))
        if (req.query.skip) params.set('skip', String(req.query.skip))
        const r2 = await fetch(`${RZP}/payments?${params}`, { headers: { Authorization: auth } })
        const body = await r2.json() as any
        if (!r2.ok) { res.status(r2.status).json({ error: body.error?.description ?? `Razorpay ${r2.status}` }); return }
        res.json(body)
      } catch (err: any) { res.status(500).json({ error: err.message }) }
    })

  // get_payment
  r.get('/api/connectors/razorpay/payments/:id',
    requireAuth, identifyTenant, checkPermission('integrations', 'view'),
    async (req, res) => {
      try {
        const auth = await getRazorpayAuthHeader(supabase, (req as any).tenantId)
        const r2 = await fetch(`${RZP}/payments/${req.params.id}`, { headers: { Authorization: auth } })
        const body = await r2.json() as any
        if (!r2.ok) { res.status(r2.status).json({ error: body.error?.description ?? `Razorpay ${r2.status}` }); return }
        res.json(body)
      } catch (err: any) { res.status(500).json({ error: err.message }) }
    })

  // refund_payment
  r.post('/api/connectors/razorpay/payments/:id/refund',
    requireAuth, identifyTenant, checkPermission('integrations', 'edit'),
    validateBody(RefundSchema),
    async (req, res) => {
      try {
        const auth = await getRazorpayAuthHeader(supabase, (req as any).tenantId)
        const r2 = await fetch(`${RZP}/payments/${req.params.id}/refund`, {
          method: 'POST',
          headers: { Authorization: auth, 'Content-Type': 'application/json' },
          body: JSON.stringify(req.body),
        })
        const body = await r2.json() as any
        if (!r2.ok) { res.status(r2.status).json({ error: body.error?.description ?? `Razorpay ${r2.status}` }); return }
        res.json(body)
      } catch (err: any) { res.status(500).json({ error: err.message }) }
    })

  // list_subscriptions
  r.get('/api/connectors/razorpay/subscriptions',
    requireAuth, identifyTenant, checkPermission('integrations', 'view'),
    async (req, res) => {
      try {
        const auth = await getRazorpayAuthHeader(supabase, (req as any).tenantId)
        const params = new URLSearchParams()
        params.set('count', String(Math.min(Number(req.query.count ?? 25), 100)))
        const r2 = await fetch(`${RZP}/subscriptions?${params}`, { headers: { Authorization: auth } })
        const body = await r2.json() as any
        if (!r2.ok) { res.status(r2.status).json({ error: body.error?.description ?? `Razorpay ${r2.status}` }); return }
        res.json(body)
      } catch (err: any) { res.status(500).json({ error: err.message }) }
    })

  // list_customers
  r.get('/api/connectors/razorpay/customers',
    requireAuth, identifyTenant, checkPermission('integrations', 'view'),
    async (req, res) => {
      try {
        const auth = await getRazorpayAuthHeader(supabase, (req as any).tenantId)
        const params = new URLSearchParams()
        params.set('count', String(Math.min(Number(req.query.count ?? 25), 100)))
        const r2 = await fetch(`${RZP}/customers?${params}`, { headers: { Authorization: auth } })
        const body = await r2.json() as any
        if (!r2.ok) { res.status(r2.status).json({ error: body.error?.description ?? `Razorpay ${r2.status}` }); return }
        res.json(body)
      } catch (err: any) { res.status(500).json({ error: err.message }) }
    })

  return r
}

// ─────────────────────────────────────────────────────────────────────────────
// Auth header builder — handles both API-key and OAuth modes.
// Exported so engine/connector-ops.ts can use Razorpay from workflow nodes.
// ─────────────────────────────────────────────────────────────────────────────
export async function getRazorpayAuthHeader(supabase: SupabaseClient, tenantId: string): Promise<string> {
  const { data: row } = await supabase.from('tenant_integrations')
    .select('access_token, refresh_token, metadata, token_expires_at')
    .eq('tenant_id', tenantId).eq('key', 'razorpay').maybeSingle()
  if (!row?.access_token) throw new Error('Razorpay not connected — connect it in Apps')

  const mode = (row.metadata as any)?.auth_mode ?? 'api_key'
  if (mode === 'api_key') {
    const keyId  = decrypt(row.access_token)
    const secret = decrypt(row.refresh_token)
    return 'Basic ' + Buffer.from(`${keyId}:${secret}`).toString('base64')
  }
  // OAuth mode
  if (row.token_expires_at && new Date(row.token_expires_at).getTime() < Date.now() + 60_000) {
    // Refresh
    const refreshToken = decrypt(row.refresh_token)
    const tokenRes = await fetch('https://auth.razorpay.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id:     process.env.RAZORPAY_PARTNER_CLIENT_ID!,
        client_secret: process.env.RAZORPAY_PARTNER_CLIENT_SECRET!,
        grant_type:    'refresh_token',
        refresh_token: refreshToken,
      }),
    })
    const body = await tokenRes.json() as any
    if (!tokenRes.ok) throw new Error(`Razorpay refresh failed: ${body.error_description ?? body.error}`)
    await supabase.from('tenant_integrations').update({
      access_token:     encrypt(body.access_token),
      refresh_token:    encrypt(body.refresh_token),
      token_expires_at: body.expires_in ? new Date(Date.now() + body.expires_in * 1000).toISOString() : null,
    }).eq('tenant_id', tenantId).eq('key', 'razorpay')
    return `Bearer ${body.access_token}`
  }
  return `Bearer ${decrypt(row.access_token)}`
}

// ─────────────────────────────────────────────────────────────────────────────
// HTML helpers (same shape as airtable.ts — kept local so each connector is
// self-contained; cheap duplication beats a coupling for ~30 lines).
// ─────────────────────────────────────────────────────────────────────────────
function closePopupHtml(payload: { ok: boolean; connector?: string; error?: string; label?: string }) {
  // B10: pin postMessage targetOrigin to FRONTEND_URL.
  const FRONTEND_ORIGIN = process.env.FRONTEND_URL || 'http://localhost:5173'
  return `<!doctype html><html><head><meta charset="utf-8"><title>${payload.ok ? 'Connected' : 'Failed'}</title>
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
