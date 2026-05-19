/**
 * Shopify tenant-facing endpoints (P1 #11).
 *
 * Authenticated routes the FE Apps card consumes:
 *
 *   GET    /api/shopify/stores
 *     List all connected (non-uninstalled) Shopify stores for the tenant.
 *
 *   GET    /api/shopify/orders/recent?store_id=&limit=50
 *     Last N events from shopify_order_events for the picker's mini-feed.
 *
 *   POST   /api/shopify/stores/:id/disconnect
 *     Soft-disconnect: stamp uninstalled_at, clear the encrypted token
 *     so a compromised DB read can't reach it. The store row stays so the
 *     audit trail of past orders keeps its FK target. Reinstall path is
 *     OAuth → upsert (refreshes the row).
 *
 *   POST   /api/connectors/shopify/fulfill-order
 *     Workflow `shopify_fulfill_order` action target. Calls Shopify Admin
 *     POST /orders/:id/fulfillments.json to mark an order as fulfilled.
 *     Tenant must have the store connected.
 */

import express from 'express'
import { SupabaseClient } from '@supabase/supabase-js'
import { decrypt } from '../crypto'

type Middleware = (req: express.Request, res: express.Response, next: express.NextFunction) => void | Promise<void>

interface Deps {
  supabase: SupabaseClient
  requireAuth: Middleware
  identifyTenant: Middleware
  checkPermission: (feature: string, action: 'view' | 'edit' | 'delete') => Middleware
}

export function createShopifyRouter(deps: Deps): express.Router {
  const r = express.Router()
  const { supabase, requireAuth, identifyTenant, checkPermission } = deps
  const guardView = [requireAuth, identifyTenant]
  // No 'apps' permission key today — fall back to whatsapp_automation (the
  // legacy umbrella that role_definitions reliably grants for any tenant
  // that's been onboarded). Disconnect / fulfill are write operations on
  // an integration, so they should require the edit grant.
  const guardEdit = [requireAuth, identifyTenant, checkPermission('whatsapp_automation', 'edit')]

  // ── GET /api/shopify/stores ─────────────────────────────────────────────
  r.get('/api/shopify/stores', ...guardView, async (req, res) => {
    const tenantId = (req as any).tenantId
    const { data, error } = await supabase.from('shopify_stores')
      .select('id, shop_domain, shop_name, scope, installed_at, uninstalled_at, updated_at')
      .eq('tenant_id', tenantId)
      .order('installed_at', { ascending: false })
    if (error) { res.status(500).json({ error: error.message }); return }
    res.json({ stores: data ?? [] })
  })

  // ── GET /api/shopify/orders/recent?store_id=&limit= ─────────────────────
  r.get('/api/shopify/orders/recent', ...guardView, async (req, res) => {
    const tenantId = (req as any).tenantId
    const storeId  = String(req.query.store_id ?? '')
    const limit    = Math.min(Math.max(Number(req.query.limit ?? 50) | 0, 1), 200)
    let q = supabase.from('shopify_order_events')
      .select('id, store_id, shopify_order_id, shopify_order_number, topic, customer_phone, customer_email, customer_first_name, customer_last_name, total_inr_paise, currency, financial_status, fulfillment_status, received_at')
      .eq('tenant_id', tenantId)
      .order('received_at', { ascending: false })
      .limit(limit)
    if (storeId) q = q.eq('store_id', storeId)
    const { data, error } = await q
    if (error) { res.status(500).json({ error: error.message }); return }
    res.json({ orders: data ?? [] })
  })

  // ── POST /api/shopify/stores/:id/disconnect ─────────────────────────────
  r.post('/api/shopify/stores/:id/disconnect', ...guardEdit, async (req, res) => {
    const tenantId = (req as any).tenantId
    const id       = String(req.params.id)
    // Verify ownership via the tenant_id filter on the update (RLS would too,
    // but service-role bypasses RLS so we enforce here).
    const { data: store, error: getErr } = await supabase.from('shopify_stores')
      .select('id, shop_domain').eq('id', id).eq('tenant_id', tenantId).maybeSingle()
    if (getErr) { res.status(500).json({ error: getErr.message }); return }
    if (!store)  { res.status(404).json({ error: 'Store not found' }); return }
    const { error: upErr } = await supabase.from('shopify_stores').update({
      uninstalled_at:         new Date().toISOString(),
      access_token_encrypted: '',
      updated_at:             new Date().toISOString(),
    }).eq('id', id).eq('tenant_id', tenantId)
    if (upErr) { res.status(500).json({ error: upErr.message }); return }

    // Clear the tenant_integrations mirror too.
    await supabase.from('tenant_integrations')
      .update({ status: 'disconnected' })
      .eq('tenant_id', tenantId).eq('key', 'shopify')

    res.json({ success: true })
  })

  // ── POST /api/connectors/shopify/fulfill-order ──────────────────────────
  // Workflow action — pairs with the `shopify_fulfill_order` capability in
  // src/connectors/registry.ts. Body: { store_id, order_id, line_items?, tracking_number?, tracking_company? }
  r.post('/api/connectors/shopify/fulfill-order', ...guardEdit, async (req, res) => {
    const tenantId = (req as any).tenantId
    const { store_id, order_id, tracking_number, tracking_company, line_items, notify_customer } = req.body ?? {}
    if (!store_id || !order_id) { res.status(400).json({ error: 'store_id and order_id are required' }); return }

    const { data: store, error: getErr } = await supabase.from('shopify_stores')
      .select('shop_domain, access_token_encrypted')
      .eq('id', store_id).eq('tenant_id', tenantId).is('uninstalled_at', null).maybeSingle()
    if (getErr) { res.status(500).json({ error: getErr.message }); return }
    if (!store) { res.status(404).json({ error: 'Shopify store not connected for this tenant' }); return }

    const token = decrypt(store.access_token_encrypted)
    if (!token) { res.status(500).json({ error: 'Token decrypt failed' }); return }

    try {
      const url = `https://${store.shop_domain}/admin/api/2024-10/orders/${encodeURIComponent(String(order_id))}/fulfillments.json`
      const body: any = { fulfillment: { notify_customer: notify_customer !== false } }
      if (tracking_number)  body.fulfillment.tracking_number  = tracking_number
      if (tracking_company) body.fulfillment.tracking_company = tracking_company
      if (Array.isArray(line_items) && line_items.length > 0) body.fulfillment.line_items = line_items

      const r2 = await fetch(url, {
        method:  'POST',
        headers: {
          'X-Shopify-Access-Token': token,
          'Content-Type':            'application/json',
          Accept:                    'application/json',
        },
        body: JSON.stringify(body),
      })
      const text = await r2.text()
      let data: any = null
      try { data = text ? JSON.parse(text) : null } catch { /* non-JSON */ }
      if (!r2.ok) {
        res.status(502).json({ error: 'Shopify fulfill failed', status: r2.status, detail: data?.errors ?? text.slice(0, 300) })
        return
      }
      res.json({ success: true, fulfillment: data?.fulfillment ?? null })
    } catch (err: any) {
      res.status(502).json({ error: err?.message ?? 'fulfill threw' })
    }
  })

  return r
}
