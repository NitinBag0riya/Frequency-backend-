/**
 * WhatsApp connection mode — platform vs bring-your-own app.
 *
 *   GET    /api/wa-connection            current mode + last capability probe
 *   POST   /api/wa-connection/probe      re-run the capability probe now
 *   POST   /api/wa-connection/byo        switch to the merchant's own Meta app
 *   DELETE /api/wa-connection/byo        revert to the platform app
 *
 * Why this exists: our platform Meta app is in dev mode until Business
 * Verification + App Review for Advanced Access land, so it cannot serve a
 * real merchant yet. A merchant who already owns a WABA and a Meta app can run
 * on Frequency today through BYO. When Tech Provider approval arrives, new
 * tenants land on 'platform' via Embedded Signup and this page becomes the
 * "we already have our own setup" escape hatch rather than the main road.
 *
 * The app secret never leaves the server — POST accepts it, GET only ever
 * reports whether one is present.
 */

import express from 'express'
import { SupabaseClient } from '@supabase/supabase-js'
import {
  resolveWaCreds, probeWabaCapability, newWebhookToken, writeSecretValue,
} from '../lib/wa-creds'

type Middleware = (req: express.Request, res: express.Response, next: express.NextFunction) => void | Promise<void>

interface Deps {
  supabase: SupabaseClient
  requireAuth: Middleware
  identifyTenant: Middleware
  checkPermission: (feature: string, action: 'view' | 'edit' | 'delete') => Middleware
}

const TENANT_FIELDS =
  'id, wa_mode, wa_app_id, wa_app_secret_enc, wa_webhook_token, wa_capability, wa_capability_at, waba_id, phone_number_id, display_phone, access_token, status'

/** Public base for the inbound webhook URL the merchant pastes into Meta. */
function webhookBase(): string {
  return (process.env.PUBLIC_API_URL || 'https://api.getfrequency.app').replace(/\/+$/, '')
}

export function createWaConnectionRouter(deps: Deps): express.Router {
  const r = express.Router()
  const { supabase, requireAuth, identifyTenant, checkPermission } = deps
  const guardView = [requireAuth, identifyTenant, checkPermission('whatsapp_automation', 'view')]
  const guardEdit = [requireAuth, identifyTenant, checkPermission('whatsapp_automation', 'edit')]

  /** Shape sent to the browser. Deliberately omits every secret. */
  const present = (t: any) => ({
    mode: t.wa_mode === 'byo' ? 'byo' : 'platform',
    connected: !!(t.waba_id && t.access_token),
    wabaId: t.waba_id,
    phoneNumberId: t.phone_number_id,
    displayPhone: t.display_phone,
    appId: t.wa_app_id ?? (t.wa_mode === 'byo' ? null : process.env.META_APP_ID ?? null),
    hasAppSecret: !!t.wa_app_secret_enc,
    // Only meaningful in BYO mode — this is what the merchant configures on
    // their own Meta app. Doubles as the Verify Token (see index.ts GET route).
    webhookUrl: t.wa_webhook_token ? `${webhookBase()}/webhook/whatsapp/${t.wa_webhook_token}` : null,
    verifyToken: t.wa_webhook_token,
    capability: t.wa_capability ?? null,
    capabilityAt: t.wa_capability_at ?? null,
  })

  r.get('/api/wa-connection', ...guardView, async (req, res) => {
    const tenantId = (req as any).tenantId
    const { data, error } = await supabase.from('tenants')
      .select(TENANT_FIELDS).eq('id', tenantId).maybeSingle()
    if (error) { res.status(500).json({ error: error.message }); return }
    if (!data) { res.status(404).json({ error: 'Tenant not found' }); return }
    res.json(present(data))
  })

  /**
   * Ask Meta what this WABA can actually do, and cache it. This is the
   * "debug their WhatsApp Business plan" step — messaging tier, quality
   * rating and review status are what decide whether a merchant's own setup
   * is good enough to keep using versus falling back to ours.
   */
  r.post('/api/wa-connection/probe', ...guardView, async (req, res) => {
    const tenantId = (req as any).tenantId
    const creds = await resolveWaCreds(supabase, tenantId)
    if (!creds?.wabaId || !creds.accessToken) {
      res.status(400).json({ error: 'WhatsApp is not connected for this workspace yet.' }); return
    }

    const capability = await probeWabaCapability(creds.wabaId, creds.accessToken)
    await supabase.from('tenants').update({
      wa_capability: capability,
      wa_capability_at: capability.checkedAt,
    }).eq('id', tenantId)

    res.json({ capability })
  })

  /**
   * Switch this workspace onto the merchant's own Meta app.
   *
   * We probe BEFORE persisting: saving credentials that don't actually work
   * would flip the tenant into a mode where every inbound signature fails and
   * every send 401s, which is far harder to diagnose than a rejected form.
   */
  r.post('/api/wa-connection/byo', ...guardEdit, async (req, res) => {
    const tenantId = (req as any).tenantId
    const appId       = String(req.body?.appId ?? '').trim()
    const appSecret   = String(req.body?.appSecret ?? '').trim()
    const wabaId      = String(req.body?.wabaId ?? '').trim()
    const phoneNumberId = String(req.body?.phoneNumberId ?? '').trim()
    const accessToken = String(req.body?.accessToken ?? '').trim()

    if (!appId || !appSecret || !wabaId || !accessToken) {
      res.status(400).json({ error: 'App ID, App Secret, WABA ID and Access Token are all required.' })
      return
    }
    if (!/^\d{10,20}$/.test(appId)) {
      res.status(400).json({ error: 'App ID should be the numeric ID from your Meta app dashboard.' })
      return
    }

    const capability = await probeWabaCapability(wabaId, accessToken)
    if (!capability.ok) {
      res.status(400).json({
        error: `Meta rejected these credentials: ${capability.error ?? 'unknown error'}`,
        capability,
      })
      return
    }

    // Keep an existing token if one was already issued, so a merchant editing
    // their secret doesn't have to go re-paste a new URL into Meta.
    const { data: existing } = await supabase.from('tenants')
      .select('wa_webhook_token').eq('id', tenantId).maybeSingle()
    const webhookToken = existing?.wa_webhook_token || newWebhookToken()

    const { data, error } = await supabase.from('tenants').update({
      wa_mode: 'byo',
      wa_app_id: appId,
      wa_app_secret_enc: writeSecretValue(appSecret),
      wa_webhook_token: webhookToken,
      waba_id: wabaId,
      phone_number_id: phoneNumberId || null,
      display_phone: capability.displayPhone ?? null,
      access_token: writeSecretValue(accessToken),
      wa_capability: capability,
      wa_capability_at: capability.checkedAt,
      status: 'active',
      updated_at: new Date().toISOString(),
    }).eq('id', tenantId).select(TENANT_FIELDS).single()

    if (error) { res.status(500).json({ error: error.message }); return }

    console.log(`[wa-connection] tenant=${tenantId} switched to BYO app=${appId} waba=${wabaId}`)
    res.json(present(data))
  })

  /**
   * Revert to the platform app. We clear the BYO identity but deliberately
   * leave waba_id / access_token alone — reverting the mode shouldn't silently
   * disconnect WhatsApp. The tenant re-runs Embedded Signup to land on our app
   * properly; until then the stored token keeps outbound alive.
   */
  r.delete('/api/wa-connection/byo', ...guardEdit, async (req, res) => {
    const tenantId = (req as any).tenantId
    const { data, error } = await supabase.from('tenants').update({
      wa_mode: 'platform',
      wa_app_id: null,
      wa_app_secret_enc: null,
      wa_webhook_token: null,
      updated_at: new Date().toISOString(),
    }).eq('id', tenantId).select(TENANT_FIELDS).single()

    if (error) { res.status(500).json({ error: error.message }); return }
    console.log(`[wa-connection] tenant=${tenantId} reverted to platform app`)
    res.json(present(data))
  })

  return r
}

/**
 * Meta's data deletion callback — required to submit the app for review, and
 * required of any Tech Provider handling business data.
 *
 * Meta POSTs a `signed_request` (base64url payload + HMAC-SHA256 signature
 * keyed on the app secret) and expects `{ url, confirmation_code }` back so a
 * user can follow the deletion's progress. Mounted separately from the router
 * above because it is unauthenticated — Meta calls it, not a logged-in user.
 */
export function createDataDeletionRouter(deps: { supabase: SupabaseClient }): express.Router {
  const r = express.Router()
  const { supabase } = deps

  r.post('/api/meta/data-deletion', express.urlencoded({ extended: false }), async (req, res) => {
    const signed = String((req.body as any)?.signed_request ?? '')
    const appSecret = process.env.META_APP_SECRET || ''
    const [sigB64, payloadB64] = signed.split('.')

    if (!sigB64 || !payloadB64 || !appSecret) {
      res.status(400).json({ error: 'invalid_signed_request' }); return
    }

    // Verify before trusting the payload — this endpoint is public.
    const crypto = await import('crypto')
    const expected = crypto.createHmac('sha256', appSecret)
      .update(payloadB64).digest('base64url')
    if (expected !== sigB64) {
      console.warn('[data-deletion] signature mismatch — rejecting')
      res.status(401).json({ error: 'invalid_signature' }); return
    }

    let userId = ''
    try {
      userId = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'))?.user_id ?? ''
    } catch {
      res.status(400).json({ error: 'invalid_payload' }); return
    }

    // Record the request rather than deleting inline: deletion spans several
    // tables and Meta expects a fast ack plus a status URL. The confirmation
    // code is what the merchant quotes when chasing it.
    const confirmationCode = `del_${Date.now().toString(36)}_${Math.abs(hash(userId)).toString(36)}`
    const { error } = await supabase.from('data_deletion_requests').insert({
      meta_user_id: userId,
      confirmation_code: confirmationCode,
      status: 'received',
    })
    if (error) console.error('[data-deletion] failed to record request:', error.message)

    const base = (process.env.PUBLIC_APP_URL || 'https://getfrequency.app').replace(/\/+$/, '')
    res.json({
      url: `${base}/data-deletion?code=${confirmationCode}`,
      confirmation_code: confirmationCode,
    })
  })

  return r
}

/** Small stable hash so a confirmation code is reproducible per user id. */
function hash(s: string): number {
  let h = 0
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0
  return h
}
