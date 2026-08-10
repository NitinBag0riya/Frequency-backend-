/**
 * Runnable self-check for the complaints pure logic (normaliser + severity).
 * No framework, no DB — just asserts. Run: `npx tsx src/routes/complaints.selfcheck.ts`
 */
import assert from 'node:assert'
import { categoryFromSwiggy, deriveSeverity, normaliseStorefrontComplaint } from './complaints'

// ── Swiggy category mapping (spec §1a) ──────────────────────────────────────
assert.equal(categoryFromSwiggy('MISSING_ITEMS'), 'missing_items')
assert.equal(categoryFromSwiggy('PACKAGING_AND_SPILLAGE_ISSUES'), 'spillage')
assert.equal(categoryFromSwiggy('SPILLAGE_ISSUES'), 'spillage')
assert.equal(categoryFromSwiggy('PACKAGING_ISSUES'), 'packaging')
assert.equal(categoryFromSwiggy('SOMETHING_NEW'), 'unknown')
assert.equal(categoryFromSwiggy(null), 'unknown')

// ── Severity derivation (spec §1b) ──────────────────────────────────────────
// resolved/closed → low
assert.equal(deriveSeverity({ status: 'resolved', category: 'quality' }), 'low')
// rating >= 4 → low
assert.equal(deriveSeverity({ rating: 5 }), 'low')
// hot category → high
assert.equal(deriveSeverity({ category: 'missing_items' }), 'high')
// rating <= 2 → high
assert.equal(deriveSeverity({ rating: 1, category: 'other' }), 'high')
// due within 12h → high
assert.equal(deriveSeverity({ dueAt: new Date(Date.now() + 3600_000).toISOString(), category: 'other' }), 'high')
// otherwise → normal
assert.equal(deriveSeverity({ category: 'billing' }), 'normal')

// ── Storefront normaliser ───────────────────────────────────────────────────
const row = normaliseStorefrontComplaint({
  tenantId: 't1',
  order: { id: 'ord_9', guestName: 'Asha', table: 4, outletId: 'o1', rating: 2 },
  index: 0,
  text: 'Coffee was cold',
  at: Date.now(),
})
assert.equal(row.source, 'storefront')
assert.equal(row.external_id, 'ord_9:complaint:0')
assert.equal(row.order_ref, 'ord_9')
assert.equal(row.category, 'other')
assert.equal(row.customer_name, 'Asha')
assert.equal(row.customer_context, 'Table 4')
assert.equal(row.rating, 2)
assert.equal(row.severity, 'high') // rating 2
assert.ok(row.due_at, 'storefront rows get an internal SLA deadline')
assert.ok(Array.isArray(row.raw.notes))

// pickup (no table) context
const pickup = normaliseStorefrontComplaint({ tenantId: 't1', order: { id: 'o2' }, index: 1, text: 'x', at: null })
assert.equal(pickup.customer_context, 'Pickup')
assert.equal(pickup.external_id, 'o2:complaint:1')

console.log('complaints.selfcheck: OK')
