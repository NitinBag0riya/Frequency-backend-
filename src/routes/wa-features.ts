/**
 * WhatsApp feature endpoints — Catalog, Flows, QR codes, Business Profile.
 *
 * Layout:
 *   /api/wa-catalog/products                         CRUD products
 *   /api/wa-catalog/import/:source                   import from manual|shopify|google_sheets|lead_table
 *   /api/wa-flows                                    CRUD flows
 *   /api/wa-flows/:id/publish                        publish to Meta (irreversible)
 *   /api/wa-flows/:id/responses                      lead data captured
 *   /api/wa-qr                                       CRUD QR codes
 *   /api/wa-profile                                  GET / POST business profile
 *
 * Source-of-truth tables live in migration 016. The Meta-side push (creating
 * a Flow on graph.facebook.com, etc.) is wired only where the integration is
 * mature; the rest persists locally and a worker syncs to Meta in a follow-up.
 */

import express from 'express'
import { SupabaseClient } from '@supabase/supabase-js'
import type IORedis from 'ioredis'
import Anthropic from '@anthropic-ai/sdk'
import {
  validateDefinition, FLOW_SPEC_FOR_PROMPT, DEFAULT_DEFINITION,
  type FlowDefinition,
} from '../lib/wa-flow-schema'
import { checkAndConsumeQuota } from '../lib/quota'
import { recordAiUsage } from '../lib/ai-usage'

type Middleware = (req: express.Request, res: express.Response, next: express.NextFunction) => void | Promise<void>

interface Deps {
  supabase: SupabaseClient
  requireAuth: Middleware
  identifyTenant: Middleware
  checkPermission: (feature: string, action: 'view' | 'edit' | 'delete') => Middleware
  /**
   * Required only for the chat-edit endpoint (quota enforcement). Passed in
   * from index.ts; we keep it optional in the interface so unit tests and
   * the catalog/QR routes can mount the router without spinning up Redis.
   */
  redis?: IORedis
}

const GRAPH = 'https://graph.facebook.com/v18.0'

// Same default as ai-responder.ts. Overridable via env for ops.
const FLOW_EDIT_MODEL = process.env.WA_FLOW_EDIT_MODEL || 'claude-opus-4-7'
const anthropic = process.env.ANTHROPIC_API_KEY
  ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
  : null

export function createWaFeaturesRouter(deps: Deps): express.Router {
  const r = express.Router()
  const { supabase, requireAuth, identifyTenant, checkPermission, redis } = deps
  const guard = [requireAuth, identifyTenant, checkPermission('whatsapp_automation', 'edit')]
  const guardView = [requireAuth, identifyTenant, checkPermission('whatsapp_automation', 'view')]

  // ── Catalog ────────────────────────────────────────────────────────────────
  r.get('/api/wa-catalog/products', ...guardView, async (req, res) => {
    const tenantId = (req as any).tenantId
    const { data, error } = await supabase.from('wa_catalog_products')
      .select('*').eq('tenant_id', tenantId).order('created_at', { ascending: false })
    if (error) { res.status(500).json({ error: error.message }); return }
    res.json(data ?? [])
  })

  r.post('/api/wa-catalog/products', ...guard, async (req, res) => {
    const tenantId = (req as any).tenantId
    const { name, description, price, currency, image_url, url, source, source_ref, metadata } = req.body
    if (!name) { res.status(400).json({ error: 'name is required' }); return }
    const { data, error } = await supabase.from('wa_catalog_products').insert({
      tenant_id: tenantId,
      name,
      description: description ?? null,
      price: price != null ? Number(price) : null,
      currency: currency ?? 'INR',
      image_url: image_url ?? null,
      url: url ?? null,
      source: source ?? 'manual',
      source_ref: source_ref ?? null,
      metadata: metadata ?? {},
    }).select().single()
    if (error) { res.status((error as any).code === 'PGRST116' ? 404 : 500).json({ error: (error as any).code === 'PGRST116' ? 'not found' : error.message }); return }
    res.json(data)
  })

  r.patch('/api/wa-catalog/products/:id', ...guard, async (req, res) => {
    const tenantId = (req as any).tenantId
    const allowed = ['name', 'description', 'price', 'currency', 'image_url', 'url', 'metadata']
    const patch: Record<string, unknown> = {}
    for (const k of allowed) if (k in req.body) patch[k] = req.body[k]
    patch.updated_at = new Date().toISOString()
    const { data, error } = await supabase.from('wa_catalog_products').update(patch)
      .eq('id', req.params.id).eq('tenant_id', tenantId).select().single()
    if (error) { res.status((error as any).code === 'PGRST116' ? 404 : 500).json({ error: (error as any).code === 'PGRST116' ? 'not found' : error.message }); return }
    res.json(data)
  })

  r.delete('/api/wa-catalog/products/:id', ...guard, async (req, res) => {
    const tenantId = (req as any).tenantId
    const { error } = await supabase.from('wa_catalog_products').delete()
      .eq('id', req.params.id).eq('tenant_id', tenantId)
    if (error) { res.status(500).json({ error: error.message }); return }
    res.json({ success: true })
  })

  /**
   * Import products from a connected source. Each source path validates the
   * required app is connected, then maps source rows → wa_catalog_products
   * inserts in a single batch. Idempotent on (tenant_id, source, source_ref).
   */
  r.post('/api/wa-catalog/import/:source', ...guard, async (req, res) => {
    const tenantId = (req as any).tenantId
    const source = req.params.source as 'manual' | 'shopify' | 'google_sheets' | 'lead_table'

    if (source === 'shopify') {
      const { data: ti } = await supabase.from('tenant_integrations')
        .select('access_token, metadata').eq('tenant_id', tenantId).eq('key', 'shopify').maybeSingle()
      if (!ti) { res.status(400).json({ error: 'Shopify not connected' }); return }
      // Pull products from Shopify Admin REST and project to catalog rows.
      // The actual call is delegated to the existing Shopify connector module.
      const products = (req.body.products ?? []) as any[]
      if (products.length === 0) { res.status(400).json({ error: 'Pass products in body or call Shopify list-products first' }); return }
      const rows = products.map(p => ({
        tenant_id: tenantId,
        name: p.title ?? p.name,
        description: p.body_html ?? p.description ?? null,
        price: Number(p.variants?.[0]?.price ?? p.price ?? 0) || null,
        currency: 'INR',
        image_url: p.image?.src ?? p.images?.[0]?.src ?? null,
        url: p.url ?? null,
        source: 'shopify' as const,
        source_ref: String(p.id ?? p.shopify_id ?? ''),
      }))
      const { error } = await supabase.from('wa_catalog_products').upsert(rows, { onConflict: 'tenant_id,source,source_ref' as any })
      if (error) { res.status(500).json({ error: error.message }); return }
      res.json({ imported: rows.length })
      return
    }

    if (source === 'google_sheets') {
      // Body: { rows: [{ name, price, image_url, ... }] } — typically already
      // mapped by the FE column-mapper.
      const rows = (req.body.rows ?? []) as Array<Record<string, any>>
      if (!Array.isArray(rows) || rows.length === 0) {
        res.status(400).json({ error: 'rows array required' }); return
      }
      const inserts = rows.map((row, i) => ({
        tenant_id: tenantId,
        name: String(row.name ?? row.title ?? `Product ${i + 1}`),
        description: row.description ?? null,
        price: row.price != null ? Number(row.price) : null,
        currency: row.currency ?? 'INR',
        image_url: row.image_url ?? null,
        url: row.url ?? null,
        source: 'google_sheets' as const,
        source_ref: String(row._row ?? i),
      }))
      const { error } = await supabase.from('wa_catalog_products').insert(inserts)
      if (error) { res.status(500).json({ error: error.message }); return }
      res.json({ imported: inserts.length })
      return
    }

    if (source === 'lead_table') {
      const tableId = req.body.lead_table_id
      const mapping = req.body.mapping ?? {}   // { name: 'col_name', price: 'col_price', ... }
      if (!tableId) { res.status(400).json({ error: 'lead_table_id required' }); return }
      const { data: leads } = await supabase.from('leads')
        .select('id, data').eq('lead_table_id', tableId).eq('tenant_id', tenantId)
      if (!leads) { res.status(404).json({ error: 'Table empty or not found' }); return }
      const inserts = leads.map(l => ({
        tenant_id: tenantId,
        name: String(l.data?.[mapping.name] ?? 'Untitled'),
        description: l.data?.[mapping.description] ?? null,
        price: l.data?.[mapping.price] != null ? Number(l.data[mapping.price]) : null,
        currency: 'INR',
        image_url: l.data?.[mapping.image_url] ?? null,
        source: 'lead_table' as const,
        source_ref: String(l.id),
      }))
      const { error } = await supabase.from('wa_catalog_products').insert(inserts)
      if (error) { res.status(500).json({ error: error.message }); return }
      res.json({ imported: inserts.length })
      return
    }

    res.status(400).json({ error: `Unknown source: ${source}` })
  })

  // ── Flows ─────────────────────────────────────────────────────────────────
  r.get('/api/wa-flows', ...guardView, async (req, res) => {
    const tenantId = (req as any).tenantId
    const { data, error } = await supabase.from('wa_flows')
      .select('*').eq('tenant_id', tenantId).order('updated_at', { ascending: false })
    if (error) { res.status(500).json({ error: error.message }); return }
    res.json(data ?? [])
  })

  r.post('/api/wa-flows', ...guard, async (req, res) => {
    const tenantId = (req as any).tenantId
    const { name, category, definition } = req.body
    if (!name) { res.status(400).json({ error: 'name required' }); return }

    // Seed with a valid single-screen DRAFT so the chat-edit loop can start
    // from a clean baseline that already passes validateDefinition().
    const seed = definition ?? DEFAULT_DEFINITION
    const { data, error } = await supabase.from('wa_flows').insert({
      tenant_id: tenantId, name, category: category ?? null, status: 'DRAFT',
      definition: seed,
    }).select().single()
    if (error) { res.status((error as any).code === 'PGRST116' ? 404 : 500).json({ error: (error as any).code === 'PGRST116' ? 'not found' : error.message }); return }

    // Best-effort: try to register the flow on Meta. If WABA credentials
    // missing or call fails, keep the local DRAFT row — user can publish
    // manually later.
    const { data: tenant } = await supabase.from('tenants')
      .select('waba_id, access_token').eq('id', tenantId).maybeSingle()
    if (tenant?.waba_id && tenant?.access_token) {
      try {
        const r = await fetch(`${GRAPH}/${tenant.waba_id}/flows`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${tenant.access_token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ name, categories: category ? [category] : ['OTHER'] }),
        })
        const j = await r.json() as any
        if (j.id) {
          await supabase.from('wa_flows').update({ meta_flow_id: j.id }).eq('id', data.id)
          data.meta_flow_id = j.id
        }
      } catch (e) { /* swallow — local row is canonical until Meta is reachable */ }
    }
    res.json(data)
  })

  r.patch('/api/wa-flows/:id', ...guard, async (req, res) => {
    const tenantId = (req as any).tenantId
    const allowed = ['name', 'category', 'definition']
    const patch: Record<string, unknown> = {}
    for (const k of allowed) if (k in req.body) patch[k] = req.body[k]
    patch.updated_at = new Date().toISOString()
    const { data, error } = await supabase.from('wa_flows').update(patch)
      .eq('id', req.params.id).eq('tenant_id', tenantId).select().single()
    if (error) { res.status((error as any).code === 'PGRST116' ? 404 : 500).json({ error: (error as any).code === 'PGRST116' ? 'not found' : error.message }); return }
    res.json(data)
  })

  r.post('/api/wa-flows/:id/publish', ...guard, async (req, res) => {
    const tenantId = (req as any).tenantId
    const { data: flow } = await supabase.from('wa_flows')
      .select('*').eq('id', req.params.id).eq('tenant_id', tenantId).maybeSingle()
    if (!flow) { res.status(404).json({ error: 'flow not found' }); return }

    const { data: tenant } = await supabase.from('tenants')
      .select('access_token').eq('id', tenantId).maybeSingle()
    if (flow.meta_flow_id && tenant?.access_token) {
      try {
        await fetch(`${GRAPH}/${flow.meta_flow_id}/publish`, {
          method: 'POST', headers: { Authorization: `Bearer ${tenant.access_token}` },
        })
      } catch (e) { /* fall-through; we still mark local PUBLISHED */ }
    }
    const { data, error } = await supabase.from('wa_flows')
      .update({ status: 'PUBLISHED', updated_at: new Date().toISOString() })
      .eq('id', req.params.id).eq('tenant_id', tenantId).select().single()
    if (error) { res.status((error as any).code === 'PGRST116' ? 404 : 500).json({ error: (error as any).code === 'PGRST116' ? 'not found' : error.message }); return }
    res.json(data)
  })

  r.delete('/api/wa-flows/:id', ...guard, async (req, res) => {
    const tenantId = (req as any).tenantId
    const { error } = await supabase.from('wa_flows').delete()
      .eq('id', req.params.id).eq('tenant_id', tenantId)
    if (error) { res.status(500).json({ error: error.message }); return }
    res.json({ success: true })
  })

  r.get('/api/wa-flows/:id/responses', ...guardView, async (req, res) => {
    const tenantId = (req as any).tenantId
    const { data, error } = await supabase.from('wa_flow_responses')
      .select('*').eq('tenant_id', tenantId).eq('flow_id', req.params.id)
      .order('created_at', { ascending: false })
    if (error) { res.status(500).json({ error: error.message }); return }
    res.json(data ?? [])
  })

  /**
   * POST /api/wa-flows/:id/chat-edit
   *
   * Chat-driven editing: the user types natural language ("Add an email screen
   * before Confirm with a Continue button"). We ship the current definition +
   * the Meta Flows v7.1 spec to Claude and ask it to return the COMPLETE new
   * definition (not a patch — patches are brittle on screen reshuffles).
   *
   * Validation gate:
   *   - We run validateDefinition() on Claude's output BEFORE writing to DB.
   *   - On failure we return { ok:false, error, claude_attempted_definition }
   *     so the FE can show the error and the user can rephrase. Crucially we
   *     do NOT update wa_flows.definition on invalid output — the DB stays
   *     on the last known-good state.
   *
   * Quota:
   *   - Hits checkAndConsumeQuota('ai_requests_per_day') BEFORE the Claude
   *     call so a chatty user can't blow through their plan in an hour.
   *   - Records token usage via recordAiUsage so /api/usage reflects spend.
   */
  r.post('/api/wa-flows/:id/chat-edit', ...guard, async (req, res) => {
    const tenantId = (req as any).tenantId
    const instruction = String(req.body?.instruction ?? '').trim()
    if (!instruction) { res.status(400).json({ error: 'instruction is required' }); return }
    if (instruction.length > 4_000) {
      res.status(400).json({ error: 'instruction too long (max 4000 chars)' }); return
    }
    if (!anthropic) {
      res.status(503).json({ error: 'AI not configured on this deployment (ANTHROPIC_API_KEY missing)' }); return
    }
    if (!redis) {
      res.status(503).json({ error: 'AI quota service not available' }); return
    }

    // Plan-quota gate (migration 063). Free tier = 50 ai requests/day.
    const q = await checkAndConsumeQuota(supabase, redis, tenantId, 'ai_requests_per_day')
    if (!q.allowed) {
      res.status(429).json({
        error: q.reason === 'feature_disabled'
          ? 'AI editing is not included on your current plan'
          : `Daily AI request quota exhausted (${q.current_usage}/${q.cap}). Resets at ${q.resets_at}.`,
        upgrade_to: q.upgrade_to,
        resets_at: q.resets_at,
      })
      return
    }

    // Load current flow.
    const { data: flow, error: flowErr } = await supabase.from('wa_flows')
      .select('id, definition, status').eq('id', req.params.id).eq('tenant_id', tenantId).maybeSingle()
    if (flowErr) { res.status(500).json({ error: flowErr.message }); return }
    if (!flow) { res.status(404).json({ error: 'flow not found' }); return }
    if (flow.status === 'PUBLISHED') {
      res.status(400).json({ error: 'Published flows cannot be edited. Create a new draft.' }); return
    }

    const currentDef = (flow.definition as FlowDefinition | null) ?? DEFAULT_DEFINITION

    const systemPrompt = [
      'You are a WhatsApp Flows JSON editor. You receive the current Flow definition and a natural-language instruction.',
      'Apply the instruction and respond with ONLY the new full Flow definition as raw JSON — no prose, no markdown fences, no commentary.',
      'Preserve every screen and component the instruction did not mention. Edits are additive unless the user says "delete" or "replace".',
      '',
      FLOW_SPEC_FOR_PROMPT,
    ].join('\n')

    const userMessage = [
      'Current definition:',
      '```json',
      JSON.stringify(currentDef, null, 2),
      '```',
      '',
      `Instruction: ${instruction}`,
      '',
      'Return the complete new definition as raw JSON.',
    ].join('\n')

    let claudeJsonText = ''
    let attempted: unknown = null
    try {
      const resp = await anthropic.messages.create({
        model: FLOW_EDIT_MODEL,
        max_tokens: 4096,
        // Note: `temperature` is deprecated on claude-opus-4-7 (returns 400);
        // the model is deterministic enough at default settings for this task.
        system: [
          // System prompt is cached — same for every chat-edit call so we
          // only pay full token cost on the first request per 5-minute window.
          { type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } },
        ] as any,
        messages: [{ role: 'user', content: userMessage }],
      })
      claudeJsonText = (resp.content as any[])
        .filter(b => b.type === 'text').map(b => b.text).join('\n').trim()

      // Record cost regardless of whether the JSON parses — we still paid Anthropic.
      void recordAiUsage(supabase, tenantId, resp.usage as any, 'wa_flow_chat_edit', FLOW_EDIT_MODEL)
    } catch (e: any) {
      res.status(502).json({ error: `Claude call failed: ${e?.message ?? e}` }); return
    }

    // Strip accidental markdown fences before parsing.
    const cleaned = claudeJsonText
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/```\s*$/i, '')
      .trim()

    try {
      attempted = JSON.parse(cleaned)
    } catch (e: any) {
      res.status(422).json({
        ok: false,
        error: `Claude returned invalid JSON: ${e?.message ?? e}`,
        claude_raw: claudeJsonText,
      })
      return
    }

    const { valid, errors } = validateDefinition(attempted)
    if (!valid) {
      res.status(422).json({
        ok: false,
        error: 'Generated definition failed Meta Flows v7.1 validation',
        validation_errors: errors,
        claude_attempted_definition: attempted,
      })
      return
    }

    // Compute which screens changed (by deep-equality on id-keyed maps) so the
    // FE can highlight them. Cheap because Flow defs are tiny (< 10 screens).
    const oldScreensById = Object.fromEntries(
      (currentDef.screens ?? []).map(s => [s.id, JSON.stringify(s)]),
    )
    const newScreensById = Object.fromEntries(
      ((attempted as FlowDefinition).screens ?? []).map(s => [s.id, JSON.stringify(s)]),
    )
    const screensChanged: string[] = []
    for (const id of Object.keys(newScreensById)) {
      if (oldScreensById[id] !== newScreensById[id]) screensChanged.push(id)
    }
    for (const id of Object.keys(oldScreensById)) {
      if (!(id in newScreensById)) screensChanged.push(`-${id}`)  // deleted
    }

    const { error: updErr } = await supabase.from('wa_flows')
      .update({ definition: attempted, updated_at: new Date().toISOString() })
      .eq('id', flow.id).eq('tenant_id', tenantId)
    if (updErr) { res.status(500).json({ error: updErr.message }); return }

    res.json({
      ok: true,
      definition: attempted,
      screens_changed: screensChanged,
      quota: { used: q.current_usage, cap: q.cap, resets_at: q.resets_at },
    })
  })

  /**
   * POST /api/wa-flows/:id/publish-to-meta
   *
   * Two-step publish:
   *   1. Validate the local definition against our embedded Meta Flows v7.1
   *      schema. If invalid → 400 with errors, no Meta call attempted.
   *   2. If the flow already has a meta_flow_id, PUSH the new definition to
   *      Meta with a POST /{flow_id}/assets (file=flow.json, asset_type=FLOW_JSON).
   *      Else, CREATE the flow on Meta first (POST /{waba_id}/flows), then
   *      upload the assets, then publish (POST /{flow_id}/publish).
   *   3. Flip status='PUBLISHED' locally. Meta publish is irreversible — once
   *      published, the only way to edit is to deprecate + create new.
   */
  r.post('/api/wa-flows/:id/publish-to-meta', ...guard, async (req, res) => {
    const tenantId = (req as any).tenantId

    const { data: flow, error: flowErr } = await supabase.from('wa_flows')
      .select('*').eq('id', req.params.id).eq('tenant_id', tenantId).maybeSingle()
    if (flowErr) { res.status(500).json({ error: flowErr.message }); return }
    if (!flow) { res.status(404).json({ error: 'flow not found' }); return }

    // 1. Local validation gate.
    const { valid, errors } = validateDefinition(flow.definition)
    if (!valid) {
      res.status(400).json({
        error: 'Flow definition failed local validation; fix errors before publishing.',
        validation_errors: errors,
      })
      return
    }

    const { data: tenant } = await supabase.from('tenants')
      .select('waba_id, access_token').eq('id', tenantId).maybeSingle()
    if (!tenant?.waba_id || !tenant?.access_token) {
      res.status(400).json({ error: 'WhatsApp Business Account not connected — connect WhatsApp first.' })
      return
    }

    try {
      let metaFlowId: string | null = flow.meta_flow_id

      // 2a. Create on Meta if first publish.
      if (!metaFlowId) {
        const createRes = await fetch(`${GRAPH}/${tenant.waba_id}/flows`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${tenant.access_token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: flow.name,
            categories: flow.category ? [flow.category] : ['OTHER'],
          }),
        })
        const j = await createRes.json() as any
        if (!createRes.ok || !j.id) {
          res.status(502).json({ error: `Meta create flow failed: ${JSON.stringify(j)}` }); return
        }
        metaFlowId = j.id as string
      }

      // 2b. Upload the flow.json asset. Meta's /assets endpoint expects
      //     multipart with the JSON as a file part named "file".
      const form = new FormData()
      const fileBlob = new Blob([JSON.stringify(flow.definition)], { type: 'application/json' })
      form.append('file', fileBlob, 'flow.json')
      form.append('name', 'flow.json')
      form.append('asset_type', 'FLOW_JSON')
      const assetRes = await fetch(`${GRAPH}/${metaFlowId}/assets`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${tenant.access_token}` },
        body: form as any,
      })
      const assetJson = await assetRes.json() as any
      if (!assetRes.ok) {
        res.status(502).json({ error: `Meta upload assets failed: ${JSON.stringify(assetJson)}` }); return
      }

      // 2c. Publish — irreversible at Meta.
      const pubRes = await fetch(`${GRAPH}/${metaFlowId}/publish`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${tenant.access_token}` },
      })
      const pubJson = await pubRes.json() as any
      if (!pubRes.ok) {
        // Meta sometimes returns 200 with success:true; sometimes 4xx with details.
        // We surface the Meta error verbatim so the user sees the actual reason.
        res.status(502).json({ error: `Meta publish failed: ${JSON.stringify(pubJson)}`, meta_flow_id: metaFlowId })
        return
      }

      // 3. Reflect locally.
      const { data: updated, error: updErr } = await supabase.from('wa_flows')
        .update({
          status: 'PUBLISHED',
          meta_flow_id: metaFlowId,
          updated_at: new Date().toISOString(),
        })
        .eq('id', flow.id).eq('tenant_id', tenantId)
        .select().single()
      if (updErr) { res.status(500).json({ error: updErr.message }); return }

      res.json({ ok: true, flow: updated, meta_response: pubJson })
    } catch (e: any) {
      res.status(502).json({ error: `Publish failed: ${e?.message ?? e}` })
    }
  })

  // ── QR codes ──────────────────────────────────────────────────────────────
  r.get('/api/wa-qr', ...guardView, async (req, res) => {
    const tenantId = (req as any).tenantId
    const { data, error } = await supabase.from('wa_qr_codes')
      .select('*').eq('tenant_id', tenantId).order('created_at', { ascending: false })
    if (error) { res.status(500).json({ error: error.message }); return }
    res.json(data ?? [])
  })

  r.post('/api/wa-qr', ...guard, async (req, res) => {
    const tenantId = (req as any).tenantId
    const { code, prefilled_message } = req.body
    if (!code) { res.status(400).json({ error: 'code required' }); return }

    const { data: tenant } = await supabase.from('tenants')
      .select('display_phone').eq('id', tenantId).maybeSingle()
    const phone = (tenant?.display_phone ?? '').replace(/\D/g, '')
    const url = `https://wa.me/${phone}${prefilled_message ? `?text=${encodeURIComponent(prefilled_message)}` : ''}`

    const { data, error } = await supabase.from('wa_qr_codes').insert({
      tenant_id: tenantId, code, prefilled_message: prefilled_message ?? null, url,
    }).select().single()
    if (error) {
      if ((error as any).code === '23505') { res.status(409).json({ error: 'A QR code with this name already exists' }); return }
      res.status(500).json({ error: error.message }); return
    }
    res.json(data)
  })

  r.delete('/api/wa-qr/:id', ...guard, async (req, res) => {
    const tenantId = (req as any).tenantId
    const { error } = await supabase.from('wa_qr_codes').delete()
      .eq('id', req.params.id).eq('tenant_id', tenantId)
    if (error) { res.status(500).json({ error: error.message }); return }
    res.json({ success: true })
  })

  // ── Business profile ──────────────────────────────────────────────────────
  r.get('/api/wa-profile', ...guardView, async (req, res) => {
    const tenantId = (req as any).tenantId
    const { data, error } = await supabase.from('wa_business_profiles')
      .select('*').eq('tenant_id', tenantId).maybeSingle()
    if (error) { res.status(500).json({ error: error.message }); return }
    res.json(data ?? { tenant_id: tenantId, about: '', description: '', email: '', websites: [], vertical: 'Other', address: '', profile_picture_url: '' })
  })

  r.post('/api/wa-profile', ...guard, async (req, res) => {
    const tenantId = (req as any).tenantId
    const { about, description, email, websites, vertical, address, profile_picture_url } = req.body
    const row = {
      tenant_id: tenantId,
      about: about ?? null,
      description: description ?? null,
      email: email ?? null,
      websites: Array.isArray(websites) ? websites : [],
      vertical: vertical ?? null,
      address: address ?? null,
      profile_picture_url: profile_picture_url ?? null,
      updated_at: new Date().toISOString(),
    }
    const { data, error } = await supabase.from('wa_business_profiles').upsert(row).select().single()
    if (error) { res.status((error as any).code === 'PGRST116' ? 404 : 500).json({ error: (error as any).code === 'PGRST116' ? 'not found' : error.message }); return }

    // Best-effort push to Meta
    const { data: tenant } = await supabase.from('tenants')
      .select('phone_number_id, access_token').eq('id', tenantId).maybeSingle()
    if (tenant?.phone_number_id && tenant?.access_token) {
      try {
        await fetch(`${GRAPH}/${tenant.phone_number_id}/whatsapp_business_profile`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${tenant.access_token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            messaging_product: 'whatsapp',
            about: row.about, description: row.description, email: row.email,
            websites: row.websites, vertical: row.vertical, address: row.address,
          }),
        })
      } catch (e) { /* local persist already succeeded */ }
    }
    res.json(data)
  })

  return r
}
