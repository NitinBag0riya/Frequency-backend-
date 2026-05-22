/**
 * Connector router — public catalog + connection lifecycle.
 *
 *   GET  /api/connectors/registry         — list of all known connectors
 *                                          (live + planned). Drives AppsModal +
 *                                          Sidebar without hardcoding the FE.
 *   GET  /api/connectors/connections      — this tenant's connected apps with
 *                                          status (token expired? scope drift?),
 *                                          plus category / isChannel /
 *                                          channelFeatures so the FE can group
 *                                          by category in the sidebar.
 *   GET  /api/channels/connected          — message-channel filter tabs
 *                                          (subset of connections where
 *                                          isChannel === true).
 *   POST /api/connectors/:key/disconnect  — revoke locally; clears tokens.
 *
 * Per-connector OAuth start/callback + capability endpoints live in
 * routes/connectors/<key>.ts and are mounted from this file.
 */

import express from 'express'
import { z } from 'zod'
import { SupabaseClient } from '@supabase/supabase-js'
import { CONNECTOR_REGISTRY, publicRegistry, getConnector } from '../../connectors/registry'
import { validateBody } from '../../validation'
import { createAirtableConnector } from './airtable'
import { createRazorpayConnector } from './razorpay'
import { createShopifyConnector } from './shopify'
import { createSlackConnector } from './slack'
import { signOauthState } from '../../lib/oauth-state'

// Meta Graph API base — kept inline to avoid pulling in unrelated config modules.
const GRAPH = 'https://graph.facebook.com/v18.0'

// WhatsApp paste-credentials connect: validates a long-lived system-user token
// against Meta before persisting onto tenants.* legacy columns. Mirrors the
// inline-form pattern used by Razorpay/Slack/Shopify so AppsModal can drive
// it without routing through the OnboardingPage embedded-signup wizard.
const WhatsAppConnectSchema = z.object({
  waba_id:         z.string().regex(/^\d{10,20}$/, 'WABA ID must be 10-20 digits'),
  phone_number_id: z.string().regex(/^\d{10,20}$/, 'Phone Number ID must be 10-20 digits'),
  access_token:    z.string().min(100, 'Access token looks too short — paste the full long-lived system-user token'),
})

type Middleware = (req: express.Request, res: express.Response, next: express.NextFunction) => void | Promise<void>

interface Deps {
  supabase: SupabaseClient
  requireAuth: Middleware
  identifyTenant: Middleware
  checkPermission: (feature: string, action: 'view' | 'edit' | 'delete') => Middleware
}

// ── Post-connect WhatsApp sync helpers ──────────────────────────────────────
// These run inline at the tail of POST /api/connectors/whatsapp/connect so the
// user-visible "Connected" toast is followed by a refetch that shows REAL Meta
// data, not the demo seed rows the tenant was initialized with. Adding queue
// jobs here would let demo data linger for one worker tick = unacceptable for
// a paid B2B surface where the next click is "send broadcast".

interface MetaTemplateComponent {
  type: string                  // HEADER | BODY | FOOTER | BUTTONS
  format?: string               // for HEADER: TEXT | IMAGE | VIDEO | DOCUMENT
  text?: string                 // HEADER text / BODY text / FOOTER text
  buttons?: Array<Record<string, unknown>>
}

interface MetaTemplate {
  id?: string
  name: string
  language: string
  status: string                // APPROVED | PENDING | REJECTED | DELETED | IN_APPEAL | PAUSED
  category: string              // MARKETING | UTILITY | AUTHENTICATION
  rejected_reason?: string | null
  components?: MetaTemplateComponent[]
}

/**
 * Page through Meta's /message_templates endpoint for a WABA. Mirrors the
 * loop in workers/template-sync.ts so column-shape drift is impossible:
 * we add `components` to the fields list so we can populate header/body/
 * footer/buttons on insert (the worker only updates status, but on first-
 * connect the row doesn't exist yet — we need the full payload).
 */
async function fetchAllMetaTemplates(wabaId: string, accessToken: string): Promise<MetaTemplate[]> {
  const url = `${GRAPH}/${wabaId}/message_templates?limit=100&fields=id,name,language,status,category,rejected_reason,components`
  const out: MetaTemplate[] = []
  let next: string | null = url
  let pages = 0
  while (next && pages < 5) {  // hard cap so a runaway pager can't loop forever
    const r = await fetch(next, { headers: { Authorization: `Bearer ${accessToken}` } })
    if (!r.ok) {
      const txt = await r.text()
      throw new Error(`Meta ${r.status}: ${txt.slice(0, 200)}`)
    }
    const body = await r.json() as { data?: MetaTemplate[]; paging?: { next?: string } }
    if (Array.isArray(body.data)) out.push(...body.data)
    next = body.paging?.next ?? null
    pages++
  }
  return out
}

/**
 * Convert Meta's `components[]` shape into the legacy column shape that
 * /api/wa-templates reads from (see index.ts:1742). The GET endpoint
 * re-renders these columns BACK into Meta components format for the FE, so
 * the round-trip MUST preserve enough data to reconstruct the original.
 *
 * Returns null for any field Meta didn't include so we don't smear stale
 * values onto a row we're updating.
 */
function metaComponentsToColumns(components: MetaTemplateComponent[] | undefined): {
  header: Record<string, unknown> | null
  body:   string
  footer: string | null
  buttons: Array<Record<string, unknown>> | null
} {
  let header: Record<string, unknown> | null = null
  let body = ''
  let footer: string | null = null
  let buttons: Array<Record<string, unknown>> | null = null
  for (const c of components ?? []) {
    const type = (c.type ?? '').toUpperCase()
    if (type === 'HEADER') {
      const fmt = (c.format ?? 'TEXT').toLowerCase()
      header = fmt === 'text' ? { type: 'text', text: c.text ?? '' } : { type: fmt }
    } else if (type === 'BODY') {
      body = c.text ?? ''
    } else if (type === 'FOOTER') {
      footer = c.text ?? null
    } else if (type === 'BUTTONS') {
      buttons = Array.isArray(c.buttons) ? c.buttons : null
    }
  }
  return { header, body, footer, buttons }
}

/**
 * Meta returns status uppercase (`APPROVED`); the wa_templates.status CHECK
 * constraint (migration 011) only accepts lowercase strings. Mirror the
 * mapper in workers/template-sync.ts so an unexpected value never trips the
 * constraint and aborts the whole sync.
 */
function mapMetaStatus(metaStatus: string): string {
  const s = (metaStatus ?? '').toLowerCase()
  return s.replace(/[^a-z_]/g, '_') || 'pending'
}

/**
 * Meta category may arrive as MARKETING / UTILITY / AUTHENTICATION (correct
 * for the CHECK constraint after lowercasing) or as something exotic like
 * `OTP`/`MARKETING_LITE` on legacy WABAs. Anything outside the allowed set
 * is folded into 'utility' so the INSERT doesn't 23514 the whole batch.
 */
function mapMetaCategory(metaCategory: string): 'marketing' | 'utility' | 'authentication' {
  const c = (metaCategory ?? '').toLowerCase()
  if (c === 'marketing' || c === 'utility' || c === 'authentication') return c
  return 'utility'
}

/**
 * Replace the tenant's wa_templates with the real Meta set.
 *
 * Approach: per-tenant DELETE-stale + UPDATE-existing + INSERT-new. We can't
 * use a single .upsert() because wa_templates has no UNIQUE (tenant_id, name,
 * language) constraint, and there's a NO-ACTION FK from broadcasts.template_id
 * which would block a naïve "delete all then insert" approach if the tenant
 * had built broadcasts against demo templates. Real broadcasts almost never
 * survive a Connect (the demo templates have synthesized names anyway), but
 * we stay defensive: if a delete trips an FK we log + continue.
 */
async function syncWhatsAppTemplates(
  supabase: SupabaseClient,
  tenantId: string,
  wabaId: string,
  accessToken: string,
  userId: string | null,
): Promise<{ fetched: number; inserted: number; updated: number; deletedStale: number }> {
  const fresh = await fetchAllMetaTemplates(wabaId, accessToken)

  // Existing rows for this tenant — we need (id, name, language) to decide
  // insert vs update, and to compute the stale set.
  const { data: existing, error: exErr } = await supabase.from('wa_templates')
    .select('id, name, language')
    .eq('tenant_id', tenantId)
  if (exErr) throw new Error(`load existing: ${exErr.message}`)

  const existingByKey = new Map<string, string>()  // `${name}|${language}` -> id
  for (const row of existing ?? []) {
    existingByKey.set(`${row.name}|${row.language}`, row.id as string)
  }

  const freshKeys = new Set<string>()
  let inserted = 0
  let updated  = 0
  const now = new Date().toISOString()

  for (const t of fresh) {
    if (!t.name || !t.language) continue                   // skip malformed Meta rows
    const key = `${t.name}|${t.language}`
    freshKeys.add(key)
    const cols = metaComponentsToColumns(t.components)
    if (!cols.body) cols.body = ' '                        // body is NOT NULL — Meta sometimes returns empty
    const status = mapMetaStatus(t.status)
    const category = mapMetaCategory(t.category)

    const existingId = existingByKey.get(key)
    if (existingId) {
      const { error } = await supabase.from('wa_templates').update({
        category,
        status,
        header:           cols.header,
        body:             cols.body,
        footer:           cols.footer,
        buttons:          cols.buttons,
        meta_template_id: t.id ?? null,
        rejection_reason: t.rejected_reason ?? null,
        last_synced_at:   now,
      }).eq('id', existingId)
      if (error) { console.warn(`[wa-connect] update template ${t.name}: ${error.message}`); continue }
      updated++
    } else {
      const { error } = await supabase.from('wa_templates').insert({
        tenant_id:        tenantId,
        user_id:          userId,            // nullable post-migration 052
        name:             t.name,
        language:         t.language,
        category,
        status,
        header:           cols.header,
        body:             cols.body,
        footer:           cols.footer,
        buttons:          cols.buttons,
        meta_template_id: t.id ?? null,
        rejection_reason: t.rejected_reason ?? null,
        last_synced_at:   now,
      })
      if (error) { console.warn(`[wa-connect] insert template ${t.name}: ${error.message}`); continue }
      inserted++
    }
  }

  // Delete rows for this tenant whose (name, language) is NOT in Meta's fresh
  // set — this is what wipes the demo seed data ("welcome", "site_visit_confirm",
  // "diwali_offer"). If an FK blocks the delete (a real broadcast points at the
  // row) we log and move on.
  let deletedStale = 0
  for (const [key, id] of existingByKey.entries()) {
    if (freshKeys.has(key)) continue
    const { error } = await supabase.from('wa_templates').delete().eq('id', id).eq('tenant_id', tenantId)
    if (error) {
      console.warn(`[wa-connect] could not delete stale template ${key}: ${error.message}`)
      continue
    }
    deletedStale++
  }

  return { fetched: fresh.length, inserted, updated, deletedStale }
}

/**
 * Pull the WhatsApp Business profile from Meta and mirror it into
 * wa_business_profiles. PK is tenant_id so .upsert() with default conflict
 * target overwrites any demo seed row in place — no DELETE needed.
 */
async function syncWhatsAppProfile(
  supabase: SupabaseClient,
  tenantId: string,
  phoneNumberId: string,
  accessToken: string,
): Promise<void> {
  const fields = 'about,address,description,email,vertical,websites,profile_picture_url'
  const r = await fetch(
    `${GRAPH}/${encodeURIComponent(phoneNumberId)}/whatsapp_business_profile?fields=${fields}`,
    { headers: { Authorization: `Bearer ${accessToken}` } },
  )
  if (!r.ok) {
    const txt = await r.text()
    throw new Error(`Meta ${r.status}: ${txt.slice(0, 200)}`)
  }
  const body = await r.json() as { data?: Array<Record<string, unknown>> }
  // Meta wraps the profile in a single-element data[] array.
  const prof = Array.isArray(body.data) && body.data.length > 0 ? body.data[0] : {}

  const row = {
    tenant_id:           tenantId,
    about:               (prof.about as string | undefined) ?? null,
    description:         (prof.description as string | undefined) ?? null,
    email:               (prof.email as string | undefined) ?? null,
    websites:            Array.isArray(prof.websites) ? prof.websites as string[] : [],
    vertical:            (prof.vertical as string | undefined) ?? null,
    address:             (prof.address as string | undefined) ?? null,
    profile_picture_url: (prof.profile_picture_url as string | undefined) ?? null,
    updated_at:          new Date().toISOString(),
  }
  // tenant_id is the PK — default upsert conflict target hits it. This
  // OVERWRITES the demo seed row ("Bangalore's premium real-estate agency")
  // with the real "Shaping the Future" / Arihant Group data.
  const { error } = await supabase.from('wa_business_profiles').upsert(row)
  if (error) throw new Error(error.message)
}

// ── WhatsApp Flows sync ─────────────────────────────────────────────────────
// Meta's /{waba_id}/flows endpoint shape. `status` per Meta docs is one of
// DRAFT | PUBLISHED | DEPRECATED | BLOCKED | THROTTLED; the wa_flows CHECK
// constraint (migration 016) only allows the first three so we fold the
// other two into DEPRECATED (they mean "exists but should not be used").
// `categories` is an array (e.g. ["LEAD_GENERATION"]); wa_flows.category is
// a singular text column, so we take the first element.
interface MetaFlow {
  id: string
  name: string
  status: string
  categories?: string[]
}

async function fetchAllMetaFlows(wabaId: string, accessToken: string): Promise<MetaFlow[]> {
  const url = `${GRAPH}/${wabaId}/flows?limit=100&fields=id,name,status,categories`
  const out: MetaFlow[] = []
  let next: string | null = url
  let pages = 0
  while (next && pages < 5) {  // same 5-page hard cap as templates
    const r = await fetch(next, { headers: { Authorization: `Bearer ${accessToken}` } })
    if (!r.ok) {
      const txt = await r.text()
      throw new Error(`Meta ${r.status}: ${txt.slice(0, 200)}`)
    }
    const body = await r.json() as { data?: MetaFlow[]; paging?: { next?: string } }
    if (Array.isArray(body.data)) out.push(...body.data)
    next = body.paging?.next ?? null
    pages++
  }
  return out
}

/**
 * Meta returns status uppercase. wa_flows.status CHECK only allows
 * DRAFT | PUBLISHED | DEPRECATED. BLOCKED and THROTTLED both mean the
 * flow exists upstream but should not be used as-is, so they fold into
 * DEPRECATED — honest about the impaired state without lying that it's
 * still live. Anything else (future Meta values) defaults to DRAFT to
 * stay safe.
 */
function mapMetaFlowStatus(metaStatus: string): 'DRAFT' | 'PUBLISHED' | 'DEPRECATED' {
  const s = (metaStatus ?? '').toUpperCase()
  if (s === 'DRAFT' || s === 'PUBLISHED' || s === 'DEPRECATED') return s
  if (s === 'BLOCKED' || s === 'THROTTLED') return 'DEPRECATED'
  return 'DRAFT'
}

/**
 * Replace the tenant's wa_flows with the real Meta set.
 *
 * Approach mirrors syncWhatsAppTemplates: per-tenant UPDATE-existing +
 * INSERT-new keyed on meta_flow_id, then DELETE rows whose meta_flow_id is
 * no longer in Meta's fresh set.
 *
 * IMPORTANT: rows with meta_flow_id IS NULL are LEFT ALONE. The
 * POST /api/wa-flows handler (wa-features.ts:185) inserts with
 * meta_flow_id=NULL on creation and only patches it in if Meta accepts the
 * create call. So a NULL meta_flow_id means either (a) the user drafted a
 * flow before connecting WABA, or (b) Meta was unreachable when they
 * pressed Save. In both cases the local row IS user work — deleting it on
 * connect would erase legitimate drafts. The /publish endpoint relies on
 * meta_flow_id being populated; until that happens the row is harmless.
 *
 * wa_flow_responses references wa_flows(id) ON DELETE CASCADE, so deleting
 * a stale flow row cleans its responses automatically. We still wrap the
 * delete in defensive logging in case a future FK is added with RESTRICT —
 * matching the templates pattern.
 *
 * Note: `definition` is jsonb NOT NULL with default '{}'. The list endpoint
 * doesn't return the flow JSON spec, so we leave the column to its DB
 * default on INSERT and never overwrite it on UPDATE. If the user later
 * needs the spec we can pull it from GET /{flow_id}?fields=preview as a
 * separate hydration step.
 */
async function syncWhatsAppFlows(
  supabase: SupabaseClient,
  tenantId: string,
  wabaId: string,
  accessToken: string,
  _userId: string | null,
): Promise<{ fetched: number; inserted: number; updated: number; deletedStale: number }> {
  const fresh = await fetchAllMetaFlows(wabaId, accessToken)

  // Pull existing rows keyed by meta_flow_id. NULL meta_flow_id rows are
  // skipped here so they're invisible to both the update path and the
  // stale-delete path — they remain user property untouched by this sync.
  const { data: existing, error: exErr } = await supabase.from('wa_flows')
    .select('id, meta_flow_id')
    .eq('tenant_id', tenantId)
    .not('meta_flow_id', 'is', null)
  if (exErr) throw new Error(`load existing: ${exErr.message}`)

  const existingByMetaId = new Map<string, string>()  // meta_flow_id -> wa_flows.id
  for (const row of existing ?? []) {
    if (row.meta_flow_id) existingByMetaId.set(row.meta_flow_id as string, row.id as string)
  }

  const freshMetaIds = new Set<string>()
  let inserted = 0
  let updated  = 0
  const now = new Date().toISOString()

  for (const f of fresh) {
    if (!f.id || !f.name) continue                       // skip malformed Meta rows
    freshMetaIds.add(f.id)
    const status = mapMetaFlowStatus(f.status)
    const category = Array.isArray(f.categories) && f.categories.length > 0
      ? String(f.categories[0])
      : null

    const existingId = existingByMetaId.get(f.id)
    if (existingId) {
      // Don't touch `definition` — Meta's list endpoint doesn't return it
      // and we don't want to clobber whatever the user/POST stored.
      const { error } = await supabase.from('wa_flows').update({
        name:       f.name,
        status,
        category,
        updated_at: now,
      }).eq('id', existingId)
      if (error) { console.warn(`[wa-connect] update flow ${f.name}: ${error.message}`); continue }
      updated++
    } else {
      // INSERT — let `definition` default to '{}' (NOT NULL constraint),
      // `created_at`/`updated_at` default to now().
      const { error } = await supabase.from('wa_flows').insert({
        tenant_id:    tenantId,
        meta_flow_id: f.id,
        name:         f.name,
        status,
        category,
      })
      if (error) { console.warn(`[wa-connect] insert flow ${f.name}: ${error.message}`); continue }
      inserted++
    }
  }

  // Delete rows for this tenant whose meta_flow_id is NOT in Meta's fresh
  // set — these are flows the user deleted upstream, or demo seed rows that
  // happened to have a meta_flow_id populated. wa_flow_responses CASCADES
  // off this delete; if a future FK pins it we log and move on.
  let deletedStale = 0
  for (const [metaId, id] of existingByMetaId.entries()) {
    if (freshMetaIds.has(metaId)) continue
    const { error } = await supabase.from('wa_flows').delete().eq('id', id).eq('tenant_id', tenantId)
    if (error) {
      console.warn(`[wa-connect] could not delete stale flow meta_flow_id=${metaId}: ${error.message}`)
      continue
    }
    deletedStale++
  }

  return { fetched: fresh.length, inserted, updated, deletedStale }
}

// ── WhatsApp Flow Definitions sync ──────────────────────────────────────────
// The flow LIST endpoint (synced above) gives us id/name/status/categories but
// NOT the actual flow JSON spec the user designed in Flow Builder. Without the
// spec, wa_flows.definition stays at its column default '{}'::jsonb and any FE
// detail/preview screen shows a blank canvas — exactly the "no real data /
// bluff" complaint the user filed.
//
// Meta's flow-detail API is two hops:
//   1. GET /{flow_id}?fields=preview,validation_errors,json_version,
//      data_api_version,application,health_status
//      → returns { preview: { preview_url, expires_at }, validation_errors,
//        json_version, application, health_status, id }
//      The `preview.preview_url` is a short-lived (~30d) embedded-iframe URL,
//      NOT the JSON spec — confirmed by probing flow_id=2490299148076967 on
//      tenant 56481854 (Acme).
//   2. GET /{flow_id}/assets
//      → returns { data: [{ name: 'flow.json', asset_type: 'FLOW_JSON',
//        download_url: '<mmg.whatsapp.net signed URL>' }] }
//      Following the download_url returns the actual { version, screens } spec.
//
// Pattern: per-flow we do 3 round-trips (detail + assets + download). Naïve
// sequential for 9 Acme flows = 27 calls = visible lag in /connect. Cap in-
// flight at FLOW_DETAIL_CONCURRENCY=5 using a simple chunked Promise.all — no
// new p-limit dep, matches the codebase idiom (workers/* use the same shape).
//
// `definition` column shape: jsonb NOT NULL default '{}'. We store the parsed
// flow JSON ({version, screens}) directly so the FE renderer doesn't need to
// re-fetch from Meta on every preview load. `meta_flow_id`-keyed UPDATE only;
// rows with NULL meta_flow_id are user-drafted and have their own definition
// already (handled by POST /api/wa-flows in wa-features.ts:185).

interface FlowDetailResponse {
  preview?: { preview_url?: string; expires_at?: string }
  validation_errors?: Array<Record<string, unknown>>
  json_version?: string
  data_api_version?: string
  application?: Record<string, unknown>
  health_status?: Record<string, unknown>
  id?: string
}

interface FlowAssetsResponse {
  data?: Array<{ name?: string; asset_type?: string; download_url?: string }>
}

const FLOW_DETAIL_CONCURRENCY = 5

/**
 * Fetch the rendered flow JSON spec ({version, screens}) for a single flow.
 * Returns null on any failure — caller increments `failed` and moves on rather
 * than aborting the whole sync. The three-hop chain (detail → assets →
 * download) is sequenced because the download_url comes out of assets.
 */
async function fetchFlowDefinition(flowId: string, accessToken: string): Promise<{
  definition: Record<string, unknown> | null
  preview_url: string | null
  json_version: string | null
  validation_errors: Array<Record<string, unknown>> | null
  health_status: Record<string, unknown> | null
} | null> {
  // 1. Detail call — gives us preview_url + validation + health for the UI banner.
  const detailRes = await fetch(
    `${GRAPH}/${encodeURIComponent(flowId)}?fields=preview,validation_errors,json_version,data_api_version,application,health_status`,
    { headers: { Authorization: `Bearer ${accessToken}` } },
  )
  if (!detailRes.ok) {
    const txt = await detailRes.text()
    throw new Error(`Meta detail ${detailRes.status}: ${txt.slice(0, 200)}`)
  }
  const detail = await detailRes.json() as FlowDetailResponse

  // 2. Assets call — find the FLOW_JSON download_url.
  const assetsRes = await fetch(
    `${GRAPH}/${encodeURIComponent(flowId)}/assets`,
    { headers: { Authorization: `Bearer ${accessToken}` } },
  )
  if (!assetsRes.ok) {
    const txt = await assetsRes.text()
    throw new Error(`Meta assets ${assetsRes.status}: ${txt.slice(0, 200)}`)
  }
  const assets = await assetsRes.json() as FlowAssetsResponse
  const flowJsonAsset = (assets.data ?? []).find(a => a.asset_type === 'FLOW_JSON')

  let definition: Record<string, unknown> | null = null
  if (flowJsonAsset?.download_url) {
    // 3. Follow the signed download URL — auth-bearer header NOT required here
    //    (the URL is pre-signed) and would actually be rejected by mmg.whatsapp.net.
    const dlRes = await fetch(flowJsonAsset.download_url)
    if (dlRes.ok) {
      try {
        definition = await dlRes.json() as Record<string, unknown>
      } catch (e) {
        // If Meta returns malformed JSON we keep going — preview_url is still
        // useful even without the spec.
        console.warn(`[wa-connect] flow ${flowId} definition JSON parse failed`)
      }
    } else {
      console.warn(`[wa-connect] flow ${flowId} download_url ${dlRes.status}`)
    }
  }

  return {
    definition,
    preview_url:       detail.preview?.preview_url ?? null,
    json_version:      detail.json_version ?? null,
    validation_errors: Array.isArray(detail.validation_errors) ? detail.validation_errors : null,
    health_status:     (detail.health_status as Record<string, unknown>) ?? null,
  }
}

/**
 * Hydrate `definition` on every wa_flows row that has a meta_flow_id.
 *
 * Run AFTER syncWhatsAppFlows so the row set is fresh. We re-select from
 * the DB here (rather than threading the freshly-inserted rows through)
 * because the in-flight insert path may have failed for some rows and we
 * want to operate on whatever's actually persisted.
 *
 * IMPORTANT: we DO NOT overwrite definition when fetchFlowDefinition returns
 * a null spec — the existing value (whatever Flow Builder POSTed, or the
 * '{}' default) is better than smearing null over real data. We DO always
 * persist the preview_url + validation_errors + health_status onto a new
 * `meta_flow_metadata` jsonb-ish field... except the column doesn't exist,
 * so for now we stash that auxiliary metadata in `definition._meta` if the
 * spec was fetched, and otherwise log it (the FE only reads {version, screens}
 * out of definition, so embedding _meta is safe).
 */
async function syncWhatsAppFlowDefinitions(
  supabase: SupabaseClient,
  tenantId: string,
  accessToken: string,
): Promise<{ fetched: number; updated: number; failed: number }> {
  const { data: rows, error } = await supabase.from('wa_flows')
    .select('id, meta_flow_id, name')
    .eq('tenant_id', tenantId)
    .not('meta_flow_id', 'is', null)
  if (error) throw new Error(`load flows: ${error.message}`)

  const targets = (rows ?? []).filter(r => r.meta_flow_id) as Array<{ id: string; meta_flow_id: string; name: string }>
  let updated = 0
  let failed  = 0

  // Chunked Promise.all — 5 flows in flight at a time. Each chunk awaits
  // before the next starts, so a slow Meta response only blocks its batch
  // not the whole sync.
  for (let i = 0; i < targets.length; i += FLOW_DETAIL_CONCURRENCY) {
    const chunk = targets.slice(i, i + FLOW_DETAIL_CONCURRENCY)
    const results = await Promise.all(chunk.map(async (row) => {
      try {
        const detail = await fetchFlowDefinition(row.meta_flow_id, accessToken)
        return { row, detail, err: null as string | null }
      } catch (e: any) {
        return { row, detail: null, err: e?.message ?? 'unknown' }
      }
    }))
    for (const { row, detail, err } of results) {
      if (err || !detail) {
        console.warn(`[wa-connect] flow ${row.name} (${row.meta_flow_id}) detail fetch failed: ${err}`)
        failed++
        continue
      }
      // Only update when we actually got a JSON spec — never clobber existing
      // definition with null. Embed _meta alongside the spec so the FE can
      // surface the embedded preview_url + validation errors without a second
      // call (no separate column exists to hold them).
      if (!detail.definition) {
        // No spec to write; still record failure so the FE can surface
        // "preview unavailable" if it cares.
        failed++
        continue
      }
      const definitionWithMeta = {
        ...detail.definition,
        _meta: {
          preview_url:       detail.preview_url,
          json_version:      detail.json_version,
          validation_errors: detail.validation_errors,
          health_status:     detail.health_status,
          synced_at:         new Date().toISOString(),
        },
      }
      const { error: updErr } = await supabase.from('wa_flows').update({
        definition: definitionWithMeta,
        updated_at: new Date().toISOString(),
      }).eq('id', row.id)
      if (updErr) {
        console.warn(`[wa-connect] flow ${row.name} update definition failed: ${updErr.message}`)
        failed++
        continue
      }
      updated++
    }
  }

  return { fetched: targets.length, updated, failed }
}

// ── WhatsApp Catalog sync ───────────────────────────────────────────────────
// Two-hop: WABA→catalogs, then catalog→products. A WABA may have zero linked
// catalogs (no commerce setup) — that's a clean exit with catalogs_found=0,
// NOT an error. Probed on Acme tenant: `/{waba_id}/product_catalogs` returns
// `{ data: [] }` for a tenant with no catalog linked.
//
// Schema (migration 016):
//   wa_catalog_products(id, tenant_id, meta_product_id, name, description,
//                       price numeric(12,2), currency text default 'INR',
//                       image_url, url, source text NOT NULL default 'manual',
//                       source_ref, metadata jsonb, created_at, updated_at)
// No UNIQUE on (tenant_id, meta_product_id) — same template pattern: select
// existing keys, UPDATE-or-INSERT in code, then DELETE-stale.

interface MetaCatalog {
  id: string
  name?: string
}

interface MetaProduct {
  id?: string                  // fb_product_id
  retailer_id?: string         // user-supplied SKU/handle
  name?: string
  description?: string
  price?: string               // e.g. "499.00 INR" or "$50 USD"
  currency?: string
  availability?: string
  image_url?: string
  url?: string
}

/**
 * Parse Meta's `price` (often "499.00 INR" or "$50 USD") into a numeric value
 * + currency. Falls back to null/INR if the string is unparseable rather than
 * throwing — a malformed price on one product MUST NOT abort the sync.
 */
function parsePrice(raw: string | undefined, explicitCurrency: string | undefined): {
  price: number | null
  currency: string
} {
  if (!raw) return { price: null, currency: explicitCurrency || 'INR' }
  // Match leading number (with optional dot), then optional currency code/symbol
  const m = String(raw).match(/[\d,]+(?:\.\d+)?/)
  const num = m ? Number(m[0].replace(/,/g, '')) : NaN
  const cur = explicitCurrency
    || (String(raw).match(/\b([A-Z]{3})\b/)?.[1])
    || 'INR'
  return { price: Number.isFinite(num) ? num : null, currency: cur }
}

async function syncWhatsAppCatalog(
  supabase: SupabaseClient,
  tenantId: string,
  wabaId: string,
  accessToken: string,
): Promise<{
  catalogs_found: number
  products_fetched: number
  products_added: number
  products_updated: number
  products_removed: number
}> {
  // 1. Linked catalogs for this WABA
  const catRes = await fetch(
    `${GRAPH}/${encodeURIComponent(wabaId)}/product_catalogs`,
    { headers: { Authorization: `Bearer ${accessToken}` } },
  )
  if (!catRes.ok) {
    const txt = await catRes.text()
    throw new Error(`Meta catalogs ${catRes.status}: ${txt.slice(0, 200)}`)
  }
  const catBody = await catRes.json() as { data?: MetaCatalog[] }
  const catalogs = Array.isArray(catBody.data) ? catBody.data : []
  if (catalogs.length === 0) {
    return { catalogs_found: 0, products_fetched: 0, products_added: 0, products_updated: 0, products_removed: 0 }
  }

  // 2. Fetch products across all linked catalogs (most accounts have 1 catalog).
  const allProducts: MetaProduct[] = []
  for (const cat of catalogs) {
    let next: string | null = `${GRAPH}/${encodeURIComponent(cat.id)}/products?fields=id,retailer_id,name,description,price,currency,availability,image_url,url&limit=100`
    let pages = 0
    while (next && pages < 5) {  // same 5-page cap as templates
      const r: Response = await fetch(next, { headers: { Authorization: `Bearer ${accessToken}` } })
      if (!r.ok) {
        const txt = await r.text()
        throw new Error(`Meta products ${r.status}: ${txt.slice(0, 200)}`)
      }
      const body = await r.json() as { data?: MetaProduct[]; paging?: { next?: string } }
      if (Array.isArray(body.data)) allProducts.push(...body.data)
      next = body.paging?.next ?? null
      pages++
    }
  }

  // 3. Existing rows for this tenant — keyed on meta_product_id.
  const { data: existing, error: exErr } = await supabase.from('wa_catalog_products')
    .select('id, meta_product_id')
    .eq('tenant_id', tenantId)
  if (exErr) throw new Error(`load existing catalog: ${exErr.message}`)

  const existingByMetaId = new Map<string, string>()
  for (const row of existing ?? []) {
    if (row.meta_product_id) existingByMetaId.set(row.meta_product_id as string, row.id as string)
  }

  const freshMetaIds = new Set<string>()
  let products_added = 0
  let products_updated = 0
  const now = new Date().toISOString()

  for (const p of allProducts) {
    // Prefer the stable retailer_id (SKU). Fall back to Meta's fb_product_id.
    const metaProductId = p.retailer_id || p.id
    if (!metaProductId || !p.name) continue
    freshMetaIds.add(metaProductId)

    const { price, currency } = parsePrice(p.price, p.currency)

    const existingId = existingByMetaId.get(metaProductId)
    if (existingId) {
      const { error } = await supabase.from('wa_catalog_products').update({
        name:        p.name,
        description: p.description ?? null,
        price,
        currency,
        image_url:   p.image_url ?? null,
        url:         p.url ?? null,
        // `source` stays whatever it was (could be 'shopify' or 'manual');
        // we don't downgrade an existing row's source field here.
        metadata:    { availability: p.availability ?? null, raw_price: p.price ?? null, fb_product_id: p.id ?? null },
        updated_at:  now,
      }).eq('id', existingId)
      if (error) { console.warn(`[wa-connect] update product ${metaProductId}: ${error.message}`); continue }
      products_updated++
    } else {
      const { error } = await supabase.from('wa_catalog_products').insert({
        tenant_id:       tenantId,
        meta_product_id: metaProductId,
        name:            p.name,
        description:     p.description ?? null,
        price,
        currency,
        image_url:       p.image_url ?? null,
        url:             p.url ?? null,
        source:          'manual',  // Meta-synced products default to manual; Shopify-linked products
                                    // would have been created with source='shopify' from a different path.
        metadata:        { availability: p.availability ?? null, raw_price: p.price ?? null, fb_product_id: p.id ?? null },
      })
      if (error) { console.warn(`[wa-connect] insert product ${metaProductId}: ${error.message}`); continue }
      products_added++
    }
  }

  // Delete-stale: rows whose meta_product_id isn't in Meta's fresh set. We
  // ONLY delete rows that have a non-null meta_product_id — locally-created
  // products (meta_product_id IS NULL, source='manual'|'shopify'|...) are
  // user-owned and must NOT be wiped by a Meta sync.
  let products_removed = 0
  for (const [metaId, id] of existingByMetaId.entries()) {
    if (freshMetaIds.has(metaId)) continue
    const { error } = await supabase.from('wa_catalog_products')
      .delete().eq('id', id).eq('tenant_id', tenantId)
      .not('meta_product_id', 'is', null)
    if (error) {
      console.warn(`[wa-connect] could not delete stale product meta_product_id=${metaId}: ${error.message}`)
      continue
    }
    products_removed++
  }

  return {
    catalogs_found:   catalogs.length,
    products_fetched: allProducts.length,
    products_added,
    products_updated,
    products_removed,
  }
}

// ── WhatsApp QR codes sync ──────────────────────────────────────────────────
// Meta calls these "message_qrdls" (qr deep links). Probed on Acme: returns
// `{ data: [] }` cleanly when none are configured.
//
// Schema (migration 016):
//   wa_qr_codes(id, tenant_id, code text NOT NULL, prefilled_message,
//               url text NOT NULL, uses int default 0, created_at)
//   UNIQUE INDEX wa_qr_tenant_code ON (tenant_id, code)
//
// Schema gaps vs Meta's response:
//   - Meta returns `qr_image_url` (CDN-hosted PNG) — NO column to store it.
//   - Meta returns `deep_link_url` (wa.me/<phone>?text=... shortlink) — maps
//     to our existing `url` column (which is documented as the wa.me link).
// FLAGGED: see report. We map deep_link_url → url, drop qr_image_url, and
// continue (the FE can regenerate the PNG client-side from the code anyway).

interface MetaQrCode {
  code?: string
  prefilled_message?: string
  deep_link_url?: string
  qr_image_url?: string
}

async function syncWhatsAppQRCodes(
  supabase: SupabaseClient,
  tenantId: string,
  phoneNumberId: string,
  accessToken: string,
): Promise<{ fetched: number; added: number; updated: number; removed: number }> {
  const r = await fetch(
    `${GRAPH}/${encodeURIComponent(phoneNumberId)}/message_qrdls?fields=code,prefilled_message,deep_link_url,qr_image_url&limit=100`,
    { headers: { Authorization: `Bearer ${accessToken}` } },
  )
  if (!r.ok) {
    const txt = await r.text()
    throw new Error(`Meta qrdls ${r.status}: ${txt.slice(0, 200)}`)
  }
  const body = await r.json() as { data?: MetaQrCode[] }
  const fresh = Array.isArray(body.data) ? body.data : []

  // Existing rows for this tenant — keyed on `code` (which is also Meta's
  // identifier; the unique index on (tenant_id, code) enforces this shape).
  const { data: existing, error: exErr } = await supabase.from('wa_qr_codes')
    .select('id, code')
    .eq('tenant_id', tenantId)
  if (exErr) throw new Error(`load existing qrdls: ${exErr.message}`)

  const existingByCode = new Map<string, string>()
  for (const row of existing ?? []) {
    if (row.code) existingByCode.set(row.code as string, row.id as string)
  }

  const freshCodes = new Set<string>()
  let added = 0
  let updated = 0

  for (const q of fresh) {
    if (!q.code) continue
    freshCodes.add(q.code)
    // `url` is NOT NULL — fall back to a synthesized empty placeholder if Meta
    // returned no deep_link_url (shouldn't happen in practice; defensive).
    const url = q.deep_link_url ?? `https://wa.me/?text=${encodeURIComponent(q.prefilled_message ?? '')}`

    const existingId = existingByCode.get(q.code)
    if (existingId) {
      const { error } = await supabase.from('wa_qr_codes').update({
        prefilled_message: q.prefilled_message ?? null,
        url,
      }).eq('id', existingId)
      if (error) { console.warn(`[wa-connect] update qr code=${q.code}: ${error.message}`); continue }
      updated++
    } else {
      const { error } = await supabase.from('wa_qr_codes').insert({
        tenant_id:         tenantId,
        code:              q.code,
        prefilled_message: q.prefilled_message ?? null,
        url,
      })
      if (error) { console.warn(`[wa-connect] insert qr code=${q.code}: ${error.message}`); continue }
      added++
    }
  }

  // Delete-stale: codes that Meta no longer reports for this phone number.
  let removed = 0
  for (const [code, id] of existingByCode.entries()) {
    if (freshCodes.has(code)) continue
    const { error } = await supabase.from('wa_qr_codes').delete()
      .eq('id', id).eq('tenant_id', tenantId)
    if (error) {
      console.warn(`[wa-connect] could not delete stale qr code=${code}: ${error.message}`)
      continue
    }
    removed++
  }

  return { fetched: fresh.length, added, updated, removed }
}

// ── WhatsApp Calling settings sync ──────────────────────────────────────────
// Meta endpoint: GET /{phone_number_id}/settings?fields=calling
// Returns: { calling: { status, call_icon_visibility,
//                        callback_permission_status, call_hours?, sip? },
//            storage_configuration: { status } }
//
// SCHEMA GAP (FLAGGED): there is no `wa_calling_settings` table. The
// migration-035 series stores per-tenant calling FEATURE columns directly on
// `public.tenants` (recording_default, consent_default, call_minutes_*) — these
// are OUR settings (retention, billing caps) not META's settings (whether
// calling is enabled on the phone number, callback policy, business hours).
//
// Without a target table we can't persist Meta's response. Two safe paths:
//   1. Skip persistence entirely; return the fetched payload in the /connect
//      response so the FE can show "Calling: NOT_SET — enable in Meta" without
//      a second round-trip.
//   2. Create a tenant_integrations row keyed `whatsapp_calling` with the
//      settings in metadata. Rejected: dual-source-of-truth confusion with
//      `tenants.*` calling columns + no FE reader yet.
//
// We take path (1): fetch + return + log, no DB write. The user can decide
// whether a `wa_calling_settings` table is worth adding once they see the
// shape Meta actually returns.

interface MetaCallingSettings {
  status?: string                       // ENABLED | DISABLED | NOT_SET
  call_icon_visibility?: string         // DEFAULT | DISABLED | ENABLED | NOT_SET
  callback_permission_status?: string   // GRANTED | DENIED | NOT_SET
  call_hours?: Record<string, unknown>
  sip?: Record<string, unknown>
}

async function syncWhatsAppCallingSettings(
  _supabase: SupabaseClient,
  _tenantId: string,
  phoneNumberId: string,
  accessToken: string,
): Promise<{
  enabled: boolean
  reason?: string
  settings?: MetaCallingSettings
}> {
  const r = await fetch(
    `${GRAPH}/${encodeURIComponent(phoneNumberId)}/settings?fields=calling`,
    { headers: { Authorization: `Bearer ${accessToken}` } },
  )
  if (!r.ok) {
    // Treat 400/404 as "calling not enabled on this phone number" — that's the
    // dominant failure mode for accounts that haven't been admitted to Meta's
    // Business Calling rollout. Anything else (5xx, 403) bubbles up so the
    // /connect tail can log it in `warnings`.
    if (r.status === 400 || r.status === 404) {
      return { enabled: false, reason: `Meta returned ${r.status} — calling not enabled on this phone number` }
    }
    const txt = await r.text()
    throw new Error(`Meta calling ${r.status}: ${txt.slice(0, 200)}`)
  }
  const body = await r.json() as { calling?: MetaCallingSettings }
  const settings = body.calling

  // status='NOT_SET' is the "never enabled" sentinel — surface it as
  // enabled:false so the FE knows not to render a "Configure Calling" panel
  // pretending the feature is live.
  if (!settings || settings.status === 'NOT_SET' || settings.status === 'DISABLED') {
    return { enabled: false, reason: `Meta status=${settings?.status ?? 'missing'}`, settings }
  }
  return { enabled: true, settings }
}

export function createConnectorsRouter(deps: Deps): express.Router {
  const r = express.Router()
  const { supabase, requireAuth, identifyTenant, checkPermission } = deps

  // ── Public registry — used by FE AppsModal + Sidebar ──────────────────────
  r.get('/api/connectors/registry', (_req, res) => {
    res.json({ connectors: publicRegistry() })
  })

  /**
   * Build a uniform connection row (whether sourced from tenant_integrations,
   * the legacy `tenants` columns, or per-channel tables like tg_bots) so the
   * sidebar's CategorySections can group consistently.
   */
  function buildConnRow(args: {
    key: string
    status?: string
    brand_label?: string | null
    scope?: string | null
    last_used_at?: string | null
    token_expires_at?: string | null
    connected_at?: string | null
    metadata?: Record<string, unknown>
  }) {
    const def = getConnector(args.key)
    return {
      key:               args.key,
      name:              def?.name ?? args.key,
      category:          def?.category ?? 'other',
      isChannel:         !!def?.isChannel,
      channelFeatures:   def?.channelFeatures ?? [],
      status:            args.status ?? 'active',
      brand_label:       args.brand_label ?? null,
      scope:             args.scope ?? null,
      last_used_at:      args.last_used_at ?? null,
      token_expires_at:  args.token_expires_at ?? null,
      connected_at:      args.connected_at ?? null,
      metadata:          args.metadata ?? {},
      capabilities:      (def?.capabilities ?? []).filter(c => c.status !== 'planned'),
      icon:              def?.iconName ?? 'Box',
      color:             def?.brandColor ?? '#888',
    }
  }

  // ── List my tenant's connections with health flags ────────────────────────
  r.get('/api/connectors/connections',
    requireAuth, identifyTenant,
    async (req, res) => {
      const tenantId = (req as any).tenantId

      // 1. tenant_integrations rows (Airtable, Razorpay, Shopify, IG, Meta Ads, …)
      const { data: tiRows, error } = await supabase.from('tenant_integrations')
        .select('key, status, brand_label, scope, token_expires_at, last_used_at, metadata, connected_at')
        .eq('tenant_id', tenantId)
      if (error) { res.status(500).json({ error: error.message }); return }

      // Track keys we've already added so legacy-table synthesis below doesn't
      // produce duplicate rows when the same app exists in tenant_integrations
      // (e.g. google_sheets row + a legacy google_access_token on tenants).
      const seen = new Set<string>()
      const rows: ReturnType<typeof buildConnRow>[] = []

      for (const row of tiRows ?? []) {
        const expired = row.token_expires_at ? new Date(row.token_expires_at).getTime() < Date.now() : false
        rows.push(buildConnRow({
          key: row.key,
          status: expired ? 'expired' : (row.status ?? 'active'),
          brand_label: row.brand_label,
          scope: row.scope,
          last_used_at: row.last_used_at,
          token_expires_at: row.token_expires_at,
          connected_at: row.connected_at,
          metadata: row.metadata ?? {},
        }))
        seen.add(row.key)
      }

      // 2. tenants — WhatsApp + Google live here for legacy reasons. Skip any
      // key that's already been added from tenant_integrations. Critically:
      // gate WhatsApp on tenants.status === 'active' so a disconnected tenant
      // (waba_id is still present because it's NOT NULL) doesn't show up as
      // connected.
      const { data: tenant } = await supabase.from('tenants')
        .select('waba_id, display_phone, status, google_email, google_access_token')
        .eq('id', tenantId).maybeSingle()
      if (tenant?.waba_id && tenant.status === 'active' && !seen.has('whatsapp')) {
        rows.push(buildConnRow({ key: 'whatsapp', brand_label: tenant.display_phone ?? tenant.waba_id }))
        seen.add('whatsapp')
      }
      if (tenant?.google_access_token) {
        for (const k of ['google_drive', 'google_sheets', 'google_calendar', 'google_gmail']) {
          if (seen.has(k)) continue
          rows.push(buildConnRow({ key: k, brand_label: tenant.google_email ?? '' }))
          seen.add(k)
        }
      }

      // 3. tg_bots — Telegram lives in its own table
      const { data: tgBot } = await supabase.from('tg_bots')
        .select('bot_username, bot_id, created_at')
        .eq('tenant_id', tenantId).maybeSingle()
      if (tgBot?.bot_id && !seen.has('telegram')) {
        rows.push(buildConnRow({
          key: 'telegram',
          brand_label: tgBot.bot_username ? `@${tgBot.bot_username}` : `bot ${tgBot.bot_id}`,
          connected_at: tgBot.created_at,
        }))
      }

      res.json(rows)
    })

  // ── Connector HEALTH summary ─────────────────────────────────────────────
  // Powers /settings/connections in the FE. Per connector, returns:
  //   - everything from /api/connectors/connections (status, brand_label,
  //     expires, capabilities)
  //   - last inbound event (from messages, lead_rows ingest_source, or
  //     webhook_inbound_log) — answers "is data actually flowing in?"
  //   - alert level (none / warn / error) computed by combining:
  //       expired token → error
  //       no event in 7 days → warn (only for channels that should be live)
  //       active without errors → none
  //   - reasons (human-readable) tied to the alert level
  // Distinct from /api/connectors/connections because the FE only wants the
  // bigger payload on the settings page; the sidebar still uses the lighter
  // /connections endpoint.
  r.get('/api/connectors/health',
    requireAuth, identifyTenant,
    async (req, res) => {
      const tenantId = (req as any).tenantId as string

      // Reuse the existing connections roundup as the base shape.
      const [{ data: tiRows }, { data: tenant }, { data: tgBot }] = await Promise.all([
        supabase.from('tenant_integrations')
          .select('key, status, brand_label, scope, token_expires_at, last_used_at, metadata, connected_at')
          .eq('tenant_id', tenantId),
        supabase.from('tenants')
          .select('waba_id, display_phone, status, google_email, google_access_token, google_token_expiry')
          .eq('id', tenantId).maybeSingle(),
        supabase.from('tg_bots')
          .select('bot_username, bot_id, created_at')
          .eq('tenant_id', tenantId).maybeSingle(),
      ])

      const seen = new Set<string>()
      const out: any[] = []

      // Pull last-message-per-channel in a single grouped query. Used for
      // both warn-when-stale alerts and the "Last activity" display.
      const { data: lastEvents } = await supabase.rpc('connector_last_events', { p_tenant_id: tenantId })
        .then(r => r, () => ({ data: null }))
      // Fallback if the RPC isn't defined yet: best-effort, swallow any error.
      const lastByChannel: Record<string, string | null> = {}
      if (Array.isArray(lastEvents)) {
        for (const row of lastEvents as any[]) lastByChannel[row.channel] = row.last_at
      } else {
        // Soft fallback — query messages directly per channel. Bounded to 3
        // channels so this remains cheap.
        for (const ch of ['whatsapp', 'instagram', 'telegram']) {
          const { data } = await supabase.from('messages')
            .select('created_at').eq('tenant_id', tenantId).eq('channel', ch)
            .order('created_at', { ascending: false }).limit(1).maybeSingle()
          lastByChannel[ch] = (data as any)?.created_at ?? null
        }
      }

      const STALE_DAYS = 7
      const staleCutoff = Date.now() - STALE_DAYS * 86_400_000

      const enrich = (base: any) => {
        const def = getConnector(base.key)
        const lastEventAt = lastByChannel[base.key] ?? base.last_used_at ?? null
        const tokenExpiry = base.token_expires_at ? new Date(base.token_expires_at).getTime() : null
        const isExpired = !!tokenExpiry && tokenExpiry < Date.now()
        const isStale = def?.isChannel && lastEventAt && new Date(lastEventAt).getTime() < staleCutoff

        const reasons: string[] = []
        let alert: 'none' | 'warn' | 'error' = 'none'
        if (isExpired) { alert = 'error'; reasons.push('Access token expired — reconnect required') }
        if (isStale && alert === 'none') { alert = 'warn'; reasons.push(`No inbound activity in last ${STALE_DAYS} days`) }

        return { ...base, last_event_at: lastEventAt, alert, reasons }
      }

      for (const row of tiRows ?? []) {
        const expired = row.token_expires_at ? new Date(row.token_expires_at).getTime() < Date.now() : false
        out.push(enrich(buildConnRow({
          key: row.key,
          status: expired ? 'expired' : (row.status ?? 'active'),
          brand_label: row.brand_label,
          scope: row.scope,
          last_used_at: row.last_used_at,
          token_expires_at: row.token_expires_at,
          connected_at: row.connected_at,
          metadata: row.metadata ?? {},
        })))
        seen.add(row.key)
      }

      if (tenant?.waba_id && tenant.status === 'active' && !seen.has('whatsapp')) {
        out.push(enrich(buildConnRow({ key: 'whatsapp', brand_label: tenant.display_phone ?? tenant.waba_id })))
        seen.add('whatsapp')
      }
      if (tenant?.google_access_token) {
        const expired = tenant.google_token_expiry && new Date(tenant.google_token_expiry).getTime() < Date.now()
        for (const k of ['google_drive', 'google_sheets', 'google_calendar', 'google_gmail']) {
          if (seen.has(k)) continue
          out.push(enrich(buildConnRow({
            key: k,
            status: expired ? 'expired' : 'active',
            brand_label: tenant.google_email ?? '',
            token_expires_at: tenant.google_token_expiry,
          })))
          seen.add(k)
        }
      }
      if (tgBot?.bot_id && !seen.has('telegram')) {
        out.push(enrich(buildConnRow({
          key: 'telegram',
          brand_label: tgBot.bot_username ? `@${tgBot.bot_username}` : `bot ${tgBot.bot_id}`,
          connected_at: tgBot.created_at,
        })))
      }

      // Also include UNCONNECTED connectors as inert "available" rows so the
      // FE can render them as Connect-CTA cards without a separate request.
      for (const def of publicRegistry()) {
        if (seen.has(def.key)) continue
        out.push({
          key: def.key,
          name: def.name,
          category: def.category,
          isChannel: !!def.isChannel,
          channelFeatures: def.channelFeatures ?? [],
          status: 'not_connected',
          brand_label: null,
          scope: null,
          last_used_at: null,
          last_event_at: null,
          token_expires_at: null,
          connected_at: null,
          metadata: {},
          capabilities: def.capabilities ?? [],
          icon: def.iconName ?? 'Box',
          color: def.brandColor ?? '#888',
          alert: 'none',
          reasons: [],
        })
      }

      // Stable order: connected channels first, then connected non-channels,
      // then available channels, then available non-channels.
      const order = (r: any) => {
        const connected = r.status !== 'not_connected'
        return (connected ? 0 : 2) + (r.isChannel ? 0 : 1)
      }
      out.sort((a, b) => order(a) - order(b) || a.name.localeCompare(b.name))

      res.json({ connectors: out })
    })

  // ── WhatsApp manual-paste setup ───────────────────────────────────────────
  // Two endpoints for the guided wizard (FE: WhatsAppSetupWizard):
  //
  //   POST /api/connectors/whatsapp/test
  //     Validate {waba_id, phone_number_id, access_token} against Meta Graph
  //     WITHOUT writing to the DB. Returns business_name + phone display
  //     so the wizard can confirm "is this the right number?" before commit.
  //
  //   POST /api/connectors/whatsapp/connect-manual
  //     Same validation, then persists to tenants table + subscribes the
  //     WABA to the webhook. This is the non-OAuth path — for devs who own
  //     their own Meta app or solo founders who set up WABA directly via
  //     Business Manager. The OAuth path stays at /api/auth/facebook/connect-waba.
  const GRAPH_URL = 'https://graph.facebook.com/v18.0'

  async function validateWaCreds(waba_id: string, phone_number_id: string, access_token: string) {
    const headers = { Authorization: `Bearer ${access_token}` }
    const wabaRes = await fetch(`${GRAPH_URL}/${waba_id}?fields=name,currency,timezone_id`, { headers })
    const waba = await wabaRes.json() as any
    if (!wabaRes.ok || waba.error) {
      return { ok: false as const, error: waba.error?.message ?? `WABA lookup failed (HTTP ${wabaRes.status})` }
    }
    const phoneRes = await fetch(`${GRAPH_URL}/${phone_number_id}?fields=display_phone_number,verified_name,quality_rating,code_verification_status`, { headers })
    const phone = await phoneRes.json() as any
    if (!phoneRes.ok || phone.error) {
      return { ok: false as const, error: phone.error?.message ?? `Phone Number ID lookup failed (HTTP ${phoneRes.status})` }
    }
    return {
      ok: true as const,
      business_name: waba.name as string,
      display_phone: phone.display_phone_number as string,
      verified_name: phone.verified_name as string,
      quality: phone.quality_rating as string | undefined,
      verification: phone.code_verification_status as string | undefined,
    }
  }

  r.post('/api/connectors/whatsapp/test',
    requireAuth, identifyTenant,
    async (req, res) => {
      const { waba_id, phone_number_id, access_token } = (req.body ?? {}) as Record<string, string>
      if (!waba_id || !phone_number_id || !access_token) {
        res.status(400).json({ ok: false, error: 'waba_id, phone_number_id, access_token required' }); return
      }
      const result = await validateWaCreds(waba_id, phone_number_id, access_token).catch(e => ({
        ok: false as const,
        error: e?.message ?? 'network error contacting Meta Graph API',
      }))
      // Always 200 — the WIZARD wants to render the error inline, not get
      // bounced to a generic error page on 4xx/5xx.
      res.json(result)
    })

  r.post('/api/connectors/whatsapp/connect-manual',
    requireAuth, identifyTenant, checkPermission('settings', 'edit'),
    async (req, res) => {
      const tenantId = (req as any).tenantId as string
      const { waba_id, phone_number_id, access_token } = (req.body ?? {}) as Record<string, string>
      if (!waba_id || !phone_number_id || !access_token) {
        res.status(400).json({ ok: false, error: 'waba_id, phone_number_id, access_token required' }); return
      }
      // Validate first; refuse to persist garbage.
      const v = await validateWaCreds(waba_id, phone_number_id, access_token).catch(e => ({
        ok: false as const, error: e?.message ?? 'network error',
      }))
      if (!v.ok) { res.status(400).json(v); return }

      // Subscribe the app to the WABA webhook so inbound messages start
      // flowing. Failure here is non-fatal; the credentials are still
      // useful (manual webhook setup remains an option).
      const subRes = await fetch(`${GRAPH_URL}/${waba_id}/subscribed_apps`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${access_token}` },
      }).then(r => r.json()).catch(e => ({ error: { message: e?.message ?? 'fetch failed' } }))
      const webhookSubscribed = (subRes as any)?.success === true

      // Persist on the tenant. The tenants schema (002) already has these
      // columns since waba_id+phone_number_id+access_token are NOT NULL.
      const { error: upErr } = await supabase.from('tenants').update({
        waba_id,
        phone_number_id,
        access_token,
        business_name: v.business_name,
        display_phone: v.display_phone,
        status: 'active',
      }).eq('id', tenantId)
      if (upErr) { res.status(500).json({ ok: false, error: upErr.message }); return }

      res.json({
        ok: true,
        business_name: v.business_name,
        display_phone: v.display_phone,
        verified_name: v.verified_name,
        webhook_subscribed: webhookSubscribed,
        webhook_url: `${process.env.PUBLIC_API_URL ?? 'https://api.getfrequency.app'}/webhook/whatsapp`,
        verify_token_hint: 'See your META_VERIFY_TOKEN env var or the webhook setup docs',
      })
    })

  // ── Channel filter tabs (Inbox / Contacts / Campaigns) ───────────────────
  // Returns ONLY the connectors marked as `isChannel`. FE renders these as
  // [All] [WhatsApp ●] [Instagram ●] [Telegram ●] tabs above each unified view.
  // Previously this did N+1 DB roundtrips (one per channel-connector). Now
  // batched into 3 parallel queries (tenants / tg_bots / tenant_integrations)
  // and resolved in memory — fires on every sidebar mount + tenant switch
  // so the savings add up.
  r.get('/api/channels/connected',
    requireAuth, identifyTenant,
    async (req, res) => {
      const tenantId = (req as any).tenantId

      const [tenantRes, tgRes, integrationsRes] = await Promise.all([
        supabase.from('tenants').select('waba_id, status').eq('id', tenantId).maybeSingle(),
        supabase.from('tg_bots').select('tenant_id').eq('tenant_id', tenantId).maybeSingle(),
        supabase.from('tenant_integrations').select('key, status').eq('tenant_id', tenantId),
      ])

      const tenant = tenantRes.data
      const tgConnected = !!tgRes.data
      const intActiveByKey = new Map<string, boolean>()
      for (const r of (integrationsRes.data ?? []) as any[]) {
        intActiveByKey.set(r.key, r.status === 'active' || r.status == null)
      }

      const channels: { key: string; name: string; brandColor: string; iconName: string; connected: boolean }[] = []
      for (const def of CONNECTOR_REGISTRY) {
        if (!def.isChannel) continue

        let connected = false
        if      (def.key === 'whatsapp') connected = !!tenant?.waba_id && tenant.status === 'active'
        else if (def.key === 'telegram') connected = tgConnected
        else                             connected = intActiveByKey.get(def.key) === true

        if (connected) {
          channels.push({
            key: def.key,
            name: def.name,
            brandColor: def.brandColor,
            iconName: def.iconName,
            connected: true,
          })
        }
      }

      res.json({ channels })
    })

  // ── WhatsApp paste-credentials connect ────────────────────────────────────
  // The FE AppsModal posts {waba_id, phone_number_id, access_token} from an
  // inline form. We verify the token+phone pair against Meta Graph BEFORE
  // persisting — wrong creds fail loudly NOW instead of silently writing
  // garbage that breaks every downstream WhatsApp call.
  //
  // checkPermission's action type is 'view' | 'edit' | 'delete' — no 'create'
  // exists, so we gate this destructive-credentials write on 'edit' (same
  // privilege Razorpay/Slack/Shopify connects use; see razorpay.ts:81).
  r.post('/api/connectors/whatsapp/connect',
    requireAuth, identifyTenant, checkPermission('integrations', 'edit'),
    validateBody(WhatsAppConnectSchema),
    async (req, res) => {
      const tenantId = (req as any).tenantId
      const { waba_id, phone_number_id, access_token } = req.body as z.infer<typeof WhatsAppConnectSchema>

      // Verify with Meta — fetches display_phone_number + verified_name in one
      // round-trip so we can also populate the brand_label without a second call.
      let displayPhoneNumber: string
      let verifiedName: string | null = null
      try {
        const verifyRes = await fetch(
          `${GRAPH}/${encodeURIComponent(phone_number_id)}?fields=display_phone_number,verified_name&access_token=${encodeURIComponent(access_token)}`,
        )
        if (!verifyRes.ok) {
          let metaMessage = `Meta returned ${verifyRes.status}`
          try {
            const errBody = await verifyRes.json() as { error?: { message?: string } }
            if (errBody?.error?.message) metaMessage = errBody.error.message
          } catch { /* non-JSON body — keep the status fallback */ }
          res.status(400).json({ error: `Invalid WhatsApp credentials: ${metaMessage}` })
          return
        }
        const phoneData = await verifyRes.json() as { display_phone_number?: string; verified_name?: string }
        if (!phoneData.display_phone_number) {
          res.status(400).json({ error: 'Invalid WhatsApp credentials: Meta did not return a display_phone_number for this Phone Number ID' })
          return
        }
        displayPhoneNumber = phoneData.display_phone_number
        verifiedName = phoneData.verified_name ?? null
      } catch (e: any) {
        res.status(400).json({ error: `Invalid WhatsApp credentials: ${e?.message ?? 'Meta Graph call failed'}` })
        return
      }

      // Persist to the legacy tenants.* columns (same shape the embedded-signup
      // path writes — see index.ts:1544). status='active' flips a previously
      // disconnected tenant back on; updated_at touches the cache key.
      const { error } = await supabase.from('tenants').update({
        waba_id,
        phone_number_id,
        access_token,
        display_phone: displayPhoneNumber,
        status: 'active',
        ...(verifiedName ? { business_name: verifiedName } : {}),
        updated_at: new Date().toISOString(),
      }).eq('id', tenantId)
      if (error) { res.status(500).json({ error: error.message }); return }

      // ── Post-connect upstream sync ───────────────────────────────────────
      // Demo seed data in wa_templates / wa_business_profiles silently breaks
      // every paid downstream feature (broadcast send → "template not found",
      // profile shows wrong agency name). Run an inline sync so the moment
      // the FE refetches AppsModal / Inbox / Broadcasts it sees REAL Meta
      // data — not seeded mocks. Each sync is wrapped in its own try/catch:
      // a Meta hiccup here MUST NOT fail /connect (creds are already saved
      // and verified upstream). Instead we collect warnings and let the FE
      // surface a soft "sync queued for retry" hint if it cares.
      const userId = (req as any).user?.id as string | undefined
      const warnings: Array<{ scope: string; message: string }> = []

      // Lift each result into outer scope so the response payload can surface
      // real per-scope counts to the FE (success toast: "Synced 98 templates,
      // 9 flows, 12 products, 2 QR codes"). Defaults are zero-counts so a
      // thrown sync still yields a typed-shape response.
      let templatesResult: { fetched: number; inserted: number; updated: number; deletedStale: number } = { fetched: 0, inserted: 0, updated: 0, deletedStale: 0 }
      let profileSynced = false

      try {
        templatesResult = await syncWhatsAppTemplates(supabase, tenantId, waba_id, access_token, userId ?? null)
        console.log(`[wa-connect] tenant=${tenantId} templates synced: inserted=${templatesResult.inserted} updated=${templatesResult.updated} deletedStale=${templatesResult.deletedStale} fetched=${templatesResult.fetched}`)
      } catch (e: any) {
        console.warn(`[wa-connect] tenant=${tenantId} template sync failed: ${e?.message}`)
        warnings.push({ scope: 'templates', message: e?.message ?? 'unknown' })
      }

      try {
        await syncWhatsAppProfile(supabase, tenantId, phone_number_id, access_token)
        profileSynced = true
        console.log(`[wa-connect] tenant=${tenantId} profile synced`)
      } catch (e: any) {
        console.warn(`[wa-connect] tenant=${tenantId} profile sync failed: ${e?.message}`)
        warnings.push({ scope: 'profile', message: e?.message ?? 'unknown' })
      }

      // Track per-scope sync results so the FE success toast can show real
      // counts ("Synced 98 templates, 9 flows (definitions: 9, failed: 0),
      // 12 products, 2 QR codes") rather than a generic "Connected!".
      // Each scope defaults to a typed-shape with zero counts so the response
      // is uniform whether or not the sync block ran or threw.
      let flowsResult:           { fetched: number; inserted: number; updated: number; deletedStale: number } = { fetched: 0, inserted: 0, updated: 0, deletedStale: 0 }
      let flowDefinitionsResult: { fetched: number; updated: number; failed: number }                          = { fetched: 0, updated: 0, failed: 0 }
      let catalogResult:         { catalogs_found: number; products_fetched: number; products_added: number; products_updated: number; products_removed: number } = { catalogs_found: 0, products_fetched: 0, products_added: 0, products_updated: 0, products_removed: 0 }
      let qrResult:              { fetched: number; added: number; updated: number; removed: number }         = { fetched: 0, added: 0, updated: 0, removed: 0 }
      let callingResult:         { enabled: boolean; reason?: string; settings?: MetaCallingSettings }        = { enabled: false }

      try {
        flowsResult = await syncWhatsAppFlows(supabase, tenantId, waba_id, access_token, userId ?? null)
        console.log(`[wa-connect] tenant=${tenantId} flows synced: inserted=${flowsResult.inserted} updated=${flowsResult.updated} deletedStale=${flowsResult.deletedStale} fetched=${flowsResult.fetched}`)
      } catch (e: any) {
        console.warn(`[wa-connect] tenant=${tenantId} flow sync failed: ${e?.message}`)
        warnings.push({ scope: 'flows', message: e?.message ?? 'unknown' })
      }

      // ── Flow definitions ───────────────────────────────────────────────
      // Must run AFTER syncWhatsAppFlows — it operates on the rows that step
      // just inserted/updated. If flows itself failed, we still try this
      // step on whatever's already in wa_flows from previous runs (no-op if
      // empty).
      try {
        flowDefinitionsResult = await syncWhatsAppFlowDefinitions(supabase, tenantId, access_token)
        console.log(`[wa-connect] tenant=${tenantId} flow definitions synced: updated=${flowDefinitionsResult.updated} failed=${flowDefinitionsResult.failed} fetched=${flowDefinitionsResult.fetched}`)
      } catch (e: any) {
        console.warn(`[wa-connect] tenant=${tenantId} flow definitions sync failed: ${e?.message}`)
        warnings.push({ scope: 'flow_definitions', message: e?.message ?? 'unknown' })
      }

      // ── Catalog ────────────────────────────────────────────────────────
      try {
        catalogResult = await syncWhatsAppCatalog(supabase, tenantId, waba_id, access_token)
        console.log(`[wa-connect] tenant=${tenantId} catalog synced: catalogs=${catalogResult.catalogs_found} fetched=${catalogResult.products_fetched} added=${catalogResult.products_added} updated=${catalogResult.products_updated} removed=${catalogResult.products_removed}`)
      } catch (e: any) {
        console.warn(`[wa-connect] tenant=${tenantId} catalog sync failed: ${e?.message}`)
        warnings.push({ scope: 'catalog', message: e?.message ?? 'unknown' })
      }

      // ── QR codes ───────────────────────────────────────────────────────
      try {
        qrResult = await syncWhatsAppQRCodes(supabase, tenantId, phone_number_id, access_token)
        console.log(`[wa-connect] tenant=${tenantId} qr codes synced: fetched=${qrResult.fetched} added=${qrResult.added} updated=${qrResult.updated} removed=${qrResult.removed}`)
      } catch (e: any) {
        console.warn(`[wa-connect] tenant=${tenantId} qr code sync failed: ${e?.message}`)
        warnings.push({ scope: 'qr_codes', message: e?.message ?? 'unknown' })
      }

      // ── Calling settings ───────────────────────────────────────────────
      // Read-only fetch + log; no DB write (no wa_calling_settings table —
      // see helper comment for rationale). 400/404 returned from helper as
      // {enabled:false, reason:...} rather than thrown.
      try {
        callingResult = await syncWhatsAppCallingSettings(supabase, tenantId, phone_number_id, access_token)
        console.log(`[wa-connect] tenant=${tenantId} calling settings: enabled=${callingResult.enabled} status=${callingResult.settings?.status ?? 'n/a'}`)
      } catch (e: any) {
        console.warn(`[wa-connect] tenant=${tenantId} calling settings sync failed: ${e?.message}`)
        warnings.push({ scope: 'calling', message: e?.message ?? 'unknown' })
      }

      res.json({
        success: true,
        brand_label: displayPhoneNumber,
        synced: {
          templates:        templatesResult,
          profile:          { synced: profileSynced },
          flows:            flowsResult,
          flow_definitions: flowDefinitionsResult,
          catalog:          catalogResult,
          qr_codes:         qrResult,
          calling:          callingResult,
        },
        ...(warnings.length ? { warnings } : {}),
      })
    })

  // ── Send WhatsApp template message ────────────────────────────────────────
  // Dedicated handler that matches the registry's send_template inputSchema
  // exactly so the ConnectorCapabilityPage form renders correctly. Same
  // pattern Razorpay create_payment_link uses — flat input fields, JSON
  // parse the template_params string server-side, real Meta Graph call.
  // The /api/inbox/send endpoint stays for the inbox composer + workflow
  // engine (which build a different shape).
  const SendTemplateSchema = z.object({
    phone:           z.string().min(8).max(20),
    template_name:   z.string().min(1).max(100),
    template_params: z.string().optional(),
    language:        z.string().min(2).max(10).optional(),
  })

  r.post('/api/connectors/whatsapp/send-template',
    requireAuth, identifyTenant, checkPermission('inbox', 'edit'),
    validateBody(SendTemplateSchema),
    async (req, res) => {
      try {
        const tenantId = (req as any).tenantId
        const { phone, template_name, template_params, language } = req.body as z.infer<typeof SendTemplateSchema>

        let params: string[] = []
        if (template_params && template_params.trim() !== '') {
          try {
            const parsed = JSON.parse(template_params)
            if (Array.isArray(parsed)) params = parsed.map((p: unknown) => String(p))
            else { res.status(400).json({ error: 'template_params must be a JSON array of strings' }); return }
          } catch {
            res.status(400).json({ error: 'template_params must be valid JSON — e.g. ["Asha", "1499"]' }); return
          }
        }

        const { data: tenant } = await supabase.from('tenants')
          .select('phone_number_id, access_token, status').eq('id', tenantId).single()
        if (!tenant || tenant.status !== 'active') {
          res.status(400).json({ error: 'WhatsApp not connected — connect via Apps modal first' }); return
        }

        const components = params.length ? [{
          type: 'body',
          parameters: params.map(p => ({ type: 'text', text: p })),
        }] : []

        const r2 = await fetch(`${GRAPH}/${tenant.phone_number_id}/messages`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${tenant.access_token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            messaging_product: 'whatsapp',
            to: phone,
            type: 'template',
            template: {
              name: template_name,
              language: { code: language ?? 'en_US' },
              ...(components.length ? { components } : {}),
            },
          }),
        })
        const body = await r2.json() as any
        if (!r2.ok) {
          res.status(r2.status).json({ error: body.error?.message ?? `Meta returned ${r2.status}` })
          return
        }
        res.json({
          message_id:    body.messages?.[0]?.id,
          to:            phone,
          template_name,
          status:        'queued',
        })
      } catch (err: any) { res.status(500).json({ error: err.message }) }
    })

  // ── Disconnect (revokes local; user revokes upstream from provider dashboard) ──
  // Three storage shapes have to be handled:
  //   1. tenant_integrations rows  → delete the row (Airtable, Razorpay, …)
  //   2. tg_bots                   → delete the bot row (Telegram)
  //   3. tenants.* legacy columns  → flip tenants.status to 'disconnected'
  //                                  (WhatsApp) or NULL google_* fields (Google).
  // The previous version only did (1), so clicking "Disconnect" on WhatsApp
  // returned 200 OK while leaving tenants.waba_id intact — the next read of
  // /api/connectors/connections still saw it as connected.
  // Disconnect is a destructive operation — gated by integrations:delete so
  // read-only roles (viewer / analyst / support_agent) can't yank a tenant's
  // WhatsApp / Google / Telegram out from under the team.
  r.post('/api/connectors/:key/disconnect',
    requireAuth, identifyTenant, checkPermission('integrations', 'delete'),
    async (req, res) => {
      const tenantId = (req as any).tenantId
      const key = String(req.params.key ?? '')

      // ── Channel-specific disconnect side effects ──
      if (key === 'telegram') {
        const { error } = await supabase.from('tg_bots').delete().eq('tenant_id', tenantId)
        if (error) { res.status(500).json({ error: error.message }); return }
      }

      if (key === 'whatsapp') {
        // tenants.waba_id is NOT NULL + UNIQUE — we can't null it out without a
        // schema change. Flipping status to 'disconnected' and clearing the
        // access_token is the supported route. The read endpoints below now
        // filter by status, so the channel disappears from the UI.
        const { error } = await supabase.from('tenants').update({
          status: 'disconnected',
          access_token: '',  // belt-and-braces: revoke local copy of the Meta token
          updated_at: new Date().toISOString(),
        }).eq('id', tenantId)
        if (error) { res.status(500).json({ error: error.message }); return }
        res.json({ success: true })
        return
      }

      if (key.startsWith('google_')) {
        // The four google_* keys all share one OAuth token on the tenants row.
        // Disconnecting any one of them revokes the shared credential, so all
        // four go away in /api/connectors/connections together — that's the
        // honest behaviour given how the token is stored.
        const { error } = await supabase.from('tenants').update({
          google_email:         null,
          google_access_token:  null,
          google_refresh_token: null,
          google_token_expiry:  null,
          updated_at: new Date().toISOString(),
        }).eq('id', tenantId)
        if (error) { res.status(500).json({ error: error.message }); return }
        res.json({ success: true })
        return
      }

      // ── Generic path: row in tenant_integrations ──
      const { error } = await supabase.from('tenant_integrations').delete()
        .eq('tenant_id', tenantId).eq('key', key)
      if (error) { res.status(500).json({ error: error.message }); return }
      res.json({ success: true })
    })

  // ── Mount per-connector routers ───────────────────────────────────────────
  // Each adds its own OAuth start/callback + capability endpoints under
  //   /api/auth/<key>/...
  //   /api/connectors/<key>/...
  r.use(createAirtableConnector(deps))
  r.use(createRazorpayConnector(deps))
  r.use(createShopifyConnector(deps))
  r.use(createSlackConnector(deps))

  // ── Google OAuth start routes — mounted inline (sub-router nesting causes
  // path-resolution quirks in Express when using full /api/auth/... paths) ────
  // All four Google app keys share the same combined scope; one token covers all.
  for (const googleKey of ['google_drive', 'google_sheets', 'google_calendar', 'google_gmail'] as const) {
    r.get(`/api/auth/${googleKey}/start`,
      requireAuth, identifyTenant,
      (req, res) => {
        const clientId = process.env.GOOGLE_CLIENT_ID
        if (!clientId || !process.env.GOOGLE_CLIENT_SECRET) {
          // Post back ok:false so the FE shows the actual error instead of
          // either a misleading "connected" toast or a "Window closed before
          // connection completed" timeout when the popup just closes silently.
          const message = 'Google OAuth not configured (GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET env vars missing on the server)'
          // B10: pin postMessage targetOrigin to FRONTEND_URL.
          const FRONTEND_ORIGIN = process.env.FRONTEND_URL || 'http://localhost:5173'
          res.status(503).type('html').send(`<!doctype html><html><head><meta charset="utf-8"><title>Google not configured</title></head><body style="font-family:DM Sans,system-ui;background:#0d1117;color:#fff;padding:24px;text-align:center;">
            <h2>⚠ Google OAuth not configured</h2>
            <p style="opacity:.6">This window will close…</p>
            <script>
              try { window.opener?.postMessage({ ok: false, message: ${JSON.stringify(message)} }, ${JSON.stringify(FRONTEND_ORIGIN)}) } catch(e){}
              setTimeout(() => { try { window.close(); } catch(e){} }, 1500);
            </script></body></html>`)
          return
        }
        const userId   = (req as any).user?.id   as string
        const tenantId = (req as any).tenantId   as string
        const redirectUri = process.env.GOOGLE_REDIRECT_URI || 'http://localhost:3001/api/auth/google/callback'
        // B4: signed state with 10-min TTL + nonce + bound connectorKey.
        const statePayload = signOauthState({ userId, tenantId, connectorKey: googleKey })
        const scopes = [
          'https://www.googleapis.com/auth/calendar',
          'https://www.googleapis.com/auth/spreadsheets',
          'https://www.googleapis.com/auth/drive.readonly',
          'https://www.googleapis.com/auth/drive.file',
          'https://www.googleapis.com/auth/gmail.modify',
          'email', 'profile',
        ].join(' ')
        const params = new URLSearchParams({
          client_id:     clientId,
          redirect_uri:  redirectUri,
          response_type: 'code',
          scope:         scopes,
          access_type:   'offline',
          prompt:        'consent',
          state:         statePayload,
        })
        console.log(`[google-connector] Starting OAuth for key=${googleKey} tenant=${tenantId}`)
        res.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`)
      })
  }

  return r
}
