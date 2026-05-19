/**
 * Shopify workflow trigger fan-out (P1 #11).
 *
 * Mirrors src/engine/inbound-router.ts:fireIgEventTrigger but for the six
 * Shopify event triggers + the abandoned-cart poller's trigger:
 *
 *   shopify_order_created
 *   shopify_order_paid
 *   shopify_order_cancelled
 *   shopify_order_fulfilled
 *   shopify_cod_order
 *   shopify_abandoned_cart
 *
 * For each LIVE workflow whose node graph contains a node of the matching
 * trigger type, we insert a workflow_sessions row stamped with channel='whatsapp'
 * (the dominant outbound channel for Shopify automations — the workflow
 * itself can override this on per-node send actions) and enqueue execution
 * of the first non-trigger node, passing the Shopify payload as `variables.trigger`.
 *
 * Channel choice rationale: Shopify is not itself a messaging channel; the
 * workflow author picks the OUT channel via their node selection (e.g.
 * "Send WhatsApp template" vs "Send Telegram message"). Setting
 * channel='whatsapp' on the session is a reasonable default for the
 * resume-on-reply path; subsequent send nodes can route however they want.
 *
 * Multiple workflows can subscribe to the same trigger — all matches fire
 * (no first-match-wins; parity with IG event triggers).
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { enqueueWorkflowExecution } from '../queue'

export type ShopifyTriggerType =
  | 'shopify_order_created'
  | 'shopify_order_paid'
  | 'shopify_order_cancelled'
  | 'shopify_order_fulfilled'
  | 'shopify_cod_order'
  | 'shopify_abandoned_cart'

export interface ShopifyTriggerPayload {
  /** Best-effort contact identifier (digit-only phone if available, else
   *  email, else 'shopify:<order_id>'). Used as workflow_sessions.contact_phone
   *  to keep the row anchored to a target. */
  contactId: string
  contactPhone?: string | null
  contactEmail?: string | null
  /** Free-form key/value bag that becomes variables.trigger.* in the workflow. */
  [key: string]: any
}

export async function fireShopifyTrigger(
  supabase: SupabaseClient,
  tenantId: string,
  triggerType: ShopifyTriggerType,
  payload: ShopifyTriggerPayload,
): Promise<{ matched: number }> {
  const { data: workflows } = await supabase.from('workflows')
    .select('id, nodes')
    .eq('tenant_id', tenantId)
    .eq('status', 'live')

  let matched = 0
  for (const wf of workflows ?? []) {
    const nodes: any[] = ((wf as any).nodes ?? []) as any[]
    const trigger = nodes.find((n: any) => n?.type === triggerType)
    if (!trigger) continue

    // Skip trigger nodes — they're entry markers, not executable actions.
    const firstAction = nodes.find((n: any) => !String(n?.type ?? '').startsWith('shopify_') && !String(n?.type ?? '').startsWith('trigger_'))
    if (!firstAction) continue

    const { data: session, error } = await supabase.from('workflow_sessions').insert({
      tenant_id:       tenantId,
      workflow_id:     wf.id,
      contact_phone:   payload.contactId,
      channel:         'whatsapp',
      current_node_id: firstAction.id,
      variables:       { trigger: payload },
      status:          'active',
    }).select('id').single()
    if (error || !session) {
      console.warn(`[shopify-trigger] start workflow ${wf.id} failed: ${error?.message ?? 'no row'}`)
      continue
    }
    await enqueueWorkflowExecution({ sessionId: session.id, nodeId: firstAction.id })
    matched++
  }

  return { matched }
}
