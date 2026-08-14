/**
 * Lean self-check for order oversight normalisation + stuck detection (no DB).
 * Run with:  npx tsx src/lib/order-oversight.selfcheck.ts
 * Runnable asserts only — the invariants the /naruto §8 order stream depends on.
 */
import assert from 'node:assert'
import {
  normalizeStorefrontOrder, normalizeAggregatorOrder, detectStuck,
  DEFAULT_THRESHOLDS, TERMINAL_STATUSES, REFUND_REVERSED_STATUSES,
} from './order-oversight'

const NOW = Date.parse('2026-08-14T12:00:00Z')
const minsAgo = (m: number) => new Date(NOW - m * 60_000).toISOString()

// ── Storefront normalisation: channel split + payment derivation ─────────────
const posRow = {
  id: 'ord_pos_1234', tenant_id: 't1', slug: 'cafe', source: 'counter',
  payment_method: 'cash', grand: 450, guest_name: 'Walk-in', created_at: minsAgo(5),
  paid_at: minsAgo(5), raw: { manualStatus: 'preparing', mode: 'dine-in', paidAt: NOW - 5 * 60_000 },
}
const pos = normalizeStorefrontOrder(posRow)
assert.equal(pos.channel, 'pos')
assert.equal(pos.status, 'preparing')          // from raw.manualStatus, not the column
assert.equal(pos.paymentStatus, 'paid')
assert.equal(pos.ref, 'POS·1234')
assert.equal(pos.amount, 450)

// COD, unpaid → 'cod'; refundedAt wins over paidAt → 'refunded'.
assert.equal(normalizeStorefrontOrder({ id: 'a', source: 'storefront', payment_method: 'cod', raw: { manualStatus: 'placed' } }).paymentStatus, 'cod')
assert.equal(normalizeStorefrontOrder({ id: 'b', source: 'storefront', paid_at: minsAgo(1), raw: { manualStatus: 'cancelled', refundedAt: NOW } }).paymentStatus, 'refunded')

// ── Aggregator normalisation: channel + prepaid + reversal ───────────────────
const agg = normalizeAggregatorOrder({ id: 'ag1', tenant_id: 't2', channel: 'swiggy', status: 'new', external_order_id: '998877', gross_amount: 700, placed_at: minsAgo(20), late_notified_at: minsAgo(2) })
assert.equal(agg.channel, 'swiggy')
assert.equal(agg.paymentStatus, 'paid')        // aggregator orders are prepaid
assert.equal(agg.ref, 'S·998877')
assert.equal(agg.lateNotified, true)
// reversed status → refunded, unknown channel coerces to zomato
assert.equal(normalizeAggregatorOrder({ id: 'x', channel: 'weird', status: 'cancelled' }).paymentStatus, 'refunded')
assert.equal(normalizeAggregatorOrder({ id: 'x', channel: 'weird', status: 'new' }).channel, 'zomato')

// ── Stuck detectors ──────────────────────────────────────────────────────────
// paid_not_confirmed: paid 12m ago, still 'placed' (> 10m default).
const paidStale = normalizeStorefrontOrder({ id: 'p1', source: 'storefront', paid_at: minsAgo(12), created_at: minsAgo(12), raw: { manualStatus: 'placed', paidAt: NOW - 12 * 60_000 } })
let reasons = detectStuck(paidStale, NOW)
assert.ok(reasons.includes('paid_not_confirmed'), 'expected paid_not_confirmed')
assert.ok(!reasons.includes('kds_unacked'), 'placed only 12m (< ackMin 15m) → not yet KDS-unacked')

// kds_unacked: placed 20m ago, never accepted (> 15m).
reasons = detectStuck(normalizeStorefrontOrder({ id: 'k1', source: 'storefront', created_at: minsAgo(20), raw: { manualStatus: 'placed' } }), NOW)
assert.ok(reasons.includes('kds_unacked'), 'expected kds_unacked')

// confirmed_not_moving: accepted, no movement 40m (> 30m).
reasons = detectStuck(normalizeStorefrontOrder({ id: 'c1', source: 'storefront', accepted_at: minsAgo(40), created_at: minsAgo(45), raw: { manualStatus: 'accepted', updatedAt: NOW - 40 * 60_000 } }), NOW)
assert.ok(reasons.includes('confirmed_not_moving'), 'expected confirmed_not_moving')

// delivery_unassigned: D2C delivery, ready 25m, no tracking (> 20m).
reasons = detectStuck(normalizeStorefrontOrder({ id: 'd1', source: 'storefront', created_at: minsAgo(25), raw: { manualStatus: 'ready', mode: 'delivery' } }), NOW)
assert.ok(reasons.includes('delivery_unassigned'), 'expected delivery_unassigned')

// aggregator late-flagged 'new' → kds_unacked even within ackMin window.
reasons = detectStuck(agg, NOW)
assert.ok(reasons.includes('kds_unacked'), 'expected kds_unacked from late_notified')
assert.ok(reasons.includes('paid_not_confirmed'), 'prepaid+new 20m → paid_not_confirmed')

// Terminal orders are never stuck; healthy fresh order is clean.
assert.deepEqual(detectStuck(normalizeStorefrontOrder({ id: 't', source: 'storefront', paid_at: minsAgo(2), created_at: minsAgo(60), raw: { manualStatus: 'served', paidAt: NOW } }), NOW), [])
assert.deepEqual(detectStuck(normalizeStorefrontOrder({ id: 'f', source: 'storefront', created_at: minsAgo(2), raw: { manualStatus: 'placed' } }), NOW), [], 'fresh 2m placed is not stuck')

// Threshold override tightens/loosens.
const midStuck = normalizeStorefrontOrder({ id: 'm', source: 'storefront', accepted_at: minsAgo(20), created_at: minsAgo(25), raw: { manualStatus: 'preparing', updatedAt: NOW - 20 * 60_000 } })
assert.ok(!detectStuck(midStuck, NOW).includes('confirmed_not_moving'), '20m < default 30m')
assert.ok(detectStuck(midStuck, NOW, { ...DEFAULT_THRESHOLDS, notMovingMin: 15 }).includes('confirmed_not_moving'), '20m > 15m override')

// Constants sanity.
assert.ok(TERMINAL_STATUSES.has('served') && TERMINAL_STATUSES.has('picked_up'))
assert.ok(REFUND_REVERSED_STATUSES.has('cancelled') && !REFUND_REVERSED_STATUSES.has('served'))

console.log('order-oversight self-check: OK')
