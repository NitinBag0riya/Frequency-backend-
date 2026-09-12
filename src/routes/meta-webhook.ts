/**
 * meta-webhook.ts — Lead Ads webhook (Facebook Page `leadgen` field).
 *
 *   GET  /webhooks/meta  — subscription verification handshake
 *   POST /webhooks/meta  — leadgen event delivery
 *
 * The GET path echoes hub.challenge if hub.verify_token matches
 * META_WEBHOOK_VERIFY_TOKEN (set that env var on the Fly app; Meta's App
 * Dashboard also carries it).
 *
 * The POST path verifies X-Hub-Signature-256 (HMAC-SHA256 over the raw
 * request bytes with META_APP_SECRET as the key) BEFORE any DB work. The
 * express.raw() parser is mounted for this path in src/index.ts so req.body
 * arrives as a Buffer — never as a parsed object (parsing changes the
 * canonicalisation and breaks HMAC).
 *
 * On a valid leadgen change:
 *   1. Resolve tenant by page_id via meta_ad_pages.
 *   2. Fetch the lead payload via GET /{leadgen_id} with the PAGE token
 *      (user token can't retrieve individual leads).
 *   3. Upsert into lead_rows (dedup_key = leadgen_id).
 *
 * A default "Meta Lead Ads" lead_table is auto-created per tenant on the
 * first lead so leads-page rendering just works — merchants can move rows
 * into a purpose-built table later if they want.
 */

import express from 'express'
import { SupabaseClient } from '@supabase/supabase-js'
import { createHmac, timingSafeEqual } from 'crypto'
import { decrypt } from '../crypto'
import { GRAPH } from '../lib/meta-graph-sync'

interface Deps { supabase: SupabaseClient }

export function createMetaWebhookRouter(deps: Deps): express.Router {
  const r = express.Router()
  const { supabase } = deps

  // ── GET verification ──────────────────────────────────────────────────────
  r.get('/webhooks/meta', (req, res) => {
    const mode      = req.query['hub.mode']
    const token     = req.query['hub.verify_token']
    const challenge = req.query['hub.challenge']
    const expected  = process.env.META_WEBHOOK_VERIFY_TOKEN ?? ''
    if (mode === 'subscribe' && expected && token === expected) {
      res.status(200).send(String(challenge ?? ''))
      return
    }
    res.sendStatus(403)
  })

  // ── POST event ────────────────────────────────────────────────────────────
  r.post('/webhooks/meta', async (req, res) => {
    const sigHeader = req.header('x-hub-signature-256') || req.header('X-Hub-Signature-256')
    const rawBody = req.body as Buffer
    const appSecret = process.env.META_APP_SECRET || ''

    if (!Buffer.isBuffer(rawBody)) {
      // express.raw not mounted → refuse rather than hash the parsed object.
      console.warn('[meta-webhook] body is not a Buffer — raw parser missing on route')
      res.status(401).json({ error: 'invalid_signature' }); return
    }
    if (!verifyMetaSignature(rawBody, sigHeader, appSecret)) {
      console.warn('[meta-webhook] HMAC verification failed')
      res.status(401).json({ error: 'invalid_signature' }); return
    }

    // Always 200 after signature check so Meta doesn't retry on our
    // processing lag. Do the actual work asynchronously.
    res.sendStatus(200)

    let body: any
    try { body = JSON.parse(rawBody.toString('utf8')) }
    catch { console.warn('[meta-webhook] JSON parse failed (body verified but malformed)'); return }
    if (body?.object !== 'page') return   // only page objects carry leadgen changes

    const entries: any[] = Array.isArray(body?.entry) ? body.entry : []
    for (const entry of entries) {
      const changes: any[] = Array.isArray(entry?.changes) ? entry.changes : []
      for (const change of changes) {
        if (change?.field !== 'leadgen') continue
        const value = change.value ?? {}
        try {
          await processLeadgen(supabase, value)
        } catch (e: any) {
          console.error('[meta-webhook] processLeadgen failed:', e?.message ?? e)
        }
      }
    }
  })

  return r
}

// ── Signature verification (Meta X-Hub-Signature-256) ───────────────────────
function verifyMetaSignature(body: Buffer, header: string | undefined, secret: string): boolean {
  if (!header || !secret) return false
  const prefix = 'sha256='
  if (!header.startsWith(prefix)) return false
  const provided = header.slice(prefix.length)
  const expected = createHmac('sha256', secret).update(body).digest('hex')
  if (provided.length !== expected.length) return false
  try { return timingSafeEqual(Buffer.from(provided, 'utf8'), Buffer.from(expected, 'utf8')) }
  catch { return false }
}

// ── Leadgen change processor ─────────────────────────────────────────────────
interface LeadgenValue {
  leadgen_id?: string
  page_id?: string
  form_id?: string
  ad_id?: string
  adgroup_id?: string
  created_time?: number
}

async function processLeadgen(supabase: SupabaseClient, v: LeadgenValue) {
  const leadgenId = String(v.leadgen_id ?? '').trim()
  const pageId    = String(v.page_id ?? '').trim()
  if (!leadgenId || !pageId) return

  // Resolve tenant + page access token.
  const { data: page } = await supabase.from('meta_ad_pages')
    .select('tenant_id, page_access_token').eq('page_id', pageId).maybeSingle()
  if (!page?.tenant_id || !page.page_access_token) {
    console.warn(`[meta-webhook] page ${pageId} not linked to any tenant — skipping ${leadgenId}`)
    return
  }
  const tenantId = page.tenant_id as string
  const pageToken = decrypt(page.page_access_token)

  // Fetch the actual lead payload. field_data is a list of {name, values}
  // pairs where `name` matches the form question's short label.
  const j = await fetch(
    `${GRAPH}/${leadgenId}?fields=id,created_time,ad_id,form_id,field_data&access_token=${encodeURIComponent(pageToken)}`,
  ).then(r => r.json()) as any
  if (j?.error) {
    console.error(`[meta-webhook] fetch ${leadgenId} failed:`, j.error.message)
    return
  }

  // Flatten field_data → { question: value } for the leads UI.
  const flat: Record<string, string> = {}
  for (const fd of Array.isArray(j.field_data) ? j.field_data : []) {
    const key = String(fd?.name ?? '').trim()
    const vals = Array.isArray(fd?.values) ? fd.values : []
    if (key) flat[key] = vals.map((x: any) => String(x)).join(', ')
  }

  const formId = String(j.form_id ?? v.form_id ?? '').trim()
  const tableId = await ensureMetaLeadTable(supabase, tenantId)
  if (!tableId) {
    console.error(`[meta-webhook] could not resolve/create lead_table for tenant ${tenantId}`)
    return
  }

  // Resolve tenant-owner user_id — lead_rows.user_id is NOT NULL.
  const { data: tenant } = await supabase.from('tenants')
    .select('user_id').eq('id', tenantId).maybeSingle()
  const ownerId = tenant?.user_id as string | undefined
  if (!ownerId) {
    console.error(`[meta-webhook] tenant ${tenantId} has no user_id`)
    return
  }

  const payload = {
    source:        'meta_lead_ad',
    leadgen_id:    leadgenId,
    form_id:       formId,
    page_id:       pageId,
    ad_id:         j.ad_id ?? v.ad_id ?? null,
    created_time:  j.created_time ?? null,
    ...flat,
  }

  // Idempotent by (table_id, dedup_key=leadgen_id) — migration 058's
  // partial unique index. ON CONFLICT DO NOTHING via .upsert with the
  // ignoreDuplicates flag.
  const { error: insErr } = await supabase.from('lead_rows').upsert({
    table_id:  tableId,
    tenant_id: tenantId,
    user_id:   ownerId,
    data:      payload,
    dedup_key: leadgenId,
    status:    'new',
  }, { onConflict: 'table_id,dedup_key' as any, ignoreDuplicates: true } as any)
  if (insErr) console.error(`[meta-webhook] insert lead ${leadgenId}:`, insErr.message)
}

// Locate (or create) the default "Meta Lead Ads" lead_table for this tenant.
// Cached only via DB — this runs once per new tenant, then reuses forever.
async function ensureMetaLeadTable(supabase: SupabaseClient, tenantId: string): Promise<string | null> {
  const { data: existing } = await supabase.from('lead_tables')
    .select('id').eq('tenant_id', tenantId).eq('source', 'meta_lead_ad').maybeSingle()
  if (existing?.id) return existing.id as string

  const { data: tenant } = await supabase.from('tenants')
    .select('user_id').eq('id', tenantId).maybeSingle()
  const ownerId = tenant?.user_id as string | undefined
  if (!ownerId) return null

  const { data: created, error } = await supabase.from('lead_tables').insert({
    tenant_id:   tenantId,
    user_id:     ownerId,
    name:        'Meta Lead Ads',
    description: 'Leads captured from Facebook / Instagram Lead Ads',
    source:      'meta_lead_ad',
    source_config: { auto_created: true, created_by: 'meta-webhook' },
  }).select('id').single()
  if (error) { console.error('[meta-webhook] create lead_table failed:', error.message); return null }
  return created?.id as string
}
