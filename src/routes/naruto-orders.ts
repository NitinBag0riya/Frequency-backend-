/**
 * Naruto Platform OS — §8 cross-tenant order oversight.
 *
 * The one place the platform team watches EVERY tenant's orders flow, catches the
 * ones that stall, and checks that the aggregator pipes are alive — without SQL
 * and without leaving /naruto (spec §0 axiom).
 *
 * ── Where orders actually live (two stores, one Supabase project) ─────────────
 *   • Direct orders (storefront mini-app + POS counter) → `orders` table.
 *     storefront-api dual-writes it on every mutation (storefront-api/db.js), keyed
 *     on the SAME `tenants.id` uuid the dashboard uses. `source` splits the channel:
 *     'storefront' = mini-app, 'counter' = POS. Fulfilment stage is `raw.manualStatus`.
 *   • Aggregator orders (Zomato / Swiggy) → `aggregator_orders` table (this DB),
 *     ingested by Frequency Desktop. `channel` = zomato|swiggy, `status` is the stage.
 * A service-role client reads both (bypasses RLS — the intended cross-tenant path,
 * same pattern as workers/order-sla.ts). We normalise the two shapes into ONE
 * PlatformOrder, merge, and serve recency-windowed + paginated.
 *
 * ── Endpoints ─────────────────────────────────────────────────────────────────
 *   GET  /api/naruto/orders            live stream (filter tenant/vertical/channel/
 *                                      status/bucket) — server-paginated + counts   [tenant.read]
 *   GET  /api/naruto/orders/detail     one order: lifecycle timeline, payment,
 *                                      notification log, customer, raw payload      [tenant.read]
 *   GET  /api/naruto/orders/sync-health  per-tenant aggregator heartbeat + last
 *                                      sync + failed pushes                          [diagnostics.read]
 *   POST /api/naruto/orders/refund     reason-required, audited refund action       [payments.refund.write]
 *
 * Reads are gated 'tenant.read' (all six platform roles have it); the refund is the
 * only mutation and carries 'payments.refund.write' + a mandatory reason + audit.
 *
 * ── WIRE(naruto) — REGISTRATION (shell owns; not edited here) ─────────────────
 * In flowgpt-server/src/index.ts, next to the other naruto routers (~line 5992,
 * after createNarutoStorefrontRouter):
 *     import { createNarutoOrdersRouter } from './routes/naruto-orders'
 *     app.use(createNarutoOrdersRouter({ supabase, requireAuth }))
 * Router declares full /api/naruto/* paths — mount at root, no prefix. The
 * `supabase` passed in is already the service-role client, so it reads every
 * tenant's rows.
 */

import express from 'express'
import { z } from 'zod'
import type { SupabaseClient } from '@supabase/supabase-js'
import { requirePlatformCapability } from '../lib/platform-guard'
import { recordPlatformAudit } from '../lib/platform-audit'
import {
  normalizeStorefrontOrder, normalizeAggregatorOrder, detectStuck,
  DEFAULT_THRESHOLDS, REFUND_REVERSED_STATUSES, type PlatformOrder, type StuckThresholds,
} from '../lib/order-oversight'

type Middleware = (req: express.Request, res: express.Response, next: express.NextFunction) => void | Promise<void>

interface Deps {
  supabase: SupabaseClient
  requireAuth: Middleware
}

// Recency window + hard row cap per source. This is an OPS view of what's flowing
// now / recently stuck — not an archival report — so a bounded fetch is correct.
// ponytail: merge + paginate happen in memory over this window. Ceiling: fine at
// current scale (single-digit tenants, hundreds of orders/day). Upgrade path when
// it grows: a `platform_orders` unified view (UNION storefront `orders` +
// `aggregator_orders`) with SQL-side ORDER BY + range for true server pagination.
const DEFAULT_DAYS = 14
const MAX_DAYS = 92
const SOURCE_CAP = 2000
const HEARTBEAT_STALE_MS = 90_000  // desktop poll cadence — stale ⇒ offline (matches dashboard)

type Channel = PlatformOrder['channel']
const STOREFRONT_CHANNELS: Channel[] = ['storefront', 'pos']
const AGG_CHANNELS: Channel[] = ['zomato', 'swiggy']

interface TenantMeta { name: string; slug: string | null; vertical: string | null; status: string | null }

/** id → tenant meta, for names + vertical filtering + vertical annotation. One
 *  read, reused across list / detail / sync-health. */
async function loadTenantMeta(supabase: SupabaseClient): Promise<Map<string, TenantMeta>> {
  const map = new Map<string, TenantMeta>()
  const { data, error } = await supabase.from('tenants')
    .select('id, business_name, slug, business_type, status')
    .neq('status', 'deleted')
  if (error) { console.warn('[naruto-orders] tenant meta load failed:', error.message); return map }
  for (const t of (data ?? []) as any[]) {
    map.set(t.id, { name: t.business_name ?? 'Unnamed', slug: t.slug ?? null, vertical: t.business_type ?? null, status: t.status ?? null })
  }
  return map
}

/** Fetch + normalise both stores into one PlatformOrder list. Best-effort per
 *  source: a failing read degrades to [] (never fails the whole page), mirroring
 *  lib/tenant-lifecycle.gatherSignals. `channels` restricts which tables we touch. */
async function fetchOrders(
  supabase: SupabaseClient,
  opts: { sinceIso: string; tenantId?: string | null; channels: Set<Channel> },
): Promise<{ orders: PlatformOrder[]; errors: string[] }> {
  const errors: string[] = []
  const wantStorefront = STOREFRONT_CHANNELS.some(c => opts.channels.has(c))
  const wantAgg = AGG_CHANNELS.some(c => opts.channels.has(c))

  const [sf, agg] = await Promise.all([
    wantStorefront ? (async () => {
      let q = supabase.from('orders')
        .select('id, tenant_id, slug, source, status, payment_method, grand, guest_name, guest_phone, mode, outlet_id, table_no, created_at, paid_at, accepted_at, raw')
        .gte('created_at', opts.sinceIso)
        .order('created_at', { ascending: false })
        .limit(SOURCE_CAP)
      if (opts.tenantId) q = q.eq('tenant_id', opts.tenantId)
      const { data, error } = await q
      if (error) { errors.push(`orders: ${error.message}`); return [] as PlatformOrder[] }
      return (data ?? []).map(normalizeStorefrontOrder)
    })() : Promise.resolve([] as PlatformOrder[]),

    wantAgg ? (async () => {
      let q = supabase.from('aggregator_orders')
        .select('id, tenant_id, channel, source, external_order_id, outlet_ref, status, status_identifier, customer_name, customer_phone_masked, item_count, gross_amount, currency, placed_at, pending_action, pending_queued_at, late_notified_at, created_at, updated_at')
        .gte('created_at', opts.sinceIso)
        .order('created_at', { ascending: false })
        .limit(SOURCE_CAP)
      if (opts.tenantId) q = q.eq('tenant_id', opts.tenantId)
      const { data, error } = await q
      if (error) { errors.push(`aggregator_orders: ${error.message}`); return [] as PlatformOrder[] }
      return (data ?? []).map(normalizeAggregatorOrder)
    })() : Promise.resolve([] as PlatformOrder[]),
  ])

  const orders = [...sf, ...agg].filter(o => opts.channels.has(o.channel))
  return { orders, errors }
}

function parseThresholds(q: Record<string, any>): StuckThresholds {
  const num = (v: any, d: number) => {
    const n = Number(v); return Number.isFinite(n) && n >= 0 ? n : d
  }
  return {
    paidConfirmMin: num(q.paidMin, DEFAULT_THRESHOLDS.paidConfirmMin),
    notMovingMin: num(q.moveMin, DEFAULT_THRESHOLDS.notMovingMin),
    ackMin: num(q.ackMin, DEFAULT_THRESHOLDS.ackMin),
    deliveryMin: num(q.deliveryMin, DEFAULT_THRESHOLDS.deliveryMin),
  }
}

export function createNarutoOrdersRouter(deps: Deps): express.Router {
  const r = express.Router()
  const { supabase, requireAuth } = deps

  // ─── Live order stream + stuck/refunds buckets ──────────────────────────────
  r.get('/api/naruto/orders',
    requireAuth, requirePlatformCapability(supabase, 'tenant.read'),
    async (req, res) => {
      const q = req.query as Record<string, any>
      const days = Math.min(MAX_DAYS, Math.max(1, Number(q.days) || DEFAULT_DAYS))
      const sinceIso = new Date(Date.now() - days * 86_400_000).toISOString()
      const tenantId = typeof q.tenantId === 'string' && q.tenantId ? q.tenantId : null
      const bucket = q.bucket === 'stuck' || q.bucket === 'refunds' ? q.bucket : 'all'
      const statusFilter = typeof q.status === 'string' && q.status && q.status !== 'all' ? q.status : null
      const th = parseThresholds(q)

      // Channel filter → restrict which tables we even hit.
      const chParam = typeof q.channel === 'string' && q.channel && q.channel !== 'all' ? q.channel : null
      const channels = new Set<Channel>(
        chParam && (['storefront', 'pos', 'zomato', 'swiggy'] as Channel[]).includes(chParam as Channel)
          ? [chParam as Channel]
          : (['storefront', 'pos', 'zomato', 'swiggy'] as Channel[]),
      )

      const page = Math.max(1, Number(q.page) || 1)
      const pageSize = Math.min(100, Math.max(1, Number(q.pageSize) || 25))

      try {
        const meta = await loadTenantMeta(supabase)
        const { orders, errors } = await fetchOrders(supabase, { sinceIso, tenantId, channels })
        const now = Date.now()

        // Annotate: tenant name/vertical + stuck reasons.
        let rows = orders.map(o => {
          const m = o.tenantId ? meta.get(o.tenantId) : null
          return {
            ...o,
            tenantName: m?.name ?? (o.slug ?? o.tenantId ?? 'Unknown'),
            vertical: m?.vertical ?? null,
            stuckReasons: detectStuck(o, now, th),
          }
        })

        // Filters that need the normalised row.
        const verticalFilter = typeof q.vertical === 'string' && q.vertical && q.vertical !== 'all' ? q.vertical : null
        if (verticalFilter) rows = rows.filter(o => o.vertical === verticalFilter)
        if (statusFilter) rows = rows.filter(o => o.status === statusFilter)

        // Bucket counts BEFORE bucket filter (so tab badges show totals in-window).
        const stuckCount = rows.filter(o => o.stuckReasons.length > 0).length
        const refundsCount = rows.filter(o => REFUND_REVERSED_STATUSES.has(o.status) && o.paymentStatus === 'paid').length

        if (bucket === 'stuck') rows = rows.filter(o => o.stuckReasons.length > 0)
        else if (bucket === 'refunds') rows = rows.filter(o => REFUND_REVERSED_STATUSES.has(o.status) && o.paymentStatus === 'paid')

        rows.sort((a, b) => (b.placedAtMs ?? 0) - (a.placedAtMs ?? 0))

        const totalItems = rows.length
        const totalPages = Math.max(1, Math.ceil(totalItems / pageSize))
        const pageRows = rows.slice((page - 1) * pageSize, page * pageSize)

        res.json({
          data: pageRows,
          page, pageSize, totalPages, totalItems,
          counts: { stuck: stuckCount, refunds: refundsCount },
          windowDays: days,
          thresholds: th,
          partial: errors.length ? errors : undefined,
        })
      } catch (e: any) {
        console.error('[naruto-orders] list failed:', e?.message ?? e)
        res.status(500).json({ error: e?.message ?? 'Order stream failed' })
      }
    })

  // ─── Order detail: timeline · payment · notifications · customer · raw ───────
  r.get('/api/naruto/orders/detail',
    requireAuth, requirePlatformCapability(supabase, 'tenant.read'),
    async (req, res) => {
      const channel = String(req.query.channel ?? '')
      const id = String(req.query.id ?? '')
      if (!id) { res.status(400).json({ error: 'id required' }); return }
      const isAgg = channel === 'zomato' || channel === 'swiggy'

      try {
        let order: PlatformOrder | null = null
        let raw: any = null
        let tenders: any[] = []
        let lines: any[] = []

        if (isAgg) {
          const { data } = await supabase.from('aggregator_orders').select('*').eq('id', id).maybeSingle()
          if (!data) { res.status(404).json({ error: 'Order not found' }); return }
          order = normalizeAggregatorOrder(data)
          raw = (data as any).payload ?? data
        } else {
          const { data } = await supabase.from('orders').select('*').eq('id', id).maybeSingle()
          if (!data) { res.status(404).json({ error: 'Order not found' }); return }
          order = normalizeStorefrontOrder(data)
          raw = (data as any).raw ?? data
          // Money movements + item lines for the receipt view.
          const [{ data: t }, { data: l }] = await Promise.all([
            supabase.from('order_tenders').select('id, mode, amount, reason, reverses_id, at').eq('order_id', id).order('at', { ascending: true }),
            supabase.from('order_lines').select('id, name, qty, price, veg, options').eq('order_id', id),
          ])
          tenders = t ?? []
          lines = l ?? []
        }

        const meta = order.tenantId ? (await loadTenantMeta(supabase)).get(order.tenantId) : null

        // Notification log — order.* events for this tenant, joined to their
        // delivery status. Order-scoped where the event data carries an id.
        // ponytail: storefront customer WhatsApp/SMS are fire-and-forget and NOT
        // logged (storefront-api notifyCustomerWa/notifyOrderSms). This shows the
        // in-app / delivery-logged notifications only. WIRE(naruto): to show
        // customer-comms delivery per order, storefront-api must persist a row on
        // each send (order_id, channel, template, status) — no such log exists yet.
        let notifications: any[] = []
        if (order.tenantId) {
          const { data: notifs } = await supabase.from('notifications')
            .select('id, event_key, data, severity, created_at')
            .eq('tenant_id', order.tenantId)
            .in('event_key', ['order.new', 'order.status', 'order.late'])
            .order('created_at', { ascending: false })
            .limit(50)
          const scoped = (notifs ?? []).filter((n: any) => {
            const d = n.data ?? {}
            const oid = d.order_id ?? d.orderId ?? d.id ?? d.external_order_id
            return oid == null || String(oid) === id || String(oid) === String((raw as any)?.external_order_id ?? '')
          }).slice(0, 20)
          const ids = scoped.map((n: any) => n.id)
          let delivery: Record<string, any[]> = {}
          if (ids.length) {
            const { data: dl } = await supabase.from('notification_delivery_log')
              .select('notification_id, channel, status, error_message, created_at')
              .in('notification_id', ids)
            for (const row of (dl ?? []) as any[]) {
              (delivery[row.notification_id] ||= []).push(row)
            }
          }
          notifications = scoped.map((n: any) => ({ ...n, deliveries: delivery[n.id] ?? [] }))
        }

        // Lifecycle timeline — ordered milestones we can prove from timestamps.
        const timeline = buildTimeline(order, raw)

        res.json({
          order: { ...order, tenantName: meta?.name ?? null, vertical: meta?.vertical ?? null },
          timeline,
          payment: {
            status: order.paymentStatus,
            method: order.paymentMethod,
            amount: order.amount,
            currency: order.currency,
            tenders,
            gateway: (raw as any)?.payment ?? null,   // prepaid receipt (Razorpay/Cashfree) when present
          },
          notifications,
          lines: lines.length ? lines : ((raw as any)?.lines ?? []),
          raw,
        })
      } catch (e: any) {
        console.error('[naruto-orders] detail failed:', e?.message ?? e)
        res.status(500).json({ error: e?.message ?? 'Order detail failed' })
      }
    })

  // ─── Aggregator sync health per tenant ──────────────────────────────────────
  r.get('/api/naruto/orders/sync-health',
    requireAuth, requirePlatformCapability(supabase, 'diagnostics.read'),
    async (_req, res) => {
      try {
        const [meta, { data: beats }, { data: syncs }, { data: failed }] = await Promise.all([
          loadTenantMeta(supabase),
          supabase.from('aggregator_heartbeats').select('tenant_id, source, last_seen_at, updated_at'),
          supabase.from('aggregator_history_sync').select('tenant_id, outlet_ref, pending_full_sync, last_synced_at'),
          supabase.from('aggregator_stock_actions').select('tenant_id').eq('status', 'failed'),
        ])
        const now = Date.now()

        // One row per tenant that has an aggregator footprint (heartbeat or sync state).
        const tenantIds = new Set<string>()
        for (const b of (beats ?? []) as any[]) tenantIds.add(b.tenant_id)
        for (const s of (syncs ?? []) as any[]) tenantIds.add(s.tenant_id)

        const beatBy = new Map((beats ?? []).map((b: any) => [b.tenant_id, b]))
        const syncByTenant = new Map<string, any[]>()
        for (const s of (syncs ?? []) as any[]) {
          const list = syncByTenant.get(s.tenant_id) ?? []
          list.push(s)
          syncByTenant.set(s.tenant_id, list)
        }
        const failedBy = new Map<string, number>()
        for (const f of (failed ?? []) as any[]) failedBy.set(f.tenant_id, (failedBy.get(f.tenant_id) ?? 0) + 1)

        const rows = [...tenantIds].map(tid => {
          const m = meta.get(tid)
          const beat = beatBy.get(tid) as any
          const lastSeenMs = beat?.last_seen_at ? Date.parse(beat.last_seen_at) : null
          const online = lastSeenMs != null && (now - lastSeenMs) < HEARTBEAT_STALE_MS
          const outlets = syncByTenant.get(tid) ?? []
          const lastSync = outlets.reduce<string | null>((acc, o) => {
            if (!o.last_synced_at) return acc
            return !acc || Date.parse(o.last_synced_at) > Date.parse(acc) ? o.last_synced_at : acc
          }, null)
          return {
            tenantId: tid,
            tenantName: m?.name ?? tid,
            vertical: m?.vertical ?? null,
            source: beat?.source ?? null,
            online,
            lastSeenAt: beat?.last_seen_at ?? null,
            outletsTracked: outlets.length,
            pendingFullSync: outlets.some((o: any) => o.pending_full_sync),
            lastSyncedAt: lastSync,
            failedPushes: failedBy.get(tid) ?? 0,
          }
        }).sort((a, b) => Number(a.online) - Number(b.online) || b.failedPushes - a.failedPushes)

        res.json({ data: rows, staleMs: HEARTBEAT_STALE_MS })
      } catch (e: any) {
        console.error('[naruto-orders] sync-health failed:', e?.message ?? e)
        res.status(500).json({ error: e?.message ?? 'Sync health failed' })
      }
    })

  // ─── Refund (reason-required, audited) ──────────────────────────────────────
  const RefundSchema = z.object({
    channel: z.enum(['storefront', 'pos', 'zomato', 'swiggy']),
    id: z.string().trim().min(1).max(120),
    amount: z.number().positive().optional(),   // omit = full
    reason: z.string().trim().min(3).max(400),
  })

  r.post('/api/naruto/orders/refund',
    requireAuth, requirePlatformCapability(supabase, 'payments.refund.write'),
    async (req, res) => {
      const parsed = RefundSchema.safeParse(req.body ?? {})
      if (!parsed.success) { res.status(400).json({ error: 'Invalid input', details: parsed.error.flatten() }); return }
      const { channel, id, amount, reason } = parsed.data
      const isAgg = channel === 'zomato' || channel === 'swiggy'

      try {
        // Load the order to validate it's refundable + capture before-state for audit.
        const table = isAgg ? 'aggregator_orders' : 'orders'
        const { data: row } = await supabase.from(table).select('*').eq('id', id).maybeSingle()
        if (!row) { res.status(404).json({ error: 'Order not found' }); return }
        const order = isAgg ? normalizeAggregatorOrder(row) : normalizeStorefrontOrder(row)

        if (order.paymentStatus !== 'paid') {
          res.status(409).json({ error: `Order is not in a refundable (paid) state — payment is '${order.paymentStatus}'` }); return
        }

        // Aggregator refunds are owned by the aggregator (Zomato/Swiggy) — never
        // Frequency's gateway. Platform can't move that money.
        if (isAgg) {
          res.status(422).json({ error: `${channel} refunds are issued by the aggregator, not by Frequency. Resolve in the ${channel} partner console.` }); return
        }

        // ── Money movement is NOT wired here. ──────────────────────────────────
        // storefront-api's order "refund" is bookkeeping only (sets refundedAt +
        // restock + loyalty reversal); it makes NO gateway refund call. The real
        // Razorpay/Cashfree refund exists only as a tenant workflow connector node
        // (flowgpt-server/src/connectors/registry.ts → razorpay refund_payment,
        // POST /api/connectors/razorpay/payments/:id/refund). A platform-initiated
        // refund must call that gateway with the TENANT's own credentials + the
        // gateway payment id (raw.payment.paymentId). Until that is plumbed here we
        // record the operator's audited decision and return it as pending — we do
        // NOT fake success or mutate the order.
        //
        // WIRE(naruto) — gateway refund: resolve the tenant's Razorpay/Cashfree
        // creds (lib/resolve gateway keys) + gatewayPaymentId from the order's
        // payment record, call the provider refund API, then on success write the
        // storefront-api order refund (paidAt→refundedAt + restock + reverseLoyalty)
        // so the tenant's books match. Keep the write idempotent on payment id.
        const gatewayPaymentId = (row as any)?.raw?.payment?.paymentId
          ?? (row as any)?.raw?.payment?.gatewayPaymentId ?? null

        await recordPlatformAudit(supabase, req, {
          capability: 'payments.refund.write',
          action: 'order.refund.request',
          tenant_id: order.tenantId,
          before: { order_id: id, channel, payment_status: order.paymentStatus, amount: order.amount },
          after: { refund_amount: amount ?? order.amount, gateway_payment_id: gatewayPaymentId, gateway_call: 'wire_pending' },
          reason,
        })

        res.json({
          recorded: true,
          gateway: 'wire_pending',
          gatewayPaymentId,
          message: gatewayPaymentId
            ? 'Refund decision recorded and audited. Gateway money-movement is not yet wired from the platform — complete it via the tenant gateway once the WIRE(naruto) refund plumbing lands.'
            : 'Refund decision recorded and audited. No gateway payment id on this order (likely COD) — refund is a manual/bookkeeping action.',
        })
      } catch (e: any) {
        console.error('[naruto-orders] refund failed:', e?.message ?? e)
        res.status(500).json({ error: e?.message ?? 'Refund failed' })
      }
    })

  return r
}

/** Prove-from-timestamps lifecycle timeline. Only milestones with a real
 *  timestamp appear, newest logic aside (returned ascending for a top-down read). */
function buildTimeline(o: PlatformOrder, raw: any): { key: string; label: string; at: string }[] {
  const out: { key: string; label: string; at: string }[] = []
  const push = (key: string, label: string, at: any) => {
    if (!at) return
    const iso = typeof at === 'number' ? new Date(at).toISOString() : String(at)
    out.push({ key, label, at: iso })
  }
  push('placed', 'Placed', o.placedAt ?? raw?.createdAt)
  push('accepted', 'Accepted', o.acceptedAt ?? raw?.acceptedAt)
  push('paid', 'Paid', o.paidAt ?? raw?.paidAt)
  push('preparing', 'Preparing', raw?.preparingAt)
  push('ready', 'Ready', raw?.readyAt)
  push('shipped', 'Shipped', raw?.shippedAt)
  push('served', 'Served', raw?.servedAt)
  push('delivered', 'Delivered', raw?.deliveredAt)
  push('returned', 'Returned', raw?.returnedAt)
  push('refunded', 'Refunded', raw?.refundedAt)
  push('cancelled', 'Cancelled', raw?.cancelledAt)
  return out.sort((a, b) => Date.parse(a.at) - Date.parse(b.at))
}
