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
        // Zomato prices live on the WRAPPER, not the catalogue: get_content_menu
        // puts them at catalogueWrappers[].variantWrappers[].variantPrices[]
        // (service="delivery"). Resolve from there first (verified live 2026-08-11);
        // fall back to legacy catalogue shapes. null → flagged needs-review, never dropped.
        price: zomatoWrapperPrice(w),
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

/**
 * Effective ₹ price for a Zomato catalogue item. Zomato rarely puts a flat `price`
 * on the item — the real price lives in a variant map (a base/default variant plus
 * optional sizes). Best-effort across the shapes seen in get_content_menu / menu_edit:
 *   1. a positive flat `price`
 *   2. the DEFAULT variant's price (isDefault / matches defaultVariantId), across
 *      `variants` / `variantGroups[].variants` / `variantsV2` / `itemVariants`
 *   3. the lowest positive variant price (fallback when no default is flagged)
 *   4. a `priceMap` / `prices` object of { variantId: price | {price} }
 * Returns null when nothing resolvable — the caller imports it flagged (₹0), never drops.
 */
/**
 * Effective ₹ price for a Zomato catalogue WRAPPER (get_content_menu). The real
 * price lives at `variantWrappers[].variantPrices[]` — each a `{service, price}`
 * (service "delivery" | "dine_out" | …). We take the DELIVERY prices (what the
 * storefront/POS mirror), else any service, and return the lowest positive one
 * (the base/smallest size → "from ₹X"). Falls back to the legacy catalogue-shape
 * resolver. Verified live 2026-08-11 against La Fiamma (Burrata Pesto ₹890).
 */
/** Storefront base price across channels = the higher of what's already stored and
 *  the channel being imported (Swiggy vs Zomato). 0 when neither has a price. */
export function higherBase(existing: number | null | undefined, incoming: number | null | undefined): number {
  return Math.max(Number(existing) || 0, Number(incoming) || 0)
}

export function zomatoWrapperPrice(w: any): number | null {
  const num = (v: any) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : null }
  const all: number[] = []
  const delivery: number[] = []
  for (const vw of (Array.isArray(w?.variantWrappers) ? w.variantWrappers : [])) {
    for (const vp of (Array.isArray(vw?.variantPrices) ? vw.variantPrices : [])) {
      const p = num(vp?.price)
      if (p == null) continue
      all.push(p)
      if (String(vp?.service ?? '').toLowerCase() === 'delivery') delivery.push(p)
    }
  }
  const pool = delivery.length ? delivery : all
  if (pool.length) return Math.min(...pool)
  return zomatoPrice(w?.catalogue)
}

export function zomatoPrice(cat: any): number | null {
  const num = (v: any) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : null }
  const direct = num(cat?.price)
  if (direct != null) return direct

  const variants: any[] = []
  const collect = (arr: any) => {
    if (!Array.isArray(arr)) return
    for (const v of arr) {
      if (!v || typeof v !== 'object') continue
      if (Array.isArray(v.variants)) collect(v.variants)   // variantGroups → nested variants
      else variants.push(v)
    }
  }
  collect(cat?.variants); collect(cat?.variantGroups); collect(cat?.variantsV2); collect(cat?.itemVariants)
  if (variants.length) {
    const defId = cat?.defaultVariantId ?? cat?.defaultVariant ?? null
    const isDefault = (v: any) => v?.isDefault === true || v?.default === true || v?.is_default === true ||
      (defId != null && String(v?.id ?? v?.variantId ?? '') === String(defId))
    const def = num(variants.find(isDefault)?.price)
    if (def != null) return def
    const prices = variants.map(v => num(v?.price)).filter((p): p is number => p != null)
    if (prices.length) return Math.min(...prices)
  }

  const pm = cat?.priceMap ?? cat?.prices
  if (pm && typeof pm === 'object') {
    const vals = Object.values(pm)
      .map((x: any) => num(x && typeof x === 'object' ? (x.price ?? x.amount) : x))
      .filter((p): p is number => p != null)
    if (vals.length) return Math.min(...vals)
  }
  return null
}

// ── per-channel item detail (Swiggy/Zomato) ─────────────────────────────────────
// The storefront item's `channels` upgraded from {swiggy:bool, zomato:bool} to
// per-channel detail. `available` = offered on the channel (a bare bool still means
// this, back-compat). `price` = per-channel override (null → base). `inStock` = last
// known stock (null → unknown). `srcId`/`outletRef` = the aggregator binding an
// import records so the dashboard can push a stock toggle back to the right entity.
export interface ChannelDetail {
  available: boolean
  price: number | null
  inStock: boolean | null
  srcId: string | null
  outletRef: string | null
}
export type ItemChannels = { zomato: ChannelDetail; swiggy: ChannelDetail }

const emptyDetail = (available = true): ChannelDetail => ({ available, price: null, inStock: null, srcId: null, outletRef: null })

/** Normalise one channel's value (bool | object | missing) → ChannelDetail. */
export function normChannelDetail(v: any): ChannelDetail {
  if (v === false) return emptyDetail(false)
  if (v == null || v === true) return emptyDetail(true)
  const o = typeof v === 'object' ? v : {}
  return {
    available: o.available !== false,
    price: o.price != null && Number(o.price) > 0 ? Math.round(Number(o.price)) : null,
    inStock: o.inStock == null ? null : !!o.inStock,
    srcId: o.srcId != null ? String(o.srcId).slice(0, 64) : null,
    outletRef: o.outletRef != null ? String(o.outletRef).slice(0, 64) : null,
  }
}
export const normChannels = (raw: any): ItemChannels => ({
  zomato: normChannelDetail(raw?.zomato),
  swiggy: normChannelDetail(raw?.swiggy),
})
const detailEq = (a: ChannelDetail, b: ChannelDetail) =>
  a.available === b.available && a.price === b.price && a.inStock === b.inStock &&
  a.srcId === b.srcId && a.outletRef === b.outletRef

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
  /** Rehost an aggregator image URL into OUR asset bucket, returning our permanent URL
   *  (or null → keep the source URL). Injected by the route (has supabase + tenantId) so
   *  stored product images never depend on Swiggy/Zomato's expiring CDN links. */
  rehost?: (srcUrl: string) => Promise<string | null>
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

  // Which channel this import speaks for + the aggregator outlet ref it binds to.
  // Populated onto the item's per-channel detail so the dashboard shows the real
  // Swiggy/Zomato price + stock, and can push a stock toggle back to this entity.
  const channel = (opts.channel === 'zomato' || opts.channel === 'swiggy') ? opts.channel : null
  const chOutletRef = opts.aggregatorResId != null ? String(opts.aggregatorResId) : null
  const detailFor = (it: MappedItem): ChannelDetail => ({
    available: true,
    price: it.priceInr > 0 ? it.priceInr : null,   // real per-channel ₹ (null = needs-review/base)
    inStock: !it.soldOut,
    srcId: it.sourceId,
    outletRef: chOutletRef,
  })

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
      // Seed this channel's per-channel detail (real price + stock + binding); the
      // other channel defaults to available with no override (server normalises).
      if (channel) body.channels = { [channel]: detailFor(it) }
      // Store OUR rehosted asset URL (never the aggregator's expiring CDN link); fall
      // back to the source URL if rehost is unavailable/fails.
      if (it.imageUrl) body.imageUrl = (opts.rehost && await opts.rehost(it.imageUrl)) || it.imageUrl
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

    // UPDATE — only fields we own: price + availability (soldOut) + outlet scope, plus a
    // one-way image BACKFILL (fill a blank image only). Leave name/description/veg/coins/
    // options — and any EXISTING image — as the merchant curated them.
    const patch: any = {}
    const changes: Record<string, { from: any; to: any }> = {}
    // Storefront base = the HIGHER of the channels seen (Swiggy vs Zomato), so the
    // direct price is never below what an aggregator charges. Only ever raises to
    // match the top channel; a later cheaper channel never lowers it.
    const desiredBase = higherBase(existing.priceInr, it.priceInr)
    if (Number(existing.priceInr) !== desiredBase) { patch.priceInr = desiredBase; changes.priceInr = { from: existing.priceInr, to: desiredBase } }
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
    // Refresh THIS channel's per-channel detail from the captured menu, preserving
    // the other channel and the operator's `available` choice. Send the full object
    // (server replaces wholesale). Idempotent: no diff → no patch.
    if (channel) {
      const merged = normChannels(existing.channels)
      const next = { ...detailFor(it), available: merged[channel].available }
      if (!detailEq(merged[channel], next)) {
        merged[channel] = next
        patch.channels = merged
        changes.channels = { from: existing.channels ?? null, to: merged }
      }
    }
    // Backfill a MISSING image only — fill a blank item image from the aggregator (Swiggy/
    // Zomato) photo, and NEVER overwrite a merchant-curated one. If the aggregator has no
    // photo either, the item stays blank (per product decision 2026-08-13).
    if (it.imageUrl && !existing.imageUrl) {
      const ourUrl = (opts.rehost && await opts.rehost(it.imageUrl)) || it.imageUrl
      patch.imageUrl = ourUrl
      changes.imageUrl = { from: existing.imageUrl ?? null, to: ourUrl }
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
