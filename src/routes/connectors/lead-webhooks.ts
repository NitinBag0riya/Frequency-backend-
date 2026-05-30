/**
 * Inbound lead-webhook connectors — JustDial, MagicBricks, 99acres, Housing,
 * Quikr, Sulekha, Facebook Lead Ads.
 *
 * These portals do NOT expose a self-serve "pull" API to arbitrary third
 * parties (unlike IndiaMART / TradeIndia). Their leads are *pushed* — the
 * seller configures the portal (or an aggregator / Zapier-style relay / the
 * portal's own webhook field) to POST each new lead to a URL. So the honest,
 * real integration is an INBOUND webhook: we mint a unique per-tenant URL, the
 * user pastes it into the portal's lead-webhook field, and every lead lands in
 * a dedicated Leads table — no fake "paste an API key" stub.
 *
 * Implementation: reuse the existing battle-tested ingest primitive
 *   POST /api/ingest/:token  →  lead_rows  (src/leads.ts)
 * Connecting a source creates a `lead_tables` row (which auto-mints an
 * `ingest_token`) and returns `${PUBLIC_API_URL}/api/ingest/<token>`. The
 * connection is recorded in tenant_integrations so it shows in Connected Apps.
 */

import express from 'express'
import { z } from 'zod'
import { SupabaseClient } from '@supabase/supabase-js'
import { encrypt } from '../../crypto'

type Middleware = (req: express.Request, res: express.Response, next: express.NextFunction) => void | Promise<void>
interface Deps {
  supabase: SupabaseClient
  requireAuth: Middleware
  identifyTenant: Middleware
  checkPermission: (feature: string, action: 'view' | 'edit' | 'delete') => Middleware
}

const PUBLIC_BASE_URL = (process.env.PUBLIC_API_URL ?? 'http://localhost:3001').replace(/\/+$/, '')

/** The lead-source portals that deliver leads by webhook push. */
export interface WebhookSource { key: string; name: string; instructions: string }
export const LEAD_WEBHOOK_SOURCES: WebhookSource[] = [
  { key: 'justdial',         name: 'JustDial',          instructions: 'In your JustDial seller dashboard (or via your JustDial lead-relay), set the lead webhook / push URL to the address below. New JustDial leads will POST here automatically.' },
  { key: 'magicbricks',      name: 'MagicBricks',       instructions: 'In MagicBricks (or your lead aggregator), point the lead push/webhook URL to the address below. Each new MagicBricks enquiry will POST here.' },
  { key: '99acres',          name: '99acres',           instructions: 'Configure your 99acres lead push / CRM webhook to send to the URL below. New 99acres enquiries will arrive here.' },
  { key: 'housing',          name: 'Housing.com',       instructions: 'Set the Housing.com lead webhook / push URL to the address below so every new Housing enquiry POSTs here.' },
  { key: 'quikr',            name: 'Quikr',             instructions: 'Point your Quikr lead push / webhook to the URL below to capture new Quikr leads here.' },
  { key: 'sulekha',          name: 'Sulekha',           instructions: 'Configure your Sulekha lead delivery / webhook to POST to the URL below.' },
  { key: 'facebook_leadads', name: 'Facebook Lead Ads', instructions: 'Use Meta’s Lead Ads webhook (or a relay like Zapier/Make) to forward each new Lead Ads submission to the URL below.' },
  { key: 'commonfloor',      name: 'CommonFloor',       instructions: 'Point your CommonFloor lead push / CRM webhook to the URL below so every new CommonFloor enquiry POSTs here.' },
  { key: 'makaan',           name: 'Makaan',            instructions: 'Configure your Makaan.com lead push / webhook to send to the URL below. New Makaan enquiries will arrive here.' },
  { key: 'propertywala',     name: 'PropertyWala',      instructions: 'Set the PropertyWala lead push / webhook URL to the address below so every new enquiry POSTs here.' },
  { key: 'indiaproperty',    name: 'IndiaProperty',     instructions: 'Point your IndiaProperty lead push / webhook to the URL below to capture new enquiries here.' },
  { key: 'roofandfloor',     name: 'RoofandFloor',      instructions: 'Configure your RoofandFloor lead delivery / webhook to POST to the URL below.' },
]

const defaultColumns = (tableId: string, tenantId: string, userId: string) => ([
  { name: 'Name',   key: 'name',   type: 'text',     is_primary: true,  is_required: false, position: 0 },
  { name: 'Phone',  key: 'phone',  type: 'phone',    is_primary: false, is_required: false, position: 1 },
  { name: 'Email',  key: 'email',  type: 'email',    is_primary: false, is_required: false, position: 2 },
  { name: 'Status', key: 'status', type: 'select',   is_primary: false, is_required: false, position: 3, options: ['new', 'contacted', 'qualified', 'lost', 'won'] },
  { name: 'Source', key: 'source', type: 'text',     is_primary: false, is_required: false, position: 4 },
  { name: 'Message',key: 'message',type: 'textarea', is_primary: false, is_required: false, position: 5 },
].map(c => ({ ...c, table_id: tableId, tenant_id: tenantId, user_id: userId, options: (c as any).options ?? [] })))

function ingestUrl(token: string): string { return `${PUBLIC_BASE_URL}/api/ingest/${token}` }

/**
 * Ensure a Leads table + tenant_integrations row exist for this source and
 * return the inbound URL. Idempotent: reconnecting returns the same URL.
 */
async function ensureSource(
  supabase: SupabaseClient, tenantId: string, userId: string, src: WebhookSource,
): Promise<{ url: string; tableId: string }> {
  // Reuse an existing connection's table if present.
  const { data: existing } = await supabase.from('tenant_integrations')
    .select('metadata').eq('tenant_id', tenantId).eq('key', src.key).maybeSingle()
  let tableId: string | undefined = (existing?.metadata as any)?.lead_table_id
  let token: string | undefined = (existing?.metadata as any)?.ingest_token

  // Validate the cached table still exists (user may have deleted it).
  if (tableId) {
    const { data: t } = await supabase.from('lead_tables')
      .select('id, ingest_token').eq('id', tableId).eq('tenant_id', tenantId).maybeSingle()
    if (t?.ingest_token) { token = t.ingest_token } else { tableId = undefined; token = undefined }
  }

  if (!tableId || !token) {
    const { data: table, error } = await supabase.from('lead_tables')
      .insert({ name: `${src.name} Leads`, description: `Leads captured from ${src.name} via webhook`, source: src.key, tenant_id: tenantId, user_id: userId })
      .select().single()
    if (error || !table) throw new Error(`Could not create the ${src.name} leads table: ${error?.message ?? 'unknown error'}`)
    tableId = table.id
    token = (table as any).ingest_token
    if (!token) throw new Error(`${src.name} leads table was created without an ingest token`)
    const { error: colErr } = await supabase.from('lead_columns').insert(defaultColumns(tableId!, tenantId, userId))
    if (colErr) { await supabase.from('lead_tables').delete().eq('id', tableId!); throw new Error(`Could not set up the ${src.name} leads table columns: ${colErr.message}`) }
  }

  const url = ingestUrl(token!)
  const { error: upErr } = await supabase.from('tenant_integrations').upsert({
    tenant_id:    tenantId,
    user_id:      userId,
    key:          src.key,
    status:       'active',
    access_token: encrypt(token!),
    scope:        'lead_gen',
    brand_label:  src.name,
    metadata:     { auth_mode: 'webhook_inbound', source: src.key, lead_table_id: tableId, ingest_token: token, ingest_url: url },
  }, { onConflict: 'tenant_id,key' })
  if (upErr) throw new Error(`Failed to persist the ${src.name} connection: ${upErr.message}`)
  return { url, tableId: tableId! }
}

export function createLeadWebhookConnectors(deps: Deps): express.Router {
  const r = express.Router()
  const { supabase, requireAuth, identifyTenant, checkPermission } = deps
  const guardEdit = [requireAuth, identifyTenant, checkPermission('integrations', 'edit')]
  const guardView = [requireAuth, identifyTenant, checkPermission('integrations', 'view')]

  for (const src of LEAD_WEBHOOK_SOURCES) {
    // Connect (mint/return the inbound URL).
    r.post(`/api/connectors/${src.key}/connect-webhook`, ...guardEdit, async (req, res) => {
      const tenantId = (req as any).tenantId
      const userId = (req as any).user?.id as string | undefined
      if (!userId) { res.status(401).json({ error: 'auth missing user.id' }); return }
      try {
        const { url, tableId } = await ensureSource(supabase, tenantId, userId, src)
        res.json({ success: true, url, table_id: tableId, instructions: src.instructions })
      } catch (err: any) {
        console.error(`[${src.key} connect-webhook] ${err?.message}`)
        res.status(500).json({ error: err?.message ?? 'Could not set up the webhook' })
      }
    })

    // Reveal the URL for an already-connected source (for the "show URL" view).
    r.get(`/api/connectors/${src.key}/webhook-url`, ...guardView, async (req, res) => {
      const tenantId = (req as any).tenantId
      const { data: row } = await supabase.from('tenant_integrations')
        .select('metadata').eq('tenant_id', tenantId).eq('key', src.key).maybeSingle()
      const md = (row?.metadata as any) ?? {}
      if (!md.ingest_url) { res.status(404).json({ error: `${src.name} not connected` }); return }
      res.json({ url: md.ingest_url, table_id: md.lead_table_id, instructions: src.instructions })
    })
  }

  return r
}
