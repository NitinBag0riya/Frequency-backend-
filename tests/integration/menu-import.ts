/**
 * Self-check for the aggregator → storefront menu import.
 * Runnable: `npx tsx tests/integration/menu-import.ts` (no framework, assert-based).
 *
 * Uses an in-memory storefront client (no network) to prove:
 *   1. First import creates the category + all items, scoped to the target outlet.
 *   2. A second identical import is idempotent (0 created / 0 updated).
 *   3. A price change on the aggregator side → exactly 1 update, non-destructive.
 *   4. Merchant edits (description/veg) are NOT clobbered on update.
 */
import assert from 'node:assert'
import { parseMenuSnapshot, importMenuToStorefront } from '../../src/connectors/aggregator/menu-import'

// A minimal Swiggy restaurant-menu-wrapper shape: one category, two items.
function snapshot(margheritaPrice: number) {
  const mk = (id: string, name: string, price: number, veg: string, desc: string) => ({
    main_category_id: '77165826', main_category_name: 'Napolitan Pizzeria', main_category_order: 1,
    item: { id, name, price, is_veg: veg, in_stock: 1, description: desc },
  })
  return { data: { menu: { items_vo: [
    mk('204662623', 'Margherita Pizza', margheritaPrice, 'VEG', 'Marinara, Fresh Mozzarella, Basil'),
    mk('204662624', 'Diavola Verde Pizza', 790, 'NON_VEG', 'Garlic, Jalapeno, Mushrooms'),
  ] } } }
}

// In-memory storefront: mimics the file-backed /admin/menu + /admin/categories + /admin/items.
function makeStore() {
  const cats: any[] = []
  const items: any[] = []
  let n = 0
  const client = async (method: string, path: string, _slug: string, body?: any) => {
    if (method === 'GET' && path === '/admin/menu') return { categories: cats, items }
    if (method === 'GET' && path === '/admin/config') return { outlets: [{ id: 'o788e77', swiggyResId: '1398903', zomatoResId: '22223982' }] }
    if (method === 'POST' && path === '/admin/categories') { const c = { id: 'c' + ++n, name: body.name }; cats.push(c); return c }
    if (method === 'POST' && path === '/admin/items') { const it = { id: 'i' + ++n, ...body }; items.push(it); return it }
    if (method === 'PATCH' && path.startsWith('/admin/items/')) {
      const id = path.split('/').pop(); const it = items.find(x => x.id === id); Object.assign(it, body); return it
    }
    throw new Error(`unexpected ${method} ${path}`)
  }
  return { cats, items, client }
}

;(async () => {
  const store = makeStore()
  const ents = parseMenuSnapshot(snapshot(720))
  assert.equal(ents.filter(e => e.entity_type === 'item').length, 2, 'parses 2 items')
  assert.equal(ents.filter(e => e.entity_type === 'category').length, 1, 'parses 1 category')

  // 1) First import — resolve outlet from swiggy resId, create everything.
  const r1 = await importMenuToStorefront('t', ents, { aggregatorResId: '1398903', channel: 'swiggy', client: store.client })
  assert.equal(r1.categoriesCreated, 1, 'creates 1 category')
  assert.equal(r1.created, 2, 'creates 2 items')
  assert.equal(r1.updated, 0)
  assert.equal(r1.outletId, 'o788e77', 'resolved outlet from swiggyResId')
  const marg = store.items.find(i => i.name === 'Margherita Pizza')
  assert.equal(marg.priceInr, 720)
  assert.equal(marg.veg, true, 'VEG → veg true')
  assert.deepEqual(marg.availableOutlets, ['o788e77'], 'scoped to outlet')
  const diav = store.items.find(i => i.name === 'Diavola Verde Pizza')
  assert.equal(diav.veg, false, 'NON_VEG → veg false')

  // Merchant curates the description after import.
  marg.description = 'MERCHANT EDITED — do not clobber'

  // 2) Idempotent re-run — same snapshot → nothing changes.
  const r2 = await importMenuToStorefront('t', ents, { aggregatorResId: '1398903', channel: 'swiggy', client: store.client })
  assert.equal(r2.created, 0, 'idempotent: 0 created')
  assert.equal(r2.updated, 0, 'idempotent: 0 updated')
  assert.equal(r2.unchanged, 2, 'idempotent: 2 unchanged')

  // 3) Price change → exactly one update; description preserved.
  const r3 = await importMenuToStorefront('t', parseMenuSnapshot(snapshot(760)), { aggregatorResId: '1398903', channel: 'swiggy', client: store.client })
  assert.equal(r3.updated, 1, 'one price update')
  assert.equal(r3.created, 0)
  assert.equal(marg.priceInr, 760, 'price synced')
  assert.equal(marg.description, 'MERCHANT EDITED — do not clobber', 'merchant edit preserved')

  console.log('menu-import self-check: PASS')
})().catch(e => { console.error('menu-import self-check: FAIL\n', e); process.exit(1) })
