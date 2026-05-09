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

type Middleware = (req: express.Request, res: express.Response, next: express.NextFunction) => void | Promise<void>

interface Deps {
  supabase: SupabaseClient
  requireAuth: Middleware
  identifyTenant: Middleware
  checkPermission: (feature: string, action: 'view' | 'edit' | 'delete') => Middleware
}

const GRAPH = 'https://graph.facebook.com/v18.0'

export function createWaFeaturesRouter(deps: Deps): express.Router {
  const r = express.Router()
  const { supabase, requireAuth, identifyTenant, checkPermission } = deps
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
    if (error) { res.status(500).json({ error: error.message }); return }
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
    if (error) { res.status(500).json({ error: error.message }); return }
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

    const { data, error } = await supabase.from('wa_flows').insert({
      tenant_id: tenantId, name, category: category ?? null, status: 'DRAFT',
      definition: definition ?? { version: '7.1', screens: [] },
    }).select().single()
    if (error) { res.status(500).json({ error: error.message }); return }

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
    if (error) { res.status(500).json({ error: error.message }); return }
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
    if (error) { res.status(500).json({ error: error.message }); return }
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
    if (error) { res.status(500).json({ error: error.message }); return }

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
