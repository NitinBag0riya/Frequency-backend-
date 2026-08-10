/**
 * Self-check: backend order-history parsing against a REAL captured Zomato
 * get-all-v2 snapshot + a synthetic Swiggy history group. Proves P0-4's server leg.
 *   Run:  npx tsx src/routes/connectors/aggregator-history.selfcheck.ts
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseOrderHistory, parseZomatoSnippets, parseSwiggyHistoryGroups, stripZomatoMarkup } from './aggregator.js'

let pass = 0
const fail: string[] = []
const ok = (c: boolean, m: string) => (c ? pass++ : fail.push(m))

// ---- markup strip ----
ok(stripZomatoMarkup('<semibold-200|{white-500|DELIVERED}>') === 'DELIVERED', 'strips Zomato markup')

// ---- Zomato snippets (real capture) ----
const zBody = JSON.parse(readFileSync(join(__dirname, '__fixtures__/zomato-history.json'), 'utf8'))
const z = parseOrderHistory(zBody)
ok(z.length === zBody.snippets.length, `every Zomato snippet → a row (${z.length}/${zBody.snippets.length})`)
ok(z.every((o) => o.external_order_id && /^\d+$/.test(o.external_order_id)), 'each row has a numeric external_order_id')
ok(z.some((o) => o.status === 'DELIVERED'), 'at least one DELIVERED status parsed')
ok(z.some((o) => (o.gross_amount ?? 0) > 0), 'at least one row has a positive gross_amount')
ok(z.some((o) => o.customer_name), 'at least one row has a customer_name')
ok(z.every((o) => o.item_count >= 1), 'every row has item_count >= 1')
ok(parseZomatoSnippets(zBody.snippets).length === z.length, 'parseOrderHistory dispatches to the snippet branch')

// ---- Swiggy history groups (synthetic — real capture was empty) ----
const sGroups = [{ restId: '1224043', data: { objects: [
  { order_id: '77', order_status: 'delivered', order_total: 720, customer_name: 'A', order_items: [{ name: 'Margherita', quantity: 1 }] },
] } }]
const s = parseOrderHistory({ data: sGroups })
ok(s.length === 1 && s[0].external_order_id === '77' && s[0].gross_amount === 720 && s[0].item_count === 1, 'Swiggy history group parses id/gross/items')
ok(parseSwiggyHistoryGroups(sGroups).length === 1, 'parseOrderHistory dispatches to the Swiggy branch')

// ---- generic fallback still works ----
ok(parseOrderHistory({ orders: [{ order_id: '5', status: 'x' }] }).length === 1, 'generic orders[] fallback intact')

console.log(`\n  Zomato snapshot → ${z.length} past orders:`)
for (const o of z.slice(0, 5)) console.log(`    #${o.external_order_id} [${o.status}] ${o.customer_name ?? '?'} ×${o.item_count} ₹${o.gross_amount ?? '-'}`)
console.log(`\n  ${pass} checks passed, ${fail.length} failed`)
if (fail.length) { for (const f of fail) console.error('  ✗ ' + f); process.exit(1) }
console.log('  ✓ backend order-history parsing OK')
