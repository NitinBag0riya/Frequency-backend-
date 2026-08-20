// Selfcheck for aggregator → inventory pure helpers.
//   npx tsc ... && node aggregator-inventory.selfcheck.js
import assert from 'node:assert'
import { inventoryActionForStatus, externalOrderKey, extractOrderLines } from './aggregator-inventory.js'

// ── status → action (deplete on accept, reverse on cancel) ────────────────────
assert.equal(inventoryActionForStatus('new'), 'none', 'new → wait')
assert.equal(inventoryActionForStatus('preparing'), 'deplete', 'preparing → deplete')
assert.equal(inventoryActionForStatus('ready'), 'deplete', 'ready → deplete')
assert.equal(inventoryActionForStatus('picked_up'), 'deplete', 'picked_up → deplete')
assert.equal(inventoryActionForStatus('cancelled'), 'reverse', 'cancelled → reverse')
assert.equal(inventoryActionForStatus('rejected'), 'reverse', 'rejected → reverse')
assert.equal(inventoryActionForStatus(null), 'none', 'null → none')

// ── namespacing ───────────────────────────────────────────────────────────────
assert.equal(externalOrderKey('zomato', 'ORD9'), 'agg:zomato:ORD9', 'order key namespaced')

// ── line extraction across the real payload shapes ────────────────────────────
// Zomato: nested cartDetails.items.dishes with `quantity`
const zomato = { order: { id: 1, cartDetails: { items: { dishes: [
  { name: 'Paneer Tikka', quantity: 2, totalCost: 500 },
  { name: 'Naan', quantity: 3 },
] } } } }
assert.deepEqual(extractOrderLines(zomato), [{ name: 'Paneer Tikka', qty: 2 }, { name: 'Naan', qty: 3 }], 'zomato dishes')

// Swiggy-ish: flat line_items with `quantity` + alternate name spellings
const swiggy = { line_items: [
  { item_name: 'Veg Biryani', quantity: 1 },
  { name: 'Coke', qty: 2 },
] }
assert.deepEqual(extractOrderLines(swiggy), [{ name: 'Veg Biryani', qty: 1 }, { name: 'Coke', qty: 2 }], 'swiggy line_items')

// normalized raw.lines shape ({name, qty}) also works
assert.deepEqual(extractOrderLines({ lines: [{ name: 'Latte', qty: 1 }] }), [{ name: 'Latte', qty: 1 }], 'normalized lines')

// junk is dropped, not thrown
assert.deepEqual(extractOrderLines({ items: [{ name: '', quantity: 5 }, { name: 'X', quantity: 0 }, { quantity: 1 }] }), [], 'unnamed/zero-qty dropped')
assert.deepEqual(extractOrderLines(null), [], 'null payload → []')
assert.deepEqual(extractOrderLines({}), [], 'empty payload → []')

console.log('✓ aggregator-inventory selfcheck passed')
