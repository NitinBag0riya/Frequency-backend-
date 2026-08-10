/**
 * Runnable self-check for the menu-import per-channel model + Zomato price parse.
 * Assert-based, no framework:
 *
 *   npx tsx src/connectors/aggregator/menu-import.selfcheck.ts
 *
 * Exits non-zero on the first failed assertion so it can gate CI.
 */
import assert from 'node:assert/strict'
import {
  zomatoPrice, parseMenuSnapshot, normChannels, normChannelDetail,
  importMenuToStorefront, type ParsedEntity,
} from './menu-import'

let n = 0
const ok = (cond: boolean, msg: string) => { assert.ok(cond, msg); n++ }
const eq = (a: unknown, b: unknown, msg: string) => { assert.deepEqual(a, b, msg); n++ }

// ── zomatoPrice: prices live in a variant/price map, rarely a flat price ─────────
eq(zomatoPrice({ price: 249 }), 249, 'flat positive price')
eq(zomatoPrice({ price: 0 }), null, 'flat 0 → unresolved (needs-review)')
eq(zomatoPrice({ defaultVariantId: 'v2', variants: [{ id: 'v1', price: 199 }, { id: 'v2', price: 299 }] }), 299, 'default variant by id')
eq(zomatoPrice({ variants: [{ price: 199 }, { isDefault: true, price: 259 }] }), 259, 'default variant by flag')
eq(zomatoPrice({ variantGroups: [{ variants: [{ price: 350 }, { price: 180 }] }] }), 180, 'nested variantGroups → lowest when no default')
eq(zomatoPrice({ variantsV2: [{ price: 120 }] }), 120, 'variantsV2 key')
eq(zomatoPrice({ priceMap: { small: { price: 90 }, large: { price: 140 } } }), 90, 'priceMap of {price} objects')
eq(zomatoPrice({ prices: { a: 60, b: 45 } }), 45, 'prices map of scalars')
eq(zomatoPrice({ name: 'Water' }), null, 'no resolvable price → null, never a fake 0')

// ── parseMenuSnapshot: Zomato catalogueWrappers with variant-map prices ──────────
const zomatoSnap = {
  menuResponse: {
    categoryWrappers: [{ category: { categoryId: 10, name: 'Pizzas' } }],
    catalogueWrappers: [
      { catalogue: { catalogueId: 101, name: 'Margherita', inStock: true, category: { categoryId: 10 },
        defaultVariantId: 'r', variants: [{ id: 'r', price: 320 }, { id: 'l', price: 520 }] } },
      { catalogue: { catalogueId: 102, name: 'Mystery Special', inStock: false, category: { categoryId: 10 } } }, // no price
    ],
  },
}
const zRows = parseMenuSnapshot(zomatoSnap)
const marg = zRows.find(r => r.entity_id === '101')!
ok(!!marg, 'Zomato item parsed')
eq(marg.price, 320, 'Zomato item resolves default-variant ₹ (not 0)')
eq(marg.in_stock, true, 'Zomato item in_stock')
const mystery = zRows.find(r => r.entity_id === '102')!
eq(mystery.price, null, 'unresolvable Zomato price kept as null (import flags ₹0 needs-review, not dropped)')

// ── per-channel model round-trip (mirrors storefront-api cleanChannels) ──────────
eq(normChannelDetail(true), { available: true, price: null, inStock: null, srcId: null, outletRef: null }, 'bool true → available, no override (back-compat)')
eq(normChannelDetail(false).available, false, 'bool false → unavailable')
eq(normChannelDetail(undefined).available, true, 'missing → available (back-compat both-on)')
const rt = normChannelDetail({ available: true, price: 275, inStock: false, srcId: 'sw-9', outletRef: 'res-1' })
eq(rt, { available: true, price: 275, inStock: false, srcId: 'sw-9', outletRef: 'res-1' }, 'object detail round-trips')
eq(normChannelDetail({ price: 0 }).price, null, 'zero/blank override → base (null)')
const both = normChannels({ swiggy: true, zomato: { available: false, price: 199 } })
eq(both.swiggy.available, true, 'normChannels swiggy from bool')
eq(both.zomato.price, 199, 'normChannels zomato price override')

// ── import populates per-channel detail + preserves the other channel ────────────
async function importRoundTrip() {
  // Mock storefront-api client. First run: empty menu → CREATE captures channels.
  let createdBody: any = null
  const clientCreate = async (method: string, path: string, _slug: string, body?: any) => {
    if (method === 'GET' && path === '/admin/menu') return { categories: [{ id: 'c1', name: 'Pizzas' }], items: [] }
    if (method === 'POST' && path === '/admin/items') { createdBody = body; return { id: 'i1', ...body } }
    return { ok: true }
  }
  const entities: ParsedEntity[] = [
    { entity_type: 'category', entity_id: '10', name: 'Pizzas', in_stock: true, price: null, category_ref: null, raw: {} },
    { entity_type: 'item', entity_id: '101', name: 'Margherita', in_stock: true, price: 320, category_ref: '10', raw: { is_veg: 'VEG' } },
  ]
  const created = await importMenuToStorefront('t', entities, { channel: 'swiggy', aggregatorResId: 'res-1', client: clientCreate })
  ok(created.created === 1, 'one item created')
  ok(createdBody?.channels?.swiggy?.srcId === '101', 'create binds Swiggy srcId = aggregator entity id')
  ok(createdBody.channels.swiggy.outletRef === 'res-1', 'create binds Swiggy outletRef = aggregator res id')
  ok(createdBody.channels.swiggy.price === 320, 'create stores real Swiggy ₹')
  ok(createdBody.channels.swiggy.inStock === true, 'create stores Swiggy in-stock')

  // Second run: existing item already carries a Zomato detail; a Swiggy import must
  // MERGE (update swiggy) and PRESERVE zomato — never wipe the sibling channel.
  let patchBody: any = null
  const existing = {
    id: 'i1', name: 'Margherita', priceInr: 320, soldOut: false, availableOutlets: [],
    channels: { zomato: { available: true, price: 300, inStock: true, srcId: 'z-55', outletRef: 'res-1' },
                swiggy: { available: true, price: 320, inStock: true, srcId: '101', outletRef: 'res-1' } },
  }
  const clientUpdate = async (method: string, path: string, _slug: string, body?: any) => {
    if (method === 'GET' && path === '/admin/menu') return { categories: [{ id: 'c1', name: 'Pizzas' }], items: [existing] }
    if (method === 'PATCH' && path === '/admin/items/i1') { patchBody = body; return { ok: true } }
    return { ok: true }
  }
  // Same name, but Swiggy now out of stock at ₹340 → a real diff.
  const entities2: ParsedEntity[] = [
    { entity_type: 'item', entity_id: '101', name: 'Margherita', in_stock: false, price: 340, category_ref: '10', raw: {} },
  ]
  const updated = await importMenuToStorefront('t', entities2, { channel: 'swiggy', aggregatorResId: 'res-1', client: clientUpdate })
  ok(updated.updated === 1, 'existing item updated')
  ok(patchBody?.channels?.zomato?.srcId === 'z-55', 'update PRESERVES the Zomato channel binding')
  ok(patchBody.channels.swiggy.price === 340, 'update refreshes Swiggy ₹')
  ok(patchBody.channels.swiggy.inStock === false, 'update refreshes Swiggy stock')
  n += 8

  // Idempotency: re-import the SAME data → no channel churn (patch omits channels).
  existing.channels.swiggy = { available: true, price: 340, inStock: false, srcId: '101', outletRef: 'res-1' }
  existing.priceInr = 340; existing.soldOut = true
  let patch2: any = null
  const clientNoop = async (method: string, path: string, _slug: string, body?: any) => {
    if (method === 'GET' && path === '/admin/menu') return { categories: [{ id: 'c1', name: 'Pizzas' }], items: [existing] }
    if (method === 'PATCH') { patch2 = body; return { ok: true } }
    return { ok: true }
  }
  const again = await importMenuToStorefront('t', entities2, { channel: 'swiggy', aggregatorResId: 'res-1', client: clientNoop })
  ok(again.unchanged === 1, 'second identical import is a no-op (idempotent)')
  ok(patch2 === null, 'no PATCH sent when nothing changed')
  n += 2
}

importRoundTrip().then(() => {
  // eslint-disable-next-line no-console
  console.log(`✓ menu-import self-check passed (${n} assertions)`)
}).catch(e => { console.error(e); process.exit(1) })
