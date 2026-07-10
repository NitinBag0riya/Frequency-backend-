/**
 * DynoAPIs adapter — the interim source.
 *
 * DynoAPIs is a desktop client the *merchant* installs on their own Windows
 * machine. It logs into the merchant's own Zomato/Swiggy dashboard and does all
 * the aggregator talking there — our servers never call Zomato/Swiggy. The
 * integration with us is a PULL model over the webhook the merchant's machine
 * points at (see routes/connectors/aggregator.ts):
 *
 *   • New/updated orders  → DynoAPIs POSTs them to us      → we upsert
 *   • Operator decisions  → we QUEUE them on the order row → DynoAPIs polls
 *       GET {base}/{resId}/orders/status, executes on the aggregator, then
 *       POSTs the result back to {base}/orders/{orderId}/status
 *   • Stock toggles       → we QUEUE a row                 → DynoAPIs polls
 *       GET {base}/{resId}/items, executes, POSTs {resId}/items/status back
 *
 * So both write methods here just enqueue — nothing leaves our infra. That is
 * the whole point: the aggregator access stays on the merchant's machine.
 */

import { SupabaseClient } from '@supabase/supabase-js'
import {
  AggregatorAdapter, AdapterCapabilities, AdapterContext, OrderDecision, StockToggle, AggregatorChannel,
} from './types'

export class DynoApisAdapter implements AggregatorAdapter {
  readonly source = 'dynoapis' as const
  constructor(private supabase: SupabaseClient) {}

  capabilities(): AdapterCapabilities {
    // DynoAPIs rides the merchant dashboard's *order-ops* surface only. It can
    // take orders and flip items on/off, but it cannot build or edit a menu —
    // those live behind a heavier surface it doesn't cover. The FE greys out
    // menu editing accordingly until the tenant moves to a direct/middleware
    // source that reports these true.
    return {
      orders:      true,
      orderStatus: true,
      stock:       true,
      menuRead:    true,
      menuEdit:    false,
      categories:  false,
      variants:    false,
      offers:      false,
    }
  }

  async submitOrderDecision(
    ctx: AdapterContext,
    order: { externalOrderId: string; channel: AggregatorChannel; outletRef: string | null },
    decision: OrderDecision,
  ): Promise<{ queued: boolean; executed: boolean }> {
    // Queue the decision on the order row; DynoAPIs pulls it on its next poll.
    const { error } = await this.supabase.from('aggregator_orders')
      .update({
        pending_action:    decision.kind,
        pending_prep_time: decision.kind === 'accept' ? (decision.prepTime ?? 30) : null,
        pending_reason:    decision.kind === 'reject' ? (decision.reason ?? null) : null,
        pending_queued_at: new Date().toISOString(),
        updated_at:        new Date().toISOString(),
      })
      .eq('tenant_id', ctx.tenantId)
      .eq('channel', order.channel)
      .eq('external_order_id', order.externalOrderId)
    if (error) throw Object.assign(new Error('Failed to queue order decision: ' + error.message), { status: 500 })
    return { queued: true, executed: false }
  }

  async submitStockToggle(ctx: AdapterContext, toggle: StockToggle): Promise<{ queued: boolean; executed: boolean }> {
    const { error } = await this.supabase.from('aggregator_stock_actions').insert({
      tenant_id:   ctx.tenantId,
      source:      this.source,
      channel:     toggle.channel,
      outlet_ref:  toggle.outletRef,
      entity_type: toggle.entityType,
      entity_id:   toggle.entityId,
      in_stock:    toggle.inStock,
      status:      'pending',
    })
    if (error) throw Object.assign(new Error('Failed to queue stock toggle: ' + error.message), { status: 500 })
    return { queued: true, executed: false }
  }
}
