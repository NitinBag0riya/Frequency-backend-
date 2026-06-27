/**
 * catalog.ts — back the storefront menu with the generic Database→Tables feature.
 *
 * Architecture (see memory `project_generic_catalog_vision`):
 *  - System of record = the tenant's `lead_tables` (a "Categories" table + a
 *    "Menu Items" table). Regular tables/rows — no bespoke schema, fully generic,
 *    so the same machinery serves a D2C catalog by swapping the template + map.
 *  - Serving = a MATERIALIZED read model. storefront-api keeps its fast file cache;
 *    on any catalog write we compose {categories, items} from the rows and PUT the
 *    snapshot to storefront-api `/admin/menu`. No per-request Tables query, no
 *    staleness (push-on-write), `lead_rows` never exposed to the public client.
 *  - One bidirectional `catalog_config` (table ids + column role map) stored in the
 *    storefront-api tenant record; drives BOTH compose (Table→UI) and the row
 *    writes the dashboard makes (UI→Table), so they can't drift.
 */
import type { SupabaseClient } from '@supabase/supabase-js'

const SF_API = process.env.STOREFRONT_API_URL || 'http://localhost:5181'
const SF_SECRET = process.env.STOREFRONT_ADMIN_SECRET || 'dev-admin'

// Marks a lead_table as catalog-backing so a direct row edit (in the Tables UI)
// can auto-materialize. Uses the existing `source` column — no migration.
export const CATALOG_SOURCE = 'catalog'

export interface CatalogConfig {
  version: number
  categoriesTableId: string
  itemsTableId: string
  map: {
    category: { name: string }
    item: Record<string, string> // role → column key
  }
}

// HoReCa template. Column `key` is the JSONB slug used in lead_rows.data and in
// the role map below. To support another vertical, define a new template + map.
const CATEGORY_COLS = [
  { name: 'Name', key: 'name', type: 'text', is_primary: true, is_required: true },
]
const ITEM_COLS = [
  { name: 'Name', key: 'name', type: 'text', is_primary: true, is_required: true },
  { name: 'Description', key: 'description', type: 'textarea' },
  { name: 'Price', key: 'price', type: 'number' },
  { name: 'Coins', key: 'coins', type: 'number' },
  { name: 'Veg', key: 'veg', type: 'boolean' },
  { name: 'Sold out', key: 'sold_out', type: 'boolean' },
  { name: 'Image URL', key: 'image_url', type: 'url' },
  { name: 'Category', key: 'category', type: 'text' },
  { name: 'Add-ons (JSON)', key: 'addons', type: 'textarea' },
]
const HORECA_MAP: CatalogConfig['map'] = {
  category: { name: 'name' },
  item: {
    name: 'name', description: 'description', price: 'price', coins: 'coins',
    veg: 'veg', soldOut: 'sold_out', image: 'image_url', category: 'category', addons: 'addons',
  },
}

// ── storefront-api admin client (server-to-server, shared secret) ───────────────
async function sf(method: string, path: string, slug: string, body?: unknown): Promise<any> {
  const r = await fetch(`${SF_API}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Tenant': slug, 'X-Admin-Secret': SF_SECRET },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  const text = await r.text()
  let json: any
  try { json = JSON.parse(text) } catch { json = text }
  if (!r.ok) throw new Error(`storefront-api ${method} ${path} → ${r.status}: ${typeof json === 'string' ? json : json?.error || ''}`)
  return json
}

async function slugForTenant(supabase: SupabaseClient, tenantId: string): Promise<string | null> {
  const { data } = await supabase.from('tenants').select('slug').eq('id', tenantId).maybeSingle()
  return (data as any)?.slug || null
}

// Lead cells are stored as strings; coerce common truthy spellings.
const truthy = (v: any) => v === true || v === 'true' || v === '1' || v === 1 || v === 'yes'

// ── compose: Tables rows → the {categories, items} contract storefront-api serves ─
export function composeMenu(config: CatalogConfig, catRows: any[], itemRows: any[]) {
  const m = config.map
  const categories = (catRows || [])
    .map(r => ({ id: r.id, name: String(r.data?.[m.category.name] ?? '').trim() }))
    .filter(c => c.name)
  const byName = new Map(categories.map(c => [c.name.toLowerCase(), c.id]))
  const fallback = categories[0]?.id
  const im = m.item
  const items = (itemRows || []).map(r => {
    const d = r.data || {}
    const catName = String(d[im.category] ?? '').trim().toLowerCase()
    const categoryId = byName.get(catName) || fallback
    let options: any[] = []
    if (d[im.addons]) { try { const p = JSON.parse(d[im.addons]); if (Array.isArray(p)) options = p } catch { /* leave empty */ } }
    return {
      id: r.id,
      name: String(d[im.name] ?? '').trim(),
      description: String(d[im.description] ?? ''),
      priceInr: Math.max(0, Math.round(Number(d[im.price]) || 0)),
      coins: Math.max(0, Math.round(Number(d[im.coins]) || 0)),
      veg: truthy(d[im.veg]),
      soldOut: truthy(d[im.soldOut]),
      categoryId,
      imageUrl: d[im.image] || null,
      options,
    }
  }).filter(it => it.name && it.categoryId)
  return { categories, items }
}

// ── status: is this tenant's menu backed by Tables yet? ─────────────────────────
export async function getCatalogConfig(slug: string): Promise<CatalogConfig | null> {
  const cfg = await sf('GET', '/admin/config', slug)
  return (cfg && cfg.catalogConfig) || null
}

// ── materialize: compose from rows and push the snapshot to storefront-api ───────
export async function materializeCatalog(supabase: SupabaseClient, tenantId: string, slug?: string): Promise<{ categories: number; items: number } | null> {
  const s = slug || (await slugForTenant(supabase, tenantId))
  if (!s) return null
  const config = await getCatalogConfig(s)
  if (!config) return null
  const [cats, items] = await Promise.all([
    supabase.from('lead_rows').select('id, data').eq('tenant_id', tenantId).eq('table_id', config.categoriesTableId).order('created_at', { ascending: true }),
    supabase.from('lead_rows').select('id, data').eq('tenant_id', tenantId).eq('table_id', config.itemsTableId).order('created_at', { ascending: true }),
  ])
  const menu = composeMenu(config, cats.data || [], items.data || [])
  await sf('PUT', '/admin/menu', s, menu)
  return { categories: menu.categories.length, items: menu.items.length }
}

// Fire-and-forget auto-sync used by the leads row handlers: if a written row
// belongs to a catalog table, re-materialize. Never throws.
export async function maybeSyncCatalog(supabase: SupabaseClient, tenantId: string, tableId: string): Promise<void> {
  try {
    const { data } = await supabase.from('lead_tables').select('source').eq('id', tableId).eq('tenant_id', tenantId).maybeSingle()
    if ((data as any)?.source !== CATALOG_SOURCE) return
    await materializeCatalog(supabase, tenantId)
  } catch (e: any) {
    console.warn('[catalog] auto-sync (non-fatal):', e?.message)
  }
}

// ── provision: create the tables, backfill from the current menu, wire config ────
async function createTable(supabase: SupabaseClient, tenantId: string, userId: string, name: string, cols: any[]): Promise<string> {
  const { data: table, error } = await supabase.from('lead_tables')
    .insert({ name, description: 'Storefront catalog (managed)', source: CATALOG_SOURCE, tenant_id: tenantId, user_id: userId })
    .select().single()
  if (error || !table) throw new Error(`create table "${name}" failed: ${error?.message || 'no row'}`)
  const colRows = cols.map((c, i) => ({
    table_id: table.id, tenant_id: tenantId, user_id: userId,
    name: c.name, key: c.key, type: c.type || 'text', options: c.options || [],
    is_required: !!c.is_required, is_primary: !!c.is_primary || i === 0, position: i,
  }))
  const { error: colErr } = await supabase.from('lead_columns').insert(colRows)
  if (colErr) { await supabase.from('lead_tables').delete().eq('id', table.id); throw new Error(`columns for "${name}" failed: ${colErr.message}`) }
  return table.id
}

export async function provisionCatalog(supabase: SupabaseClient, tenantId: string, userId: string, slug: string): Promise<{ created: boolean; config: CatalogConfig; counts: { categories: number; items: number } }> {
  // Idempotent: if already provisioned, just re-materialize.
  const existing = await getCatalogConfig(slug)
  if (existing) {
    const counts = await materializeCatalog(supabase, tenantId, slug)
    return { created: false, config: existing, counts: counts || { categories: 0, items: 0 } }
  }
  // Snapshot the current (file-store) menu to seed the tables.
  const menu = await sf('GET', '/admin/menu', slug) as { categories: any[]; items: any[] }
  const categoriesTableId = await createTable(supabase, tenantId, userId, 'Menu Categories', CATEGORY_COLS)
  const itemsTableId = await createTable(supabase, tenantId, userId, 'Menu Items', ITEM_COLS)

  // Backfill categories (preserve order via insert order).
  const catNameById = new Map<string, string>()
  for (const c of (menu.categories || [])) {
    const { data } = await supabase.from('lead_rows')
      .insert({ table_id: categoriesTableId, tenant_id: tenantId, user_id: userId, data: { name: String(c.name || '') }, status: 'active' })
      .select('id').single()
    if (data) catNameById.set(c.id, String(c.name || ''))
  }
  // Backfill items. Cells are strings (Tables convention); add-ons → JSON string.
  const itemRows = (menu.items || []).map((it: any) => ({
    table_id: itemsTableId, tenant_id: tenantId, user_id: userId, status: 'active',
    data: {
      name: String(it.name || ''),
      description: String(it.description || ''),
      price: String(it.priceInr ?? 0),
      coins: String(it.coins ?? 0),
      veg: String(!!it.veg),
      sold_out: String(!!it.soldOut),
      image_url: String(it.imageUrl || ''),
      category: catNameById.get(it.categoryId) || '',
      addons: JSON.stringify(it.options || []),
    },
  }))
  if (itemRows.length) {
    const { error } = await supabase.from('lead_rows').insert(itemRows)
    if (error) throw new Error(`backfill items failed: ${error.message}`)
  }

  const config: CatalogConfig = { version: 1, categoriesTableId, itemsTableId, map: HORECA_MAP }
  // Persist the mapping + flip the serving flag, then materialize the snapshot.
  await sf('PATCH', '/admin/config', slug, { catalogConfig: config, catalogSource: 'tables' })
  const counts = await materializeCatalog(supabase, tenantId, slug)
  return { created: true, config, counts: counts || { categories: 0, items: 0 } }
}
