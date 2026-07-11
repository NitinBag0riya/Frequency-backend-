/**
 * Aggregator connector — source-agnostic Zomato/Swiggy order & stock management.
 *
 * Two surfaces:
 *
 *  A) FE/BE-facing normalised API (guarded)  /api/connectors/aggregator/*
 *     The dashboard order board + stock toggles call these. They never know or
 *     care which source is active — an adapter handles that.
 *
 *  B) DynoAPIs webhook contract (public, per-tenant token)
 *       /api/connectors/aggregator/dyno/:token/*
 *     The DynoAPIs desktop client on the MERCHANT's machine drives these. It
 *     pushes new orders to us and PULLS the decisions we queued, executes them
 *     against Zomato/Swiggy itself, and posts results back. Our servers never
 *     talk to the aggregators — the exact contract is reverse-engineered from
 *     the client (POST /orders, GET /:resId/orders/status, POST
 *     /orders/:orderId/status, GET /:resId/items, POST /:resId/items/status …).
 *
 * Adding UrbanPiper / official-direct later means a new adapter (surface A keeps
 * working unchanged) + its own inbound webhook if it has one — surface B is
 * DynoAPIs-specific and drops away when DynoAPIs does.
 */

import express from 'express'
import { z } from 'zod'
import { SupabaseClient } from '@supabase/supabase-js'
import crypto from 'crypto'
import { validateBody } from '../../validation'
import { resolveAdapter, normalizeStatus, AggregatorChannel } from '../../connectors/aggregator'
import { emitNotification } from '../notifications'

type Middleware = (req: express.Request, res: express.Response, next: express.NextFunction) => void | Promise<void>
interface Deps {
  supabase: SupabaseClient
  requireAuth: Middleware
  identifyTenant: Middleware
  checkPermission: (feature: string, action: 'view' | 'edit' | 'delete') => Middleware
}

const PUBLIC_BASE_URL = (process.env.PUBLIC_API_URL ?? 'http://localhost:3001').replace(/\/+$/, '')

// DynoAPIs order-status codes it expects in our poll responses / result posts.
const PULL_CODE  = { accept: 1, ready: 3, reject: -1 } as const   // we tell it what to do
const RESULT_MAP: Record<number, string> = { 2: 'preparing', 4: 'ready', [-2]: 'rejected' } // it tells us the outcome

function chan(vendor: unknown): AggregatorChannel {
  return String(vendor ?? '').toLowerCase() === 'swiggy' ? 'swiggy' : 'zomato'
}
const CHANNEL_LABEL: Record<AggregatorChannel, string> = { zomato: 'Zomato', swiggy: 'Swiggy' }
const STATUS_LABEL: Record<string, string> = {
  new: 'New', preparing: 'Preparing', ready: 'Ready', picked_up: 'Picked up',
  delivered: 'Delivered', rejected: 'Rejected', cancelled: 'Cancelled',
}
const CUR: Record<string, string> = { INR: '₹', USD: '$', EUR: '€', GBP: '£' }
function orderSummary(items: number, gross: number | null, currency = 'INR'): string {
  const amt = gross != null ? ` · ${CUR[currency] ?? currency}${Number(gross).toLocaleString('en-IN')}` : ''
  return `${items} item${items === 1 ? '' : 's'}${amt}`
}

interface ParsedEntity { entity_type: 'item' | 'category'; entity_id: string; name: string | null; in_stock: boolean; price: number | null; category_ref: string | null; raw: any }

/**
 * Parse a DynoAPIs menu snapshot into normalised item/category rows.
 * The aggregators' menu JSON is undocumented + varies, so this is best-effort
 * across common shapes and ALWAYS keeps the raw entity in `raw`.
 * TODO(menu-spec): tighten field names once a real snapshot is captured.
 */
function parseMenuSnapshot(body: any): ParsedEntity[] {
  const sr = body?.statusResponse ?? body?.data ?? body ?? {}
  const itemArr: any[] = Array.isArray(sr) ? sr : (sr.items ?? sr.data?.items ?? sr.menu?.items ?? [])
  const catArr: any[] = sr.categories ?? sr.data?.categories ?? sr.menu?.categories ?? []
  const bool = (v: any, dflt = true) => (v === undefined || v === null ? dflt : !(v === false || v === 0 || v === 'out_of_stock' || v === 'OUT_OF_STOCK'))
  const out: ParsedEntity[] = []
  for (const x of Array.isArray(itemArr) ? itemArr : []) {
    const id = x?.id ?? x?.item_id ?? x?.itemId ?? x?.entity_id
    if (id == null) continue
    out.push({
      entity_type: 'item', entity_id: String(id),
      name: x.name ?? x.title ?? x.item_name ?? null,
      in_stock: bool(x.inStock ?? x.in_stock ?? x.stockStatus ?? x.in_stock_status),
      price: x.price ?? x.cost ?? x.item_price ?? null,
      category_ref: x.category_id != null ? String(x.category_id) : (x.categoryId != null ? String(x.categoryId) : null),
      raw: x,
    })
  }
  for (const x of Array.isArray(catArr) ? catArr : []) {
    const id = x?.id ?? x?.category_id ?? x?.categoryId ?? x?.entity_id
    if (id == null) continue
    out.push({
      entity_type: 'category', entity_id: String(id),
      name: x.name ?? x.title ?? x.category_name ?? null,
      in_stock: bool(x.inStock ?? x.in_stock ?? x.stockStatus), price: null, category_ref: null, raw: x,
    })
  }
  return out
}

interface ParsedHistOrder { external_order_id: string; status: string | null; customer_name: string | null; item_count: number; gross_amount: number | null; placed_at: string | null; raw: any }

/**
 * Parse a DynoAPIs order-history snapshot into normalised past-order rows.
 * Zomato pushes an array of order-details; Swiggy pushes its history payload;
 * some shapes page under `pages[].orders`. Best-effort across all, raw retained.
 * TODO(history-spec): tighten once a real snapshot is captured.
 */
function parseOrderHistory(body: any): ParsedHistOrder[] {
  const sr = body?.statusResponse ?? body?.data ?? body ?? {}
  let orders: any[] = []
  if (Array.isArray(sr)) orders = sr
  else if (Array.isArray(sr.orders)) orders = sr.orders
  else if (Array.isArray(sr.data)) orders = sr.data
  else if (Array.isArray(sr.pages)) orders = sr.pages.flatMap((p: any) => (Array.isArray(p?.orders) ? p.orders : []))
  const out: ParsedHistOrder[] = []
  for (const o of orders) {
    const ord = o?.order ?? o
    const id = ord?.order_id ?? ord?.id ?? ord?.tab_id ?? ord?.orderId ?? o?.order_id ?? o?.id
    if (id == null) continue
    const itemsArr = Array.isArray(ord.items) ? ord.items : Array.isArray(ord.order_items) ? ord.order_items : []
    out.push({
      external_order_id: String(id),
      status: ord.state ?? ord.status ?? ord.order_status ?? null,
      customer_name: ord.customer?.name ?? ord.customer_name ?? null,
      item_count: itemsArr.reduce((n: number, it: any) => n + (Number(it.quantity ?? it.qty ?? 1) || 1), 0),
      gross_amount: ord.total_cost ?? ord.net_amount ?? ord.order_total ?? ord.grand_total ?? ord.total ?? null,
      placed_at: ord.created_at ?? ord.order_date ?? ord.placed_at ?? null,
      raw: o,
    })
  }
  return out
}

/** Best-effort customer/amount extraction — full raw order is always kept in payload. */
function extractSummary(data: any): { name: string | null; phone: string | null; items: number; gross: number | null } {
  const o = data?.order ?? data ?? {}
  const items = Array.isArray(o.items) ? o.items : Array.isArray(o.order_items) ? o.order_items : []
  return {
    name:  o.customer?.name ?? o.customer_name ?? null,
    phone: o.customer?.phone ?? o.customer_phone ?? null,   // aggregators mask this
    items: items.reduce((n: number, it: any) => n + (Number(it.quantity ?? it.qty ?? 1) || 1), 0),
    gross: o.total_cost ?? o.net_amount ?? o.order_total ?? o.grand_total ?? null,
  }
}

export function createAggregatorConnector(deps: Deps): express.Router {
  const r = express.Router()
  const { supabase, requireAuth, identifyTenant, checkPermission } = deps
  const guardEdit = [requireAuth, identifyTenant, checkPermission('integrations', 'edit')]
  const guardView = [requireAuth, identifyTenant, checkPermission('integrations', 'view')]

  // Active members of a tenant — the recipients for order notifications.
  const tenantRecipients = async (tenantId: string): Promise<string[]> => {
    const { data } = await supabase.from('user_role_assignments')
      .select('user_id').eq('tenant_id', tenantId).is('disabled_at', null)
    return Array.from(new Set((data ?? []).map((r: any) => r.user_id).filter(Boolean)))
  }

  // Ring the bell: emit an in-app notification for an order event. Fire-and-forget.
  const notifyOrder = async (
    tenantId: string,
    ev: { isNew: boolean; channel: AggregatorChannel; orderId: string; status: string; summary: string },
  ) => {
    try {
      const recipients = await tenantRecipients(tenantId)
      if (!recipients.length) return
      await emitNotification(supabase, {
        tenant_id: tenantId,
        event_key: ev.isNew ? 'order.new' : 'order.status',
        recipient_user_ids: recipients,
        link: '/orders',
        data: {
          channel: ev.channel, channel_label: CHANNEL_LABEL[ev.channel],
          order_id: ev.orderId, status: ev.status, status_label: STATUS_LABEL[ev.status] ?? ev.status,
          summary: ev.isNew ? `${ev.summary} — accept now` : ev.summary,
          priority: ev.isNew ? 'high' : 'normal',
        },
      })
    } catch (e: any) { console.warn(`[aggregator] notify failed (non-fatal): ${e?.message}`) }
  }

  // Bump the DynoAPIs liveness heartbeat (called from the regular poll).
  const bumpHeartbeat = async (tenantId: string) => {
    try {
      await supabase.from('aggregator_heartbeats').upsert(
        { tenant_id: tenantId, source: 'dynoapis', last_seen_at: new Date().toISOString(), updated_at: new Date().toISOString() },
        { onConflict: 'tenant_id' },
      )
    } catch { /* non-fatal */ }
  }

  // Best-effort channel for an outlet (from orders we've already seen).
  const channelForOutlet = async (tenantId: string, outletRef: string): Promise<string | null> => {
    const { data } = await supabase.from('aggregator_orders')
      .select('channel').eq('tenant_id', tenantId).eq('outlet_ref', outletRef).limit(1).maybeSingle()
    return (data as any)?.channel ?? null
  }

  // Ingest a full menu snapshot → upsert aggregator_menu (dedup on natural key),
  // then clear the outlet's pending_full_sync flag.
  const ingestMenu = async (tenantId: string, outletRef: string, body: any) => {
    const entities = parseMenuSnapshot(body)
    const channel = await channelForOutlet(tenantId, outletRef)
    const now = new Date().toISOString()
    if (entities.length) {
      const rows = entities.map(e => ({
        tenant_id: tenantId, source: 'dynoapis', channel, outlet_ref: outletRef,
        entity_type: e.entity_type, entity_id: e.entity_id, name: e.name,
        in_stock: e.in_stock, price: e.price, category_ref: e.category_ref,
        raw: e.raw, last_synced_at: now, updated_at: now,
      }))
      const { error } = await supabase.from('aggregator_menu')
        .upsert(rows, { onConflict: 'tenant_id,outlet_ref,entity_type,entity_id' })
      if (error) console.error(`[aggregator/menu] upsert failed: ${error.message}`)
    }
    await supabase.from('aggregator_menu_sync').upsert(
      { tenant_id: tenantId, outlet_ref: outletRef, pending_full_sync: false, last_synced_at: now, updated_at: now },
      { onConflict: 'tenant_id,outlet_ref' },
    )
    console.log(`[aggregator/menu] ingested ${entities.length} entities for outlet ${outletRef}`)
  }

  // Whether the next DynoAPIs items-poll should request a full menu pull.
  const needsFullSync = async (tenantId: string, outletRef: string): Promise<boolean> => {
    const { data } = await supabase.from('aggregator_menu_sync')
      .select('pending_full_sync').eq('tenant_id', tenantId).eq('outlet_ref', outletRef).maybeSingle()
    if (!data) {
      // No sync row yet → first time we see this outlet poll → request a pull
      // and record the intent so we don't hammer it every tick.
      await supabase.from('aggregator_menu_sync').upsert(
        { tenant_id: tenantId, outlet_ref: outletRef, pending_full_sync: true, updated_at: new Date().toISOString() },
        { onConflict: 'tenant_id,outlet_ref' },
      )
      return true
    }
    return !!(data as any).pending_full_sync
  }

  // Ingest an order-history snapshot → upsert aggregator_order_history (dedup on
  // natural key), then clear the outlet's history pending flag.
  const ingestHistory = async (tenantId: string, outletRef: string, body: any) => {
    const parsed = parseOrderHistory(body)
    const channel = await channelForOutlet(tenantId, outletRef)
    const now = new Date().toISOString()
    if (parsed.length) {
      const rows = parsed.map(o => ({
        tenant_id: tenantId, source: 'dynoapis', channel, outlet_ref: outletRef,
        external_order_id: o.external_order_id, status: o.status,
        customer_name: o.customer_name, item_count: o.item_count, gross_amount: o.gross_amount,
        placed_at: o.placed_at, raw: o.raw, updated_at: now,
      }))
      const { error } = await supabase.from('aggregator_order_history')
        .upsert(rows, { onConflict: 'tenant_id,outlet_ref,external_order_id' })
      if (error) console.error(`[aggregator/history] upsert failed: ${error.message}`)
    }
    await supabase.from('aggregator_history_sync').upsert(
      { tenant_id: tenantId, outlet_ref: outletRef, pending_full_sync: false, last_synced_at: now, updated_at: now },
      { onConflict: 'tenant_id,outlet_ref' })
    console.log(`[aggregator/history] ingested ${parsed.length} past order(s) for outlet ${outletRef}`)
  }

  // Whether the next orders poll should request a one-shot history backfill.
  const needsHistorySync = async (tenantId: string, outletRef: string): Promise<boolean> => {
    const { data } = await supabase.from('aggregator_history_sync')
      .select('pending_full_sync').eq('tenant_id', tenantId).eq('outlet_ref', outletRef).maybeSingle()
    if (!data) {
      await supabase.from('aggregator_history_sync').upsert(
        { tenant_id: tenantId, outlet_ref: outletRef, pending_full_sync: true, updated_at: new Date().toISOString() },
        { onConflict: 'tenant_id,outlet_ref' })
      return true
    }
    return !!(data as any).pending_full_sync
  }

  // ══════════════════════════════════════════════════════════════════════════
  // A) FE/BE-facing normalised API
  // ══════════════════════════════════════════════════════════════════════════

  // What can the active source actually do? FE reads this to enable/disable UI.
  r.get('/api/connectors/aggregator/capabilities', ...guardView, async (req, res) => {
    try {
      const tenantId = (req as any).tenantId
      const adapter = await resolveAdapter(supabase, tenantId)
      res.json({ source: adapter.source, capabilities: adapter.capabilities() })
    } catch (err: any) { res.status(err?.status ?? 500).json({ error: err.message }) }
  })

  // Operator order board (reads the normalised table).
  r.get('/api/connectors/aggregator/orders', ...guardView, async (req, res) => {
    try {
      let q = supabase.from('aggregator_orders')
        .select('id, source, channel, external_order_id, outlet_ref, status, status_identifier, customer_name, item_count, gross_amount, currency, placed_at, pending_action, last_action_result, updated_at')
        .eq('tenant_id', (req as any).tenantId)
        .order('placed_at', { ascending: false, nullsFirst: false })
        .limit(Math.min(Number(req.query.limit ?? 100), 200))
      if (req.query.channel) q = q.eq('channel', String(req.query.channel))
      if (req.query.status)  q = q.eq('status', String(req.query.status))
      const { data, error } = await q
      if (error) { res.status(500).json({ error: error.message }); return }
      res.json(data ?? [])
    } catch (err: any) { res.status(err?.status ?? 500).json({ error: err.message }) }
  })

  // Order decisions — accept / ready / reject. Routed through the active adapter.
  const loadOrder = async (tenantId: string, id: string) => {
    const { data } = await supabase.from('aggregator_orders')
      .select('external_order_id, channel, outlet_ref')
      .eq('tenant_id', tenantId).eq('id', id).maybeSingle()
    return data as { external_order_id: string; channel: AggregatorChannel; outlet_ref: string | null } | null
  }

  const AcceptBody = z.object({ prepTime: z.number().int().positive().max(240).optional() })
  r.post('/api/connectors/aggregator/orders/:id/accept', ...guardEdit, validateBody(AcceptBody), async (req, res) => {
    try {
      const tenantId = (req as any).tenantId
      const order = await loadOrder(tenantId, String(req.params.id))
      if (!order) { res.status(404).json({ error: 'Order not found' }); return }
      const adapter = await resolveAdapter(supabase, tenantId)
      if (!adapter.capabilities().orderStatus) { res.status(422).json({ error: `${adapter.source} cannot change order status` }); return }
      const out = await adapter.submitOrderDecision(
        { tenantId, source: adapter.source },
        { externalOrderId: order.external_order_id, channel: order.channel, outletRef: order.outlet_ref },
        { kind: 'accept', prepTime: (req.body as any).prepTime },
      )
      res.json({ ok: true, ...out })
    } catch (err: any) { res.status(err?.status ?? 500).json({ error: err.message }) }
  })

  r.post('/api/connectors/aggregator/orders/:id/ready', ...guardEdit, async (req, res) => {
    try {
      const tenantId = (req as any).tenantId
      const order = await loadOrder(tenantId, String(req.params.id))
      if (!order) { res.status(404).json({ error: 'Order not found' }); return }
      const adapter = await resolveAdapter(supabase, tenantId)
      const out = await adapter.submitOrderDecision(
        { tenantId, source: adapter.source },
        { externalOrderId: order.external_order_id, channel: order.channel, outletRef: order.outlet_ref },
        { kind: 'ready' },
      )
      res.json({ ok: true, ...out })
    } catch (err: any) { res.status(err?.status ?? 500).json({ error: err.message }) }
  })

  const RejectBody = z.object({ reason: z.string().max(500).optional() })
  r.post('/api/connectors/aggregator/orders/:id/reject', ...guardEdit, validateBody(RejectBody), async (req, res) => {
    try {
      const tenantId = (req as any).tenantId
      const order = await loadOrder(tenantId, String(req.params.id))
      if (!order) { res.status(404).json({ error: 'Order not found' }); return }
      const adapter = await resolveAdapter(supabase, tenantId)
      const out = await adapter.submitOrderDecision(
        { tenantId, source: adapter.source },
        { externalOrderId: order.external_order_id, channel: order.channel, outletRef: order.outlet_ref },
        { kind: 'reject', reason: (req.body as any).reason },
      )
      res.json({ ok: true, ...out })
    } catch (err: any) { res.status(err?.status ?? 500).json({ error: err.message }) }
  })

  // Item / category stock toggle.
  const StockBody = z.object({
    channel:    z.enum(['zomato', 'swiggy']).optional(),   // resolved server-side if omitted
    outletRef:  z.string().min(1),
    entityType: z.enum(['item', 'category']),
    entityId:   z.string().min(1),
    inStock:    z.boolean(),
  })
  r.post('/api/connectors/aggregator/stock', ...guardEdit, validateBody(StockBody), async (req, res) => {
    try {
      const tenantId = (req as any).tenantId
      const adapter = await resolveAdapter(supabase, tenantId)
      if (!adapter.capabilities().stock) { res.status(422).json({ error: `${adapter.source} cannot toggle stock` }); return }
      const b = req.body as z.infer<typeof StockBody>
      // DynoAPIs routes stock actions by outlet_ref, so channel is informational
      // — resolve a best-effort value (body → orders → default) for the record.
      const channel = (b.channel ?? await channelForOutlet(tenantId, b.outletRef) ?? 'zomato') as AggregatorChannel
      const out = await adapter.submitStockToggle({ tenantId, source: adapter.source }, { ...b, channel })
      // Optimistically reflect the desired state on the menu row so the UI
      // updates immediately (the merchant's client applies it on next poll).
      await supabase.from('aggregator_menu').update({ in_stock: b.inStock, updated_at: new Date().toISOString() })
        .eq('tenant_id', tenantId).eq('outlet_ref', b.outletRef).eq('entity_type', b.entityType).eq('entity_id', b.entityId)
      res.json({ ok: true, ...out })
    } catch (err: any) { res.status(err?.status ?? 500).json({ error: err.message }) }
  })

  // Menu for the stock-toggle UI (items + categories for the tenant / outlet).
  r.get('/api/connectors/aggregator/menu', ...guardView, async (req, res) => {
    try {
      let q = supabase.from('aggregator_menu')
        .select('id, channel, outlet_ref, entity_type, entity_id, name, in_stock, price, currency, category_ref, last_synced_at')
        .eq('tenant_id', (req as any).tenantId)
        .order('entity_type', { ascending: true }).order('name', { ascending: true })
        .limit(2000)
      if (req.query.outlet) q = q.eq('outlet_ref', String(req.query.outlet))
      const { data, error } = await q
      if (error) { res.status(500).json({ error: error.message }); return }
      // Distinct outlets for the FE outlet selector.
      const outlets = Array.from(new Set((data ?? []).map((m: any) => m.outlet_ref)))
      res.json({ menu: data ?? [], outlets })
    } catch (err: any) { res.status(err?.status ?? 500).json({ error: err.message }) }
  })

  // Request a full menu re-pull (next client poll fetches the whole menu).
  r.post('/api/connectors/aggregator/menu/resync', ...guardEdit, async (req, res) => {
    try {
      const tenantId = (req as any).tenantId
      const outlet = req.body?.outlet ? String(req.body.outlet) : null
      if (outlet) {
        await supabase.from('aggregator_menu_sync').upsert(
          { tenant_id: tenantId, outlet_ref: outlet, pending_full_sync: true, updated_at: new Date().toISOString() },
          { onConflict: 'tenant_id,outlet_ref' })
      } else {
        await supabase.from('aggregator_menu_sync').update({ pending_full_sync: true, updated_at: new Date().toISOString() })
          .eq('tenant_id', tenantId)
      }
      res.json({ ok: true, note: 'Full menu re-pull requested — it lands on the merchant client\'s next poll (~30s).' })
    } catch (err: any) { res.status(err?.status ?? 500).json({ error: err.message }) }
  })

  // Count of orders still awaiting acceptance — drives the sidebar badge.
  r.get('/api/connectors/aggregator/orders/pending-count', ...guardView, async (req, res) => {
    try {
      const { count } = await supabase.from('aggregator_orders')
        .select('id', { count: 'exact', head: true })
        .eq('tenant_id', (req as any).tenantId).eq('status', 'new')
      res.json({ count: count ?? 0 })
    } catch (err: any) { res.status(err?.status ?? 500).json({ error: err.message }) }
  })

  // Backfilled past orders (read-only archive) for the History view.
  r.get('/api/connectors/aggregator/orders/history', ...guardView, async (req, res) => {
    try {
      let q = supabase.from('aggregator_order_history')
        .select('id, channel, outlet_ref, external_order_id, status, customer_name, item_count, gross_amount, currency, placed_at')
        .eq('tenant_id', (req as any).tenantId)
        .order('placed_at', { ascending: false, nullsFirst: false })
        .limit(Math.min(Number(req.query.limit ?? 200), 500))
      if (req.query.channel) q = q.eq('channel', String(req.query.channel))
      if (req.query.outlet) q = q.eq('outlet_ref', String(req.query.outlet))
      const { data, error } = await q
      if (error) { res.status(500).json({ error: error.message }); return }
      res.json(data ?? [])
    } catch (err: any) { res.status(err?.status ?? 500).json({ error: err.message }) }
  })

  // Connection health — is the merchant's DynoAPIs client polling us?
  r.get('/api/connectors/aggregator/health', ...guardView, async (req, res) => {
    try {
      const { data } = await supabase.from('aggregator_heartbeats')
        .select('last_seen_at, source').eq('tenant_id', (req as any).tenantId).maybeSingle()
      const lastSeen = (data as any)?.last_seen_at ?? null
      const online = lastSeen ? (Date.now() - new Date(lastSeen).getTime()) < 90_000 : false
      res.json({ online, lastSeenAt: lastSeen, source: (data as any)?.source ?? null })
    } catch (err: any) { res.status(err?.status ?? 500).json({ error: err.message }) }
  })

  // Connect DynoAPIs: mint the per-tenant webhook token + return the URL the
  // operator pastes into DynoAPIs' Cloud URL config on their machine.
  r.post('/api/connectors/aggregator/dynoapis/connect', ...guardEdit, async (req, res) => {
    try {
      const tenantId = (req as any).tenantId
      const userId = (req as any).user?.id as string | undefined
      if (!userId) { res.status(401).json({ error: 'auth missing user.id' }); return }
      const { data: existing } = await supabase.from('tenant_integrations')
        .select('metadata').eq('tenant_id', tenantId).eq('key', 'aggregator_dynoapis').maybeSingle()
      const ingestToken = (existing?.metadata as any)?.ingest_token ?? crypto.randomBytes(24).toString('hex')
      const { error } = await supabase.from('tenant_integrations').upsert({
        tenant_id: tenantId, user_id: userId, key: 'aggregator_dynoapis', status: 'active',
        scope: 'order_management', brand_label: 'Zomato/Swiggy · DynoAPIs',
        metadata: { source: 'dynoapis', ingest_token: ingestToken },
      }, { onConflict: 'tenant_id,key' })
      if (error) { res.status(500).json({ error: 'Failed to persist connection: ' + error.message }); return }
      const cloudUrl = `${PUBLIC_BASE_URL}/api/connectors/aggregator/dyno/${ingestToken}`
      res.json({
        success: true, source: 'dynoapis', cloudUrl,
        note: "Paste this as the Cloud URL in DynoAPIs on the merchant's machine. Orders will flow into your order board; accept/ready/reject and stock toggles are pulled back automatically.",
      })
    } catch (err: any) { res.status(err?.status ?? 500).json({ error: err.message }) }
  })

  // ══════════════════════════════════════════════════════════════════════════
  // B) DynoAPIs webhook contract (public; tenant resolved by URL token)
  // ══════════════════════════════════════════════════════════════════════════

  const resolveToken = async (token: string): Promise<string | null> => {
    const { data } = await supabase.from('tenant_integrations')
      .select('tenant_id').eq('key', 'aggregator_dynoapis')
      .eq('metadata->>ingest_token', token).maybeSingle()
    return (data as any)?.tenant_id ?? null
  }

  // POST /orders — DynoAPIs pushes a batch of new/updated orders.
  // We diff against the stored status so a re-push of an unchanged order does
  // NOT re-ring the bell — only genuinely new orders and real status changes
  // notify + fire workflows (essential: the client re-pushes the same orders
  // every ~40s).
  r.post('/api/connectors/aggregator/dyno/:token/orders', async (req, res) => {
    const tenantId = await resolveToken(String(req.params.token))
    if (!tenantId) { res.status(404).json({ error: 'Unknown token' }); return }
    void bumpHeartbeat(tenantId)
    const orders = Array.isArray(req.body?.orders) ? req.body.orders : []

    // Prior statuses for this batch (one query) to detect new vs changed.
    const ids = orders.map((o: any) => String(o.orderId ?? '')).filter(Boolean)
    const priorByKey = new Map<string, string>()
    if (ids.length) {
      const { data: prior } = await supabase.from('aggregator_orders')
        .select('channel, external_order_id, status')
        .eq('tenant_id', tenantId).in('external_order_id', ids)
      for (const p of prior ?? []) priorByKey.set(`${(p as any).channel}:${(p as any).external_order_id}`, (p as any).status)
    }

    let notified = 0
    for (const el of orders) {
      try {
        const channel = chan(el.vendor)
        const status = normalizeStatus(el.status)
        const s = extractSummary(el.data)
        const externalOrderId = String(el.orderId ?? '')
        if (!externalOrderId) continue
        const prior = priorByKey.get(`${channel}:${externalOrderId}`)
        const isNewRow = prior === undefined
        const changed = isNewRow || prior !== status

        const { error } = await supabase.from('aggregator_orders').upsert({
          tenant_id: tenantId, source: 'dynoapis', channel, external_order_id: externalOrderId,
          outlet_ref: el.resId != null ? String(el.resId) : null,
          status, status_identifier: el.statusIdentifier ?? String(el.status ?? ''),
          customer_name: s.name, customer_phone_masked: s.phone,
          item_count: s.items, gross_amount: s.gross,
          placed_at: el.data?.placed_at ?? el.data?.order?.created_at ?? null,
          payload: el.data ?? {}, updated_at: new Date().toISOString(),
        }, { onConflict: 'tenant_id,channel,external_order_id' })
        if (error) { console.error(`[aggregator/dyno] upsert failed: ${error.message}`); continue }

        if (!changed) continue   // unchanged re-push — no bell, no trigger
        notified++
        const isNew = isNewRow && status === 'new'
        void notifyOrder(tenantId, { isNew, channel, orderId: externalOrderId, status, summary: orderSummary(s.items, s.gross) })
        void import('../../engine/inbound-router').then(({ fireOrderTrigger }) =>
          fireOrderTrigger(supabase, tenantId, {
            kind: isNew ? 'new_order' : 'order_status', channel, status,
            contactPhone: s.phone, orderId: externalOrderId, order: el.data ?? {},
          })
        ).catch(e => console.warn(`[aggregator/dyno] trigger (non-fatal): ${e?.message}`))
      } catch (e: any) { console.error(`[aggregator/dyno] order error: ${e?.message}`) }
    }
    res.status(200).json({ received: true, count: orders.length, changed: notified })
  })

  // GET /:resId/orders/status — DynoAPIs polls for decisions we queued.
  // Returns { orders: [{ orderId, status, prepTime? }] } using DynoAPIs' codes.
  r.get('/api/connectors/aggregator/dyno/:token/:resId/orders/status', async (req, res) => {
    const tenantId = await resolveToken(String(req.params.token))
    if (!tenantId) { res.status(404).json({ error: 'Unknown token' }); return }
    void bumpHeartbeat(tenantId)   // regular poll = liveness signal
    const { data } = await supabase.from('aggregator_orders')
      .select('external_order_id, pending_action, pending_prep_time')
      .eq('tenant_id', tenantId).eq('outlet_ref', String(req.params.resId))
      .not('pending_action', 'is', null)
    const orders = (data ?? []).map((o: any) => ({
      orderId: o.external_order_id,
      status: PULL_CODE[o.pending_action as keyof typeof PULL_CODE] ?? 0,
      prepTime: o.pending_prep_time ?? 30,
    }))
    // Request a one-shot history backfill the first time we see this outlet.
    const orderHistory = await needsHistorySync(tenantId, String(req.params.resId))
    res.json({ orders, orderHistory })
  })

  // POST /orders/:orderId/status — DynoAPIs reports a decision's outcome.
  // Body { statusCode, statusResponse }. We MUST echo { status: statusCode } so
  // the client considers it applied. Clears the queued decision.
  r.post('/api/connectors/aggregator/dyno/:token/orders/:orderId/status', async (req, res) => {
    const tenantId = await resolveToken(String(req.params.token))
    if (!tenantId) { res.status(404).json({ error: 'Unknown token' }); return }
    const statusCode = Number(req.body?.statusCode)
    const mapped = RESULT_MAP[statusCode]
    await supabase.from('aggregator_orders').update({
      pending_action: null, pending_prep_time: null, pending_reason: null, pending_queued_at: null,
      ...(mapped ? { status: mapped } : {}),
      last_action_result: req.body?.statusResponse ?? null, updated_at: new Date().toISOString(),
    }).eq('tenant_id', tenantId).eq('external_order_id', String(req.params.orderId))
    res.json({ status: statusCode })   // echo so the client marks it done
  })

  // GET /:resId/items — DynoAPIs polls for stock toggles we queued.
  // Returns { items:[{id,stockStatus}], categories:[{id,stockStatus}], getAllItems:false }.
  r.get('/api/connectors/aggregator/dyno/:token/:resId/items', async (req, res) => {
    const tenantId = await resolveToken(String(req.params.token))
    if (!tenantId) { res.status(404).json({ error: 'Unknown token' }); return }
    const { data } = await supabase.from('aggregator_stock_actions')
      .select('entity_type, entity_id, in_stock')
      .eq('tenant_id', tenantId).eq('outlet_ref', String(req.params.resId)).eq('status', 'pending')
    const items: any[] = [], categories: any[] = []
    for (const a of data ?? []) {
      const row = { id: (a as any).entity_id, stockStatus: (a as any).in_stock }
      ;((a as any).entity_type === 'category' ? categories : items).push(row)
    }
    // Ask the client to fetch + push the full menu when we don't have it yet
    // (or a resync was requested) — this is how an onboarded restaurant's
    // existing catalog lands in our POS on day one.
    const getAllItems = await needsFullSync(tenantId, String(req.params.resId))
    res.json({ items, categories, getAllItems })
  })

  // POST /:resId/items/status & /:resId/categories/status — toggle results.
  // Body { entityId, statusResponse, aggregator, stockStatus, ... }. Echo {status:200}.
  const stockResult = (entityType: 'item' | 'category') => async (req: express.Request, res: express.Response) => {
    const tenantId = await resolveToken(String(req.params.token))
    if (!tenantId) { res.status(404).json({ error: 'Unknown token' }); return }
    await supabase.from('aggregator_stock_actions').update({
      status: 'done', result: req.body?.statusResponse ?? req.body ?? null, updated_at: new Date().toISOString(),
    }).eq('tenant_id', tenantId).eq('outlet_ref', String(req.params.resId))
      .eq('entity_type', entityType).eq('entity_id', String(req.body?.entityId ?? '')).eq('status', 'pending')
    res.json({ status: 200 })
  }
  r.post('/api/connectors/aggregator/dyno/:token/:resId/items/status',      stockResult('item'))
  r.post('/api/connectors/aggregator/dyno/:token/:resId/categories/status', stockResult('category'))

  // Full menu snapshot → parse + upsert into aggregator_menu (day-one catalog).
  r.post('/api/connectors/aggregator/dyno/:token/:resId/items', async (req, res) => {
    const tenantId = await resolveToken(String(req.params.token))
    if (!tenantId) { res.status(404).json({ error: 'Unknown token' }); return }
    try { await ingestMenu(tenantId, String(req.params.resId), req.body) }
    catch (e: any) { console.error(`[aggregator/menu] ingest error: ${e?.message}`) }
    res.json({ status: 200 })
  })

  // Order-history snapshot → parse + upsert into aggregator_order_history (day-one backfill).
  r.post('/api/connectors/aggregator/dyno/:token/:resId/orders/history', async (req, res) => {
    const tenantId = await resolveToken(String(req.params.token))
    if (!tenantId) { res.status(404).json({ error: 'Unknown token' }); return }
    try { await ingestHistory(tenantId, String(req.params.resId), req.body) }
    catch (e: any) { console.error(`[aggregator/history] ingest error: ${e?.message}`) }
    res.json({ status: 200 })
  })

  return r
}
