/**
 * MSG91 connector — single `authkey` (India-first SMS / OTP / WhatsApp rail).
 *
 * MSG91 is the dominant transactional-SMS + OTP provider for Indian SMBs. Like
 * WooCommerce/Brevo there is NO central app/partner registration: each account
 * owner copies their Auth Key from the dashboard (MSG91 → top-right user menu →
 * "Auth Key", or Settings → API). Pure paste-key connect — works today for any
 * tenant the moment they paste the key.
 *
 * Auth: a single `authkey: <key>` request header over HTTPS (the documented
 * primary method; https://docs.msg91.com/).
 *
 * INDIA NOTE: Indian SMS is governed by TRAI DLT. Every transactional/OTP SMS
 * must reference a DLT-approved `template_id` (created in the MSG91 dashboard
 * and registered on a DLT portal). We surface `template_id` as a required input
 * rather than hiding it — sending without an approved template will be rejected
 * by the carrier, and pretending otherwise would be a bluff.
 *
 * Capabilities (MSG91 v5):
 *   send_sms     POST  /api/v5/flow/          (flow/template SMS)
 *   send_otp     POST  /api/v5/otp            (generate + send OTP)
 *   verify_otp   GET   /api/v5/otp/verify     (verify a submitted OTP)
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

const MSG91_BASE = 'https://control.msg91.com'

const TokenSchema = z.object({
  auth_key: z.string().min(20, 'MSG91 Auth Key looks too short — copy the full key from the dashboard'),
})

const SmsSchema = z.object({
  template_id: z.string().min(1, 'A DLT-approved template_id is required (TRAI mandate)'),
  recipients:  z.array(z.record(z.string(), z.any())).min(1, 'At least one recipient is required'),
  short_url:   z.union([z.literal(0), z.literal(1)]).optional(),
}).passthrough()

const OtpSchema = z.object({
  template_id: z.string().min(1, 'A DLT-approved OTP template_id is required'),
  mobile:      z.string().min(10, 'Mobile (with country code, e.g. 919876543210) is required'),
  otp:         z.string().optional(),
  otp_expiry:  z.number().optional(),
}).passthrough()

const VerifyOtpSchema = z.object({
  mobile: z.string().min(10, 'Mobile (with country code) is required'),
  otp:    z.string().min(3, 'OTP is required'),
}).passthrough()

function msgErr(r: Response, body: any): string {
  if (r.status === 429) return 'MSG91 rate limit exceeded — try again in a moment'
  if (typeof body === 'string' && body) return body.slice(0, 200)
  if (body?.message) return String(body.message)
  return `MSG91 ${r.status}`
}

export function createMsg91Connector(deps: Deps): express.Router {
  const r = express.Router()
  const { supabase, requireAuth, identifyTenant, checkPermission } = deps

  // ── Paste-key connect (works today, no app registration) ──────────────────
  r.post('/api/connectors/msg91/connect-key',
    requireAuth, identifyTenant, checkPermission('integrations', 'edit'),
    validateBody(TokenSchema),
    async (req, res) => {
      const tenantId = (req as any).tenantId
      const userId = (req as any).user?.id as string | undefined
      if (!userId) { res.status(401).json({ error: 'auth missing user.id' }); return }

      const { auth_key } = req.body as z.infer<typeof TokenSchema>

      // Verify with a real call before persisting. The legacy balance endpoint
      // returns a bare number on success and an auth-failure string on a bad
      // key — a cheap, side-effect-free way to prove the key works.
      let verify: Response
      try {
        verify = await fetch(`${MSG91_BASE}/api/balance.php?authkey=${encodeURIComponent(auth_key)}&type=4`)
      } catch (e: any) {
        res.status(400).json({ error: `Could not reach MSG91 (${e?.message ?? 'network error'})` })
        return
      }
      const text = (await verify.text().catch(() => '')).trim()
      // Success shape: a numeric balance (e.g. "1523" or "0"). Anything else
      // (Authentication failure, JSON error) means the key is bad.
      const looksNumeric = /^[\d.]+$/.test(text)
      if (!verify.ok || !looksNumeric) {
        res.status(400).json({ error: 'Auth Key rejected by MSG91 (check the key was copied fully and SMS is enabled on the account)', body: text.slice(0, 200) })
        return
      }

      const { error: upsertErr } = await supabase.from('tenant_integrations').upsert({
        tenant_id:    tenantId,
        user_id:      userId,
        key:          'msg91',
        status:       'active',
        access_token: encrypt(auth_key),
        scope:        'sms_otp',
        brand_label:  `MSG91 (balance: ${text})`,
        metadata:     { auth_mode: 'api_key' },
      }, { onConflict: 'tenant_id,key' })
      if (upsertErr) {
        console.error(`[msg91 connect] DB upsert failed: ${upsertErr.message}`)
        res.status(500).json({ error: 'Failed to persist connection: ' + upsertErr.message }); return
      }
      res.json({ success: true, balance: text })
    })

  // ── Capabilities ──────────────────────────────────────────────────────────
  const guardEdit = [requireAuth, identifyTenant, checkPermission('integrations', 'edit')]

  r.post('/api/connectors/msg91/sms', ...guardEdit,
    validateBody(SmsSchema),
    async (req, res) => {
      try {
        const authKey = await loadKey(supabase, (req as any).tenantId)
        const r2 = await fetch(`${MSG91_BASE}/api/v5/flow/`, {
          method: 'POST',
          headers: { authkey: authKey, 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify(req.body),
        })
        const body = await r2.json().catch(() => ({})) as any
        if (!r2.ok || body?.type === 'error') { res.status(r2.ok ? 400 : r2.status).json({ error: msgErr(r2, body) }); return }
        res.json(body)
      } catch (err: any) { res.status(500).json({ error: err.message }) }
    })

  r.post('/api/connectors/msg91/otp', ...guardEdit,
    validateBody(OtpSchema),
    async (req, res) => {
      try {
        const authKey = await loadKey(supabase, (req as any).tenantId)
        const { template_id, mobile, ...rest } = req.body as z.infer<typeof OtpSchema>
        const qs = new URLSearchParams({ template_id, mobile })
        const r2 = await fetch(`${MSG91_BASE}/api/v5/otp?${qs}`, {
          method: 'POST',
          headers: { authkey: authKey, 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify(rest),
        })
        const body = await r2.json().catch(() => ({})) as any
        if (!r2.ok || body?.type === 'error') { res.status(r2.ok ? 400 : r2.status).json({ error: msgErr(r2, body) }); return }
        res.json(body)
      } catch (err: any) { res.status(500).json({ error: err.message }) }
    })

  r.post('/api/connectors/msg91/otp/verify', ...guardEdit,
    validateBody(VerifyOtpSchema),
    async (req, res) => {
      try {
        const authKey = await loadKey(supabase, (req as any).tenantId)
        const { mobile, otp } = req.body as z.infer<typeof VerifyOtpSchema>
        const qs = new URLSearchParams({ mobile, otp })
        const r2 = await fetch(`${MSG91_BASE}/api/v5/otp/verify?${qs}`, {
          method: 'GET',
          headers: { authkey: authKey, Accept: 'application/json' },
        })
        const body = await r2.json().catch(() => ({})) as any
        if (!r2.ok || body?.type === 'error') { res.status(r2.ok ? 400 : r2.status).json({ error: msgErr(r2, body) }); return }
        res.json(body)
      } catch (err: any) { res.status(500).json({ error: err.message }) }
    })

  return r
}

/**
 * Exported so engine/connector-ops.ts can call MSG91 from workflow nodes
 * without duplicating the auth lookup. Returns the decrypted Auth Key.
 */
export async function loadKey(supabase: SupabaseClient, tenantId: string): Promise<string> {
  const { data: row } = await supabase.from('tenant_integrations')
    .select('access_token')
    .eq('tenant_id', tenantId).eq('key', 'msg91').maybeSingle()
  if (!row?.access_token) throw new Error('MSG91 not connected')
  return decrypt(row.access_token)
}
