/**
 * Self-check: Zomato menu price resolution against a REAL captured La Fiamma
 * get_content_menu snapshot. Proves the #2 fix — items resolve real ₹ instead
 * of null (which rendered blank on the storefront).
 *   Run:  npx tsx src/connectors/aggregator/menu-import.selfcheck.ts
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseMenuSnapshot, zomatoWrapperPrice, higherBase } from './menu-import.js'

const body = JSON.parse(readFileSync(join(__dirname, '__fixtures__/zomato-menu.json'), 'utf8'))
const rows = parseMenuSnapshot(body)
const items = rows.filter((r) => r.entity_type === 'item')
const priced = items.filter((r) => typeof r.price === 'number' && (r.price as number) > 0)

let pass = 0
const fail: string[] = []
const ok = (c: boolean, m: string) => (c ? pass++ : fail.push(m))

ok(items.length > 0, `expected items parsed, got ${items.length}`)
ok(priced.length === items.length, `every item must resolve a positive price — ${priced.length}/${items.length} did (was 0 before the fix)`)
ok(items.every((r) => r.name), 'every item has a name')

// direct resolver sanity: at least every real item wrapper prices (the other
// wrappers are modifiers/add-ons with no delivery variantPrice — correctly null).
const wrappers = body.data.menuResponse.catalogueWrappers
const resolved = wrappers.map((w: any) => zomatoWrapperPrice(w)).filter((p: number | null) => p && p > 0)
ok(resolved.length >= items.length, `resolver priced ${resolved.length} wrappers (>= ${items.length} items) of ${wrappers.length} total`)

// storefront base = higher of the two channels
ok(higherBase(720, 850) === 850 && higherBase(890, null) === 890 && higherBase(null, 640) === 640 && higherBase(null, null) === 0, 'higherBase picks the max channel price (never lowers)')

console.log(`\n  parsed ${items.length} items, ${priced.length} priced:`)
for (const r of items.slice(0, 6)) console.log(`    ${r.name} → ₹${r.price}`)
console.log(`\n  ${pass} checks passed, ${fail.length} failed`)
if (fail.length) { for (const f of fail) console.error('  ✗ ' + f); process.exit(1) }
console.log('  ✓ Zomato menu price resolution OK')
