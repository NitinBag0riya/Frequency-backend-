/**
 * menu-import — turn a captured aggregator (Swiggy/Zomato) menu into the tenant's
 * REAL storefront/POS menu (the one the mini-app + POS render and sell from).
 *
 * The aggregator bridge already READS a captured menu into `aggregator_menu`
 * (connector bookkeeping). That is NOT the sellable menu. This module maps those
 * normalised entities into the storefront-api catalog (categories + items scoped
 * to an outlet) via the existing X-Admin-Secret admin CRUD, idempotently:
 *
 *   - categories merged by normalised name (created once, reused after)
 *   - items matched by normalised name within the tenant; new → POST, existing →
 *     PATCH only the fields we own (price + availability), never clobbering merchant
 *     edits (coins, options, image, description are set on CREATE and left alone on
 *     update). availableOutlets is UNIONed with the target outlet, never narrowed.
 *   - nothing is ever deleted — the merchant's existing menu is preserved.
 *
 * Platform-agnostic: it consumes the normalised ParsedEntity[] that parseMenuSnapshot
 * produces for BOTH Swiggy and Zomato, so a captured Zomato menu imports the same way
 * once its full item list is present in the snapshot.
 *
 * ponytail: idempotency key is the normalised item NAME (no schema change on the
 * file-backed storefront). Ceiling: if a merchant renames an imported item on the
 * aggregator, the next import re-creates it instead of updating. Upgrade path: persist
 * the aggregator source id on the storefront item (needs a storefront-api item field)
 * and match on that first, name second.
 */

// ── normalised entity (also the shape aggregator_menu rows carry) ───────────────
export interface ParsedEntity {
  entity_type: 'item' | 'category'
  entity_id: string
  name: string | null
  in_stock: boolean
  price: number | null
  category_ref: string | null
  raw: any
}

/**
 * Parse a Frequency Desktop menu snapshot into normalised item/category rows.
 * The aggregators' menu JSON is undocumented + varies, so this is best-effort
 * across common shapes and ALWAYS keeps the raw entity in `raw`.
 */
export function parseMenuSnapshot(body: any): ParsedEntity[] {
  // Swiggy Frequency-Desktop snapshot (real shape, mapped live 2026-07-25):
  // restaurant-menu-wrapper → data.menu.items_vo[], each row flattening a
  // category + one item. Handle it explicitly; fall through to the generic
  // best-effort parser for other/unknown shapes.
  const itemsVo = body?.data?.menu?.items_vo ?? body?.menu?.items_vo
  if (Array.isArray(itemsVo) && itemsVo.length) {
    const rows: ParsedEntity[] = []
    const seenCat = new Set<string>()
    for (const row of itemsVo) {
      const catId = row?.main_category_id != null ? String(row.main_category_id) : null
      if (catId && !seenCat.has(catId)) {
        seenCat.add(catId)
        rows.push({
          entity_type: 'category', entity_id: catId, name: row.main_category_name ?? null,
          in_stock: true, price: null, category_ref: null,
          raw: { main_category_id: catId, main_category_name: row.main_category_name, main_category_order: row.main_category_order },
        })
      }
      const it = row?.item
      if (it && it.id != null) {
        rows.push({
          entity_type: 'item', entity_id: String(it.id), name: it.name ?? null,
          in_stock: it.in_stock === 1 || it.in_stock === true,
          price: typeof it.price === 'number' ? it.price : (it.price != null ? Number(it.price) : null),
          category_ref: catId, raw: it,
        })
      }
    }
    if (rows.length) return rows
  }

  // Zomato Frequency-Desktop snapshot (get_content_menu, mapped live 2026-07-30):
  // menuResponse.categoryWrappers[].category + catalogueWrappers[].catalogue
  // (name, inStock, nested category ref). Price lives in a variant map — kept in
  // raw; in_stock is what stock-toggle needs.
  const mr = body?.menuResponse ?? body?.response?.menuResponse ?? body?.data?.menuResponse
  if (mr && Array.isArray(mr.catalogueWrappers)) {
    const rows: ParsedEntity[] = []
    for (const cw of mr.categoryWrappers ?? []) {
      const c = cw?.category
      if (c?.categoryId != null) rows.push({
        entity_type: 'category', entity_id: String(c.categoryId), name: c.name ?? null,
        in_stock: true, price: null, category_ref: null, raw: c,
      })
    }
    for (const w of mr.catalogueWrappers) {
      const cat = w?.catalogue
      if (cat?.catalogueId == null) continue
      rows.push({
        entity_type: 'item', entity_id: String(cat.catalogueId), name: cat.name ?? null,
        in_stock: cat.inStock !== false,
        price: typeof cat.price === 'number' ? cat.price : (cat.price != null ? Number(cat.price) : null),
        category_ref: cat.category?.categoryId != null ? String(cat.category.categoryId) : null,
        raw: cat,
      })
    }
    if (rows.length) return rows
  }

  const sr = body?.statusResponse ?? body?.data ?? body ?? {}
  const itemArr: any[] = Array.isArray(sr) ? sr : (sr.items ?? sr.data?.items ?? sr.menu?.items ?? [])
  const catArr: any[] = sr.categories ?? sr.data?.categories ?? sr.menu?.categories ?? []
  const bool = (v: any, dflt = true) => (v === undefined || v === null ? dflt : !(v === false || v === 0 || v === 'out_of_stock' || v === 'OUT_OF_STOCK'))
  const out: ParsedEntity[] = []
  for (const x of Array.isArray(itemArr) ? itemArr : []) {
    const id = x?.id ?? x?.item_id ?? x?.itemId ?? x?.entity_id
    if (id == null) continue
    out.push({
      entity_type: 'item', entity_id: String(id),
      name: x.name ?? x.title ?? x.item_name ?? null,
      in_stock: bool(x.inStock ?? x.in_stock ?? x.stockStatus ?? x.in_stock_status),
      price: x.price ?? x.cost ?? x.item_price ?? null,
      category_ref: x.category_id != null ? String(x.category_id) : (x.categoryId != null ? String(x.categoryId) : null),
      raw: x,
    })
  }
  for (const x of Array.isArray(catArr) ? catArr : []) {
    const id = x?.id ?? x?.category_id ?? x?.categoryId ?? x?.entity_id
    if (id == null) continue
    out.push({
      entity_type: 'category', entity_id: String(id),
      name: x.name ?? x.title ?? x.category_name ?? null,
      in_stock: bool(x.inStock ?? x.in_stock ?? x.stockStatus), price: null, category_ref: null, raw: x,
    })
  }
  return out
}

// ── normalisation helpers ───────────────────────────────────────────────────────
/** Stable match key: lowercase, strip punctuation/diacritics, collapse whitespace. */
export const normKey = (s: unknown): string => String(s ?? '').toLowerCase().normalize('NFKD')
  .replace(/[^a-z0-9]+/g, ' ').trim().replace(/\s+/g, ' ')

/** Best-effort veg flag across Swiggy (is_veg:"VEG"|"NON_VEG") + Zomato (veg/1|2). */
export function vegOf(raw: any): boolean {
  const v = raw?.is_veg ?? raw?.veg ?? raw?.isVeg ?? raw?.classifier ?? raw?.item_attribute
  if (typeof v === 'boolean') return v
  if (typeof v === 'string') {
    const s = v.toUpperCase()
    if (s.includes('NON')) return false
    if (s === 'VEG' || s === '1' || s === 'TRUE' || s === 'YES') return true
    return false
  }
  if (v === 1) return true   // Zomato: 1 = veg
  if (v === 2) return false  // Zomato: 2 = non-veg
  return false
}

// ── mapped storefront shapes ────────────────────────────────────────────────────
export interface MappedCategory { sourceId: string; name: string }
export interface MappedItem {
  sourceId: string
  name: string
  priceInr: number
  veg: boolean
  soldOut: boolean
  description: string
  imageUrl: string | null
  catSourceId: string | null
}

/** Map normalised aggregator entities → storefront categories + items. */
export function mapEntities(entities: ParsedEntity[]): { categories: MappedCategory[]; items: MappedItem[] } {
  const categories: MappedCategory[] = []
  const items: MappedItem[] = []
  for (const e of entities) {
    if (e.entity_type === 'category') {
      const name = String(e.name ?? '').trim()
      if (name) categories.push({ sourceId: e.entity_id, name })
    } else {
      const name = String(e.name ?? '').trim()
      if (!name) continue
      items.push({
        sourceId: e.entity_id,
        name,
        priceInr: Math.max(0, Math.round(Number(e.price) || 0)),
        veg: vegOf(e.raw),
        soldOut: !e.in_stock,
        description: String(e.raw?.description ?? e.raw?.desc ?? '').slice(0, 160),
        imageUrl: e.raw?.image_url ?? e.raw?.s3_image_url ?? e.raw?.imageUrl ?? e.raw?.image ?? null,
        catSourceId: e.category_ref,
      })
    }
  }
  return { categories, items }
}

// ── storefront-api admin client (server-to-server, shared secret) ───────────────
// Read env INSIDE the call so a caller (e.g. the live-run script) can point these at
// a specific environment before invoking, without import-time capture.
async function sf(method: string, path: string, slug: string, body?: unknown): Promise<any> {
  const base = process.env.STOREFRONT_API_URL || 'http://localhost:5181'
  const secret = process.env.STOREFRONT_ADMIN_SECRET || 'dev-admin'
  const r = await fetch(`${base}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Tenant': slug, 'X-Admin-Secret': secret },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  const text = await r.text()
  let json: any
  try { json = JSON.parse(text) } catch { json = text }
  if (!r.ok) throw new Error(`storefront-api ${method} ${path} → ${r.status}: ${typeof json === 'string' ? json : json?.error || ''}`)
  return json
}

export interface ImportChange {
  action: 'category_created' | 'created' | 'updated' | 'unchanged'
  name: string
  id?: string
  changes?: Record<string, { from: any; to: any }>
}
export interface ImportResult {
  ok: boolean
  slug: string
  outletId: string | null
  categoriesCreated: number
  created: number
  updated: number
  unchanged: number
  changelog: ImportChange[]
}

export interface ImportOpts {
  /** Storefront outlet id the imported items are scoped to (empty list = all outlets). */
  targetOutletId?: string | null
  /** If targetOutletId is absent, resolve it from the storefront outlet whose
   *  swiggyResId/zomatoResId matches this aggregator restaurant id. */
  aggregatorResId?: string | null
  /** 'swiggy' | 'zomato' — which resId field to match when resolving by aggregatorResId. */
  channel?: string | null
  /** Don't write — just compute what WOULD change (used by the self-check). */
  dryRun?: boolean
  /** Injected storefront client (tests). Defaults to the real X-Admin-Secret sf(). */
  client?: (method: string, path: string, slug: string, body?: unknown) => Promise<any>
}

/** Resolve a storefront outlet id from an aggregator restaurant id, via the tenant's
 *  outlet records (each carries swiggyResId/zomatoResId). Returns null if no match. */
export async function resolveOutletId(
  slug: string,
  aggregatorResId: string,
  channel: string | null | undefined,
  call: (method: string, path: string, slug: string, body?: unknown) => Promise<any> = sf,
): Promise<string | null> {
  const cfg = await call('GET', '/admin/config', slug)
  const outlets: any[] = Array.isArray(cfg?.outlets) ? cfg.outlets : []
  const want = String(aggregatorResId)
  const ch = String(channel ?? '').toLowerCase()
  const match = outlets.find(o =>
    (ch !== 'zomato' && String(o.swiggyResId ?? '') === want) ||
    (ch !== 'swiggy' && String(o.zomatoResId ?? '') === want))
  return match?.id ?? null
}

/**
 * Import mapped aggregator entities into a tenant's storefront/POS menu. Idempotent,
 * non-destructive, per-outlet. Returns a per-item changelog.
 */
export async function importMenuToStorefront(
  slug: string,
  entities: ParsedEntity[],
  opts: ImportOpts = {},
): Promise<ImportResult> {
  const call = opts.client || sf
  let outletId = opts.targetOutletId || null
  if (!outletId && opts.aggregatorResId) {
    outletId = await resolveOutletId(slug, opts.aggregatorResId, opts.channel, call)
  }
  const { categories: aggCats, items: aggItems } = mapEntities(entities)

  const menu = await call('GET', '/admin/menu', slug) as { categories: any[]; items: any[] }
  const existingCats: any[] = Array.isArray(menu?.categories) ? menu.categories : []
  const existingItems: any[] = Array.isArray(menu?.items) ? menu.items : []

  const catIdByNorm = new Map<string, string>(existingCats.map(c => [normKey(c.name), c.id]))
  const itemByNorm = new Map<string, any>(existingItems.map(i => [normKey(i.name), i]))
  // aggregator category sourceId → normalised name, so items resolve their category.
  const aggCatNameById = new Map<string, string>(aggCats.map(c => [c.sourceId, c.name]))

  const changelog: ImportChange[] = []
  let categoriesCreated = 0, created = 0, updated = 0, unchanged = 0

  // 1) Categories — create any the tenant doesn't already have (by name).
  for (const c of aggCats) {
    const key = normKey(c.name)
    if (catIdByNorm.has(key)) continue
    if (opts.dryRun) {
      catIdByNorm.set(key, `dry_${key}`)
    } else {
      const res = await call('POST', '/admin/categories', slug, { name: c.name })
      catIdByNorm.set(key, res.id)
    }
    categoriesCreated++
    changelog.push({ action: 'category_created', name: c.name, id: catIdByNorm.get(key) })
  }

  const fallbackCatId = () => existingCats[0]?.id || [...catIdByNorm.values()][0] || null

  // 2) Items — POST new, PATCH changed, leave the rest.
  for (const it of aggItems) {
    const catName = it.catSourceId != null ? aggCatNameById.get(it.catSourceId) : null
    const categoryId = (catName && catIdByNorm.get(normKey(catName))) || fallbackCatId()
    if (!categoryId) continue // no category to hang it on — skip rather than orphan
    const key = normKey(it.name)
    const existing = itemByNorm.get(key)

    if (!existing) {
      // CREATE — set the full descriptive record once; scope to the outlet.
      const body: any = {
        name: it.name,
        priceInr: it.priceInr,
        veg: it.veg,
        soldOut: it.soldOut,
        description: it.description,
        categoryId,
        availableOutlets: outletId ? [outletId] : [],
      }
      if (it.imageUrl) body.imageUrl = it.imageUrl
      if (!opts.dryRun) {
        const res = await call('POST', '/admin/items', slug, body)
        itemByNorm.set(key, res)
        changelog.push({ action: 'created', name: it.name, id: res.id })
      } else {
        changelog.push({ action: 'created', name: it.name })
      }
      created++
      continue
    }

    // UPDATE — only fields we own: price + availability (soldOut) + outlet scope.
    // Leave name/description/veg/coins/options/image as the merchant curated them.
    const patch: any = {}
    const changes: Record<string, { from: any; to: any }> = {}
    if (Number(existing.priceInr) !== it.priceInr) { patch.priceInr = it.priceInr; changes.priceInr = { from: existing.priceInr, to: it.priceInr } }
    if (!!existing.soldOut !== it.soldOut) { patch.soldOut = it.soldOut; changes.soldOut = { from: !!existing.soldOut, to: it.soldOut } }
    // UNION the outlet into availableOutlets — never narrow. Empty existing list means
    // "all outlets", so leave it empty (adding would wrongly restrict it).
    if (outletId) {
      const cur: string[] = Array.isArray(existing.availableOutlets) ? existing.availableOutlets : []
      if (cur.length > 0 && !cur.includes(outletId)) {
        const next = [...cur, outletId]
        patch.availableOutlets = next
        changes.availableOutlets = { from: cur, to: next }
      }
    }

    if (Object.keys(patch).length === 0) {
      unchanged++
      changelog.push({ action: 'unchanged', name: it.name, id: existing.id })
      continue
    }
    if (!opts.dryRun) await call('PATCH', `/admin/items/${existing.id}`, slug, patch)
    updated++
    changelog.push({ action: 'updated', name: it.name, id: existing.id, changes })
  }

  return { ok: true, slug, outletId, categoriesCreated, created, updated, unchanged, changelog }
}
