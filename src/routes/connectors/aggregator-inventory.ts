// Pure helpers for depleting inventory from aggregator (Zomato/Swiggy) sales.
// Kept dependency-free so they can be unit-checked in isolation
// (see aggregator-inventory.selfcheck.ts). The route wires these to the storefront-api
// /admin/inventory/apply-external-sale + reverse-external-sale endpoints.

import type { AggregatorChannel } from '../../connectors/aggregator'

// Deplete once an order is ACCEPTED (preparing/ready/picked_up), reverse on cancel/
// reject, do nothing while still 'new'. Matches the first-party rule (deplete on
// confirmation) and the product decision "deplete on accept".
const DEPLETE = new Set(['preparing', 'ready', 'picked_up'])
const REVERSE = new Set(['cancelled', 'rejected'])

export type InventoryAction = 'deplete' | 'reverse' | 'none'
export function inventoryActionForStatus(status: string | null | undefined): InventoryAction {
  const s = String(status || '').toLowerCase()
  if (DEPLETE.has(s)) return 'deplete'
  if (REVERSE.has(s)) return 'reverse'
  return 'none'
}

// Namespaced so an aggregator order can never collide with a storefront order id.
export const externalOrderKey = (channel: AggregatorChannel, externalId: string): string =>
  `agg:${channel}:${externalId}`

// Per-line { name, qty } for depletion. Reuses the SAME item-array resolution as
// extractSummary (so it tracks every payload shape the summary/board already handle),
// then pulls a name across the known field spellings. Best-effort: unnamed / zero-qty
// lines are dropped (they'd just be reported unmatched downstream anyway).
export function extractOrderLines(data: any): { name: string; qty: number; srcId?: string }[] {
  const o = data?.order ?? data?.orderDetails ?? data?.order_details ?? data ?? {}
  const items: any[] = Array.isArray(o.cartDetails?.items?.dishes) ? o.cartDetails.items.dishes
    : Array.isArray(o.lines) ? o.lines
    : Array.isArray(o.items) ? o.items
    : Array.isArray(o.order_items) ? o.order_items
    : Array.isArray(o.cart_items) ? o.cart_items
    : Array.isArray(o.line_items) ? o.line_items
    : Array.isArray(o.orderItems) ? o.orderItems : []
  const out: { name: string; qty: number; srcId?: string }[] = []
  for (const it of items) {
    const name = String(it?.name ?? it?.item_name ?? it?.itemName ?? it?.dish_name ?? it?.dishName ?? it?.title ?? '').trim()
    const qty = Number(it?.quantity ?? it?.qty ?? it?.count ?? 1) || 0
    if (!name || qty <= 0) continue
    // The aggregator's own item id, when the payload carries one — lets depletion bind a
    // line to a dish by its stored channel srcId (menu-import records it), which survives a
    // dashboard rename that would break name matching. Omitted when absent (name still works).
    const rawId = it?.id ?? it?.item_id ?? it?.itemId ?? it?.dish_id ?? it?.dishId ?? it?.catalogue_id ?? it?.catalogueId ?? it?.menu_item_id ?? it?.menuItemId
    const line: { name: string; qty: number; srcId?: string } = { name: name.slice(0, 120), qty }
    if (rawId != null && String(rawId).trim()) line.srcId = String(rawId).trim().slice(0, 120)
    out.push(line)
  }
  return out
}
