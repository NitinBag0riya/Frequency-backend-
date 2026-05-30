/**
 * Exotel connector — API key + token + account SID (India cloud telephony).
 *
 * Exotel is the leading Indian cloud-telephony / IVR provider. SMBs use it to
 * connect agents↔customers over masked numbers, run IVRs, and send SMS. Pure
 * paste-key: from the Exotel dashboard (Settings → API Settings) a tenant copies
 * their API Key, API Token, and Account SID. No partner agreement needed.
 *
 * Auth: HTTP Basic — base64(api_key:api_token) — on every call.
 * Region: Indian accounts live on api.in.exotel.com (Mumbai); the older
 * Singapore cluster is api.exotel.com. The tenant picks region on connect.
 *
 * Verify: GET /v1/Accounts/{sid}.json (account details) is a read-only call
 * that proves the key/token/sid triple — 200 valid, 401 invalid. No call/SMS
 * is placed during verification.
 *
 * Capabilities (Exotel v1):
 *   make_call          POST /v1/Accounts/{sid}/Calls/connect       (connect From↔To)
 *   send_sms           POST /v1/Accounts/{sid}/Sms/send.json
 *   get_call_details   GET  /v1/Accounts/{sid}/Calls/{call_sid}.json
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

const EXO_BASE: Record<'in' | 'sg', string> = {
  in: 'https://api.in.exotel.com',
  sg: 'https://api.exotel.com',
}

const TokenSchema = z.object({
  api_key:     z.string().min(4, 'API Key is required (Exotel → Settings → API Settings)'),
  api_token:   z.string().min(4, 'API Token is required'),
  account_sid: z.string().min(2, 'Account SID is required'),
  region:      z.enum(['in', 'sg']).default('in'),
})

const CallSchema = z.object({
  from:      z.string().min(6, 'from (agent number, E.164) is required'),
  to:        z.string().min(6, 'to (customer number, E.164) is required'),
  caller_id: z.string().min(4, 'caller_id (your ExoPhone / virtual number) is required'),
}).passthrough()

const SmsSchema = z.object({
  to:   z.string().min(6, 'to (E.164) is required'),
  body: z.string().min(1, 'body is required'),
  from: z.string().optional(),
}).passthrough()

function basic(apiKey: string, apiToken: string): string {
  return 'Basic ' + Buffer.from(`${apiKey}:${apiToken}`).toString('base64')
}

function exoErr(r: Response, body: any): string {
  if (r.status === 429) return 'Exotel rate limit exceeded — try again in a moment'
  const m = body?.RestException?.Message || body?.Message || body?.message
  if (m) return String(m)
  return `Exotel ${r.status}`
}

export function createExotelConnector(deps: Deps): express.Router {
  const r = express.Router()
  const { supabase, requireAuth, identifyTenant, checkPermission } = deps

  // ── Paste-key connect (read-only verify, then persist) ────────────────────
  r.post('/api/connectors/exotel/connect-key',
    requireAuth, identifyTenant, checkPermission('integrations', 'edit'),
    validateBody(TokenSchema),
    async (req, res) => {
      const tenantId = (req as any).tenantId
      const userId = (req as any).user?.id as string | undefined
      if (!userId) { res.status(401).json({ error: 'auth missing user.id' }); return }

      const { api_key, api_token, account_sid, region } = req.body as z.infer<typeof TokenSchema>
      const base = EXO_BASE[region]

      let verify: Response
      try {
        verify = await fetch(`${base}/v1/Accounts/${encodeURIComponent(account_sid)}.json`, {
          headers: { Authorization: basic(api_key, api_token), Accept: 'application/json' },
        })
      } catch (e: any) {
        res.status(400).json({ error: `Could not reach Exotel (${e?.message ?? 'network error'})` })
        return
      }
      if (verify.status === 401 || verify.status === 403) {
        res.status(400).json({ error: 'Exotel rejected these credentials (check API Key, Token, and Account SID).' })
        return
      }
      if (verify.status === 404) {
        res.status(400).json({ error: `Account SID "${account_sid}" not found in the ${region === 'in' ? 'Mumbai' : 'Singapore'} region — try the other region.` })
        return
      }
      if (!verify.ok) {
        res.status(400).json({ error: `Exotel verification failed (${verify.status})` })
        return
      }

      const { error: upsertErr } = await supabase.from('tenant_integrations').upsert({
        tenant_id:    tenantId,
        user_id:      userId,
        key:          'exotel',
        status:       'active',
        access_token: encrypt(api_token),
        scope:        'telephony',
        brand_label:  `Exotel (${account_sid})`,
        metadata:     { auth_mode: 'basic', api_key, account_sid, region },
      }, { onConflict: 'tenant_id,key' })
      if (upsertErr) {
        console.error(`[exotel connect] DB upsert failed: ${upsertErr.message}`)
        res.status(500).json({ error: 'Failed to persist connection: ' + upsertErr.message }); return
      }
      res.json({ success: true, account_sid })
    })

  // ── Capabilities ──────────────────────────────────────────────────────────
  const guardView = [requireAuth, identifyTenant, checkPermission('integrations', 'view')]
  const guardEdit = [requireAuth, identifyTenant, checkPermission('integrations', 'edit')]

  r.post('/api/connectors/exotel/call', ...guardEdit,
    validateBody(CallSchema),
    async (req, res) => {
      try {
        const { authHeader, base, sid } = await loadCreds(supabase, (req as any).tenantId)
        const { from, to, caller_id, ...rest } = req.body as z.infer<typeof CallSchema>
        const body = new URLSearchParams({ From: from, To: to, CallerId: caller_id, ...stringMap(rest) }).toString()
        const r2 = await fetch(`${base}/v1/Accounts/${encodeURIComponent(sid)}/Calls/connect.json`, {
          method: 'POST', headers: { Authorization: authHeader, 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' }, body,
        })
        const out = await r2.json().catch(() => ({})) as any
        if (!r2.ok) { res.status(r2.status).json({ error: exoErr(r2, out) }); return }
        res.json(out)
      } catch (err: any) { res.status(500).json({ error: err.message }) }
    })

  r.post('/api/connectors/exotel/sms', ...guardEdit,
    validateBody(SmsSchema),
    async (req, res) => {
      try {
        const { authHeader, base, sid } = await loadCreds(supabase, (req as any).tenantId)
        const { to, body: text, from, ...rest } = req.body as z.infer<typeof SmsSchema>
        const params: Record<string, string> = { To: to, Body: text, ...stringMap(rest) }
        if (from) params.From = from
        const r2 = await fetch(`${base}/v1/Accounts/${encodeURIComponent(sid)}/Sms/send.json`, {
          method: 'POST', headers: { Authorization: authHeader, 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
          body: new URLSearchParams(params).toString(),
        })
        const out = await r2.json().catch(() => ({})) as any
        if (!r2.ok) { res.status(r2.status).json({ error: exoErr(r2, out) }); return }
        res.json(out)
      } catch (err: any) { res.status(500).json({ error: err.message }) }
    })

  r.get('/api/connectors/exotel/call/:call_sid', ...guardView, async (req, res) => {
    try {
      const { authHeader, base, sid } = await loadCreds(supabase, (req as any).tenantId)
      const callSid = encodeURIComponent(String(req.params.call_sid))
      const r2 = await fetch(`${base}/v1/Accounts/${encodeURIComponent(sid)}/Calls/${callSid}.json`, {
        headers: { Authorization: authHeader, Accept: 'application/json' },
      })
      const out = await r2.json().catch(() => ({})) as any
      if (!r2.ok) { res.status(r2.status).json({ error: exoErr(r2, out) }); return }
      res.json(out)
    } catch (err: any) { res.status(500).json({ error: err.message }) }
  })

  return r
}

/** Coerce a loose object's values to strings for URLSearchParams. */
function stringMap(obj: Record<string, any>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(obj)) if (v != null) out[k] = String(v)
  return out
}

/**
 * Exported so engine/connector-ops.ts can call Exotel from workflow nodes.
 * Returns the Basic auth header, the region base URL, and the account SID.
 */
export async function loadCreds(
  supabase: SupabaseClient, tenantId: string,
): Promise<{ authHeader: string; base: string; sid: string }> {
  const { data: row } = await supabase.from('tenant_integrations')
    .select('access_token, metadata')
    .eq('tenant_id', tenantId).eq('key', 'exotel').maybeSingle()
  if (!row?.access_token) throw new Error('Exotel not connected')
  const md = (row.metadata as any) ?? {}
  if (!md.api_key || !md.account_sid) throw new Error('Exotel connection missing api_key/account_sid — please reconnect')
  const region: 'in' | 'sg' = md.region === 'sg' ? 'sg' : 'in'
  return { authHeader: basic(String(md.api_key), decrypt(row.access_token)), base: EXO_BASE[region], sid: String(md.account_sid) }
}
