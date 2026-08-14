/**
 * Self-check for the platform payments money math (no DB, no network).
 * Run with:  npx tsx src/routes/naruto-payments.selfcheck.ts
 * Locks the ledger/revenue invariants the /naruto §9 numbers depend on.
 */
import assert from 'node:assert'
import {
  ledgerRowOf, buildLedger, rollupRevenue, GATEWAY_FEE_EST_PCT,
  type RawTxn, type TenantMeta,
} from './naruto-payments'

const meta = new Map<string, TenantMeta>([
  ['cafe', { tenantId: 'T1', name: 'Cafe X', vertical: 'horeca', plan: 'growth' }],
  ['salon', { tenantId: 'T2', name: 'Aura', vertical: 'salon', plan: 'starter' }],
])

const mk = (o: Partial<RawTxn>): RawTxn => ({
  orderId: 'o', slug: 'cafe', tenantName: 'Cafe X', gross: 0, method: 'prepaid',
  gateway: 'razorpay', txnId: 't', paidAt: Date.UTC(2026, 6, 15), createdAt: Date.UTC(2026, 6, 15),
  status: 'served', refunded: false, platformFeePaise: null, viaPlatformRoute: false, ...o,
})

// ── Prepaid via platform Route: 1% commission (from stored paise) + 2% est PSP fee ──
{
  const row = ledgerRowOf(mk({ gross: 1000, platformFeePaise: 1000, viaPlatformRoute: true }), meta.get('cafe'))
  assert.equal(row.platformFee, 10, 'platform fee = ₹10 (1% of ₹1000, from paise)')
  assert.equal(row.gatewayFee, 20, 'gateway fee = ₹20 (2% est)')
  assert.equal(row.net, 970, 'net = gross − platform − gateway')
  assert.equal(row.settlement, 'routed')
  assert.equal(row.vertical, 'horeca')
}

// ── Prepaid on own keys (no Route): commission 0, still a PSP fee, settles direct ──
{
  const row = ledgerRowOf(mk({ gross: 500, platformFeePaise: null, gateway: 'cashfree' }))
  assert.equal(row.platformFee, 0, 'no Route → no commission (never fabricated)')
  assert.equal(row.gatewayFee, 10, '2% of ₹500')
  assert.equal(row.settlement, 'direct')
}

// ── COD: full cash to merchant, no platform/PSP fee, settles cash ──
{
  const row = ledgerRowOf(mk({ method: 'cod', gateway: null, gross: 300 }))
  assert.equal(row.platformFee, 0)
  assert.equal(row.gatewayFee, 0)
  assert.equal(row.net, 300, 'COD net = full cash')
  assert.equal(row.settlement, 'cod')
}

// ── Refund is visible but nets OUT of GMV/commission ──
{
  const { summary } = buildLedger([
    mk({ orderId: 'a', gross: 1000, platformFeePaise: 1000, viaPlatformRoute: true }),
    mk({ orderId: 'b', gross: 400, refunded: true, status: 'refunded' }),
  ], meta)
  assert.equal(summary.gross, 1000, 'refunded ₹400 excluded from GMV')
  assert.equal(summary.commission, 10)
  assert.equal(summary.count, 1)
  assert.equal(summary.refundCount, 1)
  assert.equal(summary.refundAmount, 400)
  assert.equal(summary.takeRate, 0.01, 'take-rate = commission/GMV = 1%')
}

// ── Rollup: grouping, trend, per-tenant sparkline, comparison window ──
{
  const raws = [
    mk({ orderId: 'a', slug: 'cafe', gross: 1000, platformFeePaise: 1000, viaPlatformRoute: true, paidAt: Date.UTC(2026, 5, 10) }),
    mk({ orderId: 'b', slug: 'cafe', gross: 2000, platformFeePaise: 2000, viaPlatformRoute: true, paidAt: Date.UTC(2026, 6, 10) }),
    mk({ orderId: 'c', slug: 'salon', tenantName: 'Aura', gross: 500, method: 'cod', gateway: null, paidAt: Date.UTC(2026, 6, 12) }),
  ]
  const compare = [mk({ orderId: 'z', gross: 800, platformFeePaise: 800, viaPlatformRoute: true })]
  const roll = rollupRevenue(raws, meta, compare)
  assert.equal(roll.summary.gross, 3500)
  assert.equal(roll.summary.commission, 30, '₹10 + ₹20 (salon COD has no commission)')
  assert.equal(roll.compare?.gross, 800, 'comparison window totals surfaced')
  assert.equal(roll.byVertical.find(v => v.key === 'horeca')?.gross, 3000)
  assert.equal(roll.byVertical.find(v => v.key === 'salon')?.gross, 500)
  assert.equal(roll.byPlan.find(p => p.key === 'growth')?.count, 2)
  assert.equal(roll.trend.length, 2, 'two months (Jun, Jul)')
  const cafe = roll.byTenant.find(t => t.slug === 'cafe')!
  assert.equal(cafe.spark.length, roll.trend.length, 'sparkline aligned to trend months')
  assert.deepEqual(cafe.spark, [1000, 2000], 'monthly GMV series')
}

// ── Empty input is safe (no divide-by-zero) ──
{
  const roll = rollupRevenue([], meta)
  assert.equal(roll.summary.takeRate, 0)
  assert.equal(roll.byTenant.length, 0)
}

assert.equal(GATEWAY_FEE_EST_PCT, 0.02)
console.log('naruto-payments self-check: OK')
