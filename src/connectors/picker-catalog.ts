/**
 * Picker catalog — the single source of truth for the workflow builder.
 *
 * Adding a new app to Frequency's workflow builder is a 10-line edit
 * to this file. The catalog drives THREE things automatically:
 *
 *   1. SYSTEM_PROMPT composition — /api/parse-workflow iterates this
 *      catalog at request time and emits the picker conventions Claude
 *      should follow when building a workflow blueprint.
 *
 *   2. /api/workflow-builder/picker-catalog endpoint — the FE reads
 *      the same structure to know which fields back live-data
 *      dropdowns and where to fetch the options.
 *
 *   3. SmartFieldPicker dispatch — when the FE sees a missing_config
 *      field whose name matches a catalog entry, it renders a
 *      DynamicLiveDataPicker driven by the catalog's apiPath +
 *      labelField + valueField metadata. No per-app picker component
 *      required (unless you want a richer UX, in which case the
 *      legacy app-specific pickers still win — see SmartFieldPicker).
 *
 * Design contract:
 *   - Each picker has a STABLE field-name convention. Claude emits
 *     this exact field name in missing_config[].field; the FE matches.
 *   - depends_on links a downstream picker to an upstream one by
 *     field name. The FE refreshes downstream options when the
 *     upstream value changes.
 *   - live_endpoint is a relative API path. Empty string ⇒ no live
 *     data (just a select with the static `options` array).
 *   - depends_on_query_param (when set) is the query parameter the
 *     dynamic picker appends to live_endpoint with the upstream
 *     field's value. So sheet_tab_name picker calls
 *     `/api/google/spreadsheets/{spreadsheet_id}` and the FE knows
 *     to substitute the upstream value into the URL.
 */

export type PickerType =
  | 'text' | 'textarea' | 'number' | 'email' | 'phone' | 'url' | 'date'
  | 'select'                  // static options[] (no live data)
  | 'live_select'             // hits live_endpoint for options
  | 'template_picker'         // WA approved templates (legacy live)
  | 'integration_picker'      // tenant's connected apps

export interface PickerDef {
  /** Canonical field name. Claude emits this exact string in missing_config[].field. */
  field: string
  /** UI label shown above the picker. */
  label: string
  /** Input shape. */
  type: PickerType
  /** Required to publish the workflow. Almost always true for catalog entries. */
  required: boolean
  /** Placeholder shown when value is empty. */
  placeholder: string
  /** Static option list (for `type: 'select'`). Live pickers ignore this. */
  options?: string[]
  /** API path for live dropdowns. Supports {field} substitution for upstream
   *  values: e.g. "/api/google/spreadsheets/{spreadsheet_id}" gets the
   *  upstream spreadsheet_id value spliced in at runtime. */
  live_endpoint?: string
  /** When live data comes from a parent resource (e.g. sheet→tab),
   *  the parent's field name. The FE re-fetches when this changes. */
  depends_on?: string
  /** For arrays of resources: which JSON property is the option label. */
  label_field?: string
  /** For arrays of resources: which JSON property is the option value. */
  value_field?: string
  /** Short hint for prompt examples — appears in COMMON INTENT PATTERNS. */
  example_intent?: string
  /** Trigger phrases — informs Claude when to emit this picker. */
  trigger_phrases?: string[]
}

export interface PickerCategory {
  /** Stable key — also used as URL segment in the workflow builder. */
  key: string
  /** Human-readable category name. */
  name: string
  /** One-line "why this category exists" for the prompt. */
  blurb: string
  /** Phrases in user intent that should fire pickers in this category. */
  trigger_phrases: string[]
  /** The pickers in this category. */
  pickers: PickerDef[]
  /** Optional: operation enum + per-operation-required pickers. When
   *  set, Claude emits the operation_* picker FIRST then only the
   *  per-op pickers below. The FE refreshes the dependent picker set
   *  when the operation changes. */
  operation_picker?: {
    field: string
    label: string
    placeholder: string
    operations: Array<{
      key: string                       // value of the operation_* picker
      label: string                     // human-readable operation name
      requires: string[]                // field names that become required for this op
    }>
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// CATALOG — one entry per category. Add a new connector by appending here.
// ═══════════════════════════════════════════════════════════════════════════

export const PICKER_CATALOG: PickerCategory[] = [

  // ────────────────────────────────────────────────────────────────────────
  // A. Frequency Tables (internal lead_tables)
  // ────────────────────────────────────────────────────────────────────────
  {
    key: 'tables',
    name: 'Frequency Tables',
    blurb: 'The tenant\'s own database tables (lead_tables). Pick a table, an operation, columns, and values.',
    trigger_phrases: [
      'my leads table', 'my contacts table', 'my data table',
      'row in my table', 'when a row is created', 'when status changes in my table',
    ],
    pickers: [
      { field: 'table_id', label: 'Table', type: 'live_select', required: true,
        placeholder: 'Pick a table',
        live_endpoint: '/api/lead-tables',
        label_field: 'name', value_field: 'id' },
      { field: 'column_name_status', label: 'Status column', type: 'live_select', required: true,
        depends_on: 'table_id',
        live_endpoint: '/api/lead-tables/{table_id}/columns',
        label_field: 'name', value_field: 'name',
        placeholder: 'Pick the status column' },
      { field: 'column_value_status', label: 'Status value', type: 'live_select', required: true,
        depends_on: 'column_name_status',
        live_endpoint: '/api/lead-tables/{table_id}/columns/{column_name_status}/values',
        label_field: 'value', value_field: 'value',
        placeholder: 'Pick the status value' },
      { field: 'row_id', label: 'Row ID', type: 'text', required: false,
        placeholder: 'Row ID or {{variable}} (used by update/delete)' },
    ],
    operation_picker: {
      field: 'operation_table',
      label: 'Table operation',
      placeholder: 'Pick an operation',
      operations: [
        { key: 'find_row',   label: 'Find row',        requires: ['column_name_status', 'column_value_status'] },
        { key: 'create_row', label: 'Create row',      requires: [] },
        { key: 'update_row', label: 'Update row',      requires: ['row_id'] },
        { key: 'upsert_row', label: 'Upsert row',      requires: ['column_name_status'] },
        { key: 'delete_row', label: 'Delete row',      requires: ['row_id'] },
        { key: 'filter_rows',label: 'Filter rows',     requires: ['column_name_status', 'column_value_status'] },
      ],
    },
  },

  // ────────────────────────────────────────────────────────────────────────
  // B. Conversations / Inbox
  // ────────────────────────────────────────────────────────────────────────
  {
    key: 'inbox',
    name: 'Conversations & Inbox',
    blurb: 'Channel, sending phone number, agent assignment, tags, quick replies, inbox folder.',
    trigger_phrases: [
      'assign to agent', 'tag the conversation', 'use my quick reply',
      'send via my WhatsApp number', 'mark as snoozed', 'mark as closed',
    ],
    pickers: [
      { field: 'channel', label: 'Channel', type: 'select', required: true,
        placeholder: 'Pick channel',
        options: ['whatsapp', 'instagram', 'telegram'] },
      { field: 'quick_reply_id', label: 'Quick reply', type: 'live_select', required: false,
        placeholder: 'Pick a quick reply',
        live_endpoint: '/api/quick-replies',
        label_field: 'title', value_field: 'id' },
      { field: 'assigned_agent_id', label: 'Assigned agent', type: 'live_select', required: false,
        placeholder: 'Pick an agent',
        live_endpoint: '/api/team-members',
        label_field: 'name', value_field: 'user_id' },
      { field: 'inbox_folder', label: 'Inbox folder', type: 'select', required: false,
        placeholder: 'Pick a folder',
        options: ['open', 'snoozed', 'closed', 'mine', 'unassigned'] },
    ],
  },

  // ────────────────────────────────────────────────────────────────────────
  // C. Campaigns / Broadcasts / Segments
  // ────────────────────────────────────────────────────────────────────────
  {
    key: 'campaigns',
    name: 'Campaigns, Broadcasts & Segments',
    blurb: 'Targeting + templates for outbound messaging.',
    trigger_phrases: [
      'send a campaign', 'trigger broadcast', 'send to segment', 'all hot leads',
      'premium customers', 'VIP segment',
    ],
    pickers: [
      { field: 'campaign_id', label: 'Campaign', type: 'live_select', required: false,
        placeholder: 'Pick a campaign',
        live_endpoint: '/api/campaigns',
        label_field: 'name', value_field: 'id' },
      { field: 'broadcast_id', label: 'Broadcast', type: 'live_select', required: false,
        placeholder: 'Pick a broadcast',
        live_endpoint: '/api/broadcasts',
        label_field: 'name', value_field: 'id' },
      { field: 'segment_id', label: 'Contact segment', type: 'live_select', required: false,
        placeholder: 'Pick a segment',
        live_endpoint: '/api/segments',
        label_field: 'name', value_field: 'id' },
      { field: 'template_name', label: 'WhatsApp template', type: 'template_picker', required: true,
        placeholder: 'Pick an approved template' },
      { field: 'template_language', label: 'Language', type: 'select', required: true,
        placeholder: 'Pick language',
        options: ['en', 'en_US', 'hi', 'hi_IN', 'mr', 'ta', 'te', 'bn', 'gu'] },
    ],
  },

  // ────────────────────────────────────────────────────────────────────────
  // D. CRM Pipeline
  // ────────────────────────────────────────────────────────────────────────
  {
    key: 'crm',
    name: 'CRM Pipeline',
    blurb: 'Deal stages, deal IDs, deal operations.',
    trigger_phrases: [
      'move to stage', 'won deal', 'close lost', 'kanban', 'deal stage',
    ],
    pickers: [
      { field: 'pipeline_stage_id', label: 'Pipeline stage', type: 'live_select', required: true,
        placeholder: 'Pick a CRM stage',
        live_endpoint: '/api/crm/stages',
        label_field: 'name', value_field: 'id' },
      { field: 'deal_id', label: 'Deal', type: 'text', required: false,
        placeholder: 'Deal ID or {{conversation.deal_id}}' },
    ],
    operation_picker: {
      field: 'operation_deal',
      label: 'Deal operation',
      placeholder: 'Pick an operation',
      operations: [
        { key: 'move_stage',   label: 'Move to a stage',   requires: ['pipeline_stage_id'] },
        { key: 'assign_owner', label: 'Assign an owner',   requires: ['assigned_agent_id'] },
        { key: 'add_tag',      label: 'Add a tag',         requires: [] },
        { key: 'add_note',     label: 'Add a note',        requires: [] },
        { key: 'mark_won',     label: 'Mark won',          requires: [] },
        { key: 'mark_lost',    label: 'Mark lost',         requires: [] },
      ],
    },
  },

  // ────────────────────────────────────────────────────────────────────────
  // E. Google Workspace
  // ────────────────────────────────────────────────────────────────────────
  {
    key: 'google',
    name: 'Google Workspace (Sheets, Calendar, Gmail)',
    blurb: 'Spreadsheets with cascading tab→column→value, calendars, Gmail accounts.',
    trigger_phrases: [
      'Google Sheet', 'spreadsheet', 'leads coming from sheet', 'when row in sheet',
      'calendar booking', 'Gmail', 'schedule meeting',
    ],
    pickers: [
      { field: 'spreadsheet_id', label: 'Google Sheet', type: 'live_select', required: true,
        placeholder: 'Pick a Google Sheet',
        live_endpoint: '/api/google/spreadsheets',
        label_field: 'name', value_field: 'id' },
      { field: 'sheet_tab_name', label: 'Tab', type: 'live_select', required: true,
        depends_on: 'spreadsheet_id',
        live_endpoint: '/api/google/spreadsheets/{spreadsheet_id}',
        label_field: 'name', value_field: 'name',
        placeholder: 'Pick a tab' },
      { field: 'column_name_status', label: 'Status column', type: 'live_select', required: false,
        depends_on: 'sheet_tab_name',
        live_endpoint: '/api/google/spreadsheets/{spreadsheet_id}/tabs/{sheet_tab_name}/columns',
        label_field: 'name', value_field: 'name',
        placeholder: 'Pick the status column' },
      { field: 'column_value_status', label: 'Status value', type: 'live_select', required: false,
        depends_on: 'column_name_status',
        live_endpoint: '/api/google/spreadsheets/{spreadsheet_id}/tabs/{sheet_tab_name}/columns/{column_name_status}/values',
        label_field: 'value', value_field: 'value',
        placeholder: 'Pick the status value' },
      { field: 'calendar_id', label: 'Calendar', type: 'live_select', required: false,
        placeholder: 'Pick a calendar',
        live_endpoint: '/api/google/calendars',
        label_field: 'summary', value_field: 'id' },
      { field: 'gmail_account_id', label: 'Gmail account', type: 'integration_picker', required: false,
        placeholder: 'Pick a Gmail account' },
    ],
    operation_picker: {
      field: 'operation_sheet',
      label: 'Sheet operation',
      placeholder: 'Pick an operation',
      operations: [
        { key: 'append_row',  label: 'Append a row',     requires: ['spreadsheet_id', 'sheet_tab_name'] },
        { key: 'update_row',  label: 'Update a row',     requires: ['spreadsheet_id', 'sheet_tab_name'] },
        { key: 'read_range',  label: 'Read a range',     requires: ['spreadsheet_id', 'sheet_tab_name'] },
        { key: 'find_row',    label: 'Find a row',       requires: ['spreadsheet_id', 'sheet_tab_name', 'column_name_status', 'column_value_status'] },
        { key: 'upsert_row',  label: 'Upsert a row',     requires: ['spreadsheet_id', 'sheet_tab_name'] },
      ],
    },
  },

  // ────────────────────────────────────────────────────────────────────────
  // F. Payments — Razorpay (extensible; add Stripe/PayPal by adding new
  // categories with the same shape — no other code touches needed).
  // ────────────────────────────────────────────────────────────────────────
  {
    key: 'razorpay',
    name: 'Razorpay',
    blurb: 'Payment links, status checks, refunds, subscriptions.',
    trigger_phrases: [
      'Razorpay', 'send payment link', 'check payment status', 'refund',
      'subscription', 'recurring payment',
    ],
    pickers: [
      { field: 'razorpay_plan_id', label: 'Razorpay plan', type: 'live_select', required: false,
        placeholder: 'Pick a Razorpay plan',
        live_endpoint: '/api/razorpay/plans',
        label_field: 'item.name', value_field: 'id' },
      { field: 'razorpay_payment_id', label: 'Razorpay payment ID', type: 'text', required: false,
        placeholder: 'pay_XXXX or {{node_3.payment_id}}' },
      { field: 'amount_paise', label: 'Amount (paise)', type: 'number', required: false,
        placeholder: '99900 (= ₹999)' },
      { field: 'customer_email', label: 'Customer email', type: 'email', required: false,
        placeholder: 'customer@example.com or {{trigger.email}}' },
      { field: 'description', label: 'Description', type: 'text', required: false,
        placeholder: 'Onboarding fee' },
    ],
    operation_picker: {
      field: 'operation_razorpay',
      label: 'Razorpay operation',
      placeholder: 'Pick an operation',
      operations: [
        { key: 'create_payment_link',   label: 'Create a payment link',     requires: ['amount_paise', 'customer_email', 'description'] },
        { key: 'check_payment_status',  label: 'Check payment status',      requires: ['razorpay_payment_id'] },
        { key: 'refund_payment',        label: 'Refund a payment',          requires: ['razorpay_payment_id'] },
        { key: 'fetch_payment',         label: 'Fetch a payment',           requires: ['razorpay_payment_id'] },
        { key: 'create_subscription',   label: 'Create a subscription',     requires: ['razorpay_plan_id', 'customer_email'] },
        { key: 'cancel_subscription',   label: 'Cancel a subscription',     requires: ['razorpay_payment_id'] },
      ],
    },
  },

  // ────────────────────────────────────────────────────────────────────────
  // G. Email (Gmail/Outlook/Resend/SendGrid/Mailgun/SES)
  // ────────────────────────────────────────────────────────────────────────
  {
    key: 'email',
    name: 'Email',
    blurb: 'Provider + sender + recipient + filters.',
    trigger_phrases: [
      'forward email', 'send an email', 'email when', 'Gmail filter',
    ],
    pickers: [
      { field: 'email_provider', label: 'Email provider', type: 'select', required: true,
        placeholder: 'Pick a provider',
        options: ['gmail', 'outlook', 'resend', 'sendgrid', 'mailgun', 'ses', 'smtp'] },
      { field: 'from_email', label: 'From address', type: 'email', required: true,
        placeholder: 'support@yourcompany.com' },
      { field: 'to_email', label: 'To address', type: 'email', required: false,
        placeholder: 'recipient@example.com or {{trigger.email}}' },
      { field: 'filter_subject', label: 'Subject filter', type: 'text', required: false,
        placeholder: 'invoice / receipt / order' },
      { field: 'filter_from_email', label: 'From filter', type: 'email', required: false,
        placeholder: 'orders@stripe.com' },
    ],
  },

  // ────────────────────────────────────────────────────────────────────────
  // H. Generic Connectors (Shopify, HTTP, custom webhooks)
  // ────────────────────────────────────────────────────────────────────────
  {
    key: 'generic',
    name: 'Generic Connectors',
    blurb: 'Catch-all for arbitrary integrations + raw HTTP.',
    trigger_phrases: [
      'when webhook arrives', 'call this API', 'hit my custom endpoint',
    ],
    pickers: [
      { field: 'api_endpoint', label: 'API endpoint', type: 'url', required: true,
        placeholder: 'https://api.example.com/v1/resource' },
      { field: 'http_method', label: 'HTTP method', type: 'select', required: true,
        placeholder: 'Pick a method',
        options: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] },
      { field: 'webhook_url', label: 'Webhook URL', type: 'url', required: false,
        placeholder: 'Frequency-generated' },
      { field: 'webhook_secret', label: 'Webhook secret', type: 'text', required: false,
        placeholder: 'Signing secret' },
    ],
  },
]

// ═══════════════════════════════════════════════════════════════════════════
// Lookups + serializers
// ═══════════════════════════════════════════════════════════════════════════

/** Flat map { field_name → PickerDef } for O(1) FE lookup. */
export function flattenPickers(): Record<string, PickerDef & { category: string }> {
  const out: Record<string, PickerDef & { category: string }> = {}
  for (const cat of PICKER_CATALOG) {
    for (const p of cat.pickers) {
      out[p.field] = { ...p, category: cat.key }
    }
    if (cat.operation_picker) {
      const op = cat.operation_picker
      out[op.field] = {
        field: op.field, label: op.label, type: 'select', required: true,
        placeholder: op.placeholder,
        options: op.operations.map(o => o.key),
        category: cat.key,
      }
    }
  }
  return out
}

/**
 * Compose the dynamic part of SYSTEM_PROMPT from the catalog. Called by
 * /api/parse-workflow at request time. Adding a new app to the catalog
 * is the only thing required — Claude will see it on the very next
 * request thanks to this composition.
 */
export function composePickerPromptSection(): string {
  const lines: string[] = []
  lines.push('PICKER FIELDS (CRITICAL — universal catalog of every Frequency surface):')
  lines.push('')
  lines.push('When the user\'s intent implies a SPECIFIC resource the FE can select from a live list,')
  lines.push('DO NOT emit a free-form text field. Emit a missing_config entry with the EXACT field')
  lines.push('name below and the EXACT type. Mark required:true so the workflow cannot run without it.')
  lines.push('')

  for (const cat of PICKER_CATALOG) {
    lines.push('═══════════════════════════════════════════════════════════════════════════════')
    lines.push(`${cat.name}`)
    lines.push('═══════════════════════════════════════════════════════════════════════════════')
    lines.push(cat.blurb)
    lines.push(`Trigger phrases: ${cat.trigger_phrases.join(', ')}`)
    lines.push('')

    if (cat.operation_picker) {
      const op = cat.operation_picker
      lines.push(`ALWAYS emit ${op.field} FIRST. Then emit ONLY the additional pickers the chosen`)
      lines.push(`operation requires.`)
      lines.push(`- field: "${op.field}", type: "select", required: true, placeholder: "${op.placeholder}"`)
      lines.push(`  options: [${op.operations.map(o => `"${o.key}"`).join(', ')}]`)
      lines.push(`Per-op requirements:`)
      for (const o of op.operations) {
        lines.push(`  ${o.key} → ${o.requires.length ? o.requires.join(', ') : '(no extra fields)'}`)
      }
      lines.push('')
    }

    for (const p of cat.pickers) {
      const opts = p.options ? ` options: [${p.options.map(o => `"${o}"`).join(', ')}]` : ''
      const dep = p.depends_on ? `, depends_on: "${p.depends_on}"` : ''
      const req = p.required ? ' required: true' : ''
      lines.push(`- field: "${p.field}", type: "${p.type}",${req}${dep}, placeholder: "${p.placeholder}"${opts}`)
    }
    lines.push('')
  }

  lines.push('═══════════════════════════════════════════════════════════════════════════════')
  lines.push('OPERATION-PICKER PATTERN (universal rule)')
  lines.push('═══════════════════════════════════════════════════════════════════════════════')
  lines.push('For any resource with multiple operations, emit operation_<resource> picker FIRST.')
  lines.push('Then emit ONLY the additional pickers the chosen operation requires. The FE refreshes')
  lines.push('the dependent picker set when the operation changes.')
  lines.push('')
  lines.push('CASCADING RULE (universal)')
  lines.push('When a picker depends on an upstream picker\'s value, emit them ALL in the same node\'s')
  lines.push('missing_config[] AND set depends_on to the upstream field\'s name. Without depends_on')
  lines.push('the FE has to guess — be explicit.')

  return lines.join('\n')
}
