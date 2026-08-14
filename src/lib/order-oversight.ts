/**
 * Order oversight — pure normalisation + stuck-order detection for /naruto §8.
 *
 * Two order stores, two shapes; this file collapses them into ONE PlatformOrder
 * and derives the stuck-order signals from it. Kept pure (no DB, injectable clock)
 * so the route can serve it and the self-check can prove it without Supabase —
 * same discipline as lib/tenant-lifecycle's computeLifecycleState.
 *
 * Sources (see routes/naruto-orders.ts header for the storage map):
 *   • storefront `orders` row  → normalizeStorefrontOrder  (channel storefront|pos)
 *   • `aggregator_orders` row  → normalizeAggregatorOrder  (channel zomato|swiggy)
 *
 * Status vocabulary mirrors the dashboard's src/lib/orders-unified.ts so the
 * platform view can't drift from the operator board.
 */

export type OrderChannel = 'storefront' | 'pos' | 'zomato' | 'swiggy'
export type PaymentStatus = 'paid' | 'pending' | 'refunded' | 'cod'

export interface PlatformOrder {
  key: string                 // `${channel}:${id}` — unique across both stores
  id: string
  channel: OrderChannel
  ref: string                 // short human ref for the row
  tenantId: string | null
  slug: string | null
  status: string              // fulfilment stage (placed/accepted/preparing/ready/served/… | new/…)
  paymentStatus: PaymentStatus
  paymentMethod: string | null
  amount: number
  currency: string
  customerName: string | null
  customerPhone: string | null
  outletRef: string | null
  table: number | null
  mode: string | null         // dine-in | pickup | delivery | shipping | …
  hasTracking: boolean        // delivery assignment signal (D2C)
  pendingAction: string | null
  lateNotified: boolean       // aggregator order-sla already flagged it late
  placedAt: string | null     // ISO
  paidAt: string | null
  acceptedAt: string | null
  updatedAt: string | null
  placedAtMs: number | null   // for sorting without re-parsing
}

// Terminal = no further movement expected (mirrors orders-unified.TERMINAL, plus
// aggregator picked_up which is rider-owned/read-only from our side).
export const TERMINAL_STATUSES = new Set([
  'served', 'delivered', 'rejected', 'cancelled', 'canceled', 'returned', 'refunded', 'picked_up',
])
// Reversed = a paid order landed in a give-money-back state → refunds queue.
export const REFUND_REVERSED_STATUSES = new Set(['cancelled', 'canceled', 'rejected', 'returned', 'refunded'])
// Stages that mean "accepted but mid-flow" — used by confirmed-not-moving.
const MID_FLOW_STATUSES = new Set(['accepted', 'confirmed', 'preparing', 'packed'])
// Stages that mean "arrived, nobody has picked it up" — used by kds-unacked.
const UNACKED_STATUSES = new Set(['placed', 'new'])
// Delivery-ready-but-unassigned candidate stages (D2C storefront).
const AWAITING_DISPATCH_STATUSES = new Set(['ready', 'packed', 'confirmed'])
const DELIVERY_MODES = new Set(['delivery', 'shipping'])

export interface StuckThresholds {
  paidConfirmMin: number   // paid but never accepted
  notMovingMin: number     // accepted but not advancing
  ackMin: number           // placed/new but never acknowledged (KDS)
  deliveryMin: number      // ready for dispatch but unassigned
}

export const DEFAULT_THRESHOLDS: StuckThresholds = {
  paidConfirmMin: 10,
  notMovingMin: 30,
  ackMin: 15,
  deliveryMin: 20,
}

const toMs = (v: string | number | null | undefined): number | null => {
  if (v == null) return null
  const n = typeof v === 'number' ? v : Date.parse(v)
  return Number.isFinite(n) ? n : null
}
const toIso = (v: string | number | null | undefined): string | null => {
  const ms = toMs(v)
  return ms == null ? null : new Date(ms).toISOString()
}

/** storefront-api `orders` row (or its `raw` order object) → PlatformOrder.
 *  Fulfilment stage lives in `raw.manualStatus`; the top-level `status` column is
 *  a payment-ish mirror, so we prefer raw. Falls back gracefully to columns. */
export function normalizeStorefrontOrder(row: any): PlatformOrder {
  const raw = row?.raw ?? row ?? {}
  const channel: OrderChannel = (row?.source ?? raw?.source) === 'counter' ? 'pos' : 'storefront'
  const status = String(raw?.manualStatus ?? 'placed')
  const paidAt = row?.paid_at ?? raw?.paidAt ?? null
  const refundedAt = raw?.refundedAt ?? null
  const method = (row?.payment_method ?? raw?.paymentMethod ?? null) as string | null
  const paymentStatus: PaymentStatus =
    refundedAt ? 'refunded'
      : paidAt ? 'paid'
        : method === 'cod' ? 'cod'
          : 'pending'
  const id = String(row?.id ?? raw?.id ?? '')
  const tracking = raw?.tracking
  const createdAt = row?.created_at ?? raw?.createdAt ?? null

  return {
    key: `${channel}:${id}`,
    id,
    channel,
    ref: `${channel === 'pos' ? 'POS·' : '#'}${id.slice(-4)}`,
    tenantId: row?.tenant_id ?? null,
    slug: row?.slug ?? raw?.slug ?? null,
    status,
    paymentStatus,
    paymentMethod: method,
    amount: Number(row?.grand ?? raw?.grand ?? 0) || 0,
    currency: 'INR',
    customerName: row?.guest_name ?? raw?.guestName ?? raw?.posGuestName ?? null,
    customerPhone: row?.guest_phone ?? raw?.guestPhone ?? raw?.posGuestPhone ?? null,
    outletRef: row?.outlet_id ?? raw?.outletId ?? null,
    table: (row?.table_no ?? raw?.table ?? null) as number | null,
    mode: (raw?.mode ?? null) as string | null,
    hasTracking: !!(tracking && (tracking.number || tracking.url || tracking.carrier)),
    pendingAction: null,
    lateNotified: false,
    placedAt: toIso(createdAt),
    paidAt: toIso(paidAt),
    acceptedAt: toIso(row?.accepted_at ?? raw?.acceptedAt ?? null),
    updatedAt: toIso(raw?.updatedAt ?? row?.updated_at ?? createdAt),
    placedAtMs: toMs(createdAt),
  }
}

/** `aggregator_orders` row → PlatformOrder. Aggregator orders are prepaid by the
 *  platform (Zomato/Swiggy), so payment reads as 'paid' unless reversed. */
export function normalizeAggregatorOrder(row: any): PlatformOrder {
  const channel: OrderChannel = row?.channel === 'swiggy' ? 'swiggy' : 'zomato'
  const status = String(row?.status ?? 'new')
  const reversed = REFUND_REVERSED_STATUSES.has(status)
  const id = String(row?.id ?? '')
  const placedAt = row?.placed_at ?? row?.created_at ?? null

  return {
    key: `${channel}:${id}`,
    id,
    channel,
    ref: `${channel === 'swiggy' ? 'S·' : 'Z·'}${String(row?.external_order_id ?? id).slice(-6)}`,
    tenantId: row?.tenant_id ?? null,
    slug: null,
    status,
    paymentStatus: reversed ? 'refunded' : 'paid',
    paymentMethod: 'aggregator',
    amount: Number(row?.gross_amount ?? 0) || 0,
    currency: String(row?.currency ?? 'INR'),
    customerName: row?.customer_name ?? null,
    customerPhone: row?.customer_phone_masked ?? null,
    outletRef: row?.outlet_ref ?? null,
    table: null,
    mode: 'delivery',
    hasTracking: true,   // rider assignment is the aggregator's, never unassigned on our side
    pendingAction: row?.pending_action ?? null,
    lateNotified: !!row?.late_notified_at,
    placedAt: toIso(placedAt),
    paidAt: reversed ? null : toIso(placedAt),
    acceptedAt: null,
    updatedAt: toIso(row?.updated_at ?? placedAt),
    placedAtMs: toMs(placedAt),
  }
}

const minsSince = (iso: string | null, nowMs: number): number => {
  const ms = toMs(iso)
  return ms == null ? Infinity : (nowMs - ms) / 60_000
}

/**
 * Which stuck buckets does this order fall into (spec §8.2)? Pure: order in,
 * reason keys out. Terminal orders are never stuck. Returns [] for healthy ones.
 *
 *   paid_not_confirmed     — money in, but nobody accepted it              (> paidConfirmMin)
 *   confirmed_not_moving    — accepted but stalled mid-flow                 (> notMovingMin)
 *   kds_unacked             — placed/new, never acknowledged                (> ackMin, or agg late-flagged)
 *   delivery_unassigned     — ready to dispatch, no courier assigned (D2C)  (> deliveryMin)
 *   notification_failed     — NOT computed here (see route WIRE note): storefront
 *                             customer comms are unlogged, so no reliable per-order
 *                             "notification failed" signal exists yet.
 */
export function detectStuck(o: PlatformOrder, nowMs: number, th: StuckThresholds = DEFAULT_THRESHOLDS): string[] {
  if (TERMINAL_STATUSES.has(o.status)) return []
  const reasons: string[] = []

  // paid_not_confirmed — paid (or aggregator new+prepaid) yet still unaccepted.
  const unaccepted = UNACKED_STATUSES.has(o.status)
  if (unaccepted && o.paymentStatus === 'paid' && minsSince(o.paidAt ?? o.placedAt, nowMs) > th.paidConfirmMin) {
    reasons.push('paid_not_confirmed')
  }

  // confirmed_not_moving — accepted/mid-flow but no forward movement.
  if (MID_FLOW_STATUSES.has(o.status) && minsSince(o.updatedAt ?? o.acceptedAt ?? o.placedAt, nowMs) > th.notMovingMin) {
    reasons.push('confirmed_not_moving')
  }

  // kds_unacked — sat in placed/new too long, or the SLA worker already flagged it.
  if (unaccepted && (o.lateNotified || minsSince(o.placedAt, nowMs) > th.ackMin)) {
    reasons.push('kds_unacked')
  }

  // delivery_unassigned — D2C delivery order past ready/packed with no courier.
  if (
    o.mode && DELIVERY_MODES.has(o.mode) && !o.hasTracking &&
    AWAITING_DISPATCH_STATUSES.has(o.status) &&
    minsSince(o.placedAt, nowMs) > th.deliveryMin
  ) {
    reasons.push('delivery_unassigned')
  }

  return reasons
}

export const STUCK_REASON_LABELS: Record<string, string> = {
  paid_not_confirmed: 'Paid, not confirmed',
  confirmed_not_moving: 'Confirmed, not moving',
  kds_unacked: 'KDS unacknowledged',
  delivery_unassigned: 'Delivery unassigned',
  notification_failed: 'Notification failed',
}
