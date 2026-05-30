/**
 * TradeIndia connector — userid + profile_id + key (India B2B marketplace).
 *
 * TradeIndia's "My Inquiry API" lets a seller pull the inquiries/leads that
 * landed on their TradeIndia account as JSON. Three credentials, all visible at
 *   TradeIndia → (account name) → Inquiries & Contacts → My Inquiry API
 * which shows the API Link, user id, profile_id and key. Self-serve, no partner
 * agreement.
 *
 * Endpoint: GET https://www.tradeindia.com/utils/my_inquiry.html
 *   ?userid=&profile_id=&key=&from_date=YYYY-MM-DD&to_date=YYYY-MM-DD
 *   • Returns a JSON array of inquiries (or a message string when empty/errored).
 *
 * Verify: a real GET over a recent date window. The endpoint returns the JSON
 * string "Sorry! Please provide all the required parameters." when a parameter
 * is missing — so a structurally-complete call that does NOT return that error
 * (and is not an explicit invalid-credentials message) proves the three
 * credentials are wired correctly. The first real lead pull is the final proof;
 * we never write a lead during verification.
 *
 * Capability: fetch_leads — pull inquiries for a date window (default last 7d).
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

const TI_BASE = 'https://www.tradeindia.com/utils/my_inquiry.html'

const TokenSchema = z.object({
  userid:     z.string().min(1, 'User ID is required'),
  profile_id: z.string().min(1, 'Profile ID is required'),
  key:        z.string().min(6, 'API key is required'),
})

const FetchSchema = z.object({
  from_date: z.string().optional(),
  to_date:   z.string().optional(),
}).passthrough()

/** YYYY-MM-DD for a Date (TradeIndia accepts this format). */
function ymd(d: Date): string { return d.toISOString().slice(0, 10) }

/** Build the inquiry-pull URL. Defaults to the last `days` days when no window. */
function pullUrl(c: { userid: string; profile_id: string; key: string }, fromDate?: string, toDate?: string, days = 7): string {
  const to = toDate || ymd(new Date())
  const from = fromDate || ymd(new Date(Date.now() - days * 86400_000))
  const qs = new URLSearchParams({ userid: c.userid, profile_id: c.profile_id, key: c.key, from_date: from, to_date: to })
  return `${TI_BASE}?${qs}`
}

/** The known "missing parameters" guard message from TradeIndia. */
function tiMissingParams(body: any): boolean {
  return typeof body === 'string' && /provide all the required parameters/i.test(body)
}

/** Heuristic: an explicit invalid-credentials style message (string response). */
function tiInvalidCreds(body: any): boolean {
  return typeof body === 'string' && /(invalid|incorrect|unauthor|not\s*valid).*(key|user|profile|credential)/i.test(body)
}

export function createTradeindiaConnector(deps: Deps): express.Router {
  const r = express.Router()
  const { supabase, requireAuth, identifyTenant, checkPermission } = deps

  // ── Paste-key connect (read-only inquiry pull verify, then persist) ───────
  r.post('/api/connectors/tradeindia/connect-key',
    requireAuth, identifyTenant, checkPermission('integrations', 'edit'),
    validateBody(TokenSchema),
    async (req, res) => {
      const tenantId = (req as any).tenantId
      const userId = (req as any).user?.id as string | undefined
      if (!userId) { res.status(401).json({ error: 'auth missing user.id' }); return }

      const c = req.body as z.infer<typeof TokenSchema>

      let verify: Response, vbody: any = null
      try {
        verify = await fetch(pullUrl(c), { headers: { Accept: 'application/json' } })
        vbody = await verify.json().catch(() => null)
      } catch (e: any) {
        res.status(400).json({ error: `Could not reach TradeIndia (${e?.message ?? 'network error'}) — try again in a moment.` })
        return
      }
      if (!verify.ok) { res.status(400).json({ error: `TradeIndia verification failed (${verify.status})` }); return }
      if (tiMissingParams(vbody)) {
        res.status(400).json({ error: 'TradeIndia could not read these credentials — re-check User ID, Profile ID, and Key from Inquiries & Contacts → My Inquiry API.' })
        return
      }
      if (tiInvalidCreds(vbody)) {
        res.status(400).json({ error: 'TradeIndia rejected these credentials. Copy them again from My Inquiry API.' })
        return
      }
      // A JSON array of inquiries, an empty array, or a non-error message all
      // mean the credentials were accepted structurally. The next fetch is the
      // final proof; nothing is written here.

      const { error: upsertErr } = await supabase.from('tenant_integrations').upsert({
        tenant_id:    tenantId,
        user_id:      userId,
        key:          'tradeindia',
        status:       'active',
        access_token: encrypt(c.key),
        scope:        'lead_gen',
        brand_label:  'TradeIndia',
        metadata:     { auth_mode: 'inquiry_api', userid: c.userid, profile_id: c.profile_id },
      }, { onConflict: 'tenant_id,key' })
      if (upsertErr) {
        console.error(`[tradeindia connect] DB upsert failed: ${upsertErr.message}`)
        res.status(500).json({ error: 'Failed to persist connection: ' + upsertErr.message }); return
      }
      res.json({ success: true })
    })

  // ── Capability: fetch inquiries ───────────────────────────────────────────
  const guardView = [requireAuth, identifyTenant, checkPermission('integrations', 'view')]

  r.get('/api/connectors/tradeindia/leads', ...guardView,
    async (req, res) => {
      try {
        const c = await loadCreds(supabase, (req as any).tenantId)
        const fromDate = req.query.from_date ? String(req.query.from_date) : undefined
        const toDate   = req.query.to_date ? String(req.query.to_date) : undefined
        const r2 = await fetch(pullUrl(c, fromDate, toDate), { headers: { Accept: 'application/json' } })
        const out = await r2.json().catch(() => null) as any
        if (!r2.ok) { res.status(r2.status).json({ error: `TradeIndia ${r2.status}` }); return }
        if (tiMissingParams(out) || tiInvalidCreds(out)) { res.status(400).json({ error: String(out) }); return }
        res.json({ inquiries: out })
      } catch (err: any) { res.status(500).json({ error: err.message }) }
    })

  r.post('/api/connectors/tradeindia/leads', requireAuth, identifyTenant, checkPermission('integrations', 'view'),
    validateBody(FetchSchema),
    async (req, res) => {
      try {
        const c = await loadCreds(supabase, (req as any).tenantId)
        const p = req.body as z.infer<typeof FetchSchema>
        const r2 = await fetch(pullUrl(c, p.from_date, p.to_date), { headers: { Accept: 'application/json' } })
        const out = await r2.json().catch(() => null) as any
        if (!r2.ok) { res.status(r2.status).json({ error: `TradeIndia ${r2.status}` }); return }
        if (tiMissingParams(out) || tiInvalidCreds(out)) { res.status(400).json({ error: String(out) }); return }
        res.json({ inquiries: out })
      } catch (err: any) { res.status(500).json({ error: err.message }) }
    })

  return r
}

/**
 * Exported so engine/connector-ops.ts can pull TradeIndia inquiries from
 * workflow nodes. Returns userid, profile_id and the decrypted key.
 */
export async function loadCreds(
  supabase: SupabaseClient, tenantId: string,
): Promise<{ userid: string; profile_id: string; key: string }> {
  const { data: row } = await supabase.from('tenant_integrations')
    .select('access_token, metadata')
    .eq('tenant_id', tenantId).eq('key', 'tradeindia').maybeSingle()
  if (!row?.access_token) throw new Error('TradeIndia not connected')
  const md = (row.metadata as any) ?? {}
  if (!md.userid || !md.profile_id) throw new Error('TradeIndia connection missing userid/profile_id — please reconnect')
  return { userid: String(md.userid), profile_id: String(md.profile_id), key: decrypt(row.access_token) }
}

export { TI_BASE, pullUrl, tiMissingParams, tiInvalidCreds }
