/**
 * Frequency Desktop adapter — the interim source.
 *
 * Frequency Desktop is our own app the *merchant* installs on their machine, and
 * it runs the Frequency web app with the merchant logged in. It logs into the
 * merchant's own Zomato/Swiggy dashboard and does all the aggregator talking
 * there — our servers never call Zomato/Swiggy. The integration with us is a
 * PULL model, but authenticated by the logged-in Frequency session (NO token):
 * the app relays through its own web view (see routes/connectors/aggregator.ts):
 *
 *   • New/updated orders  → relayed to POST /orders/ingest → we upsert
 *   • Operator decisions  → we QUEUE them on the order row → the app polls
 *       GET /pending-actions, executes on the aggregator, then POSTs the result
 *       back to /actions/result
 *   • Stock toggles       → we QUEUE a row                 → same pull/result path
 *
 * So both write methods here just enqueue — nothing leaves our infra. That is
 * the whole point: the aggregator access stays on the merchant's machine.
 */

import { SupabaseClient } from '@supabase/supabase-js'
import {
  AggregatorAdapter, AdapterCapabilities, AdapterContext, OrderDecision, StockToggle, AggregatorChannel,
} from './types'

export class FrequencyDesktopAdapter implements AggregatorAdapter {
  readonly source = 'frequency_desktop' as const
  constructor(private supabase: SupabaseClient) {}

  capabilities(): AdapterCapabilities {
    // The desktop source rides the merchant dashboard's *order-ops* surface + the
    // Menu Editor's Submit Changes flow (mapped live 2026-08-28). It can take orders,
    // flip items on/off (Swiggy), AND submit item edits (both channels — Swiggy via
    // vhc-composer QC, Zomato via update_content_menu — see aggregatorClient.editItem).
    return {
      orders:      true,
      orderStatus: true,
      stock:       true,
      menuRead:    true,
      menuEdit:    true,     // both channels — Swiggy queuedToQc, Zomato instant
      categories:  false,
      variants:    false,
      offers:      false,
      // Publishing = flipping an item/category visible via the STOCK endpoint.
      // Swiggy stock-status is live (setStock), Zomato stock is still gated because
      // its setStock endpoint hasn't been captured yet — Zomato uses a different
      // path than editItem. Flip zomato to 'live' when the Zomato item-stock
      // toggle POST is captured and setStock's zomato branch is wired.
      publish:     { swiggy: 'live', zomato: 'gated' },
    }
  }

  async submitOrderDecision(
    ctx: AdapterContext,
    order: { externalOrderId: string; channel: AggregatorChannel; outletRef: string | null },
    decision: OrderDecision,
  ): Promise<{ queued: boolean; executed: boolean }> {
    // Queue the decision on the order row; the desktop app pulls it on its next poll.
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
