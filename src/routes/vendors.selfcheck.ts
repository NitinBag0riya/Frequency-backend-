/**
 * Runnable self-check for the vendors pure logic (phone, line clean, receive total).
 * No framework, no DB — just asserts. Run: `npx tsx src/routes/vendors.selfcheck.ts`
 */
import assert from 'node:assert/strict'
import { vendorPhone, cleanLines, receivedTotal } from './vendors'

// ── phone: last-10 digits ────────────────────────────────────────────────────
assert.equal(vendorPhone('+91 98765 43210'), '9876543210')
assert.equal(vendorPhone('098765-43210'), '9876543210')
assert.equal(vendorPhone(''), '')
assert.equal(vendorPhone(null), '')

// ── cleanLines: drops blanks, floors qty, defaults unit ──────────────────────
const draft = cleanLines([
  { name: ' Tomatoes ', qty: 5, unit: 'kg' },
  { name: '', qty: 9, unit: 'kg' },        // dropped (no name)
  { name: 'Milk', qty: 0, unit: '' },      // qty floored to 1, unit → pcs
])
assert.equal(draft.length, 2)
assert.deepEqual(draft[0], { name: 'Tomatoes', qty: 5, unit: 'kg' })
assert.deepEqual(draft[1], { name: 'Milk', qty: 1, unit: 'pcs' })
assert.equal(draft[0].qtyReceived, undefined, 'draft mode carries no receipt fields')

// ── cleanLines withReceipt: keeps qtyReceived + price, floors negatives ───────
const recv = cleanLines([
  { name: 'Tomatoes', qty: 5, unit: 'kg', qtyReceived: 4, price: 30 },
  { name: 'Milk', qty: 2, unit: 'ltr', qtyReceived: -1, price: -5 }, // floored to 0/0
], true)
assert.deepEqual(recv[0], { name: 'Tomatoes', qty: 5, unit: 'kg', qtyReceived: 4, price: 30 })
assert.equal(recv[1].qtyReceived, 0)
assert.equal(recv[1].price, 0)

// ── receivedTotal: Σ(qtyReceived × price), never negative ────────────────────
assert.equal(receivedTotal(recv), 120)                 // 4×30 + 0×0
assert.equal(receivedTotal([]), 0)
assert.equal(receivedTotal([{ name: 'x', qty: 1, unit: 'kg', qtyReceived: 2.5, price: 12.4 }]), 31)

console.log('vendors.selfcheck: OK')
