/**
 * IndiaMART connector — single CRM key (India's #1 B2B lead marketplace).
 *
 * IndiaMART's Lead Manager "Pull API" (CRM Integration v2) lets a seller fetch
 * the buy-leads / enquiries / PNS calls that landed on their IndiaMART account,
 * as JSON, using a single key. Pure paste-key: the seller generates the key at
 *   https://seller.indiamart.com/leadmanager/crmapi
 * (Lead Manager → CRM API). No partner agreement — every paid seller has it.
 *
 * Endpoint: GET https://mapi.indiamart.com/wservce/crm/crmListing/v2/?glusr_crm_key=KEY
 *   • optional start_time / end_time (DD-Mon-YYYY) window; omitted = last 24h.
 *   • Response: { CODE, STATUS, MESSAGE, TOTAL_RECORDS, RESPONSE: [ ...leads ] }
 *
 * Verify: the same GET with the pasted key. A bad key returns
 *   { CODE: 401, STATUS: "FAILURE", MESSAGE: "CRM key ... is incorrect" }.
 *   CODE 200 = valid. CODE 429 = rate-limited but the key WAS recognized (the
 *   5-min-gap throttle only fires for known keys), so we accept that too.
 * No lead is written during verification — it is a read-only pull.
 *
 * Capability: fetch_leads — pull recent leads (optionally a date window).
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

const IM_BASE = 'https://mapi.indiamart.com/wservce/crm/crmListing/v2/'

const TokenSchema = z.object({
  crm_key: z.string().min(12, 'Your IndiaMART CRM key is required'),
})

const FetchSchema = z.object({
  start_time: z.string().optional(),
  end_time:   z.string().optional(),
}).passthrough()

/** Build the pull URL with the key and an optional date window. */
function pullUrl(key: string, startTime?: string, endTime?: string): string {
  const qs = new URLSearchParams({ glusr_crm_key: key })
  if (startTime) qs.set('start_time', startTime)
  if (endTime)   qs.set('end_time', endTime)
  return `${IM_BASE}?${qs}`
}

/** IndiaMART signals a bad key via CODE 401 / STATUS FAILURE. */
function imRejected(body: any): boolean {
  return body?.CODE === 401 || body?.STATUS === 'FAILURE'
}

function imMessage(body: any, httpStatus: number): string {
  return String(body?.MESSAGE || body?.STATUS || `IndiaMART ${httpStatus}`)
}

export function createIndiamartConnector(deps: Deps): express.Router {
  const r = express.Router()
  const { supabase, requireAuth, identifyTenant, checkPermission } = deps

  // ── Paste-key connect (read-only pull verify, then persist) ───────────────
  r.post('/api/connectors/indiamart/connect-key',
    requireAuth, identifyTenant, checkPermission('integrations', 'edit'),
    validateBody(TokenSchema),
    async (req, res) => {
      const tenantId = (req as any).tenantId
      const userId = (req as any).user?.id as string | undefined
      if (!userId) { res.status(401).json({ error: 'auth missing user.id' }); return }

      const { crm_key } = req.body as z.infer<typeof TokenSchema>

      let verify: Response, vbody: any = {}
      try {
        verify = await fetch(pullUrl(crm_key), { headers: { Accept: 'application/json' } })
        vbody = await verify.json().catch(() => ({}))
      } catch (e: any) {
        res.status(400).json({ error: `Could not reach IndiaMART (${e?.message ?? 'network error'}) — try again in a moment.` })
        return
      }
      // 429 = throttled but the key was recognized (5-min-gap rule only applies
      // to valid keys), so treat it as a successful proof-of-key.
      const okKey = verify.status === 429 || (verify.ok && !imRejected(vbody))
      if (!okKey) {
        res.status(400).json({ error: imRejected(vbody)
          ? 'IndiaMART rejected this CRM key (incorrect). Copy it again from Lead Manager → CRM API.'
          : imMessage(vbody, verify.status) })
        return
      }

      const { error: upsertErr } = await supabase.from('tenant_integrations').upsert({
        tenant_id:    tenantId,
        user_id:      userId,
        key:          'indiamart',
        status:       'active',
        access_token: encrypt(crm_key),
        scope:        'lead_gen',
        brand_label:  'IndiaMART',
        metadata:     { auth_mode: 'crm_key' },
      }, { onConflict: 'tenant_id,key' })
      if (upsertErr) {
        console.error(`[indiamart connect] DB upsert failed: ${upsertErr.message}`)
        res.status(500).json({ error: 'Failed to persist connection: ' + upsertErr.message }); return
      }
      res.json({ success: true })
    })

  // ── Capability: fetch recent leads ────────────────────────────────────────
  const guardView = [requireAuth, identifyTenant, checkPermission('integrations', 'view')]

  r.get('/api/connectors/indiamart/leads', ...guardView,
    async (req, res) => {
      try {
        const key = await loadKey(supabase, (req as any).tenantId)
        const startTime = req.query.start_time ? String(req.query.start_time) : undefined
        const endTime   = req.query.end_time ? String(req.query.end_time) : undefined
        const r2 = await fetch(pullUrl(key, startTime, endTime), { headers: { Accept: 'application/json' } })
        const out = await r2.json().catch(() => ({})) as any
        if (!r2.ok || imRejected(out)) { res.status(r2.ok ? 400 : r2.status).json({ error: imMessage(out, r2.status) }); return }
        res.json(out)
      } catch (err: any) { res.status(500).json({ error: err.message }) }
    })

  // Also accept POST (workflow nodes pass a body with the date window).
  r.post('/api/connectors/indiamart/leads', requireAuth, identifyTenant, checkPermission('integrations', 'view'),
    validateBody(FetchSchema),
    async (req, res) => {
      try {
        const key = await loadKey(supabase, (req as any).tenantId)
        const p = req.body as z.infer<typeof FetchSchema>
        const r2 = await fetch(pullUrl(key, p.start_time, p.end_time), { headers: { Accept: 'application/json' } })
        const out = await r2.json().catch(() => ({})) as any
        if (!r2.ok || imRejected(out)) { res.status(r2.ok ? 400 : r2.status).json({ error: imMessage(out, r2.status) }); return }
        res.json(out)
      } catch (err: any) { res.status(500).json({ error: err.message }) }
    })

  return r
}

/**
 * Exported so engine/connector-ops.ts can pull IndiaMART leads from workflow
 * nodes. Returns the decrypted CRM key.
 */
export async function loadKey(supabase: SupabaseClient, tenantId: string): Promise<string> {
  const { data: row } = await supabase.from('tenant_integrations')
    .select('access_token')
    .eq('tenant_id', tenantId).eq('key', 'indiamart').maybeSingle()
  if (!row?.access_token) throw new Error('IndiaMART not connected')
  return decrypt(row.access_token)
}

export { IM_BASE, pullUrl, imRejected, imMessage }
