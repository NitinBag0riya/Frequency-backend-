/**
 * Source-agnostic food-aggregator (Zomato / Swiggy) integration layer.
 *
 * The FE and BE only ever speak this normalised vocabulary. HOW an order
 * decision actually reaches Zomato/Swiggy is the job of an `AggregatorAdapter`,
 * of which there can be several — swapping one for another is a one-line change
 * in `resolveAdapter()` and never touches the routes or the FE:
 *
 *   frequency_desktop — our own Frequency Desktop app runs on the merchant's
 *                   machine WITH the merchant logged into Frequency. It rides the
 *                   merchant's own Zomato/Swiggy dashboard login, relays captured
 *                   orders using that authenticated Frequency session, and pulls
 *                   the decisions we queue. Our servers never call the
 *                   aggregators.  ← first implementation
 *   urbanpiper    — a licensed middleware partner's API                 (future)
 *   zomato_direct / swiggy_direct — the official partner APIs, once approved
 *                   past the store-count / volume gate                  (future)
 *
 * Capability-gated: each adapter declares what it can actually do. The desktop
 * source can take orders and toggle stock but cannot edit a menu, so `menuEdit`
 * is false — the FE greys out menu editing until the tenant is on a source that
 * supports it.
 */

export type AggregatorSource =
  | 'frequency_desktop'
  | 'urbanpiper'
  | 'zomato_direct'
  | 'swiggy_direct'

export type AggregatorChannel = 'zomato' | 'swiggy'

/** Normalised order lifecycle shared across all sources. */
export type OrderStatus =
  | 'new'
  | 'preparing'
  | 'ready'
  | 'picked_up'
  | 'delivered'
  | 'rejected'
  | 'cancelled'

/** What the operator can ask us to do to an order. */
export type OrderDecisionKind = 'accept' | 'ready' | 'reject'

export interface OrderDecision {
  kind: OrderDecisionKind
  prepTime?: number   // minutes, for `accept`
  reason?: string     // for `reject`
}

export interface StockToggle {
  channel: AggregatorChannel
  outletRef: string
  entityType: 'item' | 'category'
  entityId: string
  inStock: boolean
}

/**
 * What a source can actually do. The FE reads this to enable/disable UI, so it
 * is the single source of truth for "is menu editing available yet?".
 */
export interface AdapterCapabilities {
  orders: boolean          // receive live orders
  orderStatus: boolean     // accept / ready / reject
  stock: boolean           // item + category in/out of stock
  menuRead: boolean        // read the menu / item list
  menuEdit: boolean        // create/edit items, descriptions, prices, images
  categories: boolean      // create/edit category structure
  variants: boolean        // add-ons / modifiers / variants
  offers: boolean          // promotions / ads
  // Per-channel "make item/category live/visible" — a stock-visibility write.
  // 'live' = we can apply it now (Swiggy setStock); 'gated' = blocked on
  // Zomato write path not yet mapped. The FE reads this to render "publish" vs
  // "pending partner" per channel instead of hardcoding it.
  publish: Record<AggregatorChannel, 'live' | 'gated'>
}

/** Everything an adapter needs to act for one tenant. */
export interface AdapterContext {
  tenantId: string
  source: AggregatorSource
}

/**
 * The contract every source implements. `frequency_desktop` fulfils order/stock
 * via a PULL model (queue rows the merchant's machine polls); a future
 * `urbanpiper` or `*_direct` adapter fulfils the same methods with an outbound HTTP call.
 * Either way the routes and FE are identical.
 */
export interface AggregatorAdapter {
  readonly source: AggregatorSource
  capabilities(): AdapterCapabilities

  /**
   * Advance an order (accept/ready/reject). Returns whether the decision was
   * `queued` for the source to pick up (pull model) and/or `executed` inline
   * (push model). Throws with `{status}` on a hard failure.
   */
  submitOrderDecision(
    ctx: AdapterContext,
    order: { externalOrderId: string; channel: AggregatorChannel; outletRef: string | null },
    decision: OrderDecision,
  ): Promise<{ queued: boolean; executed: boolean }>

  /** Toggle an item/category in or out of stock. */
  submitStockToggle(ctx: AdapterContext, toggle: StockToggle): Promise<{ queued: boolean; executed: boolean }>
}

/** Map a raw source status string onto our normalised lifecycle. */
export function normalizeStatus(raw: string | null | undefined): OrderStatus {
  const s = String(raw ?? '').toUpperCase()
  if (!s) return 'new'
  // New/awaiting-acceptance — Zomato says NEW; Swiggy variants say PLACED/PENDING/
  // RECEIVED/CREATED. Catch them all so a fresh order surfaces (accept prompt + ring)
  // instead of silently falling through to 'preparing'.
  if (s.includes('NEW') || s.includes('PLACE') || s.includes('PEND') || s.includes('RECEIV') || s.includes('CREAT')) return 'new'
  if (s.includes('READY')) return 'ready'
  if (s.includes('PICK')) return 'picked_up'
  if (s.includes('DELIVER')) return 'delivered'
  if (s.includes('REJECT')) return 'rejected'
  if (s.includes('CANCEL')) return 'cancelled'
  if (s.includes('PREP')) return 'preparing'
  return 'preparing'
}
