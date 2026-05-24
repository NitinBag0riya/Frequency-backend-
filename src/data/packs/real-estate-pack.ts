/**
 * Real Estate Vertical Pack — manifest v1
 *
 * Single source of truth for the Real Estate pipeline pack. Upserted into
 * pipeline_packs on every BE boot via src/lib/seed-packs.ts (keyed on
 * slug = 'real_estate_v1'). The install handler in src/routes/pipelines.ts
 * reads this exact shape to provision a tenant's lead_table + pipeline +
 * workflow drafts + template drafts in one transaction.
 *
 * Origin: distilled from a 50KB n8n real-estate WhatsApp automation a user
 * pasted three times asking us to translate it. Instead of translating,
 * we built the Pack system. This file is the productionised version of
 * that flow — generalised for any Indian residential developer, not the
 * specific tower the user pasted.
 *
 * Workflow nodes_json uses ONLY node types from the canonical list in
 * src/index.ts:1028-1036 (the SYSTEM_PROMPT block). Inventing a new
 * node type here would break execution silently — the engine would skip
 * the unrecognised type and the flow would terminate early.
 *
 * Template categories use the lowercase wa_templates enum
 * (marketing|utility|authentication, see migration 001) — the FE layer
 * uppercases them at render time.
 */

export interface PackColumn {
  name: string
  key: string
  type: 'text' | 'number' | 'email' | 'phone' | 'date' | 'select' | 'boolean' | 'textarea' | 'url'
  options?: string[]
  is_required?: boolean
  is_primary?: boolean
  position: number
}

export interface PackStage {
  name: string
  sort_order: number
  color: string
  terminal?: boolean
}

export interface PackWorkflow {
  slug: string
  name: string
  description: string
  trigger_type: string        // canonical node-type string
  trigger_event: 'row_created' | 'row_updated_stage' | 'inbound_button' | 'inbound_text' | 'webhook' | 'scheduled' | 'form_submit'
  trigger_filter?: string
  nodes_json: unknown
}

export interface PackTemplateButton {
  type: 'QUICK_REPLY' | 'URL' | 'PHONE_NUMBER'
  text: string
  url?: string
  phone_number?: string
  payload?: string
}

export interface PackTemplate {
  name: string
  category: 'UTILITY' | 'MARKETING' | 'AUTHENTICATION'
  language: string
  body: string
  header?: { type: 'TEXT' | 'IMAGE' | 'DOCUMENT' | 'VIDEO'; text?: string }
  buttons?: PackTemplateButton[]
  variables?: string[]
}

export interface PackManifest {
  table: {
    name: string
    description: string
    columns: PackColumn[]
  }
  pipeline: {
    name: string
    slug: string
    stages: PackStage[]
    stage_column: string
    key_column: string
  }
  workflows: PackWorkflow[]
  templates: PackTemplate[]
}

// ─────────────────────────────────────────────────────────────────────────
// Stage colors are picked to walk the user's eye from cold (slate) →
// warm (amber/emerald) → committed (violet) → muted (terminal states).
// ─────────────────────────────────────────────────────────────────────────
const STAGES: PackStage[] = [
  { name: 'No Reply Yet',     sort_order: 0, color: '#94A3B8' },
  { name: 'BHK Replied',      sort_order: 1, color: '#F59E0B' },
  { name: 'Budget Replied',   sort_order: 2, color: '#FB923C' },
  { name: 'Visit Scheduled',  sort_order: 3, color: '#10B981' },
  { name: 'Visit Completed',  sort_order: 4, color: '#8B5CF6' },
  { name: 'Stale',            sort_order: 5, color: '#6B7280', terminal: true },
  { name: 'Cold',             sort_order: 6, color: '#475569', terminal: true },
]

// ─────────────────────────────────────────────────────────────────────────
// Lead table schema — 22 columns. Mobile is the primary key (matched on
// inbound WA messages). Lead_Stage is the routing column. The rest are
// the operational fields a sales team actually uses day-to-day.
// ─────────────────────────────────────────────────────────────────────────
const COLUMNS: PackColumn[] = [
  { name: 'Name',                  key: 'name',                  type: 'text',    is_required: true, position: 0 },
  { name: 'Mobile',                key: 'mobile',                type: 'phone',   is_primary: true, is_required: true, position: 1 },
  { name: 'Source',                key: 'source',                type: 'select',  options: ['Meta Ad','Google Ad','Walk-in','Referral','99acres','MagicBricks','Housing.com','Other'], position: 2 },
  { name: 'Project_Phase',         key: 'project_phase',         type: 'select',  options: ['Phase 1','Phase 2','Phase 3','Not specified'], position: 3 },
  { name: 'Layout',                key: 'layout',                type: 'select',  options: ['1 BHK','2 BHK','3 BHK','4 BHK','Penthouse','Not specified'], position: 4 },
  { name: 'Budget',                key: 'budget',                type: 'select',  options: ['Under 50 L','50 L – 1 Cr','1 – 1.5 Cr','1.5 – 2 Cr','2 – 3 Cr','3 Cr+','Not specified'], position: 5 },
  { name: 'Pending_Action',        key: 'pending_action',        type: 'text',    position: 6 },
  { name: 'Lead_Stage',            key: 'lead_stage',            type: 'select',  options: STAGES.map(s => s.name), is_required: true, position: 7 },
  { name: 'WA_Status',             key: 'wa_status',             type: 'select',  options: ['Not Sent','Delivered','Read','Replied','Failed','Opted Out'], position: 8 },
  { name: 'Visit_Date',            key: 'visit_date',            type: 'date',    position: 9 },
  { name: 'Visit_Time',            key: 'visit_time',            type: 'text',    position: 10 },
  { name: 'Visit_Status',          key: 'visit_status',          type: 'select',  options: ['Not Scheduled','Scheduled','Confirmed','Done','No Show','Rescheduled'], position: 11 },
  { name: 'Visit_Done_Timestamp',  key: 'visit_done_timestamp',  type: 'date',    position: 12 },
  { name: 'No_of_Visits',          key: 'no_of_visits',          type: 'number',  position: 13 },
  { name: 'Brochure',              key: 'brochure',              type: 'url',     position: 14 },
  { name: 'Callback_Date',         key: 'callback_date',         type: 'date',    position: 15 },
  { name: 'Callback_Time',         key: 'callback_time',         type: 'text',    position: 16 },
  { name: 'Office_Mtg_Date',       key: 'office_mtg_date',       type: 'date',    position: 17 },
  { name: 'Office_Mtg_Time',       key: 'office_mtg_time',       type: 'text',    position: 18 },
  { name: 'Last_Activity_At',      key: 'last_activity_at',      type: 'date',    position: 19 },
  { name: 'Stale_Since',           key: 'stale_since',           type: 'date',    position: 20 },
  { name: 'Created_At',            key: 'created_at',            type: 'date',    position: 21 },
]

// ─────────────────────────────────────────────────────────────────────────
// Workflows. Each is 3-6 nodes. Template names are referenced by string
// (not ID) so they resolve at execution time against the tenant's
// installed wa_templates rows. Connections are inline { default: id }.
//
// IMPORTANT: every `type` string here must be in the canonical list at
// src/index.ts:1028-1036. If you add a new type, also add it there or
// the engine will skip the node.
// ─────────────────────────────────────────────────────────────────────────
const WORKFLOWS: PackWorkflow[] = [

  // 1 — New lead intake. Webhook from ad form / 99acres / CRM →
  // create row in leads table → send welcome BHK options.
  {
    slug: 'wf_new_lead_welcome',
    name: 'New lead — welcome + ask BHK',
    description: 'Catches new lead webhook, creates row in leads table, sends opening BHK question on WhatsApp.',
    trigger_type: 'trigger_webhook',
    trigger_event: 'webhook',
    trigger_filter: '/new-lead',
    nodes_json: {
      nodes: [
        { id: 'n1', type: 'trigger_webhook', label: 'Lead webhook',
          position: 1, config: { path: '/new-lead', method: 'POST' },
          connections: { default: 'n2' } },
        { id: 'n2', type: 'update_sheet', label: 'Create lead row',
          position: 2, config: { operation: 'insert', table_key: 'leads',
            mapping: { name: '{{trigger.name}}', mobile: '{{trigger.mobile}}',
              source: '{{trigger.source|Meta Ad}}', lead_stage: 'No Reply Yet',
              created_at: '{{now}}' } },
          connections: { default: 'n3' } },
        { id: 'n3', type: 'send_template', label: 'Send BHK welcome',
          position: 3, config: { template_name: 'lead_welcome_bhk',
            language: 'en', to: '{{trigger.mobile}}', variables: ['{{trigger.name}}'] },
          template_required: true,
          connections: {} },
      ],
    },
  },

  // 2 — BHK reply router. User taps 1BHK/2BHK/3BHK quick reply →
  // update Layout column + push to "BHK Replied" stage → ask budget.
  {
    slug: 'wf_bhk_reply_router',
    name: 'BHK reply → ask budget',
    description: 'Routes the BHK quick-reply button payload to the matching budget question and advances the lead stage.',
    trigger_type: 'trigger_inbound_keyword',
    trigger_event: 'inbound_button',
    trigger_filter: 'BHK_',
    nodes_json: {
      nodes: [
        { id: 'n1', type: 'trigger_inbound_keyword', label: 'BHK button reply',
          position: 1, config: { match_type: 'button_payload_prefix', value: 'BHK_' },
          connections: { default: 'n2' } },
        { id: 'n2', type: 'update_sheet', label: 'Update layout + stage',
          position: 2, config: { operation: 'update', table_key: 'leads',
            match_column: 'mobile', match_value: '{{conversation.from}}',
            mapping: { layout: '{{trigger.button_payload|replace:BHK_:}} BHK',
              lead_stage: 'BHK Replied',
              last_activity_at: '{{now}}' } },
          connections: { default: 'n3' } },
        { id: 'n3', type: 'condition_button_click', label: 'Which BHK?',
          position: 3, config: { variable: '{{trigger.button_payload}}' },
          connections: {
            'BHK_1': 'n4a', 'BHK_2': 'n4b', 'BHK_3': 'n4c',
            default: 'n4b',
          } },
        { id: 'n4a', type: 'send_template', label: 'Send 1BHK budget',
          position: 4, config: { template_name: 'lead_budget_1bhk', language: 'en',
            to: '{{conversation.from}}' },
          template_required: true, connections: {} },
        { id: 'n4b', type: 'send_template', label: 'Send 2BHK budget',
          position: 5, config: { template_name: 'lead_budget_2bhk', language: 'en',
            to: '{{conversation.from}}' },
          template_required: true, connections: {} },
        { id: 'n4c', type: 'send_template', label: 'Send 3BHK budget',
          position: 6, config: { template_name: 'lead_budget_3bhk', language: 'en',
            to: '{{conversation.from}}' },
          template_required: true, connections: {} },
      ],
    },
  },

  // 3 — Budget reply → action menu (visit / brochure / callback).
  {
    slug: 'wf_budget_reply_actions',
    name: 'Budget reply → action menu',
    description: 'After lead confirms budget, send the action picker: schedule visit, send brochure, or request callback.',
    trigger_type: 'trigger_inbound_keyword',
    trigger_event: 'inbound_button',
    trigger_filter: 'BUDGET_',
    nodes_json: {
      nodes: [
        { id: 'n1', type: 'trigger_inbound_keyword', label: 'Budget button',
          position: 1, config: { match_type: 'button_payload_prefix', value: 'BUDGET_' },
          connections: { default: 'n2' } },
        { id: 'n2', type: 'update_sheet', label: 'Save budget + advance stage',
          position: 2, config: { operation: 'update', table_key: 'leads',
            match_column: 'mobile', match_value: '{{conversation.from}}',
            mapping: { budget: '{{trigger.button_text}}',
              lead_stage: 'Budget Replied',
              last_activity_at: '{{now}}' } },
          connections: { default: 'n3' } },
        { id: 'n3', type: 'send_template', label: 'Send action options',
          position: 3, config: { template_name: 'lead_action_options', language: 'en',
            to: '{{conversation.from}}' },
          template_required: true, connections: {} },
      ],
    },
  },

  // 4 — Visit booking flow. User taps "Schedule visit" → confirm
  // → save date/time + flip to "Visit Scheduled" + alert exec.
  {
    slug: 'wf_visit_booking',
    name: 'Visit scheduling flow',
    description: 'Captures visit date/time from the lead, updates the row, notifies the assigned sales executive.',
    trigger_type: 'trigger_inbound_keyword',
    trigger_event: 'inbound_button',
    trigger_filter: 'ACTION_VISIT',
    nodes_json: {
      nodes: [
        { id: 'n1', type: 'trigger_inbound_keyword', label: 'Visit CTA',
          position: 1, config: { match_type: 'button_payload', value: 'ACTION_VISIT' },
          connections: { default: 'n2' } },
        { id: 'n2', type: 'send_template', label: 'Send visit booking CTA',
          position: 2, config: { template_name: 'visit_booking_flow_cta', language: 'en',
            to: '{{conversation.from}}' },
          template_required: true,
          connections: { default: 'n3' } },
        { id: 'n3', type: 'update_sheet', label: 'Mark visit scheduled',
          position: 3, config: { operation: 'update', table_key: 'leads',
            match_column: 'mobile', match_value: '{{conversation.from}}',
            mapping: { lead_stage: 'Visit Scheduled', visit_status: 'Scheduled',
              visit_date: '{{trigger.input_visit_date}}',
              visit_time: '{{trigger.input_visit_time}}',
              last_activity_at: '{{now}}' } },
          connections: { default: 'n4' } },
        { id: 'n4', type: 'send_template', label: 'Confirm to lead',
          position: 4, config: { template_name: 'visit_confirmation', language: 'en',
            to: '{{conversation.from}}' },
          template_required: true,
          connections: { default: 'n5' } },
        { id: 'n5', type: 'send_template', label: 'Alert sales exec',
          position: 5, config: { template_name: 'exec_new_visit_alert', language: 'en',
            to: '{{tenant.sales_exec_phone}}' },
          template_required: true, connections: {} },
      ],
    },
  },

  // 5 — Brochure delivery on demand.
  {
    slug: 'wf_brochure_delivery',
    name: 'Brochure delivery',
    description: 'When lead taps "Send brochure", deliver the PDF and log the request.',
    trigger_type: 'trigger_inbound_keyword',
    trigger_event: 'inbound_button',
    trigger_filter: 'ACTION_BROCHURE',
    nodes_json: {
      nodes: [
        { id: 'n1', type: 'trigger_inbound_keyword', label: 'Brochure CTA',
          position: 1, config: { match_type: 'button_payload', value: 'ACTION_BROCHURE' },
          connections: { default: 'n2' } },
        { id: 'n2', type: 'send_template', label: 'Send brochure PDF',
          position: 2, config: { template_name: 'brochure_delivery', language: 'en',
            to: '{{conversation.from}}' },
          template_required: true,
          connections: { default: 'n3' } },
        { id: 'n3', type: 'update_sheet', label: 'Log brochure send',
          position: 3, config: { operation: 'update', table_key: 'leads',
            match_column: 'mobile', match_value: '{{conversation.from}}',
            mapping: { pending_action: 'Brochure sent — follow up in 24h',
              last_activity_at: '{{now}}' } },
          connections: {} },
      ],
    },
  },

  // 6 — Callback scheduling.
  {
    slug: 'wf_callback_scheduling',
    name: 'Callback scheduling',
    description: 'Captures preferred callback date/time and adds it to the sales executive\'s queue.',
    trigger_type: 'trigger_inbound_keyword',
    trigger_event: 'inbound_button',
    trigger_filter: 'ACTION_CALLBACK',
    nodes_json: {
      nodes: [
        { id: 'n1', type: 'trigger_inbound_keyword', label: 'Callback CTA',
          position: 1, config: { match_type: 'button_payload', value: 'ACTION_CALLBACK' },
          connections: { default: 'n2' } },
        { id: 'n2', type: 'collect_input', label: 'Ask callback time',
          position: 2, config: { prompt: 'When works best for a callback? (e.g. Tue 4pm)',
            variable: 'callback_slot' },
          connections: { default: 'n3' } },
        { id: 'n3', type: 'update_sheet', label: 'Save callback slot',
          position: 3, config: { operation: 'update', table_key: 'leads',
            match_column: 'mobile', match_value: '{{conversation.from}}',
            mapping: { pending_action: 'Callback at {{vars.callback_slot}}',
              last_activity_at: '{{now}}' } },
          connections: { default: 'n4' } },
        { id: 'n4', type: 'send_template', label: 'Confirm callback',
          position: 4, config: { template_name: 'callback_confirmation', language: 'en',
            to: '{{conversation.from}}', variables: ['{{vars.callback_slot}}'] },
          template_required: true, connections: {} },
      ],
    },
  },

  // 7 — 9am visit prep digest to sales exec (cron).
  {
    slug: 'wf_exec_visit_prep_9am',
    name: 'Sales exec — 9am visit prep digest',
    description: 'Every weekday at 9am, sends today\'s scheduled visits to the assigned sales executive.',
    trigger_type: 'trigger_scheduled',
    trigger_event: 'scheduled',
    trigger_filter: '0 9 * * *',
    nodes_json: {
      nodes: [
        { id: 'n1', type: 'trigger_scheduled', label: 'Daily 9am IST',
          position: 1, config: { cron: '0 9 * * *', timezone: 'Asia/Kolkata' },
          connections: { default: 'n2' } },
        { id: 'n2', type: 'send_template', label: 'Send prep digest',
          position: 2, config: { template_name: 'exec_visit_prep_9am', language: 'en',
            to: '{{tenant.sales_exec_phone}}' },
          template_required: true, connections: {} },
      ],
    },
  },

  // 8 — Visit day reminder to lead (cron, 1h before).
  {
    slug: 'wf_visit_day_reminder',
    name: 'Visit day reminder to lead',
    description: 'Sends a reminder 1 hour before each scheduled visit; cron scans rows hourly.',
    trigger_type: 'trigger_scheduled',
    trigger_event: 'scheduled',
    trigger_filter: '0 * * * *',
    nodes_json: {
      nodes: [
        { id: 'n1', type: 'trigger_scheduled', label: 'Hourly scan',
          position: 1, config: { cron: '0 * * * *', timezone: 'Asia/Kolkata' },
          connections: { default: 'n2' } },
        { id: 'n2', type: 'condition_variable', label: 'Visit in next hour?',
          position: 2, config: { table_key: 'leads',
            filter: { visit_status: 'Confirmed', visit_window: 'next_60min' } },
          connections: { match: 'n3', default: 'n3' } },
        { id: 'n3', type: 'send_template', label: 'Send reminder',
          position: 3, config: { template_name: 'visit_day_reminder', language: 'en',
            to: '{{row.mobile}}', variables: ['{{row.name}}','{{row.visit_time}}'] },
          template_required: true, connections: {} },
      ],
    },
  },

  // 9 — Visit completion follow-up. Fires when visit_status flips to "Done".
  {
    slug: 'wf_visit_completion_followup',
    name: 'Post-visit thank-you + next steps',
    description: 'Triggered when visit_status changes to Done. Sends thank-you with next-step CTA.',
    trigger_type: 'trigger_sheet_row',
    trigger_event: 'row_updated_stage',
    trigger_filter: 'Visit Completed',
    nodes_json: {
      nodes: [
        { id: 'n1', type: 'trigger_sheet_row', label: 'Stage = Visit Completed',
          position: 1, config: { table_key: 'leads', column: 'lead_stage',
            value: 'Visit Completed', mode: 'on_change_to' },
          connections: { default: 'n2' } },
        { id: 'n2', type: 'wait_delay', label: 'Wait 2 hours',
          position: 2, config: { duration_minutes: 120 },
          connections: { default: 'n3' } },
        { id: 'n3', type: 'send_template', label: 'Send thank-you',
          position: 3, config: { template_name: 'visit_thankyou_next_steps', language: 'en',
            to: '{{row.mobile}}', variables: ['{{row.name}}'] },
          template_required: true,
          connections: { default: 'n4' } },
        { id: 'n4', type: 'update_sheet', label: 'Bump visit count',
          position: 4, config: { operation: 'update', table_key: 'leads',
            match_column: 'mobile', match_value: '{{row.mobile}}',
            mapping: { no_of_visits: '{{row.no_of_visits|incr}}',
              visit_done_timestamp: '{{now}}' } },
          connections: {} },
      ],
    },
  },

  // 10 — Visit missed recovery. Cron scans for Scheduled visits in the past
  // with no visit_done_timestamp.
  {
    slug: 'wf_visit_missed_recovery',
    name: 'No-show recovery',
    description: 'Catches missed visits, marks No Show, sends recovery message offering reschedule.',
    trigger_type: 'trigger_scheduled',
    trigger_event: 'scheduled',
    trigger_filter: '0 19 * * *',
    nodes_json: {
      nodes: [
        { id: 'n1', type: 'trigger_scheduled', label: 'Daily 7pm IST',
          position: 1, config: { cron: '0 19 * * *', timezone: 'Asia/Kolkata' },
          connections: { default: 'n2' } },
        { id: 'n2', type: 'condition_variable', label: 'Missed today?',
          position: 2, config: { table_key: 'leads',
            filter: { visit_date: 'today', visit_status: 'Scheduled' } },
          connections: { match: 'n3', default: 'n3' } },
        { id: 'n3', type: 'update_sheet', label: 'Mark No Show',
          position: 3, config: { operation: 'update', table_key: 'leads',
            match_column: 'mobile', match_value: '{{row.mobile}}',
            mapping: { visit_status: 'No Show', last_activity_at: '{{now}}' } },
          connections: { default: 'n4' } },
        { id: 'n4', type: 'send_template', label: 'Send recovery',
          position: 4, config: { template_name: 'visit_missed_recovery', language: 'en',
            to: '{{row.mobile}}', variables: ['{{row.name}}'] },
          template_required: true, connections: {} },
      ],
    },
  },

  // 11 — Drip nurture. Cron-based, runs every 3 days against rows in
  // "BHK Replied" / "Budget Replied" with no recent activity. Picks the
  // next drip template in rotation based on no_of_drips_sent column
  // (read from row context — manifest assumes column exists or var=0).
  {
    slug: 'wf_drip_nurture',
    name: 'Drip nurture (7 messages over 3 weeks)',
    description: 'Sends one drip per 3 days to engaged but undecided leads. Rotates through 7 marketing templates.',
    trigger_type: 'trigger_scheduled',
    trigger_event: 'scheduled',
    trigger_filter: '0 11 */3 * *',
    nodes_json: {
      nodes: [
        { id: 'n1', type: 'trigger_scheduled', label: 'Every 3 days 11am',
          position: 1, config: { cron: '0 11 */3 * *', timezone: 'Asia/Kolkata' },
          connections: { default: 'n2' } },
        { id: 'n2', type: 'condition_variable', label: 'Eligible for drip?',
          position: 2, config: { table_key: 'leads',
            filter: { lead_stage_in: ['BHK Replied','Budget Replied'],
              last_activity_days_ago: { gte: 3 } } },
          connections: { match: 'n3', default: 'n3' } },
        { id: 'n3', type: 'send_template', label: 'Send next drip',
          position: 3, config: { template_name: '{{drip_rotation.next}}',
            language: 'en', to: '{{row.mobile}}',
            rotation: ['drip_life_at_tower','drip_zero_risk','drip_team_video',
              'drip_testimonial','drip_price_trends','drip_comparison',
              'drip_directors_note'] },
          template_required: true,
          connections: { default: 'n4' } },
        { id: 'n4', type: 'update_sheet', label: 'Update last activity',
          position: 4, config: { operation: 'update', table_key: 'leads',
            match_column: 'mobile', match_value: '{{row.mobile}}',
            mapping: { last_activity_at: '{{now}}' } },
          connections: {} },
      ],
    },
  },

  // 12 — Stale + Cold detector. Daily cron. Anything > 14 days no
  // activity → Stale. > 30 days → Cold + opt-out confirm message.
  {
    slug: 'wf_stale_cold_detector',
    name: 'Stale + Cold lead detector',
    description: 'Daily sweep that pushes inactive leads to Stale (14d) and Cold (30d), with an opt-out check before Cold.',
    trigger_type: 'trigger_scheduled',
    trigger_event: 'scheduled',
    trigger_filter: '30 6 * * *',
    nodes_json: {
      nodes: [
        { id: 'n1', type: 'trigger_scheduled', label: 'Daily 6:30am IST',
          position: 1, config: { cron: '30 6 * * *', timezone: 'Asia/Kolkata' },
          connections: { default: 'n2' } },
        { id: 'n2', type: 'condition_variable', label: 'How stale?',
          position: 2, config: { table_key: 'leads',
            filter: { last_activity_days_ago: { gte: 14 } } },
          connections: { '>=30': 'n3b', '>=14': 'n3a', default: 'n3a' } },
        { id: 'n3a', type: 'update_sheet', label: 'Mark Stale',
          position: 3, config: { operation: 'update', table_key: 'leads',
            match_column: 'mobile', match_value: '{{row.mobile}}',
            mapping: { lead_stage: 'Stale', stale_since: '{{now}}' } },
          connections: {} },
        { id: 'n3b', type: 'update_sheet', label: 'Mark Cold',
          position: 4, config: { operation: 'update', table_key: 'leads',
            match_column: 'mobile', match_value: '{{row.mobile}}',
            mapping: { lead_stage: 'Cold' } },
          connections: { default: 'n4' } },
        { id: 'n4', type: 'send_template', label: 'Final opt-out check',
          position: 5, config: { template_name: 'opt_out_confirm', language: 'en',
            to: '{{row.mobile}}' },
          template_required: true, connections: {} },
      ],
    },
  },

  // 13 — Re-engagement broadcast to Cold leads. Manual trigger via
  // webhook (admin clicks "Re-engage cold" in dashboard, hits this).
  {
    slug: 'wf_reengagement_cold',
    name: 'Cold lead re-engagement',
    description: 'Triggered manually from the Pipeline dashboard. Sends a soft re-engagement marketing template to all Cold leads.',
    trigger_type: 'trigger_webhook',
    trigger_event: 'webhook',
    trigger_filter: '/reengage-cold',
    nodes_json: {
      nodes: [
        { id: 'n1', type: 'trigger_webhook', label: 'Re-engage trigger',
          position: 1, config: { path: '/reengage-cold', method: 'POST' },
          connections: { default: 'n2' } },
        { id: 'n2', type: 'condition_variable', label: 'Cold leads only',
          position: 2, config: { table_key: 'leads',
            filter: { lead_stage: 'Cold' } },
          connections: { match: 'n3', default: 'n3' } },
        { id: 'n3', type: 'send_template', label: 'Send re-engagement',
          position: 3, config: { template_name: 'lead_reengagement', language: 'en',
            to: '{{row.mobile}}', variables: ['{{row.name}}'] },
          template_required: true,
          connections: { default: 'n4' } },
        { id: 'n4', type: 'update_sheet', label: 'Reset last activity',
          position: 4, config: { operation: 'update', table_key: 'leads',
            match_column: 'mobile', match_value: '{{row.mobile}}',
            mapping: { last_activity_at: '{{now}}' } },
          connections: {} },
      ],
    },
  },
]

// ─────────────────────────────────────────────────────────────────────────
// Templates. 24 total. Production-ready copy for an Indian real-estate
// audience — ₹ symbol, professional Indian English tone, no emoji clutter.
//
// Naming convention: snake_case, prefixed by purpose (lead_, visit_,
// exec_, drip_, opt_). Quick-reply payloads use ALL_CAPS_PREFIX format
// (BHK_*, BUDGET_*, ACTION_*) so the inbound routers can pattern-match.
// ─────────────────────────────────────────────────────────────────────────
const TEMPLATES: PackTemplate[] = [
  // — Welcome / qualification (UTILITY) —
  {
    name: 'lead_welcome_bhk', category: 'UTILITY', language: 'en',
    body: 'Hi {{1}}, thanks for showing interest in our project. To share the most relevant details, could you tell us which configuration you are looking for?',
    buttons: [
      { type: 'QUICK_REPLY', text: '1 BHK', payload: 'BHK_1' },
      { type: 'QUICK_REPLY', text: '2 BHK', payload: 'BHK_2' },
      { type: 'QUICK_REPLY', text: '3 BHK', payload: 'BHK_3' },
    ],
    variables: ['name'],
  },
  {
    name: 'lead_budget_1bhk', category: 'UTILITY', language: 'en',
    body: 'Great choice. Our 1 BHK homes are designed for smart urban living. What is your approximate budget?',
    buttons: [
      { type: 'QUICK_REPLY', text: 'Under ₹50 L', payload: 'BUDGET_U50' },
      { type: 'QUICK_REPLY', text: '₹50 L – 1 Cr', payload: 'BUDGET_50_100' },
      { type: 'QUICK_REPLY', text: '₹1 Cr+',      payload: 'BUDGET_100P' },
    ],
  },
  {
    name: 'lead_budget_2bhk', category: 'UTILITY', language: 'en',
    body: 'Excellent. Our 2 BHK homes are the most popular pick. What is your approximate budget range?',
    buttons: [
      { type: 'QUICK_REPLY', text: '₹50 L – 1 Cr',  payload: 'BUDGET_50_100' },
      { type: 'QUICK_REPLY', text: '₹1 – 1.5 Cr',   payload: 'BUDGET_100_150' },
      { type: 'QUICK_REPLY', text: '₹1.5 Cr+',      payload: 'BUDGET_150P' },
    ],
  },
  {
    name: 'lead_budget_3bhk', category: 'UTILITY', language: 'en',
    body: 'Wonderful. Our 3 BHK residences are spacious and built for growing families. What is your budget range?',
    buttons: [
      { type: 'QUICK_REPLY', text: '₹1.5 – 2 Cr', payload: 'BUDGET_150_200' },
      { type: 'QUICK_REPLY', text: '₹2 – 3 Cr',   payload: 'BUDGET_200_300' },
      { type: 'QUICK_REPLY', text: '₹3 Cr+',      payload: 'BUDGET_300P' },
    ],
  },

  // — Action menu (UTILITY) —
  {
    name: 'lead_action_options', category: 'UTILITY', language: 'en',
    body: 'Thanks for sharing. How would you like to take this forward?',
    buttons: [
      { type: 'QUICK_REPLY', text: 'Schedule a visit', payload: 'ACTION_VISIT' },
      { type: 'QUICK_REPLY', text: 'Send brochure',    payload: 'ACTION_BROCHURE' },
      { type: 'QUICK_REPLY', text: 'Request callback', payload: 'ACTION_CALLBACK' },
    ],
  },

  // — Brochure delivery (UTILITY) — header is a document attachment
  {
    name: 'brochure_delivery', category: 'UTILITY', language: 'en',
    header: { type: 'DOCUMENT' },
    body: 'Here is the detailed brochure for your reference. It includes the floor plans, amenities, payment plans, and possession timelines. Our sales executive will reach out shortly to answer any questions.',
  },

  // — Visit booking flow CTA (UTILITY) —
  {
    name: 'visit_booking_flow_cta', category: 'UTILITY', language: 'en',
    body: 'Please tap below to pick a convenient date and time for your site visit. Our team will receive you with a welcome drink and a guided walkthrough.',
    buttons: [
      { type: 'URL', text: 'Pick visit slot', url: 'https://example.com/visit-slot?ref={{1}}' },
    ],
    variables: ['mobile'],
  },

  {
    name: 'visit_confirmation', category: 'UTILITY', language: 'en',
    body: 'Your site visit is confirmed for {{1}} at {{2}}. Address: {{3}}. Our sales executive {{4}} will receive you. For any changes call {{5}}.',
    variables: ['visit_date','visit_time','site_address','exec_name','exec_phone'],
  },

  {
    name: 'callback_confirmation', category: 'UTILITY', language: 'en',
    body: 'Thank you. We have noted your preferred callback slot: {{1}}. Our sales executive will call you on this number at the scheduled time.',
    variables: ['callback_slot'],
  },

  // — Sales executive alerts (UTILITY) —
  {
    name: 'exec_new_visit_alert', category: 'UTILITY', language: 'en',
    body: 'New site visit booked. Lead: {{1}} ({{2}}). Slot: {{3}} {{4}}. Layout: {{5}}, Budget: {{6}}. Please prepare the relevant floor plans.',
    variables: ['name','mobile','visit_date','visit_time','layout','budget'],
  },

  {
    name: 'exec_visit_prep_9am', category: 'UTILITY', language: 'en',
    body: 'Good morning. You have {{1}} site visits scheduled today. The full list with names, mobile numbers, and preferences is in your Frequency dashboard. First visit at {{2}}.',
    variables: ['visit_count','first_visit_time'],
  },

  {
    name: 'visit_day_reminder', category: 'UTILITY', language: 'en',
    body: 'Hi {{1}}, this is a friendly reminder for your site visit today at {{2}}. We look forward to welcoming you. Reply RESCHEDULE if you need to change the slot.',
    variables: ['name','visit_time'],
  },

  {
    name: 'visit_missed_recovery', category: 'UTILITY', language: 'en',
    body: 'Hi {{1}}, we missed you at the scheduled site visit today. No worries — would you like to pick a new slot? Tap below.',
    buttons: [
      { type: 'QUICK_REPLY', text: 'Reschedule visit', payload: 'ACTION_VISIT' },
      { type: 'QUICK_REPLY', text: 'Not interested',   payload: 'ACTION_OPTOUT' },
    ],
    variables: ['name'],
  },

  {
    name: 'opt_out_confirm', category: 'UTILITY', language: 'en',
    body: 'Thank you for considering our project. We will stop sending updates. If you change your mind, reply START anytime and we will be happy to help.',
  },

  {
    name: 'office_mtg_confirmation', category: 'UTILITY', language: 'en',
    body: 'Your meeting at our experience centre is confirmed for {{1}} at {{2}}. Address: {{3}}. Please ask for {{4}} at reception.',
    variables: ['office_mtg_date','office_mtg_time','office_address','exec_name'],
  },

  // — Post-visit (MARKETING — sent outside 24h window often) —
  {
    name: 'visit_thankyou_next_steps', category: 'MARKETING', language: 'en',
    body: 'Hi {{1}}, thank you for visiting us. We hope you got a feel of the lifestyle on offer. Our team is standing by to help with the next steps — pricing breakdown, payment plan, or a unit-specific walkthrough. What would help most?',
    buttons: [
      { type: 'QUICK_REPLY', text: 'Detailed pricing', payload: 'POST_PRICING' },
      { type: 'QUICK_REPLY', text: 'Payment plan',     payload: 'POST_PAYPLAN' },
      { type: 'QUICK_REPLY', text: 'Book a unit',      payload: 'POST_BOOK' },
    ],
    variables: ['name'],
  },

  // — Drip nurture (7 MARKETING templates) —
  {
    name: 'drip_life_at_tower', category: 'MARKETING', language: 'en',
    body: 'A glimpse of life at our tower — landscaped podium, infinity pool, sky lounge on the top floor, and a full clubhouse. The amenities are crafted for residents who value both peace and community.',
    buttons: [{ type: 'URL', text: 'See gallery', url: 'https://example.com/gallery' }],
  },
  {
    name: 'drip_zero_risk', category: 'MARKETING', language: 'en',
    body: 'Why our buyers feel zero risk: RERA approved, top-tier construction partner, transparent payment milestones, and committed delivery timelines backed by penalty clauses. Buy with confidence.',
    buttons: [{ type: 'URL', text: 'RERA details', url: 'https://example.com/rera' }],
  },
  {
    name: 'drip_team_video', category: 'MARKETING', language: 'en',
    header: { type: 'VIDEO' },
    body: 'Meet the architects and engineers behind your future home. A short film from our project lead, walking you through the design philosophy and quality benchmarks.',
  },
  {
    name: 'drip_testimonial', category: 'MARKETING', language: 'en',
    body: '"We moved in last March. The handover was clean, finishes were exactly as promised, and the community here is fantastic. Best decision we made." — A recent resident.',
    buttons: [{ type: 'URL', text: 'Read more reviews', url: 'https://example.com/reviews' }],
  },
  {
    name: 'drip_price_trends', category: 'MARKETING', language: 'en',
    body: 'Quick market update — prices in this micro-market have appreciated 18% in the last 24 months, with strong demand from end-users. Our current launch pricing is below comparable inventory in the area.',
  },
  {
    name: 'drip_comparison', category: 'MARKETING', language: 'en',
    body: 'A side-by-side comparison with three other launches in the area: ours offers the largest carpet area per ₹, the best amenity-to-unit ratio, and the only project with sky-lounge access for all residents.',
    buttons: [{ type: 'URL', text: 'See comparison', url: 'https://example.com/compare' }],
  },
  {
    name: 'drip_directors_note', category: 'MARKETING', language: 'en',
    body: 'A personal note from our Managing Director — why we chose this site, what we believe makes a home truly liveable, and our commitment to delivering on every promise. Three minutes worth your time.',
    buttons: [{ type: 'URL', text: 'Read the note', url: 'https://example.com/founders-note' }],
  },

  // — Re-engagement (MARKETING) —
  {
    name: 'lead_reengagement', category: 'MARKETING', language: 'en',
    body: 'Hi {{1}}, it has been a while. We have a new launch happening this month with special pre-launch pricing for existing enquirers like you. Would you like to take a fresh look?',
    buttons: [
      { type: 'QUICK_REPLY', text: 'Yes, send details', payload: 'REENGAGE_YES' },
      { type: 'QUICK_REPLY', text: 'Not right now',     payload: 'REENGAGE_NO' },
    ],
    variables: ['name'],
  },
]

export const REAL_ESTATE_PACK: PackManifest = {
  table: {
    name: 'Real Estate Leads',
    description: 'Lead pipeline table for residential real estate projects. Created by the Real Estate vertical pack — 22 columns covering qualification, visit booking, and follow-up tracking.',
    columns: COLUMNS,
  },
  pipeline: {
    name: 'Real Estate sales pipeline',
    slug: 'real-estate',
    stages: STAGES,
    stage_column: 'Lead_Stage',
    key_column: 'Mobile',
  },
  workflows: WORKFLOWS,
  templates: TEMPLATES,
}

// Stable pack slug used by the upsert in src/lib/seed-packs.ts and the
// install handler's idempotency lookup.
export const REAL_ESTATE_PACK_SLUG = 'real_estate_v1'

export const REAL_ESTATE_PACK_ROW = {
  slug:          REAL_ESTATE_PACK_SLUG,
  name:          'Real Estate sales pipeline',
  description:   'End-to-end WhatsApp lead-to-visit funnel for Indian residential developers. Includes a 22-column leads table, 7-stage pipeline, 13 pre-built workflows (welcome, qualification, visit booking, drip, stale recovery), and 24 message templates ready to submit to Meta.',
  vertical:      'real_estate' as const,
  is_curated:    true,
  manifest_json: REAL_ESTATE_PACK,
}
