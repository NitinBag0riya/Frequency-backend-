/**
 * Aggregator connector — source-agnostic Zomato/Swiggy order & stock management.
 *
 * Two surfaces:
 *
 *  A) FE/BE-facing normalised API (guarded)  /api/connectors/aggregator/*
 *     The dashboard order board + stock toggles call these. They never know or
 *     care which source is active — an adapter handles that.
 *
 *  B) Frequency Desktop bridge (AUTHENTICATED — tenant from the logged-in
 *     session, no token, no public URL)   /api/connectors/aggregator/*
 *     The Frequency Desktop app on the MERCHANT's machine runs the Frequency web
 *     app with the merchant logged in. Captured orders are relayed here through
 *     that web view using the SAME session as every other FE call; queued
 *     operator decisions are polled back the same authenticated way. It executes
 *     them against Zomato/Swiggy itself — our servers never talk to the
 *     aggregators (POST /orders/ingest, GET /pending-actions, POST
 *     /actions/result, POST /menu/ingest, POST /history/ingest).
 *
 * Adding UrbanPiper / official-direct later means a new adapter (surface A keeps
 * working unchanged) + its own inbound path if it has one — surface B is
 * Frequency-Desktop-specific.
 */

import express from 'express'
import { z } from 'zod'
import { SupabaseClient } from '@supabase/supabase-js'
import { validateBody } from '../../validation'
import { resolveAdapter, normalizeStatus, AggregatorChannel } from '../../connectors/aggregator'
import { parseMenuSnapshot, importMenuToStorefront, ParsedEntity, sf } from '../../connectors/aggregator/menu-import'
import { inventoryActionForStatus, externalOrderKey, extractOrderLines } from './aggregator-inventory.js'
import { rehostImageToAssets } from '../assets.js'
import { channelIsLive, channelConnected } from './aggregator-health.js'
import { emitNotification, tenantNotifyRecipients } from '../notifications'

type Middleware = (req: express.Request, res: express.Response, next: express.NextFunction) => void | Promise<void>
interface Deps {
  supabase: SupabaseClient
  requireAuth: Middleware
  identifyTenant: Middleware
  checkPermission: (feature: string, action: 'view' | 'edit' | 'delete') => Middleware
}

// Order-status codes the desktop app uses in poll responses / result posts.
const PULL_CODE  = { accept: 1, ready: 3, reject: -1 } as const   // we tell it what to do
const RESULT_MAP: Record<number, string> = { 2: 'preparing', 4: 'ready', [-2]: 'rejected' } // it tells us the outcome

// Robust channel detection. The desktop app *should* send vendor='swiggy'|'zomato',
// but the field/casing varies by payload shape — substring-match so 'Swiggy',
// 'SWIGGY_DELIVERY', a nested 'swiggy_instamart' etc. all resolve correctly, and
// only fall back to zomato when there's genuinely no swiggy signal anywhere.
function chan(...vals: unknown[]): AggregatorChannel {
  const s = vals.map(v => String(v ?? '')).join(' ').toLowerCase()
  if (s.includes('swiggy')) return 'swiggy'
  return 'zomato'
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

interface ParsedHistOrder { external_order_id: string; status: string | null; customer_name: string | null; item_count: number; gross_amount: number | null; placed_at: string | null; raw: any }

/** Strip Zomato snippet markdown: `<semibold-200|{white-500|DELIVERED}>` → `DELIVERED`. */
export function stripZomatoMarkup(text: unknown): string {
  return String(text == null ? '' : text)
    .replace(/<[a-z0-9-]+\|/gi, '').replace(/\{[a-z0-9-]+\|/gi, '').replace(/[>}]/g, '')
    .replace(/\s+/g, ' ').trim()
}

const SNIPPET_MONTHS = ['january','february','march','april','may','june','july','august','september','october','november','december']
/** Zomato snippet display time → real ISO. The `topRightText` reads "11:50 AM | 11 August"
 *  (IST wall-clock, no year). We derive the year: an order can't be in the future, so if the
 *  current-year instant lands ahead of now, it belongs to last year. Beats null → a fake
 *  "just now"; the exact `order.createdAt` from an order-details capture still overrides it. */
export function parseZomatoSnippetTime(text: unknown, now: Date = new Date()): string | null {
  const m = stripZomatoMarkup(text).match(/(\d{1,2}):(\d{2})\s*(AM|PM)\s*\|\s*(\d{1,2})\s+([A-Za-z]+)/i)
  if (!m) return null
  const mon = SNIPPET_MONTHS.indexOf(m[5].toLowerCase())
  if (mon < 0) return null
  const hh = (Number(m[1]) % 12) + (/pm/i.test(m[3]) ? 12 : 0)
  const IST_MS = 5.5 * 60 * 60 * 1000 // Asia/Kolkata offset; snippet times are local IST
  const at = (y: number) => Date.UTC(y, mon, Number(m[4]), hh, Number(m[2])) - IST_MS
  let t = at(now.getUTCFullYear())
  if (t > now.getTime() + 24 * 3600 * 1000) t = at(now.getUTCFullYear() - 1)
  return new Date(t).toISOString()
}

/** Zomato get-all-v2 snippets → past-order rows (verified against real La Fiamma capture). */
export function parseZomatoSnippets(snippets: any[]): ParsedHistOrder[] {
  const out: ParsedHistOrder[] = []
  for (const s of snippets) {
    const id = s?.id
    if (id == null) continue
    const info = (Array.isArray(s.infoList) ? s.infoList : []).map((r: any) => ({
      l: stripZomatoMarkup(r?.leftText?.text), r: stripZomatoMarkup(r?.rightText?.text),
    }))
    const idRow = info.find((x: any) => /^id:/i.test(x.l))
    const itemRows = info.filter((x: any) => /\bx\b/i.test(x.l) && /₹/.test(x.r))
    const itemCount = itemRows.reduce((n: number, x: any) => {
      const m = x.l.match(/^(\d+)\s*x/i); return n + (m ? Number(m[1]) : 1)
    }, 0)
    const gross = itemRows.reduce((sum: number, x: any) => {
      const m = String(x.r).match(/([\d,]+(?:\.\d+)?)/); return sum + (m ? Number(m[1].replace(/,/g, '')) : 0)
    }, 0)
    out.push({
      external_order_id: String(id),
      status: stripZomatoMarkup(s?.primaryTag?.label?.text) || 'HISTORY',
      customer_name: idRow ? String(idRow.r).replace(/^by\s+/i, '').trim() || null : null,
      item_count: itemCount,
      gross_amount: gross > 0 ? gross : null,
      // Real order time from the snippet display ("11:23 PM | 10 August"); the exact
      // ISO from an order-details capture still overrides this on enrichment.
      placed_at: parseZomatoSnippetTime(s?.topRightText?.text),
      raw: s,
    })
  }
  return out
}

/** Swiggy orders/v1/history groups (`[{restId, data:{objects}}]`) → past-order rows.
 *  Field shape VALIDATED against live capture 2026-08-12: time is `status.ordered_time`
 *  ("YYYY-MM-DD HH:MM:SS", IST wall-clock), total is `bill`, line items are `cart.items[]`
 *  ({name, quantity, sub_total/total, is_veg}); Swiggy history does NOT expose the
 *  customer name. Legacy top-level names kept as fallbacks. */
export function parseSwiggyHistoryGroups(groups: any[]): ParsedHistOrder[] {
  const out: ParsedHistOrder[] = []
  for (const g of groups) {
    const objects = g?.data?.objects
    if (!Array.isArray(objects)) continue
    for (const o of objects) {
      const id = o?.order_id ?? o?.id ?? o?.rng_order_id
      if (id == null) continue
      const st = o.status && typeof o.status === 'object' ? o.status : null
      const cart = o.cart && typeof o.cart === 'object' ? o.cart : null
      const itemsArr: any[] = Array.isArray(cart?.items) ? cart.items
        : Array.isArray(o.order_items) ? o.order_items : Array.isArray(o.items) ? o.items : []
      const lines = itemsArr.filter((it) => it && typeof it === 'object').map((it: any) => ({
        name: it.name ?? null,
        qty: Number(it.quantity ?? it.qty ?? 1) || 1,
        price: Number(it.sub_total ?? it.total ?? it.price ?? 0) || 0,
        veg: typeof it.is_veg === 'boolean' ? it.is_veg : (it.is_veg === 1 || it.is_veg === '1' ? true : undefined),
      }))
      const orderedTime = st?.ordered_time ?? o.order_time ?? o.ordered_time ?? o.order_placed_time ?? o.created_on ?? null
      // "2026-08-11 19:12:34" is IST wall-clock, no tz → stamp +05:30 so it stores right.
      const placedAt = orderedTime && /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}/.test(String(orderedTime))
        ? String(orderedTime).replace(' ', 'T') + (/[+Z]/.test(String(orderedTime)) ? '' : '+05:30') : orderedTime
      out.push({
        external_order_id: String(id),
        status: st?.cancel_reason ? 'cancelled' : (st?.order_status ?? o.order_status ?? 'delivered'),
        customer_name: o.customer_name ?? o.customer?.name ?? null,
        item_count: lines.reduce((n, l) => n + l.qty, 0) || itemsArr.length,
        gross_amount: Number(o.bill ?? o.order_total ?? o.bill_total ?? o.total ?? o.net_total) || null,
        placed_at: placedAt,
        raw: { source: 'swiggy', order_id: String(id), lines, note: 'Real Swiggy order-history capture (dishes + time + bill).' },
      })
    }
  }
  return out
}

/** Pull a rupee number out of Zomato's money shapes (a number, or a dict with
 *  amount/value/total/…). Nested totals are common in cartDetails. */
export function money(x: any): number {
  if (typeof x === 'number') return x
  if (x && typeof x === 'object') {
    for (const k of ['amount', 'value', 'total', 'finalAmount', 'netAmount', 'grandTotal', 'totalCost', 'payableAmount']) {
      if (typeof x[k] === 'number') return x[k]
    }
    for (const v of Object.values(x)) { const m = money(v); if (m) return m }
  }
  return 0
}

/** Zomato order-details `order` → one enriched past-order row: real placed_at
 *  (`createdAt`) + structured dishes (`cartDetails.items.dishes[]`, or a dict of
 *  dish-lists) in the {name,qty,price,veg} shape the board reads from `raw.lines`. */
export function parseZomatoOrderDetail(order: any): ParsedHistOrder {
  const cart = order?.cartDetails ?? {}
  const it = cart.items
  const dishes: any[] = Array.isArray(it?.dishes) ? it.dishes
    : Array.isArray(it) ? it
    : (it && typeof it === 'object') ? Object.values(it).flatMap((v: any) => Array.isArray(v) ? v : [v])
    : []
  const lines = dishes.filter((d) => d && typeof d === 'object').map((d: any) => {
    const tags: string[] = Array.isArray(d.metadata?.tags) ? d.metadata.tags : []
    return { name: d.name ?? null, qty: Number(d.quantity ?? 1) || 1, price: money(d.unitCost ?? d.totalCost ?? 0),
             veg: tags.length ? tags.includes('veg') && !tags.includes('non-veg') : undefined }
  })
  const itemCount = lines.reduce((n, l) => n + l.qty, 0) || lines.length
  const gross = money(cart.total) || money(cart.subtotal) || lines.reduce((s, l) => s + l.price * l.qty, 0)
  return {
    external_order_id: String(order.id),
    status: order.state ?? order.status ?? 'DELIVERED',
    customer_name: order.creator?.name ?? order.customer?.name ?? null,
    item_count: itemCount,
    gross_amount: gross || null,
    placed_at: order.createdAt ?? order.actionedAt ?? order.updatedAt ?? null,
    raw: { source: 'zomato', order_id: String(order.id), lines, note: 'Real Zomato order-details capture (dishes + time + outlet).' },
  }
}

/**
 * Parse a Frequency Desktop order-history snapshot into normalised past-order rows.
 * Handles the real aggregator shapes: Zomato get-all-v2 `snippets[]`, Swiggy
 * orders/v1/history `data[].data.objects[]`, the single Zomato order-details
 * enrichment body, plus generic order arrays / paged shapes. Raw always retained.
 * Verified against live La Fiamma captures 2026-08-11.
 */
export function parseOrderHistory(body: any): ParsedHistOrder[] {
  // Zomato order-details enrichment: a SINGLE past order opened in the portal
  // ({ order:{ id, createdAt, cartDetails.items.dishes } }). Carries the real ISO
  // time + dishes the snippet list lacks; upsert-enriches the row on order.id.
  if (body?.order?.id != null && (body.order.cartDetails != null || body.order.createdAt != null)) {
    return [parseZomatoOrderDetail(body.order)]
  }
  // Zomato order/history/get-all-v2 → { snippets:[{id, primaryTag, topRightText,
  // infoList}] } (a UI-snippet list; text is markdown-wrapped `<tag|{color|TEXT}>`).
  if (Array.isArray(body?.snippets) && body.snippets.some((s: any) => s?.id != null && s?.primaryTag)) {
    return parseZomatoSnippets(body.snippets)
  }
  // Swiggy orders/v1/history → { data:[{restId, data:{objects:[order]}}] }.
  if (Array.isArray(body?.data) && body.data.some((g: any) => g?.restId != null && Array.isArray(g?.data?.objects))) {
    return parseSwiggyHistoryGroups(body.data)
  }

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

/** Best-effort customer/amount extraction across Zomato + Swiggy payload shapes —
 *  the full raw order is ALWAYS kept in payload, so a missed field is cosmetic
 *  (blank summary), never lost data. Field names span both aggregators' conventions. */
function extractSummary(data: any): { name: string | null; phone: string | null; items: number; gross: number | null } {
  const o = data?.order ?? data?.orderDetails ?? data?.order_details ?? data ?? {}
  // Zomato: customer is `creator`, line items nest at cartDetails.items.dishes,
  // and there is NO order-level total (sum the dishes). Decoded live 2026-07-30
  // against La Fiamma / res 22804912 — without these paths every Zomato order
  // ingested blank (null customer / 0 items / null amount).
  const cust = o.customer ?? o.customer_details ?? o.customerDetails ?? o.user ?? o.creator ?? {}
  const items = Array.isArray(o.cartDetails?.items?.dishes) ? o.cartDetails.items.dishes
    : Array.isArray(o.items) ? o.items
    : Array.isArray(o.order_items) ? o.order_items
    : Array.isArray(o.cart_items) ? o.cart_items
    : Array.isArray(o.line_items) ? o.line_items
    : Array.isArray(o.orderItems) ? o.orderItems : []
  const firstLast = [cust.first_name, cust.last_name].filter(Boolean).join(' ').trim() || null
  const n = (v: any) => (v == null || v === '' ? null : Number(v))
  // Zomato dishes carry totalCost/unitCost; sum them when no order-level total exists.
  const lineSum = items.reduce((s: number, it: any) =>
    s + (Number(it.totalCost ?? it.total ?? it.price ?? it.amount ?? it.unitCost ?? 0) || 0), 0) || null
  return {
    name:  cust.name ?? o.customer_name ?? o.customerName ?? firstLast ?? null,
    phone: cust.phone ?? cust.mobile ?? cust.contact_number ?? o.customer_phone ?? o.customerPhone ?? null,   // aggregators mask this
    items: (items.length
      ? items.reduce((s: number, it: any) => s + (Number(it.quantity ?? it.qty ?? it.count ?? 1) || 1), 0)
      : Number(o.item_count ?? o.items_count ?? o.itemCount ?? 0)) || 0,
    gross: n(o.total_cost) ?? n(o.net_amount) ?? n(o.order_total) ?? n(o.grand_total) ?? n(o.bill_amount)
        ?? n(o.final_amount) ?? n(o.net_total) ?? n(o.order_value) ?? n(o.total) ?? n(o.invoice?.total) ?? lineSum ?? null,
  }
}

// Off-platform (Zomato/Swiggy) sale → inventory. Deplete when the order is accepted,
// reverse on cancel/reject (see inventoryActionForStatus). Best-effort + idempotent —
// storefront-api keys applySale/applyRestock on the namespaced orderId — so it is safe
// to call on every status transition and it NEVER blocks or fails order ingest.
const HORECA_INV_TYPES = new Set(['horeca', 'restaurant', 'cafe', 'hotel'])
async function syncOrderInventory(slug: string, channel: AggregatorChannel, externalId: string, status: string, data: any): Promise<void> {
  const action = inventoryActionForStatus(status)
  if (action === 'none') return
  const orderId = externalOrderKey(channel, externalId)
  try {
    if (action === 'deplete') {
      const lines = extractOrderLines(data)
      if (lines.length) await sf('POST', '/admin/inventory/apply-external-sale', slug, { orderId, source: channel, lines })
    } else {
      await sf('POST', '/admin/inventory/reverse-external-sale', slug, { orderId })
    }
  } catch (e: any) { console.warn(`[aggregator/inv] ${orderId} ${status}: ${e?.message}`) }
}

// A "detection marker" ping (Swiggy activity sensed, no order captured) that the desktop
// relays as `{ source: 'lastOrderEventTimestamps' }` — shape-tolerant (checks one level of
// nesting too). These are NOT orders and must never ring / trigger / render.
const isGhostMarker = (data: any): boolean =>
  (data?.source ?? data?.data?.source) === 'lastOrderEventTimestamps'

export function createAggregatorConnector(deps: Deps): express.Router {
  const r = express.Router()
  const { supabase, requireAuth, identifyTenant, checkPermission } = deps
  const guardEdit = [requireAuth, identifyTenant, checkPermission('integrations', 'edit')]
  const guardView = [requireAuth, identifyTenant, checkPermission('integrations', 'view')]

  // Recipients for order notifications: OWNER ∪ active members. Delegates to the
  // shared resolver so solo-owner tenants (no user_role_assignments row) still ring.
  const tenantRecipients = (tenantId: string): Promise<string[]> => tenantNotifyRecipients(supabase, tenantId)

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
        link: '/settings/orders',   // the real orders-board route (org slug is added client-side)
        data: {
          channel: ev.channel, channel_label: CHANNEL_LABEL[ev.channel],
          order_id: ev.orderId, status: ev.status, status_label: STATUS_LABEL[ev.status] ?? ev.status,
          summary: ev.isNew ? `${ev.summary} — accept now` : ev.summary,
          priority: ev.isNew ? 'high' : 'normal',
        },
      })
    } catch (e: any) { console.warn(`[aggregator] notify failed (non-fatal): ${e?.message}`) }
  }

  // Realtime "the desktop is alive" ping. One fire-and-forget broadcast on a
  // tenant topic — `.send()` without `.subscribe()` goes out over HTTP, so there
  // is NO held socket and NO DB write (mirrors publishCallState in call-dispatch).
  // The dashboard flips to online the instant this lands instead of waiting for a
  // poll; cost ceiling is the desktop's own ~40s heartbeat cadence.
  const AGG_STATUS_TOPIC = (tenantId: string) => `aggregator-status:${tenantId}`
  const broadcastHeartbeat = (tenantId: string) => {
    try {
      const ch = supabase.channel(AGG_STATUS_TOPIC(tenantId), { config: { broadcast: { ack: false } } })
      void ch.send({ type: 'broadcast', event: 'beat', payload: { at: Date.now() } })
        .finally(() => { void supabase.removeChannel(ch).catch(() => {}) })
    } catch { /* realtime is best-effort */ }
  }

  // Bump the desktop-app liveness heartbeat (called from the regular poll).
  const bumpHeartbeat = async (tenantId: string) => {
    try {
      await supabase.from('aggregator_heartbeats').upsert(
        { tenant_id: tenantId, source: 'frequency_desktop', last_seen_at: new Date().toISOString(), updated_at: new Date().toISOString() },
        { onConflict: 'tenant_id' },
      )
    } catch { /* non-fatal */ }
    broadcastHeartbeat(tenantId)
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
        tenant_id: tenantId, source: 'frequency_desktop', channel, outlet_ref: outletRef,
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

  // Whether the next items-poll should request a full menu pull.
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
    // Prefer the channel the desktop relays (it KNOWS zomato vs swiggy). The outlet
    // lookup returns null for the 'manual' outlet the bridge uses, which left every
    // relayed row channel=null — and null coerces to Zomato on the board, mislabeling
    // Swiggy history. Fall back to the lookup, then to the order-details raw source.
    const relayCh = body?.channel === 'swiggy' || body?.channel === 'zomato' ? body.channel : null
    const rawSrc = body?.order?.cartDetails != null ? 'zomato' : null // Zomato order-details shape
    const channel = relayCh || (await channelForOutlet(tenantId, outletRef)) || rawSrc
    const now = new Date().toISOString()
    if (parsed.length) {
      const rows = parsed.map(o => ({
        tenant_id: tenantId, source: 'frequency_desktop', channel, outlet_ref: outletRef,
        external_order_id: o.external_order_id, status: normalizeStatus(o.status),
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

  // Ingest a Zomato/Swiggy customer-complaints snapshot → upsert into public.complaints
  // (source = channel). Zomato's feed (merchant-api/customer-issues/get-all) carries
  // order_id + issue_type + expired_at (the SLA deadline to respond) only; the text &
  // category live inside Zomato, so body/category stay null — the Complaints inbox
  // shows "full text only on Zomato" for exactly this case. Dedup on source+external_id
  // so a re-poll never clobbers an operator's acknowledge/resolve on an existing row.
  const ingestComplaints = async (tenantId: string, outletRef: string | null, body: any) => {
    const channel = (body?.channel === 'swiggy' || body?.channel === 'zomato')
      ? body.channel
      : (outletRef ? await channelForOutlet(tenantId, outletRef) : null) || 'zomato'
    const entities: any[] = Array.isArray(body?.entities) ? body.entities
      : Array.isArray(body?.issues) ? body.issues : []
    const now = new Date().toISOString()
    const rows = entities.map((e) => {
      const orderId = String(e?.order_id ?? e?.orderId ?? '')
      if (!orderId) return null
      const expRaw = e?.expired_at ? String(e.expired_at) : ''
      const exp = expRaw ? new Date(expRaw.replace(' ', 'T') + '+05:30') : null
      const dueAt = exp && !isNaN(exp.getTime()) ? exp.toISOString() : null
      const t = String(e?.issue_type ?? '').toUpperCase()
      const responded = e?.response_meta != null
      const status = (responded || t.includes('CLOSE') || t.includes('RESOLV')) ? 'resolved' : 'new'
      const dueSoon = dueAt ? (new Date(dueAt).getTime() - Date.now()) <= 12 * 3600_000 : false
      const severity = status === 'resolved' ? 'low' : (dueSoon ? 'high' : 'normal')
      return {
        tenant_id: tenantId, outlet_ref: outletRef, source: channel,
        external_id: `${channel}:${orderId}`, order_ref: orderId,
        category: 'unknown', raw_issue_type: e?.issue_type ?? 'issue',
        severity, status,
        opened_at: dueAt ?? now, due_at: dueAt,
        raw: { source: channel, order_id: orderId, issue_type: e?.issue_type ?? null, expired_at: e?.expired_at ?? null, notes: [], note: 'Captured from the merchant customer-issues feed; full text & category only in the aggregator app.' },
        updated_at: now,
      }
    }).filter(Boolean) as any[]
    if (!rows.length) return
    const { data: existing } = await supabase.from('complaints')
      .select('external_id').eq('tenant_id', tenantId).eq('source', channel)
      .in('external_id', rows.map(r => r.external_id))
    const have = new Set((existing ?? []).map((x: any) => x.external_id))
    const fresh = rows.filter(r => !have.has(r.external_id))
    if (fresh.length) {
      const { error } = await supabase.from('complaints').insert(fresh)
      if (error) console.error(`[aggregator/complaints] insert failed: ${error.message}`)
      else console.log(`[aggregator/complaints] ingested ${fresh.length} new ${channel} complaint(s)`)
    }
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
        // psource = payload->>source only (NOT the raw payload, which carries customer
        // PII). Lets the board drop "detection marker" ghost rows whose source is
        // 'lastOrderEventTimestamps' — a Swiggy activity ping the desktop relays with no
        // real order behind it (0 items, no bill).
        .select('id, source, channel, external_order_id, outlet_ref, status, status_identifier, customer_name, item_count, gross_amount, currency, placed_at, pending_action, last_action_result, updated_at, psource:payload->>source')
        .eq('tenant_id', (req as any).tenantId)
        .order('placed_at', { ascending: false, nullsFirst: false })
        .limit(Math.min(Number(req.query.limit ?? 100), 200))
      if (req.query.channel) q = q.eq('channel', String(req.query.channel))
      if (req.query.status)  q = q.eq('status', String(req.query.status))
      const { data, error } = await q
      if (error) { res.status(500).json({ error: error.message }); return }
      // Never surface MockFeed test fixtures (status_identifier 'mock_*') on a real board —
      // legacy demo rows were seeding into prod and stranding in the live count forever.
      res.json((data ?? []).filter(o => !String((o as any).status_identifier ?? '').startsWith('mock_')))
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
      // Stock actions route by outlet_ref, so channel is informational
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

  // Publish / make-visible an item or category on a channel. This is the
  // menu-visibility surface: "publish to Swiggy" is a REAL stock-visibility
  // write (setStock on the merchant's session); "publish to Zomato" is
  // partner/PetPooja-gated, so it is queued and the desktop reports it back as
  // gated (dashboard shows "pending partner") — never a fake success. Reuses the
  // SAME aggregator_stock_actions queue + pull/result path as stock toggles,
  // because publish == a visibility write.
  const PublishBody = z.object({
    channel:    z.enum(['zomato', 'swiggy']),
    outletRef:  z.string().min(1),
    entityType: z.enum(['item', 'category']),
    entityId:   z.string().min(1),
    visible:    z.boolean().default(true),   // publish=true (make visible/live) | false=hide
  })
  r.post('/api/connectors/aggregator/menu/publish', ...guardEdit, validateBody(PublishBody), async (req, res) => {
    try {
      const tenantId = (req as any).tenantId
      const adapter = await resolveAdapter(supabase, tenantId)
      const b = req.body as z.infer<typeof PublishBody>
      const cap = adapter.capabilities().publish?.[b.channel]
      if (!cap) { res.status(422).json({ error: `${adapter.source} cannot publish to ${b.channel}` }); return }
      // Enqueue for BOTH channels: Swiggy applies it live; Zomato is picked up and
      // reported gated so the queue row terminates in 'gated', not a fake 'done'.
      const out = await adapter.submitStockToggle(
        { tenantId, source: adapter.source },
        { channel: b.channel, outletRef: b.outletRef, entityType: b.entityType, entityId: b.entityId, inStock: b.visible },
      )
      // Optimistically reflect the desired visibility on the menu row (same as /stock).
      await supabase.from('aggregator_menu').update({ in_stock: b.visible, updated_at: new Date().toISOString() })
        .eq('tenant_id', tenantId).eq('outlet_ref', b.outletRef).eq('entity_type', b.entityType).eq('entity_id', b.entityId)
      res.json({
        ok: true, ...out, channel: b.channel, gated: cap === 'gated',
        note: cap === 'gated'
          ? 'Queued — Zomato menu/visibility publishing is partner/PetPooja-gated; it will report back as pending partner.'
          : 'Queued — the merchant client applies it on Swiggy on its next poll (~30s).',
      })
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

  // Request an on-demand PAST-order re-pull (older history). Flips the history-sync
  // flag; /pending-actions surfaces it as `historyResync`, the desktop bridge picks it
  // up and runs fd.syncHistory() (fetches ~60d of history on the merchant session) then
  // relays to /history/ingest. Mirrors menu/resync. `channel` is informational.
  r.post('/api/connectors/aggregator/history/resync', ...guardEdit, async (req, res) => {
    try {
      const tenantId = (req as any).tenantId
      const outlet = req.body?.outlet ? String(req.body.outlet) : null
      if (outlet) {
        await supabase.from('aggregator_history_sync').upsert(
          { tenant_id: tenantId, outlet_ref: outlet, pending_full_sync: true, updated_at: new Date().toISOString() },
          { onConflict: 'tenant_id,outlet_ref' })
      } else {
        await supabase.from('aggregator_history_sync').update({ pending_full_sync: true, updated_at: new Date().toISOString() })
          .eq('tenant_id', tenantId)
        // No history-sync rows yet (first ever) → seed 'manual' so the flag has something
        // to carry, matching the desktop's snippet-relay outlet convention.
        await supabase.from('aggregator_history_sync').upsert(
          { tenant_id: tenantId, outlet_ref: 'manual', pending_full_sync: true, updated_at: new Date().toISOString() },
          { onConflict: 'tenant_id,outlet_ref' })
      }
      res.json({ ok: true, note: 'Older orders re-pull requested — they land on the merchant client\'s next sync (~30s).' })
    } catch (err: any) { res.status(err?.status ?? 500).json({ error: err.message }) }
  })

  // ── Cross-channel menu reconcile (foundation for absolute menu sync) ──────────
  // Collapse the per-channel menus (our mini-app/POS catalog + captured Zomato +
  // Swiggy) into ONE master keyed by normalised name, so "3 items on Zomato / 4 on
  // Swiggy" become one master list with per-channel presence/price + an explicit
  // our_item ↔ zomato_catalogueId ↔ swiggy_itemId map (menu_channel_map). This is
  // read-only bookkeeping — no aggregator write — and the base every sync hangs off.
  const normKey = (s: unknown) => String(s ?? '').toLowerCase().normalize('NFKD')
    .replace(/[^a-z0-9]+/g, ' ').trim().replace(/\s+/g, ' ')

  // POST body (all optional): { master: [{id,name,price,available}] } — our own
  // mini-app/POS catalog items to fold in alongside the captured aggregator menus.
  r.post('/api/connectors/aggregator/menu/reconcile', ...guardEdit, async (req, res) => {
    try {
      const tenantId = (req as any).tenantId
      const rows: any[] = []
      const push = (channel: string, item: { id?: any; name?: any; price?: any; available?: any; outletRef?: any }) => {
        const name = String(item.name ?? '').trim()
        if (!name) return
        rows.push({
          tenant_id: tenantId, master_key: normKey(name), master_name: name,
          channel, outlet_ref: item.outletRef != null ? String(item.outletRef) : null,
          channel_item_id: String(item.id ?? `${channel}:${normKey(name)}`),
          channel_name: name, channel_price: item.price != null ? Number(item.price) : null,
          available: item.available !== false, match_type: 'auto', updated_at: new Date().toISOString(),
        })
      }
      // Captured aggregator items (Zomato/Swiggy) already in aggregator_menu.
      const { data: agg } = await supabase.from('aggregator_menu')
        .select('channel, outlet_ref, entity_id, name, price, in_stock')
        .eq('tenant_id', tenantId).eq('entity_type', 'item').limit(5000)
      for (const m of agg ?? []) push(m.channel, { id: m.entity_id, name: m.name, price: m.price, available: m.in_stock, outletRef: m.outlet_ref })
      // Our own catalog items passed from the FE (mini-app + POS share one menu).
      for (const m of Array.isArray(req.body?.master) ? req.body.master : []) {
        push('miniapp', { id: m.id, name: m.name, price: m.price, available: m.available })
      }
      if (rows.length) {
        await supabase.from('menu_channel_map').upsert(rows, { onConflict: 'tenant_id,channel,channel_item_id' })
      }
      const masters = new Set(rows.map(r => r.master_key))
      const byChannel: Record<string, number> = {}
      for (const r of rows) byChannel[r.channel] = (byChannel[r.channel] ?? 0) + 1
      res.json({ ok: true, mapped: rows.length, masterItems: masters.size, byChannel })
    } catch (err: any) { res.status(err?.status ?? 500).json({ error: err.message }) }
  })

  // The unified master menu: one row per master_key with which channels carry it +
  // per-channel price/availability. This is the "same items in my menu" view.
  r.get('/api/connectors/aggregator/menu/unified', ...guardView, async (req, res) => {
    try {
      const { data } = await supabase.from('menu_channel_map')
        .select('master_key, master_name, channel, channel_item_id, channel_price, available')
        .eq('tenant_id', (req as any).tenantId).limit(10000)
      const masters = new Map<string, any>()
      for (const r of data ?? []) {
        let m = masters.get(r.master_key)
        if (!m) { m = { key: r.master_key, name: r.master_name, channels: {} }; masters.set(r.master_key, m) }
        m.channels[r.channel] = { itemId: r.channel_item_id, price: r.channel_price, available: r.available }
      }
      const items = [...masters.values()].map(m => ({ ...m, presentOn: Object.keys(m.channels) }))
        .sort((a, b) => a.name.localeCompare(b.name))
      res.json({ items, count: items.length })
    } catch (err: any) { res.status(err?.status ?? 500).json({ error: err.message }) }
  })

  // Queue a menu create/edit/delete to push OUT to an aggregator. The desktop
  // pulls it on /pending-actions and runs aggregatorClient.editItem on the
  // merchant's session (Swiggy = async QC review; caller passes a built item_vo).
  // Body: { channel, outletRef, action?, entityId?, itemVo }. Swiggy only for now.
  r.post('/api/connectors/aggregator/menu/edit', ...guardEdit, async (req, res) => {
    try {
      const tenantId = (req as any).tenantId
      const { channel, outletRef, action, entityId, itemVo } = req.body ?? {}
      if (!channel || !itemVo) { res.status(400).json({ error: 'channel + itemVo are required' }); return }
      const { data, error } = await supabase.from('aggregator_menu_actions').insert({
        tenant_id: tenantId, channel: String(channel), outlet_ref: outletRef != null ? String(outletRef) : null,
        action: action ?? 'edit', entity_id: entityId != null ? String(entityId) : null, item_vo: itemVo, status: 'pending',
      }).select('id').single()
      if (error) { res.status(500).json({ error: error.message }); return }
      res.json({ ok: true, id: data?.id, note: 'Queued — the merchant client submits it to the aggregator (Swiggy = QC review) on its next poll (~30s).' })
    } catch (err: any) { res.status(err?.status ?? 500).json({ error: err.message }) }
  })

  // Import a captured aggregator menu INTO the tenant's real storefront/POS menu.
  // This is the step that turns a READ-only captured Swiggy/Zomato menu (in
  // aggregator_menu) into the sellable mini-app + POS catalog. Idempotent + non-
  // destructive (see menu-import). Source-agnostic: works for whichever platform's
  // normalised entities we have.
  //   Body: { snapshot?, outletRef?, channel?, storefrontOutletId?, dryRun? }
  //     - snapshot: a raw captured menu body (run through parseMenuSnapshot). If
  //       absent, we import whatever is already in aggregator_menu for this tenant
  //       (optionally filtered by outletRef/channel).
  //     - outletRef: the aggregator restaurant id (used to filter aggregator_menu AND
  //       to resolve the storefront outlet via its swiggyResId/zomatoResId).
  //     - storefrontOutletId: explicit target outlet; overrides resId resolution.
  const ImportBody = z.object({
    snapshot: z.any().optional(),
    outletRef: z.string().min(1).optional(),
    channel: z.enum(['zomato', 'swiggy']).optional(),
    storefrontOutletId: z.string().min(1).optional(),
    dryRun: z.boolean().optional(),
  })
  r.post('/api/connectors/aggregator/menu/import-to-pos', ...guardEdit, validateBody(ImportBody), async (req, res) => {
    try {
      const tenantId = (req as any).tenantId
      const b = req.body as z.infer<typeof ImportBody>
      const { data: t } = await supabase.from('tenants').select('slug, business_type').eq('id', tenantId).maybeSingle()
      const slug = (t as any)?.slug as string | undefined
      if (!slug) { res.status(404).json({ error: 'Tenant has no storefront slug' }); return }
      // HoReCa-gated: an aggregator menu is a restaurant catalog.
      const bt = String((t as any)?.business_type ?? '').toLowerCase()
      if (bt && bt !== 'horeca') { res.status(422).json({ error: 'Menu import is available for HoReCa (restaurant) tenants only' }); return }

      const outletRef = b.outletRef ?? null
      const channel = b.channel ?? null

      // Entities: inline snapshot, else the already-ingested aggregator_menu rows.
      let entities: ParsedEntity[]
      if (b.snapshot) {
        entities = parseMenuSnapshot(b.snapshot)
      } else {
        let q = supabase.from('aggregator_menu')
          .select('entity_type, entity_id, name, in_stock, price, category_ref, raw')
          .eq('tenant_id', tenantId)
        if (outletRef) q = q.eq('outlet_ref', outletRef)
        if (channel) q = q.eq('channel', channel)
        const { data } = await q.limit(5000)
        entities = (data ?? []).map((m: any) => ({
          entity_type: m.entity_type, entity_id: String(m.entity_id), name: m.name,
          in_stock: m.in_stock !== false, price: m.price, category_ref: m.category_ref, raw: m.raw ?? {},
        }))
      }
      if (!entities.length) {
        res.status(400).json({ error: 'No menu to import — pass { snapshot } or ingest the aggregator menu first (POST /menu/ingest).' }); return
      }

      const result = await importMenuToStorefront(slug, entities, {
        targetOutletId: b.storefrontOutletId ?? null,
        aggregatorResId: outletRef,
        channel,
        dryRun: !!b.dryRun,
        // Rehost aggregator photos into our asset bucket → store OUR permanent URL.
        rehost: b.dryRun ? undefined : (u: string) => rehostImageToAssets(supabase, tenantId, u),
      })
      res.json(result)
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
        .select('id, channel, outlet_ref, external_order_id, status, customer_name, item_count, gross_amount, currency, placed_at, raw')
        .eq('tenant_id', (req as any).tenantId)
        .order('placed_at', { ascending: false, nullsFirst: false })
        .limit(Math.min(Number(req.query.limit ?? 200), 500))
      if (req.query.channel) q = q.eq('channel', String(req.query.channel))
      if (req.query.outlet) q = q.eq('outlet_ref', String(req.query.outlet))
      const { data, error } = await q
      if (error) { res.status(500).json({ error: error.message }); return }
      // Surface structured line items when an order-details capture backfilled them
      // (raw.lines: [{name, qty, price, veg}]). Cosmetic-only: the board still works
      // without it; strip the bulky raw blob from the payload otherwise.
      const rows = (data ?? []).map(({ raw, ...o }: any) => ({
        ...o,
        lines: Array.isArray(raw?.lines) ? raw.lines : undefined,
      }))
      res.json(rows)
    } catch (err: any) { res.status(err?.status ?? 500).json({ error: err.message }) }
  })

  // Connection health — is the merchant's Frequency Desktop app polling us?
  // Also reports PER-CHANNEL status so both the web dashboard and the desktop
  // shell can show "Zomato connected" / "Swiggy connected" durably, instead of the
  // desktop-only, in-memory signal that never reached the server. A channel counts
  // as connected when the desktop is live (fresh heartbeat) AND we have ingested
  // that channel's orders at least once (i.e. the merchant logged in and it pulled
  // data). Derived from existing rows — no new desktop reporting required.
  r.get('/api/connectors/aggregator/health', ...guardView, async (req, res) => {
    try {
      const tenantId = (req as any).tenantId
      const { data } = await supabase.from('aggregator_heartbeats')
        .select('last_seen_at, source').eq('tenant_id', tenantId).maybeSingle()
      const lastSeen = (data as any)?.last_seen_at ?? null
      const online = channelIsLive(lastSeen)
      const channels: Record<AggregatorChannel, { connected: boolean; everSeen: boolean }> =
        { zomato: { connected: false, everSeen: false }, swiggy: { connected: false, everSeen: false } }
      await Promise.all((Object.keys(channels) as AggregatorChannel[]).map(async ch => {
        const { count } = await supabase.from('aggregator_orders')
          .select('id', { count: 'exact', head: true }).eq('tenant_id', tenantId).eq('channel', ch)
        const everSeen = !!count && count > 0
        channels[ch] = { everSeen, connected: channelConnected(online, everSeen) }
      }))
      // `channel` lets the dashboard subscribe to the realtime liveness pings
      // without needing to know its own tenant id.
      res.json({ online, lastSeenAt: lastSeen, source: (data as any)?.source ?? null, channels, channel: AGG_STATUS_TOPIC(tenantId) })
    } catch (err: any) { res.status(err?.status ?? 500).json({ error: err.message }) }
  })

  // Connect Frequency Desktop: just mark the integration active. There is no
  // token and no URL to paste — the desktop app authenticates every relay with
  // the merchant's own logged-in Frequency session (same as any FE→BE call).
  r.post('/api/connectors/aggregator/frequency-desktop/connect', ...guardEdit, async (req, res) => {
    try {
      const tenantId = (req as any).tenantId
      const userId = (req as any).user?.id as string | undefined
      if (!userId) { res.status(401).json({ error: 'auth missing user.id' }); return }
      const { error } = await supabase.from('tenant_integrations').upsert({
        tenant_id: tenantId, user_id: userId, key: 'aggregator_frequency_desktop', status: 'active',
        scope: 'order_management', brand_label: 'Zomato/Swiggy · Frequency Desktop',
        metadata: { source: 'frequency_desktop' },
      }, { onConflict: 'tenant_id,key' })
      if (error) { res.status(500).json({ error: 'Failed to persist connection: ' + error.message }); return }
      res.json({
        success: true, source: 'frequency_desktop',
        note: 'Connected. Open Frequency Desktop and log in, then Connect Swiggy/Zomato — orders relay in automatically under this account; accept/ready/reject and stock toggles are pulled back.',
      })
    } catch (err: any) { res.status(err?.status ?? 500).json({ error: err.message }) }
  })

  // ══════════════════════════════════════════════════════════════════════════
  // B) Frequency Desktop bridge (AUTHENTICATED — tenant from the logged-in
  //    session; no token, no public URL). The desktop app relays through its
  //    logged-in Frequency web view, so every call here is a normal guarded
  //    FE→BE request and the tenant comes from identifyTenant like everywhere.
  // ══════════════════════════════════════════════════════════════════════════

  // POST /orders/ingest — the desktop relays a batch of captured orders.
  // Money path — a live order must NEVER be silently dropped. Guarantees:
  //  1. Idempotent upsert on (tenant, channel, external_order_id) — re-pushes
  //     never dup, and the app re-pushes every ~40s (at-least-once backstop).
  //  2. One inline retry per order so a transient DB hiccup doesn't wait 40s.
  //  3. If ANY order still fails, we 503 → the app retries sooner.
  //  4. Whole handler wrapped — an early throw returns 500 (retry).
  // Unchanged re-pushes never re-ring the bell (diff against stored status).
  r.post('/api/connectors/aggregator/orders/ingest', ...guardEdit, async (req, res) => {
    try {
      const tenantId = (req as any).tenantId
      void bumpHeartbeat(tenantId)
      const orders = Array.isArray(req.body?.orders) ? req.body.orders : []

      // Prior statuses for this batch (one query) to detect new vs changed. If it
      // fails, treat all as new (a false re-ring is acceptable; a dropped order is not).
      const ids = orders.map((o: any) => String(o.orderId ?? '')).filter(Boolean)
      const priorByKey = new Map<string, string>()
      if (ids.length) {
        try {
          const { data: prior } = await supabase.from('aggregator_orders')
            .select('channel, external_order_id, status')
            .eq('tenant_id', tenantId).in('external_order_id', ids)
          for (const p of prior ?? []) priorByKey.set(`${(p as any).channel}:${(p as any).external_order_id}`, (p as any).status)
        } catch (e: any) { console.warn(`[aggregator/ingest] prior-status query failed (all treated as new): ${e?.message}`) }
      }

      // Tenant slug + vertical, resolved once for this batch — used to deplete
      // ingredient stock for accepted aggregator sales. HoReCa-only (unset ⇒ HoReCa,
      // matching storefront-api). A miss just skips inventory sync; never fatal.
      let invSlug: string | null = null
      if (orders.length) {
        try {
          const { data: tr } = await supabase.from('tenants').select('slug, business_type').eq('id', tenantId).maybeSingle()
          if (tr && HORECA_INV_TYPES.has(String((tr as any).business_type || 'horeca').toLowerCase())) invSlug = (tr as any).slug || null
        } catch { /* inventory sync is optional */ }
      }

      let notified = 0, failed = 0
      for (const el of orders) {
        try {
          const channel = chan(el.vendor, el.platform, el.source, el.channel, el.data?.vendor, el.data?.platform)
          const status = normalizeStatus(el.status)
          const s = extractSummary(el.data)
          const externalOrderId = String(el.orderId ?? '')
          if (!externalOrderId) continue
          // A Swiggy "activity detected" ping the desktop relays with no order behind it
          // ({source:'lastOrderEventTimestamps'}) — NOT a real order. Skip entirely: no row,
          // no bell, no workflow trigger. (The board also filters these on read; this kills
          // the phantom ring + trigger at the source.)
          if (isGhostMarker(el.data)) continue
          const prior = priorByKey.get(`${channel}:${externalOrderId}`)
          const isNewRow = prior === undefined
          const changed = isNewRow || prior !== status

          const row = {
            tenant_id: tenantId, source: 'frequency_desktop', channel, external_order_id: externalOrderId,
            outlet_ref: el.resId != null ? String(el.resId) : null,
            status, status_identifier: el.statusIdentifier ?? String(el.status ?? ''),
            customer_name: s.name, customer_phone_masked: s.phone,
            item_count: s.items, gross_amount: s.gross,
            // Prefer the canonical placedAt the bridge forwards (correct per platform);
            // fall back to raw, incl. Zomato's real camelCase `order.createdAt` (the old
            // snake_case `created_at` never existed → every Zomato order sank to null).
            placed_at: el.placedAt ?? el.data?.placed_at ?? el.data?.order?.createdAt ?? el.data?.order?.created_at ?? null,
            payload: el.data ?? {}, updated_at: new Date().toISOString(),
          }
          // Persist with one inline retry — a transient hiccup shouldn't cost us a live order.
          let upErr = (await supabase.from('aggregator_orders').upsert(row, { onConflict: 'tenant_id,channel,external_order_id' })).error
          if (upErr) upErr = (await supabase.from('aggregator_orders').upsert(row, { onConflict: 'tenant_id,channel,external_order_id' })).error
          if (upErr) { console.error(`[aggregator/ingest] upsert failed after retry (order ${externalOrderId}): ${upErr.message}`); failed++; continue }

          // Off-platform sale → inventory: deplete on accept, reverse on cancel/reject.
          // Only on a status transition; idempotent + best-effort, never blocks ingest.
          if (changed && invSlug) void syncOrderInventory(invSlug, channel, externalOrderId, status, el.data)

          if (!changed) continue   // unchanged re-push — no bell, no trigger
          notified++
          // Ring for a freshly-SEEN order in any early (pre-fulfilment) state, not only
          // exact 'new'. Zomato orders leave NEW before our ~8s poll catches them (accepted
          // fast), so they're first seen at 'accepted'/'preparing' — still a brand-new order
          // that must ring. Recency-gated (30 min) + first-seen-only so a late history
          // backfill of old/delivered orders never false-rings.
          const EARLY_STATES = new Set(['new', 'accepted', 'preparing', 'ready'])
          const placedMs = row.placed_at ? Date.parse(row.placed_at) : NaN
          const recentEnough = !Number.isFinite(placedMs) || (Date.now() - placedMs) < 30 * 60 * 1000
          const isNew = isNewRow && EARLY_STATES.has(status) && recentEnough
          void notifyOrder(tenantId, { isNew, channel, orderId: externalOrderId, status, summary: orderSummary(s.items, s.gross) })
          void import('../../engine/inbound-router').then(({ fireOrderTrigger }) =>
            fireOrderTrigger(supabase, tenantId, {
              kind: isNew ? 'new_order' : 'order_status', channel, status,
              contactPhone: s.phone, orderId: externalOrderId, order: el.data ?? {},
            })
          ).catch(e => console.warn(`[aggregator/ingest] trigger (non-fatal): ${e?.message}`))
        } catch (e: any) { console.error(`[aggregator/ingest] order error: ${e?.message}`); failed++ }
      }
      if (failed > 0) { res.status(503).json({ received: false, count: orders.length, changed: notified, failed, note: 'partial failure — please retry' }); return }
      res.status(200).json({ received: true, count: orders.length, changed: notified })
    } catch (e: any) {
      console.error(`[aggregator/ingest] handler threw: ${e?.message}`)
      res.status(500).json({ error: 'ingest failed — retry' })   // app re-pushes next poll
    }
  })

  // GET /pending-actions — the desktop polls the operator decisions + stock
  // toggles we queued (tenant-wide, all outlets), executes them on the merchant's
  // own dashboard, and reports back via /actions/result. Poll = liveness signal.
  r.get('/api/connectors/aggregator/pending-actions', ...guardView, async (req, res) => {
    try {
      const tenantId = (req as any).tenantId
      void bumpHeartbeat(tenantId)
      const { data: od } = await supabase.from('aggregator_orders')
        .select('external_order_id, outlet_ref, channel, pending_action, pending_prep_time, pending_reason')
        .eq('tenant_id', tenantId).not('pending_action', 'is', null)
      const orders = (od ?? []).map((o: any) => ({
        orderId: o.external_order_id, resId: o.outlet_ref, channel: o.channel,
        action: o.pending_action, code: PULL_CODE[o.pending_action as keyof typeof PULL_CODE] ?? 0,
        prepTime: o.pending_prep_time ?? 30, reason: o.pending_reason ?? null,
      }))
      const { data: stk } = await supabase.from('aggregator_stock_actions')
        .select('id, outlet_ref, channel, entity_type, entity_id, in_stock')
        .eq('tenant_id', tenantId).eq('status', 'pending')
      const stock = (stk ?? []).map((a: any) => ({
        id: a.id, resId: a.outlet_ref, channel: a.channel,
        entityType: a.entity_type, entityId: a.entity_id, inStock: a.in_stock,
      }))
      // Outlets still needing a one-shot full menu / history pull (day-one catalog).
      const { data: ms } = await supabase.from('aggregator_menu_sync')
        .select('outlet_ref').eq('tenant_id', tenantId).eq('pending_full_sync', true)
      const { data: hs } = await supabase.from('aggregator_history_sync')
        .select('outlet_ref').eq('tenant_id', tenantId).eq('pending_full_sync', true)
      // Queued menu create/edit/delete — the desktop submits each to the aggregator
      // (Swiggy = QC review) via aggregatorClient.editItem, then posts the outcome.
      const { data: me } = await supabase.from('aggregator_menu_actions')
        .select('id, outlet_ref, channel, action, entity_id, item_vo')
        .eq('tenant_id', tenantId).eq('status', 'pending')
      res.json({
        orders, stock,
        menuResync: (ms ?? []).map((r: any) => r.outlet_ref),
        historyResync: (hs ?? []).map((r: any) => r.outlet_ref),
        menuEdits: (me ?? []).map((a: any) => ({
          id: a.id, resId: a.outlet_ref, channel: a.channel, action: a.action, entityId: a.entity_id, itemVo: a.item_vo,
        })),
      })
    } catch (err: any) { res.status(err?.status ?? 500).json({ error: err.message }) }
  })

  // POST /actions/result — the desktop reports the outcome of a queued action,
  // clearing it. kind:'order' (statusCode via RESULT_MAP) | 'stock' (by id).
  r.post('/api/connectors/aggregator/actions/result', ...guardEdit, async (req, res) => {
    try {
      const tenantId = (req as any).tenantId
      const b = (req.body ?? {}) as any
      if (b.kind === 'order' && b.orderId) {
        const mapped = RESULT_MAP[Number(b.statusCode)]
        // Honest terminal handling, mirroring the stock branch. A decision only
        // DEQUEUES (clears pending_action) + advances status when the desktop
        // actually executed it on the aggregator (mapping 'done'). Anything else —
        // Swiggy 'pending-mapping', Zomato 'pending-live-order-mapping', or 'failed'
        // — leaves the decision QUEUED (so it's retried / stays visible) and only
        // records last_action_result so the board shows the honest state.
        const mapping = String(b.result?.mapping ?? '')
        const pendingOrFailed = mapping === 'pending-mapping' || mapping === 'pending-live-order-mapping' || mapping === 'failed'
        const executed = !!mapped && !b.result?.error && !pendingOrFailed
        await supabase.from('aggregator_orders').update({
          ...(executed
            ? { pending_action: null, pending_prep_time: null, pending_reason: null, pending_queued_at: null, status: mapped }
            : {}),
          last_action_result: b.result ?? null, updated_at: new Date().toISOString(),
        }).eq('tenant_id', tenantId).eq('external_order_id', String(b.orderId))
      } else if (b.kind === 'stock' && b.id != null) {
        // Honest terminal state — gated (partner-blocked, e.g. Zomato visibility)
        // ≠ failed (errored) ≠ done (applied). status is free text, no migration.
        const st = b.result?.gated ? 'gated' : (b.result?.error ? 'failed' : 'done')
        await supabase.from('aggregator_stock_actions').update({
          status: st, result: b.result ?? null, updated_at: new Date().toISOString(),
        }).eq('tenant_id', tenantId).eq('id', b.id)
      } else if (b.kind === 'menuEdit' && b.id != null) {
        // Swiggy menu edit is async QC — 'done' = accepted into QC, 'failed' = errored/rejected.
        const failed = !!(b.result?.error || b.result?.rejection)
        await supabase.from('aggregator_menu_actions').update({
          status: failed ? 'failed' : 'done', result: b.result ?? null, updated_at: new Date().toISOString(),
        }).eq('tenant_id', tenantId).eq('id', b.id)
      } else {
        res.status(400).json({ error: "body needs { kind:'order', orderId, statusCode }, { kind:'stock', id } or { kind:'menuEdit', id }" }); return
      }
      res.json({ ok: true })
    } catch (err: any) { res.status(err?.status ?? 500).json({ error: err.message }) }
  })

  // POST /menu/ingest & /history/ingest — day-one catalog + past-order backfill,
  // relayed authenticated by the web app. Body { outletRef, ... }.
  r.post('/api/connectors/aggregator/menu/ingest', ...guardEdit, async (req, res) => {
    const tenantId = (req as any).tenantId
    const outletRef = String(req.body?.outletRef ?? '')
    if (!outletRef) { res.status(400).json({ error: 'outletRef required' }); return }
    try { await ingestMenu(tenantId, outletRef, req.body) }
    catch (e: any) { console.error(`[aggregator/menu] ingest error: ${e?.message}`) }
    res.json({ ok: true })
  })
  r.post('/api/connectors/aggregator/history/ingest', ...guardEdit, async (req, res) => {
    const tenantId = (req as any).tenantId
    const outletRef = String(req.body?.outletRef ?? '')
    if (!outletRef) { res.status(400).json({ error: 'outletRef required' }); return }
    try { await ingestHistory(tenantId, outletRef, req.body) }
    catch (e: any) { console.error(`[aggregator/history] ingest error: ${e?.message}`) }
    res.json({ ok: true })
  })
  // Customer-complaints snapshot (Zomato customer-issues / Swiggy). outletRef is
  // optional — the complaints feed is account-wide, and the order_id is globally
  // unique, so we dedup on source+external_id rather than per-outlet.
  r.post('/api/connectors/aggregator/complaints/ingest', ...guardEdit, async (req, res) => {
    const tenantId = (req as any).tenantId
    const outletRef = String(req.body?.outletRef ?? '') || null
    try { await ingestComplaints(tenantId, outletRef, req.body) }
    catch (e: any) { console.error(`[aggregator/complaints] ingest error: ${e?.message}`) }
    res.json({ ok: true })
  })

  return r
}
