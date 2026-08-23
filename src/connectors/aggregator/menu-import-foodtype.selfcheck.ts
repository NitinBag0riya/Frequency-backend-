/**
 * Self-check: the dietary-mark mapping at the aggregator boundary.
 *   Zomato:  veg 1 = veg, 2 = non-veg, 3 = egg
 *   Swiggy:  is_veg "VEG" | "NON_VEG"  (no eggetarian on their side)
 *   Absent:  'unset' — we must NOT default. The previous boolean version fell back
 *            to non-veg, so every unclassified import silently mislabelled a dish.
 *   Run:  npx tsx src/connectors/aggregator/menu-import-foodtype.selfcheck.ts
 */
import assert from 'node:assert'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { foodTypeOf, vegOf, parseMenuSnapshot } from './menu-import.js'

let n = 0
const ok = (m: string) => { n++; console.log('  ✓', m) }

assert.strictEqual(foodTypeOf({ veg: 1 }), 'veg')
assert.strictEqual(foodTypeOf({ veg: 2 }), 'nonveg')
assert.strictEqual(foodTypeOf({ veg: 3 }), 'egg')
ok('Zomato 1/2/3 → veg / non-veg / egg')

assert.strictEqual(foodTypeOf({ is_veg: 'VEG' }), 'veg')
assert.strictEqual(foodTypeOf({ is_veg: 'NON_VEG' }), 'nonveg', '"NON_VEG" contains "VEG" — NON must be tested first')
assert.strictEqual(foodTypeOf({ is_veg: 'non_veg' }), 'nonveg', 'case-insensitive')
ok('Swiggy VEG / NON_VEG map correctly (NON tested before VEG)')

assert.strictEqual(foodTypeOf({}), 'unset', 'no classifier → unset, never non-veg')
assert.strictEqual(foodTypeOf(null), 'unset')
assert.strictEqual(foodTypeOf({ is_veg: 'MAYBE' }), 'unset', 'unrecognised string → unset, not a guess')
assert.strictEqual(foodTypeOf({ veg: 9 }), 'unset')
ok('an unclassified aggregator item imports as unset — no silent non-veg label')

assert.strictEqual(foodTypeOf({ item_attribute: 'EGG' }), 'egg')
assert.strictEqual(foodTypeOf({ classifier: 'contains egg' }), 'egg')
ok('egg detected from string classifiers too')

assert.strictEqual(vegOf({ veg: 1 }), true)
for (const raw of [{ veg: 2 }, { veg: 3 }, {}, { is_veg: 'NON_VEG' }]) {
  assert.strictEqual(vegOf(raw), false, `${JSON.stringify(raw)} must not read as veg`)
}
ok('vegOf stays true only for veg — egg and unset are never green')

// ── AGAINST THE REAL CAPTURED ZOMATO SNAPSHOT ────────────────────────────────
// Synthetic shapes alone were not enough: the live payload states the mark via
// dishAttributes/primary_dietary_tags + wrapper catalogueTags, and an earlier
// version of foodTypeOf read neither — so every real dish silently imported as
// 'unset'. This check is the one that would have caught it.
{
  const body = JSON.parse(readFileSync(join(__dirname, '__fixtures__/zomato-menu.json'), 'utf8'))
  const items = parseMenuSnapshot(body).filter((r) => r.entity_type === 'item')
  const marks = items.map((r) => foodTypeOf(r.raw))
  const unset = marks.filter((m) => m === 'unset').length

  assert.ok(items.length > 0, 'fixture must parse items')
  assert.ok(unset < items.length, `every real dish resolved to 'unset' — the live payload shape is not being read`)
  assert.ok(marks.every((m) => ['veg', 'nonveg', 'egg', 'unset'].includes(m)), 'only valid marks')

  const counts = marks.reduce<Record<string, number>>((a, m) => ({ ...a, [m]: (a[m] ?? 0) + 1 }), {})
  console.log('  real La Fiamma snapshot →', JSON.stringify(counts))
  for (const r of items.slice(0, 6)) console.log(`    ${r.name} → ${foodTypeOf(r.raw)}`)
  ok(`${items.length - unset}/${items.length} real Zomato dishes resolve a dietary mark`)
}

console.log(`\n  ${n} groups passed`)
