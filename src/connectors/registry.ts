/**
 * Connector registry — the single source of truth for all third-party apps.
 *
 * Goals:
 *   1. **Config-driven UI**: AppsModal + Sidebar render from this registry.
 *   2. **Workflow integration**: capability.workflowNodeType exposes each
 *      capability as a draggable node in the workflow builder.
 *   3. **Lifecycle honesty**: status='live' (working), 'beta' (auth works,
 *      capabilities stubbed), 'planned' (visible in UI as "Coming soon").
 *      Better than hiding the roadmap.
 *
 * Adding a new app = add an object below + `routes/connectors/<key>.ts`. No
 * other code edits required across server or FE.
 */

export type ConnectorStatus = 'live' | 'beta' | 'planned'
export type ConnectorAuthMode = 'oauth' | 'oauth_pkce' | 'api_key' | 'embedded_signup' | 'bot_token'
export type ConnectorCategory =
  | 'whatsapp'
  | 'payments'
  | 'commerce'
  | 'crm'
  | 'forms'
  | 'email_marketing'
  | 'communication'
  | 'productivity'
  | 'support'
  | 'calendar'
  | 'storage'
  | 'ads'
  | 'dev'
  | 'data'
  | 'accounting'

export interface ConnectorCapability {
  /** Stable key, e.g. 'create_payment_link' */
  key: string
  label: string
  description: string
  /** lucide-react icon name (resolved on FE) */
  iconName: string
  /** Server endpoint (POST/GET) — used both by direct UI actions and workflow nodes */
  apiPath: string
  apiMethod: 'GET' | 'POST' | 'PATCH' | 'DELETE'
  /** Optional: register this capability as a workflow node type */
  workflowNodeType?: string
  /** UI verb — 'action' = one-shot CTA in sidebar; 'list' = list page; 'modal' = opens a modal */
  uiKind: 'action' | 'list' | 'modal'
  /** Roadmap status — 'stub' means endpoint returns "not implemented yet" */
  status: 'live' | 'stub' | 'planned'
}

export interface ConnectorDef {
  key: string                     // 'razorpay', 'airtable', 'shopify', ...
  name: string
  category: ConnectorCategory
  /** Marketing tier — drives default sort order in AppsModal + Coming-soon visibility */
  tier: 0 | 1 | 2
  status: ConnectorStatus
  authMode: ConnectorAuthMode
  brandColor: string              // hex (used as inline style)
  iconName: string                // lucide-react name
  shortDescription: string
  docsUrl: string                 // official API docs
  /** Where to send the user to create the credential (deep link) */
  consoleUrl?: string
  /** OAuth scope string — granted scope written verbatim into consent screen */
  oauthScope?: string
  /** Capabilities exposed to UI + workflow builder */
  capabilities: ConnectorCapability[]
  /** Set true if Partner / Connect / App registration is required before OAuth works */
  requiresPartnerRegistration?: boolean
  /** Friendly note shown to admin if not yet configured */
  setupNote?: string
}

// ─────────────────────────────────────────────────────────────────────────────
// Tier 0 — already shipped (or being shipped this week)
// ─────────────────────────────────────────────────────────────────────────────
const WHATSAPP: ConnectorDef = {
  key: 'whatsapp',
  name: 'WhatsApp Business',
  category: 'whatsapp',
  tier: 0,
  status: 'live',
  authMode: 'embedded_signup',
  brandColor: '#25D366',
  iconName: 'MessageSquare',
  shortDescription: 'Send broadcasts, run conversations, automate replies via Meta Cloud API.',
  docsUrl: 'https://developers.facebook.com/docs/whatsapp/cloud-api',
  capabilities: [
    { key: 'send_template',       label: 'Send template message',  description: 'Outside the 24h window — approved Marketing/Utility template.', iconName: 'Send',     apiPath: '/api/inbox/send',          apiMethod: 'POST', workflowNodeType: 'send_template',    uiKind: 'modal',  status: 'live' },
    { key: 'send_text',           label: 'Send text reply',        description: 'Free-form text — only valid within 24h of last inbound.',     iconName: 'MessageCircle', apiPath: '/api/inbox/send',     apiMethod: 'POST', workflowNodeType: 'send_text',        uiKind: 'modal',  status: 'live' },
    { key: 'create_template',     label: 'Create template',        description: 'Submit a new template for Meta approval.',                    iconName: 'FileText', apiPath: '/api/wa-templates',        apiMethod: 'POST',                                       uiKind: 'modal',  status: 'live' },
    { key: 'list_templates',      label: 'My templates',           description: 'Approved + pending Meta-managed templates for your WABA.',    iconName: 'FileText', apiPath: '/api/wa-templates',        apiMethod: 'GET',                                        uiKind: 'list',   status: 'live' },
  ],
}

const GOOGLE_DRIVE: ConnectorDef = {
  key: 'google_drive',
  name: 'Google Drive',
  category: 'storage',
  tier: 0,
  status: 'live',
  authMode: 'oauth',
  brandColor: '#4285F4',
  iconName: 'HardDrive',
  shortDescription: 'List sheets, read files, mirror sheets to Lead Tables.',
  docsUrl: 'https://developers.google.com/drive/api',
  oauthScope: 'https://www.googleapis.com/auth/drive.readonly',
  capabilities: [
    { key: 'list_spreadsheets', label: 'My spreadsheets', description: 'Browse Google Sheets you own or have access to.',       iconName: 'FileSpreadsheet', apiPath: '/api/google/spreadsheets',      apiMethod: 'GET',                                        uiKind: 'list',   status: 'live' },
    { key: 'mirror_sheet',      label: 'Mirror sheet to CRM', description: 'Auto-sync a sheet into a Lead Table every 5 min.', iconName: 'RefreshCw',       apiPath: '/api/data-sources/google-sheet/mirror', apiMethod: 'POST',                                uiKind: 'modal',  status: 'live' },
  ],
}

const GOOGLE_SHEETS: ConnectorDef = {
  key: 'google_sheets',
  name: 'Google Sheets',
  category: 'data',
  tier: 0,
  status: 'live',
  authMode: 'oauth',
  brandColor: '#0F9D58',
  iconName: 'FileSpreadsheet',
  shortDescription: 'Append, update, read rows; trigger workflows from new rows.',
  docsUrl: 'https://developers.google.com/sheets/api',
  oauthScope: 'https://www.googleapis.com/auth/spreadsheets',
  capabilities: [
    { key: 'append_row', label: 'Append row',  description: 'Add a row at the bottom of a sheet.',  iconName: 'Plus', apiPath: '/api/google/sheets/append', apiMethod: 'POST', workflowNodeType: 'update_sheet', uiKind: 'modal', status: 'live' },
    { key: 'update_row', label: 'Update range', description: 'Update a specific cell range.',       iconName: 'Edit',  apiPath: '/api/google/sheets/update', apiMethod: 'POST', workflowNodeType: 'update_sheet', uiKind: 'modal', status: 'live' },
    { key: 'read_range', label: 'Read range',  description: 'Read values from a range.',           iconName: 'Eye',  apiPath: '/api/google/sheets/read',   apiMethod: 'GET',                                  uiKind: 'modal', status: 'live' },
  ],
}

const GOOGLE_CALENDAR: ConnectorDef = {
  key: 'google_calendar',
  name: 'Google Calendar',
  category: 'calendar',
  tier: 0,
  status: 'live',
  authMode: 'oauth',
  brandColor: '#4285F4',
  iconName: 'Calendar',
  shortDescription: 'Book appointments, send reminders, check availability.',
  docsUrl: 'https://developers.google.com/calendar/api',
  oauthScope: 'https://www.googleapis.com/auth/calendar',
  capabilities: [
    { key: 'create_event',      label: 'Create event',     description: 'Add an event with attendees + reminder.',  iconName: 'CalendarPlus',  apiPath: '/api/google/calendar/events',     apiMethod: 'POST', workflowNodeType: 'create_calendar_event',         uiKind: 'modal', status: 'live' },
    { key: 'check_availability',label: 'Check availability', description: 'Detect free/busy for a time window.',   iconName: 'Clock',         apiPath: '/api/google/calendar/availability', apiMethod: 'GET',  workflowNodeType: 'check_calendar_availability',  uiKind: 'modal', status: 'live' },
  ],
}

const GMAIL: ConnectorDef = {
  key: 'google_gmail',
  name: 'Gmail',
  category: 'email_marketing',
  tier: 0,
  status: 'live',
  authMode: 'oauth',
  brandColor: '#EA4335',
  iconName: 'Mail',
  shortDescription: 'Send + receive email, trigger workflows on inbound.',
  docsUrl: 'https://developers.google.com/gmail/api',
  oauthScope: 'https://www.googleapis.com/auth/gmail.modify',
  capabilities: [
    { key: 'send_email',     label: 'Send email',     description: 'Send a one-off email via your Gmail.',         iconName: 'Send',        apiPath: '/api/google/gmail/send',     apiMethod: 'POST', workflowNodeType: 'send_email',          uiKind: 'modal', status: 'beta' as any },
    { key: 'forward_email',  label: 'Forward email',  description: 'Forward an inbound email to another address.', iconName: 'Forward',     apiPath: '/api/google/gmail/forward',  apiMethod: 'POST', workflowNodeType: 'forward_email',       uiKind: 'modal', status: 'beta' as any },
    { key: 'list_threads',   label: 'Recent threads', description: 'Latest email threads matching a query.',       iconName: 'Mail',        apiPath: '/api/google/gmail/threads',  apiMethod: 'GET',                                          uiKind: 'list',  status: 'planned' as any },
  ],
}

const RAZORPAY: ConnectorDef = {
  key: 'razorpay',
  name: 'Razorpay',
  category: 'payments',
  tier: 0,
  status: 'live',
  authMode: 'api_key', // OAuth Partner flow planned, but API-key works today
  brandColor: '#0C3B91',
  iconName: 'CreditCard',
  shortDescription: 'Collect payments, generate links, refund, query status.',
  docsUrl: 'https://razorpay.com/docs/api/',
  consoleUrl: 'https://dashboard.razorpay.com/app/keys',
  setupNote: 'Paste keys today; OAuth via Razorpay Partner program coming after we register (1-3 days approval).',
  capabilities: [
    { key: 'create_payment_link', label: 'Create payment link', description: 'Generate a hosted payment URL with optional reminders.',   iconName: 'Link',           apiPath: '/api/connectors/razorpay/payment-links',          apiMethod: 'POST',  workflowNodeType: 'razorpay_create_payment_link', uiKind: 'modal', status: 'live' },
    { key: 'list_payments',       label: 'Payments',            description: 'List recent payments with filters.',                       iconName: 'List',           apiPath: '/api/connectors/razorpay/payments',               apiMethod: 'GET',                                                       uiKind: 'list',  status: 'live' },
    { key: 'get_payment',         label: 'Payment status',      description: 'Check status by payment_id.',                              iconName: 'Search',         apiPath: '/api/connectors/razorpay/payments/:id',           apiMethod: 'GET',   workflowNodeType: 'razorpay_get_payment_status',  uiKind: 'modal', status: 'live' },
    { key: 'refund_payment',      label: 'Refund',              description: 'Refund a captured payment, fully or partial.',             iconName: 'RotateCcw',      apiPath: '/api/connectors/razorpay/payments/:id/refund',    apiMethod: 'POST',  workflowNodeType: 'razorpay_refund',              uiKind: 'modal', status: 'live' },
    { key: 'list_subscriptions',  label: 'Subscriptions',       description: 'Active recurring subscriptions.',                          iconName: 'Repeat',         apiPath: '/api/connectors/razorpay/subscriptions',          apiMethod: 'GET',                                                       uiKind: 'list',  status: 'stub' },
    { key: 'list_customers',      label: 'Customers',           description: 'Saved Razorpay customers.',                                iconName: 'Users',          apiPath: '/api/connectors/razorpay/customers',              apiMethod: 'GET',                                                       uiKind: 'list',  status: 'stub' },
  ],
}

const AIRTABLE: ConnectorDef = {
  key: 'airtable',
  name: 'Airtable',
  category: 'data',
  tier: 0,
  status: 'beta',
  authMode: 'oauth_pkce',
  brandColor: '#FCB400',
  iconName: 'Database',
  shortDescription: 'Read + write records in your bases — same shape as Lead Tables.',
  docsUrl: 'https://airtable.com/developers/web/api/introduction',
  consoleUrl: 'https://airtable.com/create/oauth',
  oauthScope: 'data.records:read data.records:write schema.bases:read',
  capabilities: [
    { key: 'list_bases',     label: 'My bases',      description: 'Bases you own or have access to.',                    iconName: 'Database', apiPath: '/api/connectors/airtable/bases',                            apiMethod: 'GET',                                                  uiKind: 'list',  status: 'live' },
    { key: 'list_tables',    label: 'List tables',   description: 'Tables in a chosen base.',                            iconName: 'Table',    apiPath: '/api/connectors/airtable/bases/:baseId/tables',             apiMethod: 'GET',                                                  uiKind: 'modal', status: 'live' },
    { key: 'list_records',   label: 'Browse records',description: 'Records in a chosen table with filtering.',            iconName: 'FileText', apiPath: '/api/connectors/airtable/bases/:baseId/tables/:tableId',    apiMethod: 'GET',                                                  uiKind: 'list',  status: 'live' },
    { key: 'create_record',  label: 'Add record',    description: 'Insert a new record into a table.',                   iconName: 'Plus',     apiPath: '/api/connectors/airtable/bases/:baseId/tables/:tableId',    apiMethod: 'POST',  workflowNodeType: 'airtable_create_record', uiKind: 'modal', status: 'live' },
    { key: 'update_record',  label: 'Update record', description: 'Patch fields on an existing record.',                 iconName: 'Edit',     apiPath: '/api/connectors/airtable/bases/:baseId/tables/:tableId/:recordId', apiMethod: 'PATCH', workflowNodeType: 'airtable_update_record', uiKind: 'modal', status: 'live' },
  ],
}

const SHOPIFY: ConnectorDef = {
  key: 'shopify',
  name: 'Shopify',
  category: 'commerce',
  tier: 0,
  status: 'beta',
  authMode: 'oauth',
  brandColor: '#5E8E3E',
  iconName: 'ShoppingBag',
  shortDescription: 'Read orders + customers, listen for new-order events to trigger flows.',
  docsUrl: 'https://shopify.dev/docs/api/admin-rest',
  consoleUrl: 'https://partners.shopify.com/',
  requiresPartnerRegistration: true,
  setupNote: 'Requires Shopify Partner app registration. Custom-app token paste fallback works today.',
  oauthScope: 'read_orders,read_customers,read_products,write_draft_orders',
  capabilities: [
    { key: 'list_orders',         label: 'Orders',            description: 'Recent orders with filters.',                           iconName: 'ShoppingCart', apiPath: '/api/connectors/shopify/orders',                 apiMethod: 'GET',                                                  uiKind: 'list',  status: 'live' },
    { key: 'get_order',           label: 'Order detail',      description: 'Full order including line items + fulfillments.',       iconName: 'Search',       apiPath: '/api/connectors/shopify/orders/:id',             apiMethod: 'GET',                                                  uiKind: 'modal', status: 'live' },
    { key: 'list_products',       label: 'Products',          description: 'Catalog with stock + variant info.',                   iconName: 'Package',      apiPath: '/api/connectors/shopify/products',               apiMethod: 'GET',                                                  uiKind: 'list',  status: 'live' },
    { key: 'list_customers',      label: 'Customers',         description: 'Storefront customer directory.',                       iconName: 'Users',        apiPath: '/api/connectors/shopify/customers',              apiMethod: 'GET',                                                  uiKind: 'list',  status: 'live' },
    { key: 'create_draft_order',  label: 'Create draft order',description: 'Build an order to send for payment.',                  iconName: 'FilePlus',     apiPath: '/api/connectors/shopify/draft-orders',           apiMethod: 'POST', workflowNodeType: 'shopify_create_draft_order', uiKind: 'modal', status: 'stub' },
  ],
}

// ─────────────────────────────────────────────────────────────────────────────
// Tier 1 — planned (shown in AppsModal as "Coming soon", not yet connectable)
// Auth + scope strings come from official docs so the eventual implementation
// is paste-and-run.
// ─────────────────────────────────────────────────────────────────────────────
const STRIPE: ConnectorDef = {
  key: 'stripe',
  name: 'Stripe',
  category: 'payments',
  tier: 1,
  status: 'planned',
  authMode: 'oauth',
  brandColor: '#635BFF',
  iconName: 'CreditCard',
  shortDescription: 'Global counterpart to Razorpay. Payment links, subscriptions, refunds.',
  docsUrl: 'https://stripe.com/docs/api',
  requiresPartnerRegistration: true,
  setupNote: 'Stripe Connect platform registration required.',
  capabilities: [],
}
const CALENDLY: ConnectorDef = {
  key: 'calendly',
  name: 'Calendly',
  category: 'calendar',
  tier: 1,
  status: 'planned',
  authMode: 'oauth',
  brandColor: '#006BFF',
  iconName: 'Calendar',
  shortDescription: 'Booking links, availability, on-event-created triggers.',
  docsUrl: 'https://developer.calendly.com/api-docs',
  capabilities: [],
}
const TYPEFORM: ConnectorDef = {
  key: 'typeform',
  name: 'Typeform',
  category: 'forms',
  tier: 1,
  status: 'planned',
  authMode: 'oauth',
  brandColor: '#262627',
  iconName: 'FileText',
  shortDescription: 'On-form-submit trigger → WhatsApp / CRM / Sheet.',
  docsUrl: 'https://www.typeform.com/developers/get-started/',
  capabilities: [],
}
const MAILCHIMP: ConnectorDef = {
  key: 'mailchimp',
  name: 'Mailchimp',
  category: 'email_marketing',
  tier: 1,
  status: 'planned',
  authMode: 'oauth',
  brandColor: '#FFE01B',
  iconName: 'Mail',
  shortDescription: 'Email campaigns, audience sync, subscribe/unsubscribe events.',
  docsUrl: 'https://mailchimp.com/developer/marketing/',
  capabilities: [],
}
const HUBSPOT: ConnectorDef = {
  key: 'hubspot',
  name: 'HubSpot',
  category: 'crm',
  tier: 1,
  status: 'planned',
  authMode: 'oauth',
  brandColor: '#FF7A59',
  iconName: 'Briefcase',
  shortDescription: 'Two-way contact + deal sync. Push WhatsApp leads into HubSpot.',
  docsUrl: 'https://developers.hubspot.com/docs/api/overview',
  capabilities: [],
}
const SLACK: ConnectorDef = {
  key: 'slack',
  name: 'Slack',
  category: 'communication',
  tier: 1,
  status: 'planned',
  authMode: 'oauth',
  brandColor: '#4A154B',
  iconName: 'Hash',
  shortDescription: 'Notify channels on events, post messages from workflows.',
  docsUrl: 'https://api.slack.com/',
  capabilities: [],
}
const NOTION: ConnectorDef = {
  key: 'notion',
  name: 'Notion',
  category: 'productivity',
  tier: 1,
  status: 'planned',
  authMode: 'oauth',
  brandColor: '#000000',
  iconName: 'BookOpen',
  shortDescription: 'Add page on event, search a knowledge base from a workflow.',
  docsUrl: 'https://developers.notion.com/',
  capabilities: [],
}
const TELEGRAM: ConnectorDef = {
  key: 'telegram',
  name: 'Telegram',
  category: 'communication',
  tier: 1,
  status: 'planned',
  authMode: 'bot_token',
  brandColor: '#26A5E4',
  iconName: 'Send',
  shortDescription: 'Wider reach in IN/SEA/crypto segments. Bot token, no OAuth.',
  docsUrl: 'https://core.telegram.org/bots/api',
  capabilities: [],
}
const FACEBOOK_LEADS: ConnectorDef = {
  key: 'facebook_lead_ads',
  name: 'Facebook Lead Ads',
  category: 'ads',
  tier: 1,
  status: 'planned',
  authMode: 'oauth',
  brandColor: '#1877F2',
  iconName: 'Target',
  shortDescription: 'Capture leads from Facebook/Instagram ads → instant WhatsApp follow-up.',
  docsUrl: 'https://developers.facebook.com/docs/marketing-api/guides/lead-ads/retrieving',
  capabilities: [],
}
const WOOCOMMERCE: ConnectorDef = {
  key: 'woocommerce',
  name: 'WooCommerce',
  category: 'commerce',
  tier: 1,
  status: 'planned',
  authMode: 'api_key',
  brandColor: '#7F54B3',
  iconName: 'ShoppingCart',
  shortDescription: 'D2C alternative to Shopify (very common in IN). REST API key + URL.',
  docsUrl: 'https://woocommerce.github.io/woocommerce-rest-api-docs/',
  capabilities: [],
}
const ZOHO: ConnectorDef = {
  key: 'zoho_crm',
  name: 'Zoho CRM',
  category: 'crm',
  tier: 1,
  status: 'planned',
  authMode: 'oauth',
  brandColor: '#C8202F',
  iconName: 'Briefcase',
  shortDescription: 'Largest CRM in India — Lead/Contact/Deal sync. Not in n8n; we add it ourselves.',
  docsUrl: 'https://www.zoho.com/crm/developer/docs/api/v6/',
  capabilities: [],
}

// ─────────────────────────────────────────────────────────────────────────────
// Tier 2 — backlog (visible roadmap only; no setup yet)
// ─────────────────────────────────────────────────────────────────────────────
const TIER_2_PLANNED: ConnectorDef[] = [
  { key: 'pipedrive',   name: 'Pipedrive',   category: 'crm',         tier: 2, status: 'planned', authMode: 'oauth',   brandColor: '#1A1A1A', iconName: 'Briefcase', shortDescription: 'Sales-focused CRM, deal stages.',                docsUrl: 'https://developers.pipedrive.com/docs/api/v1', capabilities: [] },
  { key: 'brevo',       name: 'Brevo',       category: 'email_marketing', tier: 2, status: 'planned', authMode: 'api_key', brandColor: '#0B996E', iconName: 'Mail',     shortDescription: 'Email + SMS marketing (formerly Sendinblue).',  docsUrl: 'https://developers.brevo.com/',                  capabilities: [] },
  { key: 'twilio',      name: 'Twilio',      category: 'communication', tier: 2, status: 'planned', authMode: 'api_key', brandColor: '#F22F46', iconName: 'Phone',     shortDescription: 'SMS / voice fallback — global reach.',          docsUrl: 'https://www.twilio.com/docs',                    capabilities: [] },
  { key: 'cal_com',     name: 'Cal.com',     category: 'calendar',     tier: 2, status: 'planned', authMode: 'oauth',   brandColor: '#111827', iconName: 'Calendar',  shortDescription: 'Open-source Calendly alternative.',             docsUrl: 'https://cal.com/docs',                            capabilities: [] },
  { key: 'jotform',     name: 'Jotform',     category: 'forms',        tier: 2, status: 'planned', authMode: 'api_key', brandColor: '#0A1551', iconName: 'FileText',  shortDescription: 'Form builder — on-submission triggers.',         docsUrl: 'https://api.jotform.com/docs/',                  capabilities: [] },
  { key: 'clickup',     name: 'ClickUp',     category: 'productivity', tier: 2, status: 'planned', authMode: 'oauth',   brandColor: '#7B68EE', iconName: 'CheckSquare',shortDescription: 'Task management with rich event triggers.',     docsUrl: 'https://clickup.com/api',                         capabilities: [] },
  { key: 'zendesk',     name: 'Zendesk',     category: 'support',      tier: 2, status: 'planned', authMode: 'oauth',   brandColor: '#03363D', iconName: 'LifeBuoy',  shortDescription: 'Ticketing + macros, on-ticket-created triggers.',docsUrl: 'https://developer.zendesk.com/api-reference/',  capabilities: [] },
  { key: 'intercom',    name: 'Intercom',    category: 'support',      tier: 2, status: 'planned', authMode: 'oauth',   brandColor: '#1F8DED', iconName: 'MessageCircle',shortDescription: 'Support inbox + product messaging.',         docsUrl: 'https://developers.intercom.com/',               capabilities: [] },
  { key: 'msteams',     name: 'Microsoft Teams', category: 'communication', tier: 2, status: 'planned', authMode: 'oauth', brandColor: '#4B53BC', iconName: 'Users', shortDescription: 'Notify channels + chat from workflows.',         docsUrl: 'https://learn.microsoft.com/en-us/graph/teams-concept-overview', capabilities: [] },
  { key: 'github',      name: 'GitHub',      category: 'dev',          tier: 2, status: 'planned', authMode: 'oauth',   brandColor: '#0D1117', iconName: 'Github',    shortDescription: 'Issues, PRs, pushes — for tech-team customers.', docsUrl: 'https://docs.github.com/en/rest',                capabilities: [] },
]

// ─────────────────────────────────────────────────────────────────────────────
// Final exported registry (ordered for AppsModal default sort)
// ─────────────────────────────────────────────────────────────────────────────
export const CONNECTOR_REGISTRY: ConnectorDef[] = [
  WHATSAPP,
  GOOGLE_DRIVE,
  GOOGLE_SHEETS,
  GOOGLE_CALENDAR,
  GMAIL,
  RAZORPAY,
  AIRTABLE,
  SHOPIFY,
  // Tier 1
  STRIPE, CALENDLY, TYPEFORM, MAILCHIMP, HUBSPOT, SLACK, NOTION, TELEGRAM, FACEBOOK_LEADS, WOOCOMMERCE, ZOHO,
  // Tier 2
  ...TIER_2_PLANNED,
]

export function getConnector(key: string): ConnectorDef | undefined {
  return CONNECTOR_REGISTRY.find(c => c.key === key)
}

/** Public-safe view (no internal-only fields) for /api/connectors/registry */
export function publicRegistry() {
  return CONNECTOR_REGISTRY.map(c => ({
    key: c.key,
    name: c.name,
    category: c.category,
    tier: c.tier,
    status: c.status,
    authMode: c.authMode,
    brandColor: c.brandColor,
    iconName: c.iconName,
    shortDescription: c.shortDescription,
    docsUrl: c.docsUrl,
    consoleUrl: c.consoleUrl,
    requiresPartnerRegistration: !!c.requiresPartnerRegistration,
    setupNote: c.setupNote,
    capabilities: c.capabilities,
  }))
}
