/**
 * LeadSquared connector — Access Key + Secret Key + region host (India CRM).
 *
 * LeadSquared is a major Indian sales+marketing CRM (education, BFSI, real
 * estate). Auth is two keys passed as query params on every call; the account
 * also has a region-specific API host (e.g. api-in21.leadsquared.com for India).
 * Pure paste-key: My Profile → Settings → API and Webhooks → API Access Keys
 * shows the Host URL + Access Key + Secret Key. No partner agreement.
 *
 * Verify: GET /v2/LeadManagement.svc/LeadsMetaData.Get?accessKey&secretKey is a
 * read-only schema fetch that proves the keys (excludeOptionSets keeps it
 * light). No lead is written during verification.
 *
 * Capabilities (LeadSquared v2):
 *   create_or_update_lead  POST /v2/LeadManagement.svc/Lead.Capture
 *   get_lead_by_email      GET  /v2/LeadManagement.svc/Leads.GetByEmailaddress
 *   post_activity          POST /v2/ProspectActivity.svc/Activity/Create
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

/** Normalize a host the user might paste with a protocol or trailing slash. */
function normHost(h: string): string {
  return h.trim().replace(/^https?:\/\//i, '').replace(/\/+$/, '')
}

const TokenSchema = z.object({
  access_key: z.string().min(8, 'Access Key is required'),
  secret_key: z.string().min(8, 'Secret Key is required'),
  host:       z.string().min(4, 'API Host is required (e.g. api-in21.leadsquared.com)'),
})

const LeadSchema = z.object({
  email:      z.string().email().optional(),
  first_name: z.string().optional(),
  last_name:  z.string().optional(),
  phone:      z.string().optional(),
  company:    z.string().optional(),
  source:     z.string().optional(),
  attributes: z.union([z.array(z.record(z.string(), z.any())), z.string()]).optional(),
  search_by:  z.string().optional(),
}).refine(v => v.email || v.phone || v.attributes, 'Provide at least an email, phone, or attributes array')

const GetLeadSchema = z.object({
  email: z.string().email('a valid email is required'),
}).passthrough()

const ActivitySchema = z.object({
  related_prospect_id: z.string().min(1, 'related_prospect_id (LeadSquared ProspectId) is required'),
  activity_event:      z.union([z.string(), z.number()]).transform(String),
  activity_note:       z.string().optional(),
  fields:              z.union([z.array(z.record(z.string(), z.any())), z.string()]).optional(),
}).passthrough()

function lsErr(r: Response, body: any): string {
  if (r.status === 429) return 'LeadSquared rate limit exceeded — try again in a moment'
  const m = body?.ExceptionMessage || body?.Message || body?.Status
  if (m && body?.Status === 'Error') return String(body?.ExceptionMessage || m)
  if (m) return String(m)
  return `LeadSquared ${r.status}`
}

/** Build the lead attribute array LeadSquared expects from convenience fields. */
function leadAttributes(p: z.infer<typeof LeadSchema>): Array<{ Attribute: string; Value: string }> {
  const out: Array<{ Attribute: string; Value: string }> = []
  const push = (a: string, v?: string) => { if (v != null && v !== '') out.push({ Attribute: a, Value: String(v) }) }
  push('FirstName', p.first_name)
  push('LastName', p.last_name)
  push('EmailAddress', p.email)
  push('Phone', p.phone)
  push('Company', p.company)
  push('Source', p.source)
  let extra: any = p.attributes
  if (typeof extra === 'string' && extra.trim()) { try { extra = JSON.parse(extra) } catch { extra = [] } }
  if (Array.isArray(extra)) for (const a of extra) if (a?.Attribute) out.push({ Attribute: String(a.Attribute), Value: String(a.Value ?? '') })
  return out
}

export function createLeadsquaredConnector(deps: Deps): express.Router {
  const r = express.Router()
  const { supabase, requireAuth, identifyTenant, checkPermission } = deps

  // ── Paste-key connect (read-only metadata verify, then persist) ───────────
  r.post('/api/connectors/leadsquared/connect-key',
    requireAuth, identifyTenant, checkPermission('integrations', 'edit'),
    validateBody(TokenSchema),
    async (req, res) => {
      const tenantId = (req as any).tenantId
      const userId = (req as any).user?.id as string | undefined
      if (!userId) { res.status(401).json({ error: 'auth missing user.id' }); return }

      const { access_key, secret_key } = req.body as z.infer<typeof TokenSchema>
      const host = normHost((req.body as any).host)

      const qs = new URLSearchParams({ accessKey: access_key, secretKey: secret_key, excludeOptionSets: '1' })
      let verify: Response, vbody: any = {}
      try {
        verify = await fetch(`https://${host}/v2/LeadManagement.svc/LeadsMetaData.Get?${qs}`, { headers: { Accept: 'application/json' } })
        vbody = await verify.json().catch(() => ({}))
      } catch (e: any) {
        res.status(400).json({ error: `Could not reach LeadSquared host "${host}" (${e?.message ?? 'network error'}) — confirm the host from API Access Keys.` })
        return
      }
      // LeadSquared signals bad keys via 401 or a JSON error envelope.
      const authBad =
        verify.status === 401 || verify.status === 403 ||
        (vbody?.Status === 'Error' && /key|access|secret|auth/i.test(String(vbody?.ExceptionMessage ?? '')))
      if (authBad) {
        res.status(400).json({ error: `LeadSquared rejected these keys (check Access Key, Secret Key, and that the host "${host}" matches your account region).` })
        return
      }
      if (!verify.ok) {
        res.status(400).json({ error: `LeadSquared verification failed (${verify.status})` })
        return
      }

      const { error: upsertErr } = await supabase.from('tenant_integrations').upsert({
        tenant_id:    tenantId,
        user_id:      userId,
        key:          'leadsquared',
        status:       'active',
        access_token: encrypt(secret_key),
        scope:        'crm',
        brand_label:  `LeadSquared (${host})`,
        metadata:     { auth_mode: 'query_keys', access_key, host },
      }, { onConflict: 'tenant_id,key' })
      if (upsertErr) {
        console.error(`[leadsquared connect] DB upsert failed: ${upsertErr.message}`)
        res.status(500).json({ error: 'Failed to persist connection: ' + upsertErr.message }); return
      }
      res.json({ success: true, host })
    })

  // ── Capabilities ──────────────────────────────────────────────────────────
  const guardView = [requireAuth, identifyTenant, checkPermission('integrations', 'view')]
  const guardEdit = [requireAuth, identifyTenant, checkPermission('integrations', 'edit')]

  r.post('/api/connectors/leadsquared/lead', ...guardEdit,
    validateBody(LeadSchema),
    async (req, res) => {
      try {
        const { accessKey, secretKey, host } = await loadCreds(supabase, (req as any).tenantId)
        const p = req.body as z.infer<typeof LeadSchema>
        const qs = new URLSearchParams({ accessKey, secretKey })
        if (p.search_by) qs.set('SearchBy', p.search_by)
        else if (p.email) qs.set('SearchBy', 'EmailAddress')
        const r2 = await fetch(`https://${host}/v2/LeadManagement.svc/Lead.Capture?${qs}`, {
          method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify(leadAttributes(p)),
        })
        const out = await r2.json().catch(() => ({})) as any
        if (!r2.ok || out?.Status === 'Error') { res.status(r2.ok ? 400 : r2.status).json({ error: lsErr(r2, out) }); return }
        res.json(out)
      } catch (err: any) { res.status(500).json({ error: err.message }) }
    })

  r.get('/api/connectors/leadsquared/lead', ...guardView,
    async (req, res) => {
      try {
        const { accessKey, secretKey, host } = await loadCreds(supabase, (req as any).tenantId)
        const email = String(req.query.email ?? '')
        if (!email) { res.status(400).json({ error: 'email query param is required' }); return }
        const qs = new URLSearchParams({ accessKey, secretKey, emailaddress: email })
        const r2 = await fetch(`https://${host}/v2/LeadManagement.svc/Leads.GetByEmailaddress?${qs}`, { headers: { Accept: 'application/json' } })
        const out = await r2.json().catch(() => ({})) as any
        if (!r2.ok || out?.Status === 'Error') { res.status(r2.ok ? 400 : r2.status).json({ error: lsErr(r2, out) }); return }
        res.json(out)
      } catch (err: any) { res.status(500).json({ error: err.message }) }
    })

  r.post('/api/connectors/leadsquared/activity', ...guardEdit,
    validateBody(ActivitySchema),
    async (req, res) => {
      try {
        const { accessKey, secretKey, host } = await loadCreds(supabase, (req as any).tenantId)
        const p = req.body as z.infer<typeof ActivitySchema>
        let fields: any = p.fields
        if (typeof fields === 'string' && fields.trim()) { try { fields = JSON.parse(fields) } catch { fields = [] } }
        const payload: Record<string, any> = {
          RelatedProspectId: p.related_prospect_id,
          ActivityEvent: Number(p.activity_event),
          ActivityNote: p.activity_note ?? '',
        }
        if (Array.isArray(fields)) payload.Fields = fields
        const qs = new URLSearchParams({ accessKey, secretKey })
        const r2 = await fetch(`https://${host}/v2/ProspectActivity.svc/Activity/Create?${qs}`, {
          method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify(payload),
        })
        const out = await r2.json().catch(() => ({})) as any
        if (!r2.ok || out?.Status === 'Error') { res.status(r2.ok ? 400 : r2.status).json({ error: lsErr(r2, out) }); return }
        res.json(out)
      } catch (err: any) { res.status(500).json({ error: err.message }) }
    })

  return r
}

/**
 * Exported so engine/connector-ops.ts can call LeadSquared from workflow nodes.
 * Returns the access key, decrypted secret key, and the region host.
 */
export async function loadCreds(
  supabase: SupabaseClient, tenantId: string,
): Promise<{ accessKey: string; secretKey: string; host: string }> {
  const { data: row } = await supabase.from('tenant_integrations')
    .select('access_token, metadata')
    .eq('tenant_id', tenantId).eq('key', 'leadsquared').maybeSingle()
  if (!row?.access_token) throw new Error('LeadSquared not connected')
  const md = (row.metadata as any) ?? {}
  if (!md.access_key || !md.host) throw new Error('LeadSquared connection missing access key/host — please reconnect')
  return { accessKey: String(md.access_key), secretKey: decrypt(row.access_token), host: String(md.host) }
}

export { leadAttributes }
