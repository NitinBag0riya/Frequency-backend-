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
  ordersTableId?: string
  cartsTableId?: string
  customersTableId?: string
  outletsTableId?: string
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
  { name: 'Category', key: 'category', type: 'lookup' }, // → Categories table (options set at provision)
  { name: 'Add-ons (JSON)', key: 'addons', type: 'textarea' },
]
// The Category column is a LOOKUP into the Categories table — a validated picker
// (the Tables feature's relationship primitive), not freetext. options = [tableId,
// columnKey] per the lead_columns lookup contract. Stores the category name value,
// so composeMenu's name-grouping is unchanged + back-compatible.
function buildItemCols(categoriesTableId: string) {
  return ITEM_COLS.map(c => c.key === 'category' ? { ...c, type: 'lookup', options: [categoriesTableId, 'name'] } : c)
}
// Orders table — a mirror of the live orders (storefront-api stays authoritative
// for the customer flow; this gives the operator a queryable/automatable copy and
// lets order rows drive workflows). Fixed column keys (both sides controlled).
const ORDER_COLS = [
  { name: 'Order', key: 'order_id', type: 'text', is_primary: true, is_required: true },
  { name: 'Status', key: 'status', type: 'select', options: ['placed', 'accepted', 'preparing', 'ready', 'served', 'cancelled'] },
  { name: 'Mode', key: 'mode', type: 'text' },
  { name: 'Table', key: 'table', type: 'number' },
  { name: 'Items', key: 'items', type: 'textarea' },
  { name: 'Line items (JSON)', key: 'items_json', type: 'textarea' },
  { name: 'Total', key: 'total', type: 'number' },
  { name: 'Coins', key: 'coins', type: 'number' },
  { name: 'Customer', key: 'guest_id', type: 'text' },     // stable customer ref (guestKey)
  { name: 'Outlet', key: 'outlet_id', type: 'text' },      // stable outlet ref
  { name: 'Guest', key: 'guest_name', type: 'text' },
  { name: 'Phone', key: 'guest_phone', type: 'phone' },
  { name: 'Paid', key: 'paid', type: 'boolean' },
  { name: 'Placed at', key: 'placed_at', type: 'text' },
]
// Carts table — captured in-progress carts (abandoned-cart). status: open (live)
// | converted (became an order) | abandoned (went stale, set by a workflow/cron).
const CART_COLS = [
  { name: 'Guest key', key: 'cart_id', type: 'text', is_primary: true, is_required: true },
  { name: 'Guest', key: 'guest_name', type: 'text' },
  { name: 'Phone', key: 'guest_phone', type: 'phone' },
  { name: 'Items', key: 'items', type: 'textarea' },
  { name: 'Line items (JSON)', key: 'items_json', type: 'textarea' },
  { name: 'Total', key: 'total', type: 'number' },
  { name: 'Status', key: 'status', type: 'select', options: ['open', 'converted', 'abandoned'] },
  { name: 'Updated at', key: 'updated_at', type: 'text' },
]
// Customers table — mirror of signed-in guests (CRM-grade, queryable, automatable).
const CUSTOMER_COLS = [
  { name: 'Customer key', key: 'customer_id', type: 'text', is_primary: true, is_required: true },
  { name: 'Name', key: 'name', type: 'text' },
  { name: 'Phone', key: 'phone', type: 'phone' },
  { name: 'Email', key: 'email', type: 'email' },
  { name: 'Coins', key: 'coins', type: 'number' },
  { name: 'Tier', key: 'tier', type: 'text' },
  { name: 'WhatsApp opt-in', key: 'whatsapp_optin', type: 'boolean' },
  { name: 'Joined', key: 'created_at', type: 'text' },
]
// Outlets/Locations table — mirror of the operator's outlets.
const OUTLET_COLS = [
  { name: 'Outlet ID', key: 'outlet_id', type: 'text', is_primary: true, is_required: true },
  { name: 'Name', key: 'name', type: 'text' },
  { name: 'Address', key: 'address', type: 'text' },
  { name: 'Phone', key: 'phone', type: 'phone' },
  { name: 'Hours', key: 'hours', type: 'text' },
  { name: 'Open', key: 'open', type: 'boolean' },
  { name: 'Tables', key: 'table_count', type: 'number' },
  { name: 'Services (JSON)', key: 'services', type: 'textarea' },
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
  const byId = new Set(categories.map(c => c.id))
  const fallback = categories[0]?.id
  const im = m.item
  const items = (itemRows || []).map(r => {
    const d = r.data || {}
    // Resolve the category link by stable ROW ID first (the standard reference;
    // rename-proof), falling back to name (grid lookup-picker value / legacy rows).
    const ref = String(d[im.category] ?? '').trim()
    const categoryId = byId.has(ref) ? ref : (byName.get(ref.toLowerCase()) || fallback)
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

// ── orders mirror (storefront-api → Tables) ─────────────────────────────────────
// storefront-api stays the authoritative live-order store (fast customer flow);
// we mirror each order into the Orders table on create/pay/status-change so the
// operator gets a queryable/automatable copy. One-way; upserted by order_id.
function summarizeLines(lines: any): string {
  if (!Array.isArray(lines)) return ''
  return lines.map((l: any) => `${l.qty || 1}× ${l.name || 'item'}`).join(', ').slice(0, 300)
}
function orderToRow(o: any): Record<string, string> {
  const placedAt = o.createdAt
    ? (typeof o.createdAt === 'number' ? new Date(o.createdAt).toISOString() : String(o.createdAt))
    : ''
  return {
    order_id: String(o.id || ''),
    status: String(o.status || 'placed'),
    mode: String(o.mode || (o.table != null ? 'dinein' : 'pickup')),
    table: o.table != null && o.table !== '' ? String(o.table) : '',
    items: String(o.items != null ? o.items : summarizeLines(o.lines)),
    // Full structured cart/order lines (name, qty, price, options) — complete
    // capture, not just the human summary above.
    items_json: Array.isArray(o.lines) ? JSON.stringify(o.lines).slice(0, 6000) : '',
    total: String(Math.max(0, Math.round(Number(o.grand) || 0))),
    coins: String(Math.max(0, Math.round(Number(o.coinsEarned) || 0))),
    guest_id: String(o.guestKey || ''),
    outlet_id: String(o.outletId || ''),
    guest_name: String(o.guestName || ''),
    guest_phone: String(o.guestPhone || ''),
    paid: String(!!o.paid),
    placed_at: placedAt,
  }
}
export async function syncOrderRow(supabase: SupabaseClient, tenantId: string, slug: string, order: any): Promise<void> {
  const config = await getCatalogConfig(slug)
  if (!config?.ordersTableId || !order?.id) return
  const data = orderToRow(order)
  const { data: existing } = await supabase.from('lead_rows').select('id')
    .eq('tenant_id', tenantId).eq('table_id', config.ordersTableId).eq('data->>order_id', String(order.id)).maybeSingle()
  if (existing) await supabase.from('lead_rows').update({ data }).eq('id', (existing as any).id)
  else await supabase.from('lead_rows').insert({ table_id: config.ordersTableId, tenant_id: tenantId, user_id: null, data, status: 'active' })
}
async function backfillOrders(supabase: SupabaseClient, tenantId: string, userId: string | null, slug: string, ordersTableId: string): Promise<void> {
  let orders: any[] = []
  try { orders = await sf('GET', '/admin/orders', slug) } catch { return }
  if (!Array.isArray(orders) || !orders.length) return
  const rows = orders.slice(0, 2000).map(o => ({
    table_id: ordersTableId, tenant_id: tenantId, user_id: userId, status: 'active',
    data: orderToRow(o),
  }))
  await supabase.from('lead_rows').insert(rows)
}

// ── carts mirror (abandoned-cart capture) ───────────────────────────────────────
function cartToRow(c: any): Record<string, string> {
  const updatedAt = c.updatedAt ? (typeof c.updatedAt === 'number' ? new Date(c.updatedAt).toISOString() : String(c.updatedAt)) : ''
  return {
    cart_id: String(c.guestKey || ''),
    guest_name: String(c.guestName || ''),
    guest_phone: String(c.guestPhone || ''),
    items: summarizeLines(c.items),
    items_json: Array.isArray(c.items) ? JSON.stringify(c.items).slice(0, 6000) : '',
    total: String(Math.max(0, Math.round(Number(c.itemTotal) || 0))),
    status: ['open', 'converted', 'abandoned'].includes(c.status) ? c.status : 'open',
    updated_at: updatedAt,
  }
}
export async function syncCartRow(supabase: SupabaseClient, tenantId: string, slug: string, cart: any): Promise<void> {
  const config = await getCatalogConfig(slug)
  if (!config?.cartsTableId || !cart?.guestKey) return
  const data = cartToRow(cart)
  const { data: existing } = await supabase.from('lead_rows').select('id')
    .eq('tenant_id', tenantId).eq('table_id', config.cartsTableId).eq('data->>cart_id', String(cart.guestKey)).maybeSingle()
  if (existing) await supabase.from('lead_rows').update({ data }).eq('id', (existing as any).id)
  else await supabase.from('lead_rows').insert({ table_id: config.cartsTableId, tenant_id: tenantId, user_id: null, data, status: 'active' })
}

// ── customers mirror (signed-in guests → CRM-grade table) ───────────────────────
function customerToRow(g: any): Record<string, string> {
  const created = g.createdAt ? (typeof g.createdAt === 'number' ? new Date(g.createdAt).toISOString() : String(g.createdAt)) : ''
  return {
    customer_id: String(g.key || g.guestKey || ''),
    name: String(g.name || ''),
    phone: String(g.phone || ''),
    email: String(g.email || ''),
    coins: String(Math.max(0, Math.round(Number(g.coins) || 0))),
    tier: String(g.tier || ''),
    whatsapp_optin: String(!!g.whatsappOptin),
    created_at: created,
  }
}
export async function syncCustomerRow(supabase: SupabaseClient, tenantId: string, slug: string, guest: any): Promise<void> {
  const config = await getCatalogConfig(slug)
  const cid = guest && (guest.key || guest.guestKey)
  if (!config?.customersTableId || !cid) return
  const data = customerToRow(guest)
  const { data: existing } = await supabase.from('lead_rows').select('id')
    .eq('tenant_id', tenantId).eq('table_id', config.customersTableId).eq('data->>customer_id', String(cid)).maybeSingle()
  if (existing) await supabase.from('lead_rows').update({ data }).eq('id', (existing as any).id)
  else await supabase.from('lead_rows').insert({ table_id: config.customersTableId, tenant_id: tenantId, user_id: null, data, status: 'active' })
}
async function backfillCustomers(supabase: SupabaseClient, tenantId: string, userId: string | null, slug: string, customersTableId: string): Promise<void> {
  let guests: any[] = []
  try { guests = await sf('GET', '/admin/customers', slug) } catch { return }
  if (!Array.isArray(guests) || !guests.length) return
  const rows = guests.slice(0, 5000).map(g => ({ table_id: customersTableId, tenant_id: tenantId, user_id: userId, status: 'active', data: customerToRow(g) }))
  await supabase.from('lead_rows').insert(rows)
}

// ── outlets/locations mirror ────────────────────────────────────────────────────
function outletToRow(o: any): Record<string, string> {
  return {
    outlet_id: String(o.id || ''),
    name: String(o.name || ''),
    address: String(o.address || ''),
    phone: String(o.phone || ''),
    hours: String(o.hours || ''),
    open: String(o.open !== false),
    table_count: String(Math.max(0, Math.round(Number(o.tableCount) || 0))),
    services: o.services ? JSON.stringify(o.services) : '',
  }
}
export async function syncOutletRow(supabase: SupabaseClient, tenantId: string, slug: string, outlet: any): Promise<void> {
  const config = await getCatalogConfig(slug)
  if (!config?.outletsTableId || !outlet?.id) return
  const data = outletToRow(outlet)
  const { data: existing } = await supabase.from('lead_rows').select('id')
    .eq('tenant_id', tenantId).eq('table_id', config.outletsTableId).eq('data->>outlet_id', String(outlet.id)).maybeSingle()
  if (existing) await supabase.from('lead_rows').update({ data }).eq('id', (existing as any).id)
  else await supabase.from('lead_rows').insert({ table_id: config.outletsTableId, tenant_id: tenantId, user_id: null, data, status: 'active' })
}
async function backfillOutlets(supabase: SupabaseClient, tenantId: string, userId: string | null, slug: string, outletsTableId: string): Promise<void> {
  let outlets: any[] = []
  try { outlets = await sf('GET', '/admin/outlets', slug) } catch { return }
  if (!Array.isArray(outlets) || !outlets.length) return
  const rows = outlets.slice(0, 500).map(o => ({ table_id: outletsTableId, tenant_id: tenantId, user_id: userId, status: 'active', data: outletToRow(o) }))
  await supabase.from('lead_rows').insert(rows)
}

// ── operator edits via the rich menu editor (UI→Table), in tables-mode ──────────
// The dashboard's dish form writes through here so add-ons get the proper group
// editor (not raw JSON). Each write maps the dish onto the items-table row and
// re-materializes synchronously, so the editor sees fresh data immediately.
export interface CatalogDish {
  name: string; description?: string; priceInr?: number; coins?: number
  veg?: boolean; soldOut?: boolean; imageUrl?: string | null; categoryId?: string; options?: unknown
}
function dishToRowData(config: CatalogConfig, dish: CatalogDish): Record<string, string> {
  const im = config.map.item
  return {
    [im.name]: String(dish.name || ''),
    [im.description]: String(dish.description || ''),
    [im.price]: String(Math.max(0, Math.round(Number(dish.priceInr) || 0))),
    [im.coins]: String(Math.max(0, Math.round(Number(dish.coins) || 0))),
    [im.veg]: String(!!dish.veg),
    [im.soldOut]: String(!!dish.soldOut),
    [im.image]: String(dish.imageUrl || ''),
    [im.category]: String(dish.categoryId || ''), // stable category ROW ID (the relationship)
    [im.addons]: JSON.stringify(Array.isArray(dish.options) ? dish.options : []),
  }
}
async function categoryNameById(supabase: SupabaseClient, tenantId: string, config: CatalogConfig, categoryId?: string): Promise<string> {
  if (!categoryId) return ''
  const { data } = await supabase.from('lead_rows').select('data')
    .eq('tenant_id', tenantId).eq('table_id', config.categoriesTableId).eq('id', categoryId).maybeSingle()
  return data ? String((data as any).data?.[config.map.category.name] || '') : ''
}
async function configOrThrow(slug: string): Promise<CatalogConfig> {
  const c = await getCatalogConfig(slug)
  if (!c) throw new Error('This menu is not backed by Tables yet — provision it first.')
  return c
}

export async function catalogUpsertItem(supabase: SupabaseClient, tenantId: string, userId: string | null, slug: string, dish: CatalogDish, rowId?: string) {
  const config = await configOrThrow(slug)
  const data = dishToRowData(config, dish)
  if (rowId) {
    const { error } = await supabase.from('lead_rows').update({ data }).eq('id', rowId).eq('tenant_id', tenantId).eq('table_id', config.itemsTableId)
    if (error) throw new Error(error.message)
  } else {
    const { error } = await supabase.from('lead_rows').insert({ table_id: config.itemsTableId, tenant_id: tenantId, user_id: userId, data, status: 'active' })
    if (error) throw new Error(error.message)
  }
  await materializeCatalog(supabase, tenantId, slug)
}
export async function catalogDeleteItem(supabase: SupabaseClient, tenantId: string, slug: string, rowId: string) {
  const config = await configOrThrow(slug)
  const { error } = await supabase.from('lead_rows').delete().eq('id', rowId).eq('tenant_id', tenantId).eq('table_id', config.itemsTableId)
  if (error) throw new Error(error.message)
  await materializeCatalog(supabase, tenantId, slug)
}
export async function catalogAddCategory(supabase: SupabaseClient, tenantId: string, userId: string | null, slug: string, name: string) {
  const config = await configOrThrow(slug)
  const { error } = await supabase.from('lead_rows').insert({ table_id: config.categoriesTableId, tenant_id: tenantId, user_id: userId, data: { [config.map.category.name]: String(name || '') }, status: 'active' })
  if (error) throw new Error(error.message)
  await materializeCatalog(supabase, tenantId, slug)
}
export async function catalogDeleteCategory(supabase: SupabaseClient, tenantId: string, slug: string, rowId: string) {
  const config = await configOrThrow(slug)
  // Find the category's name, delete it, then delete items that referenced it —
  // by stable id (current) OR by name (legacy rows / grid picker value).
  const name = await categoryNameById(supabase, tenantId, config, rowId)
  const catCol = config.map.item.category
  await supabase.from('lead_rows').delete().eq('id', rowId).eq('tenant_id', tenantId).eq('table_id', config.categoriesTableId)
  await supabase.from('lead_rows').delete().eq('tenant_id', tenantId).eq('table_id', config.itemsTableId).eq(`data->>${catCol}`, rowId)
  if (name) await supabase.from('lead_rows').delete().eq('tenant_id', tenantId).eq('table_id', config.itemsTableId).eq(`data->>${catCol}`, name)
  await materializeCatalog(supabase, tenantId, slug)
}

// ── provision: create the tables, backfill from the current menu, wire config ────
// Find an existing catalog table for this tenant by name (oldest first). Used to
// ADOPT tables a prior (failed/raced) attempt created instead of duplicating them.
async function findCatalogTable(supabase: SupabaseClient, tenantId: string, name: string): Promise<string | null> {
  const { data } = await supabase.from('lead_tables').select('id')
    .eq('tenant_id', tenantId).eq('source', CATALOG_SOURCE).eq('name', name)
    .order('created_at', { ascending: true }).limit(1)
  return data && data[0] ? (data[0] as any).id : null
}
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

// Find an aux table by name, else create it (+ backfill only when newly created).
async function ensureAuxTable(
  supabase: SupabaseClient, tenantId: string, userId: string, name: string, cols: any[],
  backfill: ((id: string) => Promise<void>) | null,
): Promise<string> {
  const existing = await findCatalogTable(supabase, tenantId, name)
  if (existing) return existing
  const id = await createTable(supabase, tenantId, userId, name, cols)
  if (backfill) await backfill(id)
  return id
}

export async function provisionCatalog(supabase: SupabaseClient, tenantId: string, userId: string, slug: string): Promise<{ created: boolean; config: CatalogConfig; counts: { categories: number; items: number } }> {
  const existing = await getCatalogConfig(slug)
  let categoriesTableId: string
  let itemsTableId: string
  let created = false

  if (existing) {
    categoriesTableId = existing.categoriesTableId
    itemsTableId = existing.itemsTableId
  } else {
    // Adopt an existing menu set (orphans/race) if present; else create from the file menu.
    const adoptCat = await findCatalogTable(supabase, tenantId, 'Menu Categories')
    const adoptItem = await findCatalogTable(supabase, tenantId, 'Menu Items')
    if (adoptCat && adoptItem) {
      categoriesTableId = adoptCat
      itemsTableId = adoptItem
    } else {
      const menu = await sf('GET', '/admin/menu', slug) as { categories: any[]; items: any[] }
      categoriesTableId = await createTable(supabase, tenantId, userId, 'Menu Categories', CATEGORY_COLS)
      itemsTableId = await createTable(supabase, tenantId, userId, 'Menu Items', buildItemCols(categoriesTableId))
      // Map file category id → NEW row id so items link by STABLE id.
      const catRowIdByFileId = new Map<string, string>()
      for (const c of (menu.categories || [])) {
        const { data } = await supabase.from('lead_rows')
          .insert({ table_id: categoriesTableId, tenant_id: tenantId, user_id: userId, data: { name: String(c.name || '') }, status: 'active' })
          .select('id').single()
        if (data) catRowIdByFileId.set(c.id, (data as any).id)
      }
      const itemRows = (menu.items || []).map((it: any) => ({
        table_id: itemsTableId, tenant_id: tenantId, user_id: userId, status: 'active',
        data: {
          name: String(it.name || ''), description: String(it.description || ''),
          price: String(it.priceInr ?? 0), coins: String(it.coins ?? 0),
          veg: String(!!it.veg), sold_out: String(!!it.soldOut), image_url: String(it.imageUrl || ''),
          category: catRowIdByFileId.get(it.categoryId) || '', // stable category ROW id
          addons: JSON.stringify(it.options || []),
        },
      }))
      if (itemRows.length) {
        const { error } = await supabase.from('lead_rows').insert(itemRows)
        if (error) throw new Error(`backfill items failed: ${error.message}`)
      }
      created = true
    }
  }

  // Every aux entity is a first-class table: find-or-create, backfill when new.
  const ordersTableId = await ensureAuxTable(supabase, tenantId, userId, 'Orders', ORDER_COLS, id => backfillOrders(supabase, tenantId, userId, slug, id))
  const cartsTableId = await ensureAuxTable(supabase, tenantId, userId, 'Carts', CART_COLS, null)
  const customersTableId = await ensureAuxTable(supabase, tenantId, userId, 'Customers', CUSTOMER_COLS, id => backfillCustomers(supabase, tenantId, userId, slug, id))
  const outletsTableId = await ensureAuxTable(supabase, tenantId, userId, 'Outlets', OUTLET_COLS, id => backfillOutlets(supabase, tenantId, userId, slug, id))

  const config: CatalogConfig = {
    version: 1, categoriesTableId, itemsTableId,
    ordersTableId, cartsTableId, customersTableId, outletsTableId, map: HORECA_MAP,
  }
  await sf('PATCH', '/admin/config', slug, { catalogConfig: config, catalogSource: 'tables' })
  const counts = await materializeCatalog(supabase, tenantId, slug)
  return { created, config, counts: counts || { categories: 0, items: 0 } }
}
