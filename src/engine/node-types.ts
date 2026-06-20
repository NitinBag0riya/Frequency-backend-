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
  'send_flow',
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
  // Recurring/cron start (daily digest, weekly report, interval reminder).
  // No always-on worker: parks one scheduled_jobs row per occurrence on the
  // existing poller, self-rescheduling. See engine/schedule-trigger.ts.
  'trigger_schedule',
  // A tenant CUSTOMER payment event (Razorpay / Cashfree) — paid / failed /
  // refunded. Per-tenant signature-verified webhook, no poller. Powers
  // payment-confirmation, failed-payment recovery, refund acknowledgement.
  // See routes/payment-webhook.ts.
  'trigger_payment',
  // A WhatsApp Flow (interactive form) was SUBMITTED by a contact. Fired from
  // the inbound webhook's nfm_reply handling. If a workflow session is already
  // waiting (it sent the flow via send_flow), the submission RESUMES it instead;
  // this trigger STARTS a workflow for flows submitted with no session waiting.
  // See routeFlowSubmission in engine/inbound-router.ts.
  'trigger_flow_response',
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

/**
 * One-line description per node type — the builder's grounding. EVERY core +
 * trigger node MUST have an entry here; the manifest drift check fails the build
 * otherwise, so the workflow builder can never be unaware of a power the engine
 * has. Connector-op nodes are summarised generically (their config lives in the
 * picker catalog / connector registry).
 */
export const NODE_DESCRIPTIONS: Record<string, string> = {
  // ── Triggers ──
  trigger_inbound_keyword: 'Start when an inbound WhatsApp/Instagram/Telegram message matches a keyword or phrase (e.g. STOP, "brochure").',
  trigger_new_lead:        'Start when a single new lead arrives — a lead-table row created OR a webhook intake (99acres, FB/IG lead ads, JustDial…). Not on bulk/CSV import.',
  trigger_new_order:       'Start on a new commerce order (storefront / Zomato / Shopify / WooCommerce).',
  trigger_order_status:    'Start when an order\'s status changes (e.g. paid, shipped).',
  trigger_crm_stage:       'Start when a lead/deal status changes in a Leads table (config: table_id, to_status — e.g. to_status="Visit Completed" → post-visit flow). This is how "visit done / qualified / closed" events start a workflow.',
  trigger_missed_call:     'Start when a call is missed (Exotel / Meta calling) — powers callback flows.',
  trigger_message_status:  'Start when an outbound WhatsApp message FAILS delivery — powers SMS fallback / ops alerts.',
  trigger_schedule:        'Recurring/cron start — daily/weekly at a time, or every N minutes. Either a 1:1 reminder (set contact_id) OR fan out to an audience (set segment_id or audience.tags → one run per matching contact). Powers digests, reminders, stale-lead scans, scheduled broadcasts.',
  trigger_payment:         'Start on a tenant CUSTOMER payment event (Razorpay/Cashfree): paid / failed / refunded.',
  trigger_flow_response:   'Start when a contact SUBMITS a WhatsApp Flow / interactive form (config: flow_id to scope to one flow). Submitted fields are in {{trigger.*}}. If a workflow already sent the flow and is waiting, the submission resumes that flow instead.',
  // ── Core actions ──
  send_text:               'Send a free-form WhatsApp text (only valid inside the 24h window; outside it use send_template).',
  send_template:           'Send an approved WhatsApp template (required outside the 24h window). Supports buttons defined on the template.',
  send_interactive:        'Send quick-reply buttons (≤3) or a list picker — the in-session way to offer choices (BHK, budget, actions).',
  send_media:              'Send a media message — PDF brochure, video, or image (by URL).',
  collect_input:           'Ask the contact for a value and capture their reply into a variable.',
  wait_delay:              'Pause the flow for a duration or until a date/time, then resume (powers drip sequences + scheduled reminders).',
  condition_reply:         'Branch on the contact\'s free-text reply.',
  condition_button_click:  'Branch on which quick-reply button the contact tapped.',
  condition_variable:      'Branch on a stored variable (e.g. BHK × budget → pick the right brochure; status == Healthy).',
  add_tag:                 'Add a tag to the contact.',
  assign_agent:            'Assign the conversation/lead to a human agent (round-robin or specific).',
  http_request:            'Call an arbitrary external HTTP API (GET/POST…) — escape hatch for anything without a dedicated connector.',
  update_crm:              'Update a CRM/lead record — set stage, status, fields (e.g. mark Unsubscribed/Closed).',
  update_sheet:            'Write/update a row in a connected sheet or lead table.',
  create_calendar_event:   'Create a Google Calendar event (visit, callback, meeting) with attendees + reminders.',
  check_calendar_availability: 'Check free/busy on a calendar before offering slots.',
  run_ai_responder:        'Hand the turn to the AI responder (knowledge-grounded) to answer free-form questions.',
  send_flow:               'Send a WhatsApp Flow (interactive form, config: flow_id + cta text) and PAUSE until the contact submits it — their answers resume the workflow (read via {{trigger.*}} / the reply). The in-chat way to collect structured multi-field input.',
  send_email:              'Send an email (SendGrid/Mailgun/SES/SMTP).',
  forward_email:           'Forward a received email, preserving the original sender.',
  payment:                 'Create + send a payment link (Razorpay/Cashfree/PayU) and wait for payment.',
  notify_human:            'Notify a human/team (in-app + push) — e.g. an exec alert.',
  followup:                'Schedule a follow-up message after a delay if no reply.',
  start_workflow:          'Start/chain another workflow (e.g. T1 → T2 → T3). Cycle-checked.',
  end_flow:                'End the current workflow session.',
  connector_call:          'Run any connected app\'s operation generically (see the connector operations + App Capabilities below).',
}

/**
 * The builder's node vocabulary, generated from the arrays above — the SINGLE
 * SOURCE OF TRUTH. Inject this into the parser prompt instead of a hand-written
 * list so a node/trigger added to node-types.ts is AUTOMATICALLY known to the
 * builder (no stale, no "valid in draft / breaks live").
 */
export function composeNodeCatalogPromptSection(): string {
  const line = (t: string) => `  ${t} — ${NODE_DESCRIPTIONS[t] ?? '(no description — add one to NODE_DESCRIPTIONS)'}`
  return [
    'NODE TYPES — the EXACT, CURRENT vocabulary (auto-generated from the engine; use these strings ONLY, never invent or copy n8n/Zapier node names):',
    '',
    'Triggers (what STARTS a workflow — every workflow begins with exactly one):',
    TRIGGER_NODE_TYPES.map(line).join('\n'),
    '',
    'Actions & logic (core engine):',
    CORE_NODE_TYPES.map(line).join('\n'),
    '',
    `Connector operations (sugar over connector_call — pick the matching app + operation; full config in the App Capabilities section below):`,
    `  ${CONNECTOR_OP_NODE_TYPES.join(', ')}`,
  ].join('\n')
}
