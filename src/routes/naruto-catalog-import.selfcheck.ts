/**
 * Runnable self-check for the catalog-import PURE engine.
 * Run:  npx tsx src/routes/naruto-catalog-import.selfcheck.ts
 * No framework — plain asserts. Exits non-zero on failure.
 *
 * Proves the deterministic core an operator's import depends on:
 *   • CSV/XLSX parsing (headers + rows, blank-line skip) via SheetJS
 *   • header→role auto-mapping (synonyms + fuzzy contains)
 *   • option-group parsing (friendly grammar + JSON pass-through)
 *   • row normalisation + field validation
 *   • create/update/skip classification against an existing catalog
 *
 * What it does NOT prove (needs live Supabase + storefront-api): the commit
 * batch-write, pre-image capture, materialise, and 24h rollback — those are
 * exercised by the integration build.
 */
import assert from 'node:assert/strict'
import * as XLSX from 'xlsx'
import {
  parseSheet, suggestMapping, parseOptionGroups, normalizeRow, classify, vocabFor,
  type NormalizedDish, type ExistingItem,
} from './naruto-catalog-import'

// ── parseSheet: CSV round-trip, header order, blank-line skip ─────────────────
const csv = 'Name,Price,Category\nLatte,180,Coffee\n\nCroissant,120,Bakery\n'
const parsedCsv = parseSheet(Buffer.from(csv, 'utf8'), 'menu.csv')
assert.deepEqual(parsedCsv.headers, ['Name', 'Price', 'Category'])
assert.equal(parsedCsv.rows.length, 2, 'blank line skipped')
assert.equal(parsedCsv.rows[0].Name, 'Latte')
assert.equal(parsedCsv.rows[1].Price, '120')

// ── parseSheet: real XLSX buffer (same reader path) ──────────────────────────
const ws = XLSX.utils.aoa_to_sheet([['Name', 'Price'], ['Masala Dosa', '90']])
const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, 'S1')
const xlsxBuf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' })
const parsedXlsx = parseSheet(xlsxBuf, 'menu.xlsx')
assert.equal(parsedXlsx.rows[0].Name, 'Masala Dosa')

// ── suggestMapping: synonyms + fuzzy ─────────────────────────────────────────
const map = suggestMapping(['Item Name', 'MRP', 'Collection', 'Image URL'], 'd2c')
assert.equal(map.name, 'Item Name')      // "itemname" contains "name"
assert.equal(map.price, 'MRP')           // synonym
assert.equal(map.category, 'Collection') // synonym
assert.equal(map.image, 'Image URL')

// ── parseOptionGroups: friendly grammar ──────────────────────────────────────
const groups = parseOptionGroups('Size: Small=0, Large=40 | Milk: Oat=20, Soy=20', 'variants')
assert.equal(groups.length, 2)
assert.equal(groups[0].name, 'Size')
assert.equal(groups[0].type, 'single')
assert.equal(groups[0].required, true)
assert.deepEqual(groups[0].choices.map(c => [c.name, c.priceDelta]), [['Small', 0], ['Large', 40]])
// bare list → one group named for the kind
const addons = parseOptionGroups('Extra shot=40, Vanilla=20', 'addons')
assert.equal(addons.length, 1)
assert.equal(addons[0].name, 'Add-ons')
assert.equal(addons[0].type, 'multi')
assert.equal(addons[0].required, false)
// JSON pass-through
const json = parseOptionGroups('[{"id":"g1","name":"X","type":"single","choices":[{"id":"a","name":"A","priceDelta":5}]}]', 'addons')
assert.equal(json[0].name, 'X')
assert.equal(json[0].choices[0].priceDelta, 5)
assert.deepEqual(parseOptionGroups('', 'addons'), [])

// ── normalizeRow: mapping, validation, vertical fields ───────────────────────
const mapping = { name: 'Name', price: 'Price', category: 'Category', gst: 'GST', veg: 'Veg', addons: 'Add-ons' }
const ok = normalizeRow({ Name: 'Paneer Tikka', Price: '₹ 260', Category: 'Starters', GST: '5', Veg: 'yes', 'Add-ons': 'Cheese=30' }, mapping, 'horeca', 0)
assert.equal(ok.errors.length, 0)
assert.equal(ok.dish!.name, 'Paneer Tikka')
assert.equal(ok.dish!.priceInr, 260, 'strips ₹ and spaces')
assert.equal(ok.dish!.gstRate, 5)
assert.equal(ok.dish!.veg, true)
assert.equal(ok.dish!.options.length, 1)

// missing name → skipped with a field error
const noName = normalizeRow({ Name: '', Price: '10' }, mapping, 'horeca', 3)
assert.equal(noName.dish, null)
assert.equal(noName.errors[0].field, 'name')
assert.equal(noName.errors[0].row, 3)

// bad price → error, dish still returned (price defaults 0)
const badPrice = normalizeRow({ Name: 'X', Price: 'free' }, mapping, 'horeca', 5)
assert.ok(badPrice.errors.some(e => e.field === 'price'))
// GST over 100 → error
const badGst = normalizeRow({ Name: 'Y', Price: '10', GST: '250' }, mapping, 'horeca', 6)
assert.ok(badGst.errors.some(e => e.field === 'gst'))

// ── classify: create vs update vs skip vs in-file duplicate ──────────────────
const existing: ExistingItem[] = [{ id: 'row-latte', name: 'Latte', sku: null, categoryId: 'cat-coffee' }]
const catNameById = new Map([['cat-coffee', 'Coffee']])
const mk = (name: string, category: string): { dish: NormalizedDish | null; errors: [] } =>
  ({ dish: { name, category, description: '', priceInr: 100, imageUrl: '', options: [] }, errors: [] })
const parsed = [
  mk('Latte', 'Coffee'),     // matches existing → update
  mk('Mocha', 'Coffee'),     // new → create
  mk('Mocha', 'Coffee'),     // dup within file → skip
  { dish: null, errors: [{ row: 5, field: 'name', message: 'Name is required' }] as any }, // → skip
]
const r = classify(parsed as any, existing, catNameById, 'name')
assert.equal(r.summary.updated, 1)
assert.equal(r.summary.created, 1)
assert.equal(r.summary.skipped, 2)
assert.deepEqual(r.plan.map(p => p.action), ['update', 'create', 'skip', 'skip'])
assert.equal(r.plan[0].matchId, 'row-latte')
assert.deepEqual(r.categoriesToCreate, [], 'Coffee already exists')

// new category surfaces in categoriesToCreate
const r2 = classify([mk('Tea', 'Beverages') as any], existing, catNameById, 'name')
assert.deepEqual(r2.categoriesToCreate, ['Beverages'])

// ── vocab per vertical ───────────────────────────────────────────────────────
assert.equal(vocabFor('horeca').nounPlural, 'Menu items')
assert.equal(vocabFor('salon').noun, 'Service')
assert.equal(vocabFor('d2c').category, 'Collection')

console.log('naruto-catalog-import self-check: OK')
