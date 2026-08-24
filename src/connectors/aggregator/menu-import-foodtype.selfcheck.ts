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
import { foodTypeOf, vegOf, parseMenuSnapshot, zomatoOptionGroups } from './menu-import.js'

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

// ── add-ons must not import as dishes ────────────────────────────────────────
// Zomato puts dishes and add-ons in ONE array, split by `isRootCatalogue`. The old
// catalogueId!=null guard passed add-ons through on listings that give them real ids.
{
  const snap = { menuResponse: { resId: '1', catalogueWrappers: [
    { catalogue: { catalogueId: '1', name: 'Masala Dosai', isRootCatalogue: true, inStock: true } },
    { catalogue: { catalogueId: '2', name: 'Extra Sambhar', inStock: true } },      // add-on WITH an id
    { catalogue: { catalogueId: null, name: 'Candles', inStock: true } },           // add-on without one
  ] } }
  const names = parseMenuSnapshot(snap).filter((r) => r.entity_type === 'item').map((r) => r.name)
  assert.deepStrictEqual(names, ['Masala Dosai'], 'only root catalogues are dishes')
  ok('Zomato add-ons stay out of the dish list even when they carry catalogueIds')
}


// ── Zomato modifier groups → our OptionGroups (REAL captured payload) ────────
{
  const body = JSON.parse(readFileSync(join(__dirname, '__fixtures__/zomato-menu-modifiers.json'), 'utf8'))
  const mr = body.data.menuResponse
  const map = zomatoOptionGroups(mr)
  assert.ok(map.size > 0, 'dishes must resolve modifier groups')

  const all = [...map.values()].flat()
  assert.ok(all.every(g => g.name && g.choices.length), 'every group is named and non-empty')
  assert.ok(all.every(g => g.type === 'single' || g.type === 'multi'), 'valid group types')

  // the binding verified by hand against the live payload
  const idli = mr.catalogueWrappers.find((w: any) => w?.catalogue?.name === 'Butter Fried Idli')
  const gs = map.get(String(idli.catalogue.catalogueId)) ?? []
  assert.deepStrictEqual(gs.map(g => g.name).sort(), ['Beverages', 'Chutney'],
    'Butter Fried Idli offers exactly Beverages + Chutney')
  const bev = gs.find(g => g.name === 'Beverages')!
  assert.ok(bev.choices.some(c => /Plain Chai/i.test(c.name)), 'Beverages holds the chai add-ons')
  assert.equal(bev.type, 'multi', 'max 6 → multi-select')

  // modifiers must NOT also appear as dishes
  const dishes = parseMenuSnapshot(body).filter(r => r.entity_type === 'item').map(r => r.name)
  assert.ok(!dishes.includes('Set Of 2 Plain Chai'), 'an add-on never imports as a dish')
  ok(`${map.size} dishes carry real Zomato add-on groups; modifiers stay out of the dish list`)
}

console.log(`\n  ${n} groups passed`)
