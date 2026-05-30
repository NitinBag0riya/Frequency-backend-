/**
 * Kylas connector — single API key (India SMB sales CRM).
 *
 * Kylas (kylas.io) is an India-built sales CRM aimed at SMBs. Auth is a single
 * API key passed in the `api-key` header on every call. Pure paste-key: the key
 * lives under Settings → Integrations → API Key (Explore/Elevate plans).
 *
 * Verify: GET /v1/users/me is a read-only "who am I" call that proves the key.
 *   • 200            → key valid (we persist)
 *   • 400 code 001079→ "Invalid API key" (rejected)
 *   • 401/403        → bad/forbidden key (rejected)
 * No record is written during verification.
 *
 * Capabilities (Kylas v1):
 *   create_lead     POST /v1/leads
 *   create_contact  POST /v1/contacts
 *   create_deal     POST /v1/deals
 *   search_leads    POST /v1/search/lead
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

const KYLAS_BASE = 'https://api.kylas.io'

const TokenSchema = z.object({
  api_key: z.string().min(16, 'A valid Kylas API key is required'),
})

const LeadSchema = z.object({
  first_name:   z.string().min(1, 'first_name is required'),
  last_name:    z.string().optional(),
  email:        z.string().email().optional(),
  phone:        z.string().optional(),
  dial_code:    z.string().optional(),
  company_name: z.string().optional(),
  fields:       z.union([z.record(z.string(), z.any()), z.string()]).optional(),
}).passthrough()

const ContactSchema = z.object({
  first_name:   z.string().min(1, 'first_name is required'),
  last_name:    z.string().optional(),
  email:        z.string().email().optional(),
  phone:        z.string().optional(),
  dial_code:    z.string().optional(),
  company_name: z.string().optional(),
  fields:       z.union([z.record(z.string(), z.any()), z.string()]).optional(),
}).passthrough()

const DealSchema = z.object({
  name:   z.string().min(1, 'Deal name is required'),
  fields: z.union([z.record(z.string(), z.any()), z.string()]).optional(),
}).passthrough()

const SearchSchema = z.object({
  email:  z.string().email().optional(),
  phone:  z.string().optional(),
  fields: z.union([z.array(z.string()), z.string()]).optional(),
  rule:   z.union([z.record(z.string(), z.any()), z.string()]).optional(),
}).passthrough()

function kylasErr(r: Response, body: any): string {
  if (r.status === 429) return 'Kylas rate limit exceeded — try again in a moment'
  if (body?.code === '001079') return 'Invalid Kylas API key'
  const fe = Array.isArray(body?.fieldErrors) && body.fieldErrors.length
    ? body.fieldErrors.map((f: any) => `${f.field ?? ''} ${f.message ?? ''}`.trim()).join('; ')
    : ''
  const m = body?.message || fe
  return m ? String(m) : `Kylas ${r.status}`
}

/** JSON-parse a value that may already be an object or a JSON string. */
function asObject(v: any): Record<string, any> {
  if (v && typeof v === 'object' && !Array.isArray(v)) return v
  if (typeof v === 'string' && v.trim()) { try { const p = JSON.parse(v); return p && typeof p === 'object' ? p : {} } catch { return {} } }
  return {}
}

/**
 * Build a Kylas person payload (leads + contacts share this shape) from the
 * convenience fields, then merge any raw `fields` object on top.
 */
function personPayload(p: {
  first_name: string; last_name?: string; email?: string; phone?: string;
  dial_code?: string; company_name?: string; fields?: any;
}): Record<string, any> {
  const out: Record<string, any> = { firstName: p.first_name }
  if (p.last_name) out.lastName = p.last_name
  if (p.company_name) out.companyName = p.company_name
  if (p.email) out.emails = [{ type: 'OFFICE', value: p.email, primary: true }]
  if (p.phone) out.phoneNumbers = [{ type: 'MOBILE', value: p.phone, dialCode: p.dial_code || '+91', primary: true }]
  return { ...out, ...asObject(p.fields) }
}

/** Build the Kylas /v1/search/lead body from convenience filters. */
function searchPayload(p: z.infer<typeof SearchSchema>): Record<string, any> {
  let fields: string[] = ['id', 'firstName', 'lastName', 'emails', 'phoneNumbers']
  if (Array.isArray(p.fields)) fields = p.fields
  else if (typeof p.fields === 'string' && p.fields.trim()) { try { const f = JSON.parse(p.fields); if (Array.isArray(f)) fields = f } catch { /* keep default */ } }

  const rawRule = asObject(p.rule)
  if (Object.keys(rawRule).length) return { fields, jsonRule: rawRule }

  const rules: any[] = []
  if (p.email) rules.push({ id: 'email', field: 'email', operator: 'equal', value: p.email, type: 'string' })
  if (p.phone) rules.push({ id: 'phone', field: 'phone', operator: 'equal', value: p.phone, type: 'string' })
  return { fields, jsonRule: { condition: 'AND', rules, valid: true } }
}

export function createKylasConnector(deps: Deps): express.Router {
  const r = express.Router()
  const { supabase, requireAuth, identifyTenant, checkPermission } = deps

  // ── Paste-key connect (read-only /users/me verify, then persist) ──────────
  r.post('/api/connectors/kylas/connect-key',
    requireAuth, identifyTenant, checkPermission('integrations', 'edit'),
    validateBody(TokenSchema),
    async (req, res) => {
      const tenantId = (req as any).tenantId
      const userId = (req as any).user?.id as string | undefined
      if (!userId) { res.status(401).json({ error: 'auth missing user.id' }); return }

      const { api_key } = req.body as z.infer<typeof TokenSchema>

      let verify: Response, vbody: any = {}
      try {
        verify = await fetch(`${KYLAS_BASE}/v1/users/me`, { headers: { Accept: 'application/json', 'api-key': api_key } })
        vbody = await verify.json().catch(() => ({}))
      } catch (e: any) {
        res.status(400).json({ error: `Could not reach Kylas (${e?.message ?? 'network error'}) — try again in a moment.` })
        return
      }
      if (verify.status === 400 && vbody?.code === '001079') {
        res.status(400).json({ error: 'Kylas rejected this API key (Invalid API key). Copy it again from Settings → Integrations → API Key.' })
        return
      }
      if (verify.status === 401 || verify.status === 403) {
        res.status(400).json({ error: 'Kylas rejected this API key — check that it is active and your plan (Explore/Elevate) includes API access.' })
        return
      }
      if (!verify.ok) {
        res.status(400).json({ error: kylasErr(verify, vbody) })
        return
      }

      const label = vbody?.tenantName || vbody?.name || (vbody?.firstName ? `${vbody.firstName} ${vbody.lastName ?? ''}`.trim() : '')
      const { error: upsertErr } = await supabase.from('tenant_integrations').upsert({
        tenant_id:    tenantId,
        user_id:      userId,
        key:          'kylas',
        status:       'active',
        access_token: encrypt(api_key),
        scope:        'crm',
        brand_label:  label ? `Kylas (${label})` : 'Kylas',
        metadata:     { auth_mode: 'api_key' },
      }, { onConflict: 'tenant_id,key' })
      if (upsertErr) {
        console.error(`[kylas connect] DB upsert failed: ${upsertErr.message}`)
        res.status(500).json({ error: 'Failed to persist connection: ' + upsertErr.message }); return
      }
      res.json({ success: true, account: label || undefined })
    })

  // ── Capabilities ──────────────────────────────────────────────────────────
  const guardView = [requireAuth, identifyTenant, checkPermission('integrations', 'view')]
  const guardEdit = [requireAuth, identifyTenant, checkPermission('integrations', 'edit')]

  r.post('/api/connectors/kylas/lead', ...guardEdit,
    validateBody(LeadSchema),
    async (req, res) => {
      try {
        const apiKey = await loadKey(supabase, (req as any).tenantId)
        const out = await kylasPost(apiKey, '/v1/leads', personPayload(req.body as any))
        res.json(out.body)
      } catch (err: any) { sendErr(res, err) }
    })

  r.post('/api/connectors/kylas/contact', ...guardEdit,
    validateBody(ContactSchema),
    async (req, res) => {
      try {
        const apiKey = await loadKey(supabase, (req as any).tenantId)
        const out = await kylasPost(apiKey, '/v1/contacts', personPayload(req.body as any))
        res.json(out.body)
      } catch (err: any) { sendErr(res, err) }
    })

  r.post('/api/connectors/kylas/deal', ...guardEdit,
    validateBody(DealSchema),
    async (req, res) => {
      try {
        const apiKey = await loadKey(supabase, (req as any).tenantId)
        const p = req.body as z.infer<typeof DealSchema>
        const out = await kylasPost(apiKey, '/v1/deals', { name: p.name, ...asObject(p.fields) })
        res.json(out.body)
      } catch (err: any) { sendErr(res, err) }
    })

  r.post('/api/connectors/kylas/search-leads', ...guardView,
    validateBody(SearchSchema),
    async (req, res) => {
      try {
        const apiKey = await loadKey(supabase, (req as any).tenantId)
        const out = await kylasPost(apiKey, '/v1/search/lead', searchPayload(req.body as any))
        res.json(out.body)
      } catch (err: any) { sendErr(res, err) }
    })

  return r
}

function sendErr(res: express.Response, err: any) {
  if (err?.kylasStatus) { res.status(err.kylasStatus).json({ error: err.message }); return }
  res.status(500).json({ error: err?.message ?? 'Kylas error' })
}

/** POST helper that throws a status-bearing error on non-2xx for the routes. */
async function kylasPost(apiKey: string, path: string, body: any): Promise<{ body: any }> {
  const r2 = await fetch(`${KYLAS_BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'api-key': apiKey },
    body: JSON.stringify(body),
  })
  const out = await r2.json().catch(() => ({})) as any
  if (!r2.ok) { const e: any = new Error(kylasErr(r2, out)); e.kylasStatus = r2.status; throw e }
  return { body: out }
}

/**
 * Exported so engine/connector-ops.ts can call Kylas from workflow nodes.
 * Returns the decrypted API key.
 */
export async function loadKey(supabase: SupabaseClient, tenantId: string): Promise<string> {
  const { data: row } = await supabase.from('tenant_integrations')
    .select('access_token')
    .eq('tenant_id', tenantId).eq('key', 'kylas').maybeSingle()
  if (!row?.access_token) throw new Error('Kylas not connected')
  return decrypt(row.access_token)
}

export { KYLAS_BASE, personPayload, searchPayload, asObject, kylasErr }
