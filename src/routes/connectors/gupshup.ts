/**
 * Gupshup connector — API key + app name (India WhatsApp/SMS BSP).
 *
 * Gupshup is one of the largest WhatsApp Business Solution Providers (BSP) in
 * India. A tenant who already runs a Gupshup WhatsApp app pastes three things
 * from their Gupshup dashboard (Dashboard → app → API key):
 *   - api_key   the app's API key (sent as the `apikey` request header)
 *   - app_name  the registered Gupshup app name (`src.name`)
 *   - source    the registered WhatsApp Business number (sender)
 * Pure paste-key, no partner/BD agreement — works today for any Gupshup app.
 *
 * Auth: `apikey: <key>` header on every call (api.gupshup.io).
 *
 * Verify: GET /sm/api/v1/users/{appName} (the opt-in user list) is a read-only
 * call that proves the api_key + app_name pair — 200 on valid, 401/auth on bad.
 * Nothing is sent during verification.
 *
 * Capabilities (Gupshup WhatsApp v1):
 *   send_message   POST /wa/api/v1/msg            (free-form session text)
 *   send_template  POST /wa/api/v1/template/msg   (HSM/template — required >24h)
 *   opt_in_user    POST /sm/api/v1/app/opt/in/{appName}
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

const GS_BASE = 'https://api.gupshup.io'

const TokenSchema = z.object({
  api_key:  z.string().min(10, 'API key looks too short — copy it from your Gupshup app dashboard'),
  app_name: z.string().min(1, 'App name (src.name) is required'),
  source:   z.string().min(8, 'Source WhatsApp number (with country code, e.g. 919876543210) is required'),
})

const MsgSchema = z.object({
  destination: z.string().min(8, 'destination (with country code) is required'),
  text:        z.string().min(1, 'text is required'),
}).passthrough()

const TemplateSchema = z.object({
  destination: z.string().min(8, 'destination (with country code) is required'),
  template_id: z.string().min(1, 'template_id is required'),
  params:      z.union([z.array(z.any()), z.string()]).optional(),
}).passthrough()

const OptInSchema = z.object({
  user: z.string().min(8, 'user (phone with country code) is required'),
}).passthrough()

function gsErr(r: Response, body: any): string {
  if (r.status === 429) return 'Gupshup rate limit exceeded — try again in a moment'
  if (body?.message) return String(body.message)
  if (typeof body === 'string' && body) return body.slice(0, 200)
  return `Gupshup ${r.status}`
}

/** Build the form body Gupshup expects (x-www-form-urlencoded). */
function form(obj: Record<string, string>): string {
  return new URLSearchParams(obj).toString()
}

export function createGupshupConnector(deps: Deps): express.Router {
  const r = express.Router()
  const { supabase, requireAuth, identifyTenant, checkPermission } = deps

  // ── Paste-key connect (verify with a read-only call, then persist) ────────
  r.post('/api/connectors/gupshup/connect-key',
    requireAuth, identifyTenant, checkPermission('integrations', 'edit'),
    validateBody(TokenSchema),
    async (req, res) => {
      const tenantId = (req as any).tenantId
      const userId = (req as any).user?.id as string | undefined
      if (!userId) { res.status(401).json({ error: 'auth missing user.id' }); return }

      const { api_key, app_name, source } = req.body as z.infer<typeof TokenSchema>

      // Read-only verify: the opt-in user list proves api_key + app_name.
      let verify: Response
      try {
        verify = await fetch(`${GS_BASE}/sm/api/v1/users/${encodeURIComponent(app_name)}`, {
          headers: { apikey: api_key, Accept: 'application/json' },
        })
      } catch (e: any) {
        res.status(400).json({ error: `Could not reach Gupshup (${e?.message ?? 'network error'})` })
        return
      }
      if (verify.status === 401 || verify.status === 403) {
        res.status(400).json({ error: 'Gupshup rejected this API key (check the key and that the app name matches the dashboard).' })
        return
      }
      if (verify.status === 404) {
        res.status(400).json({ error: `Gupshup app "${app_name}" not found for this API key — confirm the exact app name from your dashboard.` })
        return
      }
      if (!verify.ok) {
        const t = (await verify.text().catch(() => '')).slice(0, 200)
        res.status(400).json({ error: `Gupshup verification failed (${verify.status}) ${t}` })
        return
      }

      const { error: upsertErr } = await supabase.from('tenant_integrations').upsert({
        tenant_id:    tenantId,
        user_id:      userId,
        key:          'gupshup',
        status:       'active',
        access_token: encrypt(api_key),
        scope:        'whatsapp_sms',
        brand_label:  `Gupshup (${app_name})`,
        metadata:     { auth_mode: 'api_key', app_name, source },
      }, { onConflict: 'tenant_id,key' })
      if (upsertErr) {
        console.error(`[gupshup connect] DB upsert failed: ${upsertErr.message}`)
        res.status(500).json({ error: 'Failed to persist connection: ' + upsertErr.message }); return
      }
      res.json({ success: true, app: app_name })
    })

  // ── Capabilities ──────────────────────────────────────────────────────────
  const guardEdit = [requireAuth, identifyTenant, checkPermission('integrations', 'edit')]

  r.post('/api/connectors/gupshup/message', ...guardEdit,
    validateBody(MsgSchema),
    async (req, res) => {
      try {
        const { apiKey, appName, source } = await loadCreds(supabase, (req as any).tenantId)
        const { destination, text } = req.body as z.infer<typeof MsgSchema>
        const body = form({
          channel: 'whatsapp', source, destination,
          'src.name': appName,
          message: JSON.stringify({ type: 'text', text }),
        })
        const r2 = await fetch(`${GS_BASE}/wa/api/v1/msg`, {
          method: 'POST',
          headers: { apikey: apiKey, 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
          body,
        })
        const out = await r2.json().catch(() => ({})) as any
        if (!r2.ok || out?.status === 'error') { res.status(r2.ok ? 400 : r2.status).json({ error: gsErr(r2, out) }); return }
        res.json(out)
      } catch (err: any) { res.status(500).json({ error: err.message }) }
    })

  r.post('/api/connectors/gupshup/template', ...guardEdit,
    validateBody(TemplateSchema),
    async (req, res) => {
      try {
        const { apiKey, appName, source } = await loadCreds(supabase, (req as any).tenantId)
        const { destination, template_id, params } = req.body as z.infer<typeof TemplateSchema>
        let paramArr: any[] = []
        if (Array.isArray(params)) paramArr = params
        else if (typeof params === 'string' && params.trim()) { try { paramArr = JSON.parse(params) } catch { paramArr = [] } }
        const body = form({
          channel: 'whatsapp', source, destination,
          'src.name': appName,
          template: JSON.stringify({ id: template_id, params: paramArr }),
        })
        const r2 = await fetch(`${GS_BASE}/wa/api/v1/template/msg`, {
          method: 'POST',
          headers: { apikey: apiKey, 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
          body,
        })
        const out = await r2.json().catch(() => ({})) as any
        if (!r2.ok || out?.status === 'error') { res.status(r2.ok ? 400 : r2.status).json({ error: gsErr(r2, out) }); return }
        res.json(out)
      } catch (err: any) { res.status(500).json({ error: err.message }) }
    })

  r.post('/api/connectors/gupshup/opt-in', ...guardEdit,
    validateBody(OptInSchema),
    async (req, res) => {
      try {
        const { apiKey, appName } = await loadCreds(supabase, (req as any).tenantId)
        const { user } = req.body as z.infer<typeof OptInSchema>
        const r2 = await fetch(`${GS_BASE}/sm/api/v1/app/opt/in/${encodeURIComponent(appName)}`, {
          method: 'POST',
          headers: { apikey: apiKey, 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
          body: form({ user }),
        })
        const out = await r2.json().catch(() => ({})) as any
        if (!r2.ok || out?.status === 'error') { res.status(r2.ok ? 400 : r2.status).json({ error: gsErr(r2, out) }); return }
        res.json(out)
      } catch (err: any) { res.status(500).json({ error: err.message }) }
    })

  return r
}

/**
 * Exported so engine/connector-ops.ts can call Gupshup from workflow nodes.
 * Returns the decrypted API key plus the app name + source from metadata.
 */
export async function loadCreds(
  supabase: SupabaseClient, tenantId: string,
): Promise<{ apiKey: string; appName: string; source: string }> {
  const { data: row } = await supabase.from('tenant_integrations')
    .select('access_token, metadata')
    .eq('tenant_id', tenantId).eq('key', 'gupshup').maybeSingle()
  if (!row?.access_token) throw new Error('Gupshup not connected')
  const md = (row.metadata as any) ?? {}
  if (!md.app_name || !md.source) throw new Error('Gupshup connection missing app name/source — please reconnect')
  return { apiKey: decrypt(row.access_token), appName: String(md.app_name), source: String(md.source) }
}
