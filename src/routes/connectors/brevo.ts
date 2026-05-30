/**
 * Brevo connector — single REST API key (formerly Sendinblue).
 *
 * Brevo is the cheapest email+SMS marketing rail popular with Indian SMBs that
 * have outgrown raw WhatsApp broadcasts and want transactional email + SMS too.
 * Like WooCommerce there is NO central app/partner registration: each account
 * owner mints a v3 API key inside their own dashboard
 * (Brevo → Settings → SMTP & API → API Keys → Generate a new API key).
 * That makes this a pure paste-key connect — works today for any tenant the
 * moment they paste the key. Mirrors the WooCommerce/Shopify connectors.
 *
 * Auth: a single `api-key: <key>` request header over HTTPS (the documented
 * primary method; https://developer.brevo.com/docs/getting-started). Keys are
 * prefixed `xkeysib-`.
 *
 * Capabilities (Brevo v3):
 *   list_contacts   GET   /v3/contacts
 *   create_contact  POST  /v3/contacts
 *   send_email      POST  /v3/smtp/email          (transactional email)
 *   send_sms        POST  /v3/transactionalSMS/sms
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

const BREVO_BASE = 'https://api.brevo.com/v3'

const TokenSchema = z.object({
  api_key: z.string().regex(/^xkeysib-/, 'Brevo API keys start with xkeysib-'),
})

const ContactSchema = z.object({
  email:         z.string().email('A valid contact email is required'),
  attributes:    z.record(z.string(), z.any()).optional(),
  listIds:       z.array(z.number()).optional(),
  updateEnabled: z.boolean().optional(),
}).passthrough()

const EmailSchema = z.object({
  to:          z.array(z.object({ email: z.string().email(), name: z.string().optional() })).min(1, 'At least one recipient is required'),
  subject:     z.string().min(1, 'Subject is required'),
  htmlContent: z.string().optional(),
  textContent: z.string().optional(),
  sender:      z.object({ email: z.string().email(), name: z.string().optional() }).optional(),
  templateId:  z.number().optional(),
  params:      z.record(z.string(), z.any()).optional(),
}).passthrough().refine(
  (v) => !!v.htmlContent || !!v.textContent || !!v.templateId,
  { message: 'Provide htmlContent, textContent, or a templateId' },
)

const SmsSchema = z.object({
  recipient: z.string().min(6, 'Recipient phone (E.164, e.g. +919876543210) is required'),
  content:   z.string().min(1, 'SMS content is required'),
  sender:    z.string().max(11, 'SMS sender is max 11 chars').optional(),
  type:      z.enum(['transactional', 'marketing']).optional(),
}).passthrough()

function brevoHeaders(apiKey: string): Record<string, string> {
  return { 'api-key': apiKey, 'Content-Type': 'application/json', Accept: 'application/json' }
}

function brevoErr(r: Response, body: any): string {
  if (r.status === 429) return 'Brevo rate limit exceeded — try again in a moment'
  if (body?.message) return String(body.message)
  if (body?.code)    return `${body.code}`
  return `Brevo ${r.status}`
}

export function createBrevoConnector(deps: Deps): express.Router {
  const r = express.Router()
  const { supabase, requireAuth, identifyTenant, checkPermission } = deps

  // ── Paste-key connect (works today, no app registration) ──────────────────
  r.post('/api/connectors/brevo/connect-key',
    requireAuth, identifyTenant, checkPermission('integrations', 'edit'),
    validateBody(TokenSchema),
    async (req, res) => {
      const tenantId = (req as any).tenantId
      // tenant_integrations.user_id is NOT NULL — omitting it produces a silent
      // constraint violation surfaced as { error } (not a throw).
      const userId = (req as any).user?.id as string | undefined
      if (!userId) { res.status(401).json({ error: 'auth missing user.id' }); return }

      const { api_key } = req.body as z.infer<typeof TokenSchema>

      // Verify with a real call before persisting (same contract as WooCommerce).
      // GET /account doubles as the identity fetch for a friendly brand_label.
      let verify: Response
      try {
        verify = await fetch(`${BREVO_BASE}/account`, { headers: brevoHeaders(api_key) })
      } catch (e: any) {
        res.status(400).json({ error: `Could not reach Brevo (${e?.message ?? 'network error'})` })
        return
      }
      if (!verify.ok) {
        const text = await verify.text().catch(() => '')
        const detail = verify.status === 401
          ? 'Key rejected by Brevo (check the key was copied fully and has not been revoked)'
          : `Brevo returned ${verify.status}`
        res.status(400).json({ error: detail, body: text.slice(0, 200) })
        return
      }

      let label = 'Brevo account'
      try {
        const acct = await verify.json() as any
        label = acct?.companyName || acct?.email || acct?.firstName || label
      } catch { /* identity parse must never block the connect */ }

      const { error: upsertErr } = await supabase.from('tenant_integrations').upsert({
        tenant_id:    tenantId,
        user_id:      userId,
        key:          'brevo',
        status:       'active',
        access_token: encrypt(api_key),
        scope:        'email_sms',
        brand_label:  String(label),
        metadata:     { auth_mode: 'api_key' },
      }, { onConflict: 'tenant_id,key' })
      if (upsertErr) {
        console.error(`[brevo connect] DB upsert failed: ${upsertErr.message}`)
        res.status(500).json({ error: 'Failed to persist connection: ' + upsertErr.message }); return
      }
      res.json({ success: true, account: String(label) })
    })

  // ── Capabilities ──────────────────────────────────────────────────────────
  const guardView = [requireAuth, identifyTenant, checkPermission('integrations', 'view')]
  const guardEdit = [requireAuth, identifyTenant, checkPermission('integrations', 'edit')]

  r.get('/api/connectors/brevo/contacts', ...guardView, async (req, res) => {
    try {
      const apiKey = await loadKey(supabase, (req as any).tenantId)
      const params = new URLSearchParams()
      params.set('limit', String(Math.min(Number(req.query.limit ?? 50), 100)))
      if (req.query.offset) params.set('offset', String(req.query.offset))
      const r2 = await fetch(`${BREVO_BASE}/contacts?${params}`, { headers: brevoHeaders(apiKey) })
      const body = await r2.json() as any
      if (!r2.ok) { res.status(r2.status).json({ error: brevoErr(r2, body) }); return }
      res.json(body)
    } catch (err: any) { res.status(500).json({ error: err.message }) }
  })

  r.post('/api/connectors/brevo/contacts', ...guardEdit,
    validateBody(ContactSchema),
    async (req, res) => {
      try {
        const apiKey = await loadKey(supabase, (req as any).tenantId)
        const r2 = await fetch(`${BREVO_BASE}/contacts`, {
          method: 'POST', headers: brevoHeaders(apiKey), body: JSON.stringify(req.body),
        })
        // Brevo returns 201 with { id } on create, 204 (no body) on update-enabled.
        if (r2.status === 204) { res.json({ success: true, updated: true }); return }
        const body = await r2.json().catch(() => ({})) as any
        if (!r2.ok) { res.status(r2.status).json({ error: brevoErr(r2, body) }); return }
        res.json(body)
      } catch (err: any) { res.status(500).json({ error: err.message }) }
    })

  r.post('/api/connectors/brevo/email', ...guardEdit,
    validateBody(EmailSchema),
    async (req, res) => {
      try {
        const apiKey = await loadKey(supabase, (req as any).tenantId)
        const r2 = await fetch(`${BREVO_BASE}/smtp/email`, {
          method: 'POST', headers: brevoHeaders(apiKey), body: JSON.stringify(req.body),
        })
        const body = await r2.json().catch(() => ({})) as any
        if (!r2.ok) { res.status(r2.status).json({ error: brevoErr(r2, body) }); return }
        res.json(body)
      } catch (err: any) { res.status(500).json({ error: err.message }) }
    })

  r.post('/api/connectors/brevo/sms', ...guardEdit,
    validateBody(SmsSchema),
    async (req, res) => {
      try {
        const apiKey = await loadKey(supabase, (req as any).tenantId)
        // Brevo requires a `type` (defaults to transactional) and a `sender`
        // alpha-tag. Fill a safe default sender if the caller omitted one.
        const payload = { type: 'transactional', sender: 'Brevo', ...req.body }
        const r2 = await fetch(`${BREVO_BASE}/transactionalSMS/sms`, {
          method: 'POST', headers: brevoHeaders(apiKey), body: JSON.stringify(payload),
        })
        const body = await r2.json().catch(() => ({})) as any
        if (!r2.ok) { res.status(r2.status).json({ error: brevoErr(r2, body) }); return }
        res.json(body)
      } catch (err: any) { res.status(500).json({ error: err.message }) }
    })

  return r
}

/**
 * Exported so engine/connector-ops.ts can call Brevo from workflow nodes
 * without duplicating the auth lookup. Returns the decrypted API key.
 */
export async function loadKey(supabase: SupabaseClient, tenantId: string): Promise<string> {
  const { data: row } = await supabase.from('tenant_integrations')
    .select('access_token')
    .eq('tenant_id', tenantId).eq('key', 'brevo').maybeSingle()
  if (!row?.access_token) throw new Error('Brevo not connected')
  return decrypt(row.access_token)
}
