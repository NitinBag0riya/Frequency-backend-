/**
 * Canonical node-type registry — the SINGLE SOURCE OF TRUTH for what the
 * executor can actually run.
 *
 * Transcribed 1:1 from the `case` labels in engine/executor.ts. Everything that
 * needs to know "which node types exist" — the LLM parser's allowed-list, the
 * workflow validator, and the capability manifest (the LLM grounding cache) —
 * should import from here instead of re-listing nodes. That kills the class of
 * bug where the AI emits a node the engine can't execute (valid-in-draft,
 * breaks-live).
 *
 * NOTE: keep this in lockstep with the executor switch. The capability-manifest
 * drift check flags any registry capability whose `workflowNodeType` is missing
 * from this set, so divergence surfaces in CI / the manifest report rather than
 * at runtime.
 */

/** Core engine nodes (messaging, control flow, CRM/sheets, calendar, etc.). */
export const CORE_NODE_TYPES = [
  'send_text', 'send_template', 'send_interactive', 'send_media', 'collect_input',
  'wait_delay',
  'condition_reply', 'condition_button_click', 'condition_variable',
  'add_tag', 'assign_agent',
  'http_request', 'update_crm', 'update_sheet',
  'create_calendar_event', 'check_calendar_availability',
  'run_ai_responder',
  'send_email', 'forward_email',
  'payment', 'notify_human', 'followup',
  'start_workflow', 'end_flow',
  'connector_call',
] as const

/** Per-connector operation aliases — sugar that routes through connector_call. */
export const CONNECTOR_OP_NODE_TYPES = [
  'airtable_list_records', 'airtable_create_record', 'airtable_update_record',
  'shopify_list_orders', 'shopify_get_order', 'shopify_list_products', 'shopify_create_draft_order',
  'razorpay_list_payments', 'razorpay_get_payment', 'razorpay_refund_payment', 'razorpay_list_subscriptions', 'razorpay_create_payment_link',
  'woocommerce_list_orders', 'woocommerce_get_order', 'woocommerce_list_products', 'woocommerce_create_order',
  'brevo_create_contact', 'brevo_send_email', 'brevo_send_sms',
  'msg91_send_sms', 'msg91_send_otp', 'msg91_verify_otp',
  'shiprocket_list_orders', 'shiprocket_create_order', 'shiprocket_track_awb', 'shiprocket_check_serviceability',
  'cashfree_create_order', 'cashfree_create_payment_link', 'cashfree_get_order', 'cashfree_create_refund',
  'gupshup_send_message', 'gupshup_send_template', 'gupshup_opt_in_user',
  'exotel_make_call', 'exotel_send_sms', 'exotel_get_call_details',
  'payu_generate_payment_hash', 'payu_verify_payment', 'payu_refund_payment',
  'leadsquared_create_or_update_lead', 'leadsquared_get_lead_by_email', 'leadsquared_post_activity',
  'kylas_create_lead', 'kylas_create_contact', 'kylas_create_deal', 'kylas_search_leads',
  'indiamart_fetch_leads', 'tradeindia_fetch_leads',
  'slack_send_message', 'gmail_send_email',
] as const

/** Trigger nodes — what can START a workflow. Thin today (see interconnect
 *  plan §2); new triggers (new_row, new_order, payment_event, …) get added here
 *  as their runtime hooks land. */
export const TRIGGER_NODE_TYPES = [
  'trigger_inbound_keyword',
  // Fires when a single new lead lands — webhook intake (JustDial, 99acres,
  // FB Lead Ads, …) or a row created in one of our Leads tables. Deliberately
  // does NOT fire on bulk/CSV import (would blast one workflow per row). See
  // fireNewLeadTrigger in engine/inbound-router.ts.
  'trigger_new_lead',
  // Commerce order events across channels (storefront / Zomato / Shopify / Woo).
  // See fireOrderTrigger in engine/inbound-router.ts.
  'trigger_new_order',
  'trigger_order_status',
  // A lead/deal changed pipeline status. Fired from the lead-row PATCH.
  'trigger_crm_stage',
  // A call was missed (Exotel/Meta call lifecycle). Powers callback flows.
  'trigger_missed_call',
  // An outbound WhatsApp message FAILED delivery. Powers failed-delivery
  // recovery (resend via SMS, alert ops). Gated to 'failed' to bound volume.
  'trigger_message_status',
] as const

export const NODE_TYPES = [
  ...CORE_NODE_TYPES,
  ...CONNECTOR_OP_NODE_TYPES,
  ...TRIGGER_NODE_TYPES,
] as const

export type NodeType = typeof NODE_TYPES[number]

export const NODE_TYPE_SET: ReadonlySet<string> = new Set(NODE_TYPES)

/** Is this a node type the executor can run? */
export function isKnownNodeType(t: string): boolean {
  return NODE_TYPE_SET.has(t)
}
