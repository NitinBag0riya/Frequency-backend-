/**
 * Naruto §5 Step 3 — Catalog import pipeline (CSV / Excel path).
 *
 * A real pipeline, not a stub:
 *   parse → column-mapping → validate → DRY-RUN (writes nothing) → COMMIT → 24h ROLLBACK.
 *
 * Writes THROUGH the existing catalog storage — the tenant's Database→Tables
 * rows (lib/catalog.ts), which materialise to storefront-api. We do NOT fork the
 * catalog: categories + items become lead_rows in the tenant's catalog tables,
 * then a single materialiseCatalog() pushes the snapshot to storefront-api. So an
 * import is exactly what the dish editor does, in bulk, with a reversible batch.
 *
 * Capability-gated (`onboarding.import.run`) + audited on commit AND rollback.
 * Idempotent commits (keyed). Rollback restores the pre-image within 24h.
 *
 * Endpoints (mounted at /api/naruto/catalog-import):
 *   POST /parse              { tenantId, fileName, contentBase64 }  → headers, sample, suggested mapping, vocab
 *   POST /dry-run            { tenantId, contentBase64, mapping, matchKey? } → summary + per-row plan (NO WRITES)
 *   POST /commit             { tenantId, contentBase64, mapping, matchKey?, idempotencyKey, reason? } → { batchId, applied, undoExpiresAt }
 *   POST /:batchId/rollback  { tenantId, reason? } → restores pre-image
 *   GET  /batches?tenantId=  → recent commits + undo window (drives the Rollback button after reload)
 *
 * The pure engine (parse/map/validate/classify) is exported for the self-check;
 * the router is the thin IO shell around it.
 *
 * WIRE(naruto): body size — realistic menu CSV/XLSX are well under the global
 * 1 MB JSON limit (a 60-item sheet is a few KB). For very large imports, add a
 * per-route override in index.ts next to the others, e.g.
 *   app.post('/api/naruto/catalog-import/parse',   express.json({ limit: '20mb' }))
 *   app.post('/api/naruto/catalog-import/dry-run',  express.json({ limit: '20mb' }))
 *   app.post('/api/naruto/catalog-import/commit',   express.json({ limit: '20mb' }))
 *
 * WIRE(naruto): image/PDF-parse and Swiggy/Zomato import paths are separate
 * ingestion front-ends that produce the same normalised dish[] this engine
 * commits — build them as follow-ups that call classify()/commit internals.
 * WIRE(naruto): bulk image upload / auto-match by filename|SKU — the mapping
 * carries the image URL per row today; a follow-up wires the assets bucket
 * (routes/assets.ts) to accept a zip/URL list and back-fill imageUrl by SKU.
 */
import express from 'express'
import type { SupabaseClient } from '@supabase/supabase-js'
import * as XLSX from 'xlsx'
import {
  getCatalogConfig, provisionCatalog, composeMenu, materializeCatalog,
  type CatalogConfig,
} from '../lib/catalog'
import { requirePlatformCapability } from '../lib/platform-guard'
import { recordPlatformAudit } from '../lib/platform-audit'

type Mw = (req: express.Request, res: express.Response, next: express.NextFunction) => void | Promise<void>

// ── Vocabulary per vertical (spec §5: "vocabulary follows vertical") ─────────
export interface Vocab { noun: string; nounPlural: string; category: string; categoryPlural: string }
export function vocabFor(businessType?: string): Vocab {
  const k = String(businessType || '').toLowerCase()
  if (k === 'salon' || k === 'spa' || k === 'services' || k === 'wellness')
    return { noun: 'Service', nounPlural: 'Services', category: 'Service group', categoryPlural: 'Service groups' }
  if (k === 'real_estate' || k === 'realestate')
    return { noun: 'Listing', nounPlural: 'Listings', category: 'Area', categoryPlural: 'Areas' }
  if (k === 'd2c' || k === 'ecommerce' || k === 'retail')
    return { noun: 'Product', nounPlural: 'Products', category: 'Collection', categoryPlural: 'Collections' }
  return { noun: 'Item', nounPlural: 'Menu items', category: 'Category', categoryPlural: 'Categories' }
}

// ── Importable roles: the target fields an operator maps columns onto ─────────
// `key` is the role; grid/materialise column mapping is derived from CatalogConfig.map.
export interface ImportRole { key: string; label: string; required?: boolean; hint?: string }
export function importRoles(businessType?: string): ImportRole[] {
  const k = String(businessType || '').toLowerCase()
  const d2cLike = ['salon', 'spa', 'services', 'wellness', 'd2c', 'ecommerce', 'retail'].includes(k)
  const common: ImportRole[] = [
    { key: 'name',        label: 'Name', required: true },
    { key: 'category',    label: 'Category', hint: 'Grouping; created if new' },
    { key: 'description', label: 'Description' },
    { key: 'price',       label: 'Price (₹)' },
    { key: 'image',       label: 'Image URL' },
    { key: 'gst',         label: 'GST rate (%)', hint: 'Tax percent, e.g. 5 or 18' },
    { key: 'hsn',         label: 'HSN / SAC code' },
    { key: 'availability',label: 'Available (yes/no)' },
    { key: 'addons',      label: d2cLike ? 'Variants / options' : 'Add-ons', hint: 'JSON, or "Size: Small=0, Large=40 | Milk: Oat=20"' },
  ]
  if (d2cLike) return [
    ...common,
    { key: 'sku',        label: 'SKU' },
    { key: 'stock',      label: 'Stock (qty)' },
    { key: 'compareAt',  label: 'Compare-at price (₹)' },
  ]
  return [
    ...common,
    { key: 'coins',      label: 'Coins (loyalty)' },
    { key: 'veg',        label: 'Veg (yes/no)' },
  ]
}

// ── Parse: one reader for CSV and Excel (SheetJS handles both) ────────────────
export interface ParsedSheet { headers: string[]; rows: Record<string, string>[] }
export function parseSheet(buf: Buffer, fileName = ''): ParsedSheet {
  // CSV comes in as text; xlsx/xls as a binary workbook. Let SheetJS sniff it.
  const isCsv = /\.csv$/i.test(fileName)
  const wb = isCsv
    ? XLSX.read(buf.toString('utf8'), { type: 'string' })
    : XLSX.read(buf, { type: 'buffer' })
  const sheet = wb.Sheets[wb.SheetNames[0]]
  if (!sheet) return { headers: [], rows: [] }
  // header:1 → array-of-arrays so we keep the ORIGINAL header order + row numbers.
  const grid: any[][] = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: false, defval: '' })
  const headerRow = (grid[0] || []).map((h: any) => String(h ?? '').trim())
  const headers = headerRow.filter(Boolean)
  const rows: Record<string, string>[] = []
  for (let i = 1; i < grid.length; i++) {
    const r = grid[i] || []
    if (r.every(c => String(c ?? '').trim() === '')) continue // skip blank lines
    const obj: Record<string, string> = {}
    headerRow.forEach((h, j) => { if (h) obj[h] = String(r[j] ?? '').trim() })
    rows.push(obj)
  }
  return { headers, rows }
}

// ── Suggested mapping: fuzzy-match headers → roles ───────────────────────────
const ROLE_SYNONYMS: Record<string, string[]> = {
  name: ['name', 'item', 'title', 'product', 'service', 'dish'],
  category: ['category', 'collection', 'group', 'section', 'menu'],
  description: ['description', 'desc', 'details', 'about'],
  price: ['price', 'mrp', 'rate', 'amount', 'cost', 'sellingprice'],
  image: ['image', 'imageurl', 'img', 'photo', 'picture'],
  gst: ['gst', 'tax', 'taxrate', 'gstrate', 'vat'],
  hsn: ['hsn', 'sac', 'hsncode'],
  availability: ['available', 'availability', 'active', 'instock', 'enabled'],
  addons: ['addons', 'addon', 'variants', 'variant', 'options', 'modifiers'],
  sku: ['sku', 'code', 'barcode', 'itemcode'],
  stock: ['stock', 'qty', 'quantity', 'inventory'],
  compareAt: ['compareat', 'compareatprice', 'was', 'strikeprice', 'listprice'],
  coins: ['coins', 'points', 'reward', 'loyalty'],
  veg: ['veg', 'vegetarian', 'isveg', 'foodtype'],
}
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '')
export function suggestMapping(headers: string[], businessType?: string): Record<string, string> {
  const roles = importRoles(businessType).map(r => r.key)
  const out: Record<string, string> = {}
  const used = new Set<string>()
  for (const role of roles) {
    const syns = ROLE_SYNONYMS[role] || [role]
    const hit = headers.find(h => !used.has(h) && syns.includes(norm(h)))
      || headers.find(h => !used.has(h) && syns.some(s => norm(h).includes(s)))
    if (hit) { out[role] = hit; used.add(hit) }
  }
  return out
}

// ── Option-group parsing (add-ons / variants) → the shape the storefront eats ─
// storefront OptionGroup: { id, name, type:'single'|'multi', required?, choices:[{id,name,priceDelta}] }
const slug = (s: string) => norm(s).slice(0, 24) || 'x'
export interface OptionGroup { id: string; name: string; type: 'single' | 'multi'; required?: boolean; choices: { id: string; name: string; priceDelta: number }[] }
export function parseOptionGroups(raw: string, kind: 'addons' | 'variants'): OptionGroup[] {
  const s = String(raw || '').trim()
  if (!s) return []
  // Advanced: a JSON array is accepted verbatim if it already matches the shape.
  if (s.startsWith('[')) {
    try {
      const p = JSON.parse(s)
      if (Array.isArray(p)) return p.filter(g => g && Array.isArray(g.choices))
    } catch { /* fall through to the friendly grammar */ }
  }
  // Friendly grammar:  Group: choice=delta, choice2 | Group2: a=10, b=20
  // A bare list (no "Group:") becomes one group named for the kind.
  const groups = s.split('|').map(g => g.trim()).filter(Boolean)
  const out: OptionGroup[] = []
  groups.forEach((g, gi) => {
    let name: string, body: string
    const ci = g.indexOf(':')
    if (ci >= 0) { name = g.slice(0, ci).trim(); body = g.slice(ci + 1) }
    else { name = kind === 'variants' ? 'Options' : 'Add-ons'; body = g }
    const choices = body.split(',').map(c => c.trim()).filter(Boolean).map((c, i) => {
      const eq = c.lastIndexOf('=')
      const label = (eq >= 0 ? c.slice(0, eq) : c).trim()
      const delta = eq >= 0 ? Number(c.slice(eq + 1).replace(/[^0-9.-]/g, '')) : 0
      return { id: `${slug(name)}-${slug(label)}-${i}`, name: label, priceDelta: Number.isFinite(delta) ? delta : 0 }
    }).filter(c => c.name)
    if (choices.length) out.push({
      id: `g-${slug(name)}-${gi}`, name,
      // Variants (size/colour) are usually a required single-pick; add-ons are optional multi.
      type: kind === 'variants' ? 'single' : 'multi',
      required: kind === 'variants',
      choices,
    })
  })
  return out
}

// ── Normalised dish + row validation ─────────────────────────────────────────
export interface NormalizedDish {
  name: string
  category: string           // category NAME (resolved to a row id at commit)
  description: string
  priceInr: number
  imageUrl: string
  options: OptionGroup[]
  // vertical-optional:
  coins?: number; veg?: boolean; soldOut?: boolean
  sku?: string; stock?: number | null; compareAtPrice?: number | null
  // catalog attributes carried in the row data blob (reserved keys):
  gstRate?: number | null; hsn?: string
}
export interface RowError { row: number; field: string; message: string }

const truthy = (v: string) => ['1', 'true', 'yes', 'y', 'veg', 'available', 'active', 'in stock'].includes(String(v).trim().toLowerCase())
const falsy  = (v: string) => ['0', 'false', 'no', 'n', 'non-veg', 'nonveg', 'unavailable', 'inactive', 'out of stock', 'sold out'].includes(String(v).trim().toLowerCase())

/** Map + validate ONE sheet row. Returns the dish (null if unusable) and any field errors. */
export function normalizeRow(raw: Record<string, string>, mapping: Record<string, string>, businessType: string | undefined, rowNumber: number): { dish: NormalizedDish | null; errors: RowError[] } {
  const errors: RowError[] = []
  const get = (role: string) => { const col = mapping[role]; return col ? String(raw[col] ?? '').trim() : '' }
  const d2cLike = importRoles(businessType).some(r => r.key === 'sku')

  const name = get('name')
  if (!name) { errors.push({ row: rowNumber, field: 'name', message: 'Name is required' }); return { dish: null, errors } }

  const num = (role: string, field: string, opts: { int?: boolean; max?: number } = {}): number | null => {
    const v = get(role); if (v === '') return null
    const n = Number(v.replace(/[₹,\s]/g, ''))
    if (!Number.isFinite(n) || n < 0) { errors.push({ row: rowNumber, field, message: `"${v}" is not a valid number` }); return null }
    if (opts.max != null && n > opts.max) { errors.push({ row: rowNumber, field, message: `${field} must be ≤ ${opts.max}` }); return null }
    return opts.int ? Math.round(n) : n
  }

  const price = num('price', 'price') ?? 0
  const gstRate = num('gst', 'gst', { max: 100 })
  const availRaw = get('availability')
  const vegRaw = get('veg')

  const dish: NormalizedDish = {
    name,
    category: get('category'),
    description: get('description'),
    priceInr: Math.round(price),
    imageUrl: get('image'),
    options: parseOptionGroups(get('addons'), d2cLike ? 'variants' : 'addons'),
    gstRate,
    hsn: get('hsn') || undefined,
    soldOut: availRaw ? falsy(availRaw) && !truthy(availRaw) : false,
  }
  if (d2cLike) {
    dish.sku = get('sku') || undefined
    dish.stock = num('stock', 'stock', { int: true })
    dish.compareAtPrice = num('compareAt', 'compareAt')
  } else {
    dish.coins = num('coins', 'coins', { int: true }) ?? undefined
    dish.veg = vegRaw ? (truthy(vegRaw) || (!falsy(vegRaw) && /veg/i.test(vegRaw) && !/non/i.test(vegRaw))) : undefined
  }
  return { dish, errors }
}

// ── Classification: created vs updated vs skipped, against the current catalog ─
export type RowAction = 'create' | 'update' | 'skip'
export interface PlanRow { row: number; action: RowAction; dish: NormalizedDish | null; matchId?: string; note?: string }
export interface ImportSummary { created: number; updated: number; skipped: number; errors: number }

export interface ExistingItem { id: string; name: string; sku?: string | null; categoryId: string }
/** Build the match key for a dish/existing item. `sku` when chosen + present, else category::name. */
function matchKeyOf(name: string, category: string, sku: string | null | undefined, matchKey: 'sku' | 'name'): string {
  if (matchKey === 'sku' && sku) return `sku:${norm(sku)}`
  return `nm:${norm(category)}:${norm(name)}`
}

export function classify(
  parsed: { dish: NormalizedDish | null; errors: RowError[] }[],
  existingItems: ExistingItem[],
  categoryNameById: Map<string, string>,
  matchKey: 'sku' | 'name',
): { plan: PlanRow[]; summary: ImportSummary; errors: RowError[]; categoriesToCreate: string[] } {
  const existingByKey = new Map<string, string>() // key → row id
  for (const it of existingItems) {
    existingByKey.set(matchKeyOf(it.name, categoryNameById.get(it.categoryId) || '', it.sku, matchKey), it.id)
  }
  const knownCats = new Set(Array.from(categoryNameById.values()).map(n => norm(n)))
  const newCats = new Set<string>()

  const plan: PlanRow[] = []
  const errors: RowError[] = []
  const summary: ImportSummary = { created: 0, updated: 0, skipped: 0, errors: 0 }
  // Guard against duplicate keys WITHIN the sheet (second occurrence updates the first's target).
  const seen = new Set<string>()

  parsed.forEach((p, i) => {
    const rowNumber = i + 2 // +1 header, +1 to 1-index like a spreadsheet
    if (p.errors.length) { errors.push(...p.errors) }
    if (!p.dish) { plan.push({ row: rowNumber, action: 'skip', dish: null, note: p.errors[0]?.message || 'Invalid row' }); summary.skipped++; summary.errors += p.errors.length; return }
    const d = p.dish
    if (p.errors.length) summary.errors += p.errors.length
    const key = matchKeyOf(d.name, d.category, d.sku, matchKey)
    if (seen.has(key)) { plan.push({ row: rowNumber, action: 'skip', dish: d, note: 'Duplicate of an earlier row in this file' }); summary.skipped++; return }
    seen.add(key)
    if (d.category && !knownCats.has(norm(d.category))) newCats.add(d.category)
    const matchId = existingByKey.get(key)
    if (matchId) { plan.push({ row: rowNumber, action: 'update', dish: d, matchId }); summary.updated++ }
    else { plan.push({ row: rowNumber, action: 'create', dish: d }); summary.created++ }
  })
  return { plan, summary, errors, categoriesToCreate: Array.from(newCats) }
}

// ── IO helpers ───────────────────────────────────────────────────────────────
async function slugForTenant(supabase: SupabaseClient, tenantId: string): Promise<string | null> {
  const { data } = await supabase.from('tenants').select('slug').eq('id', tenantId).maybeSingle()
  return (data as any)?.slug || null
}
async function businessTypeFor(supabase: SupabaseClient, tenantId: string): Promise<string | undefined> {
  const { data } = await supabase.from('tenants').select('business_type').eq('id', tenantId).maybeSingle()
  return (data as any)?.business_type || undefined
}

/** Map a normalised dish onto a catalog item row's data blob, using the vertical's role→column map. */
function dishToRowData(config: CatalogConfig, dish: NormalizedDish, categoryRowId: string): Record<string, string> {
  const im = config.map.item as any
  const d: Record<string, string> = {}
  const set = (col: string | undefined, val: string) => { if (col) d[col] = val }
  const opts = JSON.stringify(dish.options || [])
  set(im.name, dish.name)
  set(im.description, dish.description || '')
  set(im.price, String(Math.max(0, Math.round(dish.priceInr || 0))))
  set(im.image, dish.imageUrl || '')
  set(im.category, categoryRowId)     // stable category ROW id (the relationship)
  set(im.addons, opts)                // HoReCa add-on groups
  set(im.variants, opts)              // D2C variant groups (same shape)
  if (dish.coins != null) set(im.coins, String(Math.max(0, Math.round(dish.coins))))
  if (dish.veg != null) set(im.veg, String(!!dish.veg))
  if (dish.soldOut != null) set(im.soldOut, String(!!dish.soldOut))
  if (dish.sku != null) set(im.sku, dish.sku)
  if (dish.stock != null) set(im.stock, String(Math.max(0, Math.round(dish.stock))))
  if (dish.compareAtPrice != null) set(im.compareAt, String(Math.max(0, Math.round(dish.compareAtPrice))))
  // GST rate + HSN ride in the row blob as reserved keys (no mapped column) — same
  // pattern as catalog.ts _availableOutlets. Real, queryable catalog attributes.
  // WIRE(naruto): composeMenu + storefront checkout apply a flat tenant taxRate
  // today; per-item GST rendering reads these keys as a follow-up.
  if (dish.gstRate != null) d['_gstRate'] = String(dish.gstRate)
  if (dish.hsn) d['_hsn'] = dish.hsn
  return d
}

/** Load config, provisioning the catalog tables first if this tenant has none yet. */
async function ensureConfig(supabase: SupabaseClient, tenantId: string, userId: string, slug: string): Promise<CatalogConfig> {
  const existing = await getCatalogConfig(slug)
  if (existing) return existing
  const { config } = await provisionCatalog(supabase, tenantId, userId, slug)
  return config
}

/** Current catalog as {existingItems, categoryNameById, categoryIdByName} from lead_rows. */
async function loadCurrent(supabase: SupabaseClient, tenantId: string, config: CatalogConfig) {
  const [cats, items] = await Promise.all([
    supabase.from('lead_rows').select('id, data').eq('tenant_id', tenantId).eq('table_id', config.categoriesTableId),
    supabase.from('lead_rows').select('id, data').eq('tenant_id', tenantId).eq('table_id', config.itemsTableId),
  ])
  const composed = composeMenu(config, cats.data || [], items.data || [])
  const categoryNameById = new Map<string, string>(composed.categories.map(c => [c.id, c.name]))
  const categoryIdByName = new Map<string, string>(composed.categories.map(c => [norm(c.name), c.id]))
  const existingItems: ExistingItem[] = composed.items.map(it => ({ id: it.id, name: it.name, sku: (it as any).sku ?? null, categoryId: it.categoryId }))
  return { categoryNameById, categoryIdByName, existingItems, rawItemsById: new Map((items.data || []).map((r: any) => [r.id, r.data])) }
}

function decodeFile(body: any): { buf: Buffer; fileName: string } | { error: string } {
  const b64 = body?.contentBase64
  if (typeof b64 !== 'string' || !b64) return { error: 'contentBase64 (the file bytes) is required' }
  try {
    const buf = Buffer.from(b64.replace(/^data:[^;]+;base64,/, ''), 'base64')
    if (!buf.length) return { error: 'File is empty' }
    return { buf, fileName: String(body?.fileName || '') }
  } catch { return { error: 'contentBase64 is not valid base64' } }
}

// ── Router ───────────────────────────────────────────────────────────────────
// WIRE(naruto): register in src/index.ts next to the other platform routers
// (near `app.use(createSuperAdminRouter({ supabase, requireAuth }))`, ~line 5983):
//
//   import { createNarutoCatalogImportRouter } from './routes/naruto-catalog-import'
//   app.use(createNarutoCatalogImportRouter({ supabase, requireAuth }))
//
// `supabase` there is the service-role client (index.ts:702); the routes are
// capability-gated internally (onboarding.import.run), so no extra mount guard.
export function createNarutoCatalogImportRouter({ supabase, requireAuth }: { supabase: SupabaseClient; requireAuth: Mw }) {
  const router = express.Router()
  const gate: Mw[] = [requireAuth, requirePlatformCapability(supabase, 'onboarding.import.run')]
  const P = '/api/naruto/catalog-import'

  // POST /parse — read the file, return headers + a sample + suggested mapping + vocab.
  router.post(`${P}/parse`, ...gate, async (req, res) => {
    const { tenantId } = req.body || {}
    if (!tenantId) return res.status(400).json({ error: 'tenantId is required' })
    const f = decodeFile(req.body); if ('error' in f) return res.status(400).json({ error: f.error })
    let parsed: ParsedSheet
    try { parsed = parseSheet(f.buf, f.fileName) } catch (e: any) { return res.status(422).json({ error: `Could not read the file: ${e?.message || 'parse failed'}` }) }
    if (!parsed.headers.length) return res.status(422).json({ error: 'No header row found — the first row must be column names' })
    const businessType = await businessTypeFor(supabase, tenantId)
    res.json({
      headers: parsed.headers,
      rowCount: parsed.rows.length,
      sample: parsed.rows.slice(0, 8),
      suggestedMapping: suggestMapping(parsed.headers, businessType),
      roles: importRoles(businessType),
      vocab: vocabFor(businessType),
    })
  })

  // POST /dry-run — classify every row against the live catalog. WRITES NOTHING.
  router.post(`${P}/dry-run`, ...gate, async (req, res) => {
    const { tenantId, mapping, matchKey } = req.body || {}
    if (!tenantId || !mapping?.name) return res.status(400).json({ error: 'tenantId and a mapping with a "name" column are required' })
    const f = decodeFile(req.body); if ('error' in f) return res.status(400).json({ error: f.error })
    const slug = await slugForTenant(supabase, tenantId)
    if (!slug) return res.status(404).json({ error: 'Tenant has no storefront slug' })
    const businessType = await businessTypeFor(supabase, tenantId)
    const config = await getCatalogConfig(slug) // dry-run must NOT provision — read-only
    let parsedRows: ParsedSheet
    try { parsedRows = parseSheet(f.buf, f.fileName) } catch (e: any) { return res.status(422).json({ error: `Could not read the file: ${e?.message}` }) }

    const normalized = parsedRows.rows.map((r, i) => normalizeRow(r, mapping, businessType, i))
    const mk: 'sku' | 'name' = matchKey === 'sku' ? 'sku' : 'name'

    if (!config) {
      // Not provisioned yet → everything is a create; commit will provision on the way in.
      const summary: ImportSummary = { created: 0, updated: 0, skipped: 0, errors: 0 }
      const errors: RowError[] = []
      const plan: PlanRow[] = normalized.map((p, i) => {
        const row = i + 2
        if (p.errors.length) { errors.push(...p.errors); summary.errors += p.errors.length }
        if (!p.dish) { summary.skipped++; return { row, action: 'skip' as RowAction, dish: null, note: p.errors[0]?.message } }
        summary.created++; return { row, action: 'create' as RowAction, dish: p.dish }
      })
      const cats = new Set(normalized.map(p => p.dish?.category).filter(Boolean) as string[])
      return res.json({ summary, plan, errors, categoriesToCreate: Array.from(cats), vocab: vocabFor(businessType), provisioned: false })
    }

    const cur = await loadCurrent(supabase, tenantId, config)
    const { plan, summary, errors, categoriesToCreate } = classify(normalized, cur.existingItems, cur.categoryNameById, mk)
    res.json({ summary, plan, errors, categoriesToCreate, vocab: vocabFor(businessType), provisioned: true })
  })

  // POST /commit — apply the import; capture the pre-image; audited + idempotent.
  router.post(`${P}/commit`, ...gate, async (req, res) => {
    const { tenantId, mapping, matchKey, idempotencyKey, reason } = req.body || {}
    if (!tenantId || !mapping?.name) return res.status(400).json({ error: 'tenantId and a mapping with a "name" column are required' })
    const f = decodeFile(req.body); if ('error' in f) return res.status(400).json({ error: f.error })
    const userId = (req as any).user?.id || null

    // Idempotency: a repeated key returns the existing batch, no re-apply.
    if (idempotencyKey) {
      const { data: prior } = await supabase.from('catalog_import_batches')
        .select('id, summary, status, expires_at').eq('tenant_id', tenantId).eq('idempotency_key', String(idempotencyKey)).maybeSingle()
      if (prior) return res.json({ batchId: (prior as any).id, applied: (prior as any).summary, undoExpiresAt: (prior as any).expires_at, idempotentReplay: true })
    }

    const slug = await slugForTenant(supabase, tenantId)
    if (!slug) return res.status(404).json({ error: 'Tenant has no storefront slug' })
    const businessType = await businessTypeFor(supabase, tenantId)
    let parsedRows: ParsedSheet
    try { parsedRows = parseSheet(f.buf, f.fileName) } catch (e: any) { return res.status(422).json({ error: `Could not read the file: ${e?.message}` }) }
    const normalized = parsedRows.rows.map((r, i) => normalizeRow(r, mapping, businessType, i))
    const mk: 'sku' | 'name' = matchKey === 'sku' ? 'sku' : 'name'

    let config: CatalogConfig
    try { config = await ensureConfig(supabase, tenantId, userId || tenantId, slug) }
    catch (e: any) { return res.status(500).json({ error: `Could not provision the catalog: ${e?.message}` }) }

    const cur = await loadCurrent(supabase, tenantId, config)
    const { plan, summary } = classify(normalized, cur.existingItems, cur.categoryNameById, mk)

    // Pre-image accumulators for rollback.
    const preItems: { id: string; data: Record<string, any> | null }[] = []
    const preCats: { id: string }[] = []
    const catIdByName = new Map(cur.categoryIdByName) // norm(name) → id, extended as we create

    // 1) Create any missing categories first (need their row ids to link items).
    const wantedCats = new Set(plan.filter(p => p.action !== 'skip' && p.dish?.category).map(p => p.dish!.category))
    for (const catName of wantedCats) {
      if (catIdByName.has(norm(catName))) continue
      const { data, error } = await supabase.from('lead_rows')
        .insert({ table_id: config.categoriesTableId, tenant_id: tenantId, user_id: userId, status: 'active', data: { [config.map.category.name]: catName } })
        .select('id').single()
      if (error || !data) return res.status(500).json({ error: `Could not create category "${catName}": ${error?.message}` })
      catIdByName.set(norm(catName), (data as any).id)
      preCats.push({ id: (data as any).id })
    }
    const fallbackCatId = cur.existingItems.length ? cur.existingItems[0].categoryId : (catIdByName.values().next().value || '')

    // 2) Apply creates (batch-insert) + updates (per row, merge onto prior data).
    const toInsert: any[] = []
    for (const p of plan) {
      if (p.action === 'skip' || !p.dish) continue
      const catId = (p.dish.category && catIdByName.get(norm(p.dish.category))) || fallbackCatId
      const data = dishToRowData(config, p.dish, catId)
      if (p.action === 'update' && p.matchId) {
        const prior = cur.rawItemsById.get(p.matchId) || {}
        preItems.push({ id: p.matchId, data: prior })
        const { error } = await supabase.from('lead_rows').update({ data: { ...prior, ...data } }).eq('id', p.matchId).eq('tenant_id', tenantId).eq('table_id', config.itemsTableId)
        if (error) return res.status(500).json({ error: `Update failed on row ${p.row}: ${error.message}` })
      } else {
        toInsert.push({ table_id: config.itemsTableId, tenant_id: tenantId, user_id: userId, status: 'active', data })
      }
    }
    if (toInsert.length) {
      const { data, error } = await supabase.from('lead_rows').insert(toInsert).select('id')
      if (error) return res.status(500).json({ error: `Insert failed: ${error.message}` })
      for (const r of (data || [])) preItems.push({ id: (r as any).id, data: null }) // null = created by this batch
    }

    // 3) One materialise → the storefront-api snapshot reflects the whole batch.
    let counts: any = null
    try { counts = await materializeCatalog(supabase, tenantId, slug) } catch (e: any) { /* rows are written; snapshot retry is safe */ console.warn('[import] materialise (non-fatal):', e?.message) }

    // 4) Record the reversible batch.
    const { data: batch, error: bErr } = await supabase.from('catalog_import_batches').insert({
      tenant_id: tenantId, actor_user_id: userId, vertical: businessType || null, slug,
      categories_table_id: config.categoriesTableId, items_table_id: config.itemsTableId,
      summary, pre_image: { items: preItems, categories: preCats },
      idempotency_key: idempotencyKey ? String(idempotencyKey) : null, reason: reason || null,
    }).select('id, expires_at').single()
    if (bErr) return res.status(500).json({ error: `Import applied but the undo record failed to save: ${bErr.message}` })

    await recordPlatformAudit(supabase, req, {
      capability: 'onboarding.import.run', action: 'catalog.import.commit', tenant_id: tenantId,
      after: { batchId: (batch as any).id, ...summary, materialized: counts }, reason: reason || null,
    })
    res.json({ batchId: (batch as any).id, applied: summary, undoExpiresAt: (batch as any).expires_at, materialized: counts })
  })

  // POST /:batchId/rollback — reverse a commit within 24h.
  router.post(`${P}/:batchId/rollback`, ...gate, async (req, res) => {
    const { batchId } = req.params
    const { tenantId, reason } = req.body || {}
    const { data: batch, error } = await supabase.from('catalog_import_batches').select('*').eq('id', batchId).maybeSingle()
    if (error || !batch) return res.status(404).json({ error: 'Import batch not found' })
    const b = batch as any
    if (tenantId && b.tenant_id !== tenantId) return res.status(400).json({ error: 'Batch does not belong to this tenant' })
    if (b.status !== 'committed') return res.status(409).json({ error: 'This import was already rolled back' })
    if (new Date(b.expires_at).getTime() < Date.now()) return res.status(410).json({ error: 'The 24-hour rollback window for this import has passed' })

    const pre = b.pre_image || {}
    const items: { id: string; data: any }[] = pre.items || []
    const cats: { id: string }[] = pre.categories || []

    // Reverse items: created rows (data=null) → delete; updated rows → restore prior data.
    const createdIds = items.filter(i => i.data === null).map(i => i.id)
    for (const it of items.filter(i => i.data !== null)) {
      await supabase.from('lead_rows').update({ data: it.data }).eq('id', it.id).eq('tenant_id', b.tenant_id)
    }
    if (createdIds.length) await supabase.from('lead_rows').delete().in('id', createdIds).eq('tenant_id', b.tenant_id)

    // Reverse categories: delete a category this batch created ONLY if nothing else
    // references it now. The item→category link column key is `category` in both the
    // HoReCa and D2C role maps (lib/catalog.ts HORECA_MAP / D2C_MAP).
    for (const c of cats) {
      const { count } = await supabase.from('lead_rows').select('id', { count: 'exact', head: true })
        .eq('tenant_id', b.tenant_id).eq('table_id', b.items_table_id).eq('data->>category', c.id)
      if (!count) await supabase.from('lead_rows').delete().eq('id', c.id).eq('tenant_id', b.tenant_id)
    }

    let counts: any = null
    try { counts = await materializeCatalog(supabase, b.tenant_id, b.slug) } catch (e: any) { console.warn('[import] rollback materialise (non-fatal):', e?.message) }

    await supabase.from('catalog_import_batches').update({ status: 'rolled_back', rolled_back_at: new Date().toISOString() }).eq('id', batchId)
    await recordPlatformAudit(supabase, req, {
      capability: 'onboarding.import.run', action: 'catalog.import.rollback', tenant_id: b.tenant_id,
      before: b.summary, after: { rolledBack: true, materialized: counts }, reason: reason || null,
    })
    res.json({ ok: true, restored: b.summary, materialized: counts })
  })

  // GET /batches — recent commits for a tenant (drives the Rollback button after reload).
  router.get(`${P}/batches`, ...gate, async (req, res) => {
    const tenantId = String(req.query.tenantId || '')
    if (!tenantId) return res.status(400).json({ error: 'tenantId is required' })
    const { data, error } = await supabase.from('catalog_import_batches')
      .select('id, summary, status, reason, created_at, expires_at, rolled_back_at, actor_user_id')
      .eq('tenant_id', tenantId).order('created_at', { ascending: false }).limit(20)
    if (error) return res.status(500).json({ error: error.message })
    const now = Date.now()
    res.json({ batches: (data || []).map((b: any) => ({ ...b, canRollback: b.status === 'committed' && new Date(b.expires_at).getTime() > now })) })
  })

  return router
}
