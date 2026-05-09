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
 * Channel apps:
 *   `isChannel: true` marks an app as a messaging channel — it surfaces in
 *   /api/channels/connected and the Inbox / Contacts / Campaigns channel
 *   filter tabs. These apps render `channelFeatures` (Broadcasts, Templates,
 *   Flows…) under their sidebar group instead of raw capabilities. The
 *   capabilities are still kept for workflow-builder use.
 *
 * Adding a new app = add an object below + `routes/connectors/<key>.ts`. No
 * other code edits required across server or FE.
 */

export type ConnectorStatus = 'live' | 'beta' | 'planned'
export type ConnectorAuthMode = 'oauth' | 'oauth_pkce' | 'api_key' | 'embedded_signup' | 'bot_token'
export type ConnectorCategory =
  | 'whatsapp'
  | 'messaging'
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
  | 'email'

/**
 * Workflow-builder field schema. Each input field declares its type and,
 * when applicable, a resource picker that lets the user click-select a value
 * from a live API (e.g. Google Sheets spreadsheet picker, Shopify product
 * picker). Cascading dependencies via `dependsOn` (e.g. spreadsheet → sheet).
 */
export interface CapabilityField {
  key: string
  label: string
  type: 'text' | 'textarea' | 'number' | 'boolean' | 'select' | 'resource' | 'variable_ref'
  required?: boolean
  placeholder?: string
  options?: { value: string; label: string }[]   // for type='select'
  picker?: {
    /** API endpoint that returns the picker's options. Path may include
     *  {{dependsOn}} placeholders that will be substituted at fetch time. */
    endpoint: string
    /** Field key whose value this picker depends on (cascading). */
    dependsOn?: string
    /** Path inside response → display label (default 'name') */
    labelKey?: string
    /** Path inside response → option value (default 'id') */
    valueKey?: string
    /** Optional thumbnail field (image_url) */
    imageKey?: string
  }
  /** Whether this field accepts {{var}} interpolation. */
  supportsVariables?: boolean
}

export interface CapabilityOutputField {
  key: string                                     // 'payment_link.short_url'
  label: string
  type: 'string' | 'number' | 'boolean' | 'object' | 'array'
  sample?: any                                    // for VariablePicker preview
}

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
  /** Workflow-builder schema — drives auto-generated config form */
  inputSchema?: { fields: CapabilityField[] }
  outputSchema?: { fields: CapabilityOutputField[] }
  /** Whether this capability supports a "Test this node" run with mock data. */
  testRunnable?: boolean
}

/**
 * A nav-item rendered under a channel app in the sidebar (e.g. "Broadcasts",
 * "Templates", "Flows"). Channel apps render `channelFeatures` instead of
 * dumping every capability into the sidebar — capabilities are too granular
 * for top-level nav.
 */
export interface ChannelFeature {
  /** Stable key, e.g. 'broadcasts' */
  key: string
  label: string
  /** lucide-react icon name */
  iconName: string
  /** Frontend route — receives :channelKey URL param */
  route: string
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
  /** Marks this app as a messaging channel (drives filter tabs + channelFeatures) */
  isChannel?: boolean
  /** Sidebar nav items for channel apps. Ignored for non-channel apps. */
  channelFeatures?: ChannelFeature[]
  /** Set true if Partner / Connect / App registration is required before OAuth works */
  requiresPartnerRegistration?: boolean
  /** Friendly note shown to admin if not yet configured */
  setupNote?: string
}

// ─────────────────────────────────────────────────────────────────────────────
// Tier 0 — Meta ecosystem (channel apps)
// ─────────────────────────────────────────────────────────────────────────────

const WHATSAPP: ConnectorDef = {
  key: 'whatsapp',
  name: 'WhatsApp Business',
  category: 'messaging',
  tier: 0,
  status: 'live',
  authMode: 'embedded_signup',
  brandColor: '#25D366',
  iconName: 'MessageSquare',
  shortDescription: 'Send broadcasts, run conversations, automate replies via Meta Cloud API.',
  docsUrl: 'https://developers.facebook.com/docs/whatsapp/cloud-api',
  isChannel: true,
  channelFeatures: [
    { key: 'broadcasts', label: 'Broadcasts',     iconName: 'Send',       route: '/channels/whatsapp/broadcasts' },
    { key: 'templates',  label: 'Templates',      iconName: 'FileText',   route: '/channels/whatsapp/templates'  },
    { key: 'flows',      label: 'Flows',          iconName: 'Workflow',   route: '/channels/whatsapp/flows'      },
    { key: 'catalog',    label: 'Catalog',        iconName: 'Package',    route: '/channels/whatsapp/catalog'    },
    { key: 'qr_codes',   label: 'QR Codes',       iconName: 'QrCode',     route: '/channels/whatsapp/qr-codes'   },
    { key: 'profile',    label: 'Profile',        iconName: 'IdCard',     route: '/channels/whatsapp/profile'    },
  ],
  capabilities: [
    // Messaging (used by inbox + workflow builder)
    { key: 'send_template',       label: 'Send template message',  description: 'Outside the 24h window — approved Marketing/Utility template.', iconName: 'Send',          apiPath: '/api/inbox/send',                  apiMethod: 'POST', workflowNodeType: 'send_template',     uiKind: 'modal',  status: 'live',
      inputSchema: { fields: [
        { key: 'phone',         label: 'Recipient phone', type: 'text', required: true, supportsVariables: true, placeholder: '{{trigger.contact.phone}}' },
        { key: 'template_name', label: 'Template',        type: 'resource', required: true,
          picker: { endpoint: '/api/wa-templates?status=approved', labelKey: 'name', valueKey: 'name' } },
        { key: 'template_params', label: 'Template variables (JSON array)', type: 'textarea', supportsVariables: true,
          placeholder: '["John", "₹1,499"]' },
      ] },
      outputSchema: { fields: [
        { key: 'message_id', label: 'Meta message ID', type: 'string', sample: 'wamid.HBgM…' },
      ] },
      testRunnable: false,
    },
    { key: 'send_text',           label: 'Send text reply',        description: 'Free-form text — only valid within 24h of last inbound.',     iconName: 'MessageCircle', apiPath: '/api/inbox/send',                  apiMethod: 'POST', workflowNodeType: 'send_text',         uiKind: 'modal',  status: 'live' },
    { key: 'send_media',          label: 'Send media',             description: 'Image, video, document, or audio.',                            iconName: 'Image',         apiPath: '/api/inbox/send',                  apiMethod: 'POST', workflowNodeType: 'send_media',        uiKind: 'modal',  status: 'stub' },
    { key: 'send_interactive',    label: 'Send buttons / list',    description: 'Quick-reply buttons or list picker.',                          iconName: 'MousePointer',  apiPath: '/api/inbox/send',                  apiMethod: 'POST', workflowNodeType: 'send_interactive',  uiKind: 'modal',  status: 'stub' },
    { key: 'send_product',        label: 'Send product card',      description: 'Single product or product list from your catalog.',            iconName: 'ShoppingBag',   apiPath: '/api/inbox/send',                  apiMethod: 'POST', workflowNodeType: 'send_product',      uiKind: 'modal',  status: 'stub' },
    // Templates
    { key: 'create_template',     label: 'Create template',        description: 'Submit a new template for Meta approval.',                     iconName: 'FileText',      apiPath: '/api/wa-templates',                apiMethod: 'POST',                                        uiKind: 'modal',  status: 'live' },
    { key: 'list_templates',      label: 'My templates',           description: 'Approved + pending Meta-managed templates for your WABA.',     iconName: 'FileText',      apiPath: '/api/wa-templates',                apiMethod: 'GET',                                         uiKind: 'list',   status: 'live' },
    { key: 'sync_templates',      label: 'Sync from Meta',         description: 'Pull template approval status from Meta.',                     iconName: 'RefreshCw',     apiPath: '/api/wa-templates/sync',           apiMethod: 'POST',                                        uiKind: 'action', status: 'live' },
    // Broadcasts
    { key: 'create_broadcast',    label: 'Create broadcast',       description: 'Schedule or send a templated broadcast to a list.',            iconName: 'Send',          apiPath: '/api/broadcasts',                  apiMethod: 'POST',                                        uiKind: 'modal',  status: 'live' },
    { key: 'list_broadcasts',     label: 'Broadcasts',             description: 'Recent broadcasts with delivery stats.',                       iconName: 'List',          apiPath: '/api/broadcasts',                  apiMethod: 'GET',                                         uiKind: 'list',   status: 'live' },
    // Catalog
    { key: 'list_products',       label: 'Catalog products',       description: 'Products in your WhatsApp catalog.',                           iconName: 'Package',       apiPath: '/api/wa-catalog/products',         apiMethod: 'GET',                                         uiKind: 'list',   status: 'stub' },
    { key: 'create_product',      label: 'Add product',            description: 'Add a product to the catalog.',                                iconName: 'PackagePlus',   apiPath: '/api/wa-catalog/products',         apiMethod: 'POST',                                        uiKind: 'modal',  status: 'stub' },
    { key: 'import_products',     label: 'Import products',        description: 'Import from Shopify, Sheets, or Lead Tables.',                 iconName: 'Download',      apiPath: '/api/wa-catalog/import',           apiMethod: 'POST',                                        uiKind: 'modal',  status: 'stub' },
    // Flows
    { key: 'list_flows',          label: 'Flows',                  description: 'Multi-screen interactive flows.',                              iconName: 'Workflow',      apiPath: '/api/wa-flows',                    apiMethod: 'GET',                                         uiKind: 'list',   status: 'stub' },
    { key: 'create_flow',         label: 'Create flow',            description: 'Build a multi-screen flow (forms, surveys, sign-up).',         iconName: 'PlusSquare',    apiPath: '/api/wa-flows',                    apiMethod: 'POST',                                        uiKind: 'modal',  status: 'stub' },
    { key: 'publish_flow',        label: 'Publish flow',           description: 'Move a draft flow to PUBLISHED (irreversible).',               iconName: 'CheckCircle',   apiPath: '/api/wa-flows/:id/publish',        apiMethod: 'POST',                                        uiKind: 'action', status: 'stub' },
    { key: 'flow_responses',      label: 'Flow responses',         description: 'Lead data captured via flows.',                                iconName: 'Inbox',         apiPath: '/api/wa-flows/responses',          apiMethod: 'GET',                                         uiKind: 'list',   status: 'stub' },
    // QR codes
    { key: 'list_qr',             label: 'QR codes',               description: 'wa.me deep-link QR codes with prefilled messages.',            iconName: 'QrCode',        apiPath: '/api/wa-qr',                       apiMethod: 'GET',                                         uiKind: 'list',   status: 'stub' },
    { key: 'create_qr',           label: 'Create QR',              description: 'Generate a new QR code with prefilled message.',               iconName: 'PlusSquare',    apiPath: '/api/wa-qr',                       apiMethod: 'POST',                                        uiKind: 'modal',  status: 'stub' },
    // Business profile
    { key: 'get_profile',         label: 'Business profile',       description: 'View / edit profile (about, address, websites).',              iconName: 'IdCard',        apiPath: '/api/wa-profile',                  apiMethod: 'GET',                                         uiKind: 'list',   status: 'stub' },
    { key: 'update_profile',      label: 'Update profile',         description: 'Update business profile fields.',                              iconName: 'Edit',          apiPath: '/api/wa-profile',                  apiMethod: 'POST',                                        uiKind: 'modal',  status: 'stub' },
    // Numbers + analytics
    { key: 'list_numbers',        label: 'Phone numbers',          description: 'WABA-attached phone numbers.',                                  iconName: 'Phone',         apiPath: '/api/wa-phone-numbers',            apiMethod: 'GET',                                         uiKind: 'list',   status: 'stub' },
    { key: 'analytics',           label: 'Conversation analytics', description: 'Sent / delivered / read / replied trends.',                    iconName: 'BarChart3',     apiPath: '/api/wa-analytics',                apiMethod: 'GET',                                         uiKind: 'list',   status: 'stub' },
    { key: 'webhook_config',      label: 'Webhook health',         description: 'Verify Meta webhook subscription + delivery health.',          iconName: 'Activity',      apiPath: '/api/wa-webhook/health',           apiMethod: 'GET',                                         uiKind: 'list',   status: 'stub' },
    { key: 'block_contact',       label: 'Block contact',          description: 'Block a contact at the WABA level.',                           iconName: 'Ban',           apiPath: '/api/wa-block',                    apiMethod: 'POST',                                        uiKind: 'modal',  status: 'stub' },
  ],
}

const INSTAGRAM: ConnectorDef = {
  key: 'instagram',
  name: 'Instagram',
  category: 'messaging',
  tier: 0,
  status: 'beta',
  authMode: 'oauth',
  brandColor: '#E4405F',
  iconName: 'Instagram',
  shortDescription: 'DMs, comment automation, content publishing, insights via Meta Graph API.',
  docsUrl: 'https://developers.facebook.com/docs/instagram-api',
  oauthScope: 'instagram_basic,instagram_manage_messages,instagram_manage_comments,instagram_content_publish,instagram_manage_insights,pages_show_list,pages_read_engagement',
  isChannel: true,
  channelFeatures: [
    { key: 'broadcasts',  label: 'Broadcasts',          iconName: 'Send',       route: '/channels/instagram/broadcasts' },
    { key: 'comments',    label: 'Comment automation',  iconName: 'MessageCircle', route: '/channels/instagram/comments' },
    { key: 'publishing',  label: 'Content publishing',  iconName: 'ImagePlus',  route: '/channels/instagram/publishing' },
    { key: 'insights',    label: 'Insights',            iconName: 'BarChart3',  route: '/channels/instagram/insights' },
    { key: 'shopping',    label: 'Shopping',            iconName: 'ShoppingBag',route: '/channels/instagram/shopping' },
  ],
  capabilities: [
    // Messaging
    { key: 'send_dm',              label: 'Send DM',                description: 'Send a direct message to a contact.',                          iconName: 'Send',          apiPath: '/api/instagram/dm',                 apiMethod: 'POST', workflowNodeType: 'instagram_send_dm',    uiKind: 'modal',  status: 'stub' },
    { key: 'send_dm_media',        label: 'Send media DM',          description: 'Image / video / story reply via DM.',                          iconName: 'Image',         apiPath: '/api/instagram/dm/media',           apiMethod: 'POST',                                        uiKind: 'modal',  status: 'stub' },
    { key: 'send_dm_quick',        label: 'Send quick replies',     description: 'Quick-reply buttons in DM.',                                   iconName: 'MousePointer',  apiPath: '/api/instagram/dm/interactive',     apiMethod: 'POST',                                        uiKind: 'modal',  status: 'stub' },
    // Comments
    { key: 'list_comments',        label: 'Recent comments',        description: 'Comments across your posts.',                                  iconName: 'MessageCircle', apiPath: '/api/instagram/comments',           apiMethod: 'GET',                                         uiKind: 'list',   status: 'stub' },
    { key: 'reply_comment',        label: 'Reply to comment',       description: 'Public reply to a comment.',                                   iconName: 'CornerUpLeft',  apiPath: '/api/instagram/comments/reply',     apiMethod: 'POST',                                        uiKind: 'modal',  status: 'stub' },
    { key: 'hide_comment',         label: 'Hide comment',           description: 'Hide a comment without deleting.',                             iconName: 'EyeOff',        apiPath: '/api/instagram/comments/hide',      apiMethod: 'POST',                                        uiKind: 'action', status: 'stub' },
    { key: 'list_comment_rules',   label: 'Comment rules',          description: 'Keyword → auto-reply + auto-DM rules.',                        iconName: 'Filter',        apiPath: '/api/instagram/comment-rules',      apiMethod: 'GET',                                         uiKind: 'list',   status: 'stub' },
    { key: 'create_comment_rule',  label: 'New comment rule',       description: 'Trigger DM on keyword in a comment.',                          iconName: 'PlusSquare',    apiPath: '/api/instagram/comment-rules',      apiMethod: 'POST',                                        uiKind: 'modal',  status: 'stub' },
    // Content
    { key: 'publish_image',        label: 'Publish image',          description: 'Post a single image with caption.',                            iconName: 'Image',         apiPath: '/api/instagram/publish/image',      apiMethod: 'POST',                                        uiKind: 'modal',  status: 'stub' },
    { key: 'publish_carousel',     label: 'Publish carousel',       description: 'Up to 10 images/videos in a single post.',                     iconName: 'Layers',        apiPath: '/api/instagram/publish/carousel',   apiMethod: 'POST',                                        uiKind: 'modal',  status: 'stub' },
    { key: 'publish_reel',         label: 'Publish reel',           description: 'Reel (≤90s vertical video).',                                  iconName: 'Film',          apiPath: '/api/instagram/publish/reel',       apiMethod: 'POST',                                        uiKind: 'modal',  status: 'stub' },
    { key: 'publish_story',        label: 'Publish story',          description: '24-hour story with media + stickers.',                         iconName: 'Sparkles',      apiPath: '/api/instagram/publish/story',      apiMethod: 'POST',                                        uiKind: 'modal',  status: 'stub' },
    { key: 'list_posts',           label: 'My posts',               description: 'Recent published media.',                                      iconName: 'Grid3x3',       apiPath: '/api/instagram/posts',              apiMethod: 'GET',                                         uiKind: 'list',   status: 'stub' },
    // Insights
    { key: 'profile_insights',     label: 'Profile insights',       description: 'Reach, profile views, audience demographics.',                 iconName: 'BarChart3',     apiPath: '/api/instagram/insights/profile',   apiMethod: 'GET',                                         uiKind: 'list',   status: 'stub' },
    { key: 'media_insights',       label: 'Post insights',          description: 'Per-post reach, impressions, saves, shares.',                  iconName: 'TrendingUp',    apiPath: '/api/instagram/insights/media',     apiMethod: 'GET',                                         uiKind: 'list',   status: 'stub' },
    { key: 'audience_insights',    label: 'Audience demographics',  description: 'Age, gender, country, city breakdown.',                        iconName: 'Users',         apiPath: '/api/instagram/insights/audience',  apiMethod: 'GET',                                         uiKind: 'list',   status: 'stub' },
    // Shopping
    { key: 'list_product_tags',    label: 'Product tags',           description: 'Tagged products on posts.',                                    iconName: 'Tag',           apiPath: '/api/instagram/shopping/tags',      apiMethod: 'GET',                                         uiKind: 'list',   status: 'stub' },
    { key: 'create_product_tag',   label: 'Tag product',            description: 'Tag a catalog product on a post.',                             iconName: 'Pin',           apiPath: '/api/instagram/shopping/tags',      apiMethod: 'POST',                                        uiKind: 'modal',  status: 'stub' },
    { key: 'shopping_insights',    label: 'Shopping insights',      description: 'Product taps, buyer engagement.',                              iconName: 'ShoppingCart',  apiPath: '/api/instagram/shopping/insights',  apiMethod: 'GET',                                         uiKind: 'list',   status: 'stub' },
  ],
}

const TELEGRAM: ConnectorDef = {
  key: 'telegram',
  name: 'Telegram',
  category: 'messaging',
  tier: 0,
  status: 'beta',
  authMode: 'bot_token',
  brandColor: '#26A5E4',
  iconName: 'Send',
  shortDescription: 'Bot-driven channel: messaging, broadcasts, mini apps, Stars payments.',
  docsUrl: 'https://core.telegram.org/bots/api',
  consoleUrl: 'https://t.me/BotFather',
  setupNote: 'Create a bot via @BotFather to get a bot token, then paste it here.',
  isChannel: true,
  channelFeatures: [
    { key: 'broadcasts',     label: 'Broadcasts',      iconName: 'Send',         route: '/channels/telegram/broadcasts'    },
    { key: 'mini_apps',      label: 'Mini Apps',       iconName: 'AppWindow',    route: '/channels/telegram/mini-apps'      },
    { key: 'payments',       label: 'Payments (Stars)',iconName: 'Sparkles',     route: '/channels/telegram/payments'       },
    { key: 'channel_manager',label: 'Channel Manager', iconName: 'Megaphone',    route: '/channels/telegram/channels'       },
    { key: 'bot_settings',   label: 'Bot Settings',    iconName: 'Settings',     route: '/channels/telegram/bot-settings'   },
  ],
  capabilities: [
    // Messaging
    { key: 'send_message',         label: 'Send message',           description: 'Send a text message to a Telegram chat.',                       iconName: 'Send',          apiPath: '/api/telegram/send',                apiMethod: 'POST', workflowNodeType: 'telegram_send_message', uiKind: 'modal',  status: 'stub' },
    { key: 'send_media',           label: 'Send media',             description: 'Photo / video / document / audio.',                             iconName: 'Image',         apiPath: '/api/telegram/send/media',          apiMethod: 'POST',                                         uiKind: 'modal',  status: 'stub' },
    { key: 'send_keyboard',        label: 'Send keyboard',          description: 'Inline or reply keyboard with buttons.',                        iconName: 'MousePointer',  apiPath: '/api/telegram/send/keyboard',       apiMethod: 'POST',                                         uiKind: 'modal',  status: 'stub' },
    // Broadcasts
    { key: 'create_broadcast',     label: 'New broadcast',          description: 'Fan out to all bot subscribers.',                               iconName: 'Megaphone',     apiPath: '/api/telegram/broadcasts',          apiMethod: 'POST',                                         uiKind: 'modal',  status: 'stub' },
    { key: 'list_broadcasts',      label: 'My broadcasts',          description: 'Past + scheduled broadcasts.',                                  iconName: 'List',          apiPath: '/api/telegram/broadcasts',          apiMethod: 'GET',                                          uiKind: 'list',   status: 'stub' },
    // Mini Apps
    { key: 'list_mini_apps',       label: 'Mini apps',              description: 'Registered Telegram mini apps.',                                iconName: 'AppWindow',     apiPath: '/api/telegram/mini-apps',           apiMethod: 'GET',                                          uiKind: 'list',   status: 'stub' },
    { key: 'create_mini_app',      label: 'Add mini app',           description: 'Register a mini-app URL with the bot.',                         iconName: 'PlusSquare',    apiPath: '/api/telegram/mini-apps',           apiMethod: 'POST',                                         uiKind: 'modal',  status: 'stub' },
    // Payments (Stars)
    { key: 'create_invoice',       label: 'Create Stars invoice',   description: 'Issue a Telegram Stars invoice link.',                          iconName: 'Sparkles',      apiPath: '/api/telegram/payments/invoice',    apiMethod: 'POST', workflowNodeType: 'telegram_create_invoice', uiKind: 'modal', status: 'stub' },
    { key: 'list_payments',        label: 'Stars transactions',     description: 'Recent Stars payments.',                                        iconName: 'List',          apiPath: '/api/telegram/payments',            apiMethod: 'GET',                                          uiKind: 'list',   status: 'stub' },
    // Channels
    { key: 'list_channels',        label: 'My channels',            description: 'Public/private channels the bot is admin of.',                  iconName: 'Megaphone',     apiPath: '/api/telegram/channels',            apiMethod: 'GET',                                          uiKind: 'list',   status: 'stub' },
    { key: 'post_to_channel',      label: 'Post to channel',        description: 'Schedule or publish a channel post.',                           iconName: 'Send',          apiPath: '/api/telegram/channels/post',       apiMethod: 'POST',                                         uiKind: 'modal',  status: 'stub' },
    // Bot
    { key: 'get_bot',              label: 'Bot info',               description: 'getMe — bot username, IDs, capabilities.',                      iconName: 'Bot',           apiPath: '/api/telegram/bot',                 apiMethod: 'GET',                                          uiKind: 'list',   status: 'stub' },
    { key: 'set_commands',         label: 'Update commands',        description: 'Set the / command menu.',                                       iconName: 'List',          apiPath: '/api/telegram/bot/commands',        apiMethod: 'POST',                                         uiKind: 'modal',  status: 'stub' },
    { key: 'set_webhook',          label: 'Webhook',                description: 'Configure inbound webhook URL.',                                iconName: 'Activity',      apiPath: '/api/telegram/bot/webhook',         apiMethod: 'POST',                                         uiKind: 'action', status: 'stub' },
    { key: 'update_profile',       label: 'Bot profile',            description: 'Update name / about / description / picture.',                  iconName: 'IdCard',        apiPath: '/api/telegram/bot/profile',         apiMethod: 'POST',                                         uiKind: 'modal',  status: 'stub' },
  ],
}

const META_ADS: ConnectorDef = {
  key: 'meta_ads',
  name: 'Meta Ads',
  category: 'ads',
  tier: 0,
  status: 'beta',
  authMode: 'oauth',
  brandColor: '#1877F2',
  iconName: 'Target',
  shortDescription: 'CTWA / IG-DM ads, Lead Ads, Custom Audiences, Conversions API.',
  docsUrl: 'https://developers.facebook.com/docs/marketing-api',
  oauthScope: 'ads_management,ads_read,leads_retrieval,business_management,pages_show_list,pages_manage_ads',
  // Meta Ads isn't a messaging channel — but it does have rich sub-features
  // (Campaign Manager, Lead Ads, Audiences, …) that read better in the
  // sidebar as a curated nav rather than as raw capabilities.
  channelFeatures: [
    { key: 'campaigns',   label: 'Campaign Manager', iconName: 'BarChart3', route: '/ads/meta/campaigns' },
    { key: 'ctwa',        label: 'CTWA Campaigns',   iconName: 'MessageSquare', route: '/ads/meta/ctwa' },
    { key: 'lead_ads',    label: 'Lead Ads',         iconName: 'UserCheck',     route: '/ads/meta/lead-ads' },
    { key: 'audiences',   label: 'Audiences',        iconName: 'Users',         route: '/ads/meta/audiences' },
    { key: 'capi',        label: 'Conversions API',  iconName: 'Activity',      route: '/ads/meta/capi' },
  ],
  capabilities: [
    // Ad accounts + campaigns
    { key: 'list_ad_accounts',     label: 'Ad accounts',            description: 'Linked ad accounts (act_xxx).',                                 iconName: 'Building2',     apiPath: '/api/meta-ads/accounts',            apiMethod: 'GET',                                          uiKind: 'list',   status: 'stub' },
    { key: 'list_campaigns',       label: 'Campaign manager',       description: 'All ad campaigns with spend / impressions / clicks.',           iconName: 'BarChart3',     apiPath: '/api/meta-ads/campaigns',           apiMethod: 'GET',                                          uiKind: 'list',   status: 'stub' },
    { key: 'create_ctwa',          label: 'New CTWA campaign',      description: 'Click-to-WhatsApp campaign with auto follow-up.',               iconName: 'MessageSquare', apiPath: '/api/meta-ads/campaigns/ctwa',      apiMethod: 'POST',                                         uiKind: 'modal',  status: 'stub' },
    { key: 'create_ctid',          label: 'New IG DM campaign',     description: 'Click-to-Instagram-DM campaign.',                               iconName: 'Instagram',     apiPath: '/api/meta-ads/campaigns/ctid',      apiMethod: 'POST',                                         uiKind: 'modal',  status: 'stub' },
    { key: 'pause_campaign',       label: 'Pause campaign',         description: 'Pause a running campaign.',                                     iconName: 'Pause',         apiPath: '/api/meta-ads/campaigns/:id/pause', apiMethod: 'POST',                                         uiKind: 'action', status: 'stub' },
    { key: 'resume_campaign',      label: 'Resume campaign',        description: 'Resume a paused campaign.',                                     iconName: 'Play',          apiPath: '/api/meta-ads/campaigns/:id/resume',apiMethod: 'POST',                                         uiKind: 'action', status: 'stub' },
    // Lead ads
    { key: 'list_lead_forms',      label: 'Lead forms',             description: 'Lead-ad forms across pages.',                                   iconName: 'FileText',      apiPath: '/api/meta-ads/lead-forms',          apiMethod: 'GET',                                          uiKind: 'list',   status: 'stub' },
    { key: 'list_leads',           label: 'Recent leads',           description: 'Leads pulled from forms.',                                      iconName: 'UserCheck',     apiPath: '/api/meta-ads/leads',               apiMethod: 'GET',                                          uiKind: 'list',   status: 'stub' },
    // Audiences
    { key: 'list_audiences',       label: 'Custom audiences',       description: 'Custom + lookalike audiences.',                                 iconName: 'Users',         apiPath: '/api/meta-ads/audiences',           apiMethod: 'GET',                                          uiKind: 'list',   status: 'stub' },
    { key: 'create_audience',      label: 'New audience',           description: 'Build an audience from CRM phone/email hashes.',                iconName: 'UserPlus',      apiPath: '/api/meta-ads/audiences',           apiMethod: 'POST',                                         uiKind: 'modal',  status: 'stub' },
    { key: 'create_lookalike',     label: 'Lookalike audience',     description: 'Lookalike from a seed audience.',                               iconName: 'Sparkles',      apiPath: '/api/meta-ads/audiences/lookalike', apiMethod: 'POST',                                         uiKind: 'modal',  status: 'stub' },
    // Conversions API
    { key: 'send_capi_event',      label: 'Send CAPI event',        description: 'Server-side conversion event (Purchase, Lead, …).',             iconName: 'Activity',      apiPath: '/api/meta-ads/capi/events',         apiMethod: 'POST', workflowNodeType: 'meta_capi_event',                       uiKind: 'modal',  status: 'stub' },
    { key: 'capi_match_quality',   label: 'CAPI match quality',     description: 'Diagnostics for event matching.',                               iconName: 'Gauge',         apiPath: '/api/meta-ads/capi/diagnostics',    apiMethod: 'GET',                                          uiKind: 'list',   status: 'stub' },
    // Insights
    { key: 'campaign_insights',    label: 'Insights',               description: 'Spend / ROAS / CPL by campaign + adset.',                       iconName: 'TrendingUp',    apiPath: '/api/meta-ads/insights',            apiMethod: 'GET',                                          uiKind: 'list',   status: 'stub' },
  ],
}

// ─────────────────────────────────────────────────────────────────────────────
// Tier 0 — already shipped non-channel apps
// ─────────────────────────────────────────────────────────────────────────────
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
    { key: 'append_row', label: 'Append row',  description: 'Add a row at the bottom of a sheet.',  iconName: 'Plus', apiPath: '/api/google/sheets/append', apiMethod: 'POST', workflowNodeType: 'update_sheet', uiKind: 'modal', status: 'live',
      inputSchema: { fields: [
        { key: 'spreadsheet_id', label: 'Spreadsheet', type: 'resource', required: true,
          picker: { endpoint: '/api/google/spreadsheets', labelKey: 'name', valueKey: 'id' } },
        { key: 'sheet_name',     label: 'Sheet / tab',  type: 'resource', required: true,
          picker: { endpoint: '/api/google/sheets/{{spreadsheet_id}}/tabs', dependsOn: 'spreadsheet_id', labelKey: 'name', valueKey: 'name' } },
        { key: 'values',         label: 'Row values (JSON or comma-sep)', type: 'textarea', required: true, supportsVariables: true,
          placeholder: '"John", "+919876543210", "Lead"' },
      ] },
      outputSchema: { fields: [
        { key: 'updated_range', label: 'Updated range', type: 'string', sample: 'Sheet1!A12:C12' },
        { key: 'updated_rows',  label: 'Rows updated',  type: 'number', sample: 1 },
      ] },
      testRunnable: true,
    },
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
  category: 'email',
  tier: 0,
  status: 'live',
  authMode: 'oauth',
  brandColor: '#EA4335',
  iconName: 'Mail',
  shortDescription: 'Send + receive email, trigger workflows on inbound.',
  docsUrl: 'https://developers.google.com/gmail/api',
  oauthScope: 'https://www.googleapis.com/auth/gmail.modify',
  capabilities: [
    { key: 'send_email',     label: 'Send email',     description: 'Send a one-off email via your Gmail.',         iconName: 'Send',        apiPath: '/api/google/gmail/send',     apiMethod: 'POST', workflowNodeType: 'send_email',          uiKind: 'modal', status: 'stub' },
    { key: 'forward_email',  label: 'Forward email',  description: 'Forward an inbound email to another address.', iconName: 'Forward',     apiPath: '/api/google/gmail/forward',  apiMethod: 'POST', workflowNodeType: 'forward_email',       uiKind: 'modal', status: 'stub' },
    { key: 'list_threads',   label: 'Recent threads', description: 'Latest email threads matching a query.',       iconName: 'Mail',        apiPath: '/api/google/gmail/threads',  apiMethod: 'GET',                                          uiKind: 'list',  status: 'planned' as any },
  ],
}

const RAZORPAY: ConnectorDef = {
  key: 'razorpay',
  name: 'Razorpay',
  category: 'payments',
  tier: 0,
  status: 'live',
  authMode: 'api_key',
  brandColor: '#0C3B91',
  iconName: 'CreditCard',
  shortDescription: 'Collect payments, generate links, refund, query status.',
  docsUrl: 'https://razorpay.com/docs/api/',
  consoleUrl: 'https://dashboard.razorpay.com/app/keys',
  setupNote: 'Paste keys today; OAuth via Razorpay Partner program coming after we register (1-3 days approval).',
  capabilities: [
    { key: 'create_payment_link', label: 'Create payment link', description: 'Generate a hosted payment URL with optional reminders.',   iconName: 'Link',           apiPath: '/api/connectors/razorpay/payment-links',          apiMethod: 'POST',  workflowNodeType: 'razorpay_create_payment_link', uiKind: 'modal', status: 'live',
      inputSchema: { fields: [
        { key: 'amount',     label: 'Amount (INR)', type: 'number', required: true, supportsVariables: true, placeholder: '1499' },
        { key: 'description',label: 'Description',  type: 'text',                  supportsVariables: true, placeholder: 'Plan upgrade' },
        { key: 'customer_phone', label: 'Customer phone', type: 'text', supportsVariables: true, placeholder: '{{trigger.contact.phone}}' },
        { key: 'customer_name',  label: 'Customer name',  type: 'text', supportsVariables: true },
      ] },
      outputSchema: { fields: [
        { key: 'payment_link.id',         label: 'Payment link ID', type: 'string', sample: 'plink_abc123' },
        { key: 'payment_link.short_url',  label: 'Short URL',       type: 'string', sample: 'https://rzp.io/i/xyz' },
        { key: 'payment_link.amount',     label: 'Amount',          type: 'number', sample: 1499 },
        { key: 'payment_link.status',     label: 'Status',          type: 'string', sample: 'created' },
      ] },
      testRunnable: true,
    },
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
// ─────────────────────────────────────────────────────────────────────────────
const STRIPE: ConnectorDef = {
  key: 'stripe', name: 'Stripe', category: 'payments', tier: 1, status: 'planned',
  authMode: 'oauth', brandColor: '#635BFF', iconName: 'CreditCard',
  shortDescription: 'Global counterpart to Razorpay. Payment links, subscriptions, refunds.',
  docsUrl: 'https://stripe.com/docs/api',
  requiresPartnerRegistration: true,
  setupNote: 'Stripe Connect platform registration required.',
  capabilities: [],
}
const CALENDLY: ConnectorDef = {
  key: 'calendly', name: 'Calendly', category: 'calendar', tier: 1, status: 'planned',
  authMode: 'oauth', brandColor: '#006BFF', iconName: 'Calendar',
  shortDescription: 'Booking links, availability, on-event-created triggers.',
  docsUrl: 'https://developer.calendly.com/api-docs',
  capabilities: [],
}
const TYPEFORM: ConnectorDef = {
  key: 'typeform', name: 'Typeform', category: 'forms', tier: 1, status: 'planned',
  authMode: 'oauth', brandColor: '#262627', iconName: 'FileText',
  shortDescription: 'On-form-submit trigger → WhatsApp / CRM / Sheet.',
  docsUrl: 'https://www.typeform.com/developers/get-started/',
  capabilities: [],
}
const MAILCHIMP: ConnectorDef = {
  key: 'mailchimp', name: 'Mailchimp', category: 'email_marketing', tier: 1, status: 'planned',
  authMode: 'oauth', brandColor: '#FFE01B', iconName: 'Mail',
  shortDescription: 'Email campaigns, audience sync, subscribe/unsubscribe events.',
  docsUrl: 'https://mailchimp.com/developer/marketing/',
  capabilities: [],
}
const HUBSPOT: ConnectorDef = {
  key: 'hubspot', name: 'HubSpot', category: 'crm', tier: 1, status: 'planned',
  authMode: 'oauth', brandColor: '#FF7A59', iconName: 'Briefcase',
  shortDescription: 'Two-way contact + deal sync. Push WhatsApp leads into HubSpot.',
  docsUrl: 'https://developers.hubspot.com/docs/api/overview',
  capabilities: [],
}
const SLACK: ConnectorDef = {
  key: 'slack', name: 'Slack', category: 'communication', tier: 1, status: 'planned',
  authMode: 'oauth', brandColor: '#4A154B', iconName: 'Hash',
  shortDescription: 'Notify channels on events, post messages from workflows.',
  docsUrl: 'https://api.slack.com/',
  capabilities: [],
}
const NOTION: ConnectorDef = {
  key: 'notion', name: 'Notion', category: 'productivity', tier: 1, status: 'planned',
  authMode: 'oauth', brandColor: '#000000', iconName: 'BookOpen',
  shortDescription: 'Add page on event, search a knowledge base from a workflow.',
  docsUrl: 'https://developers.notion.com/',
  capabilities: [],
}
const WOOCOMMERCE: ConnectorDef = {
  key: 'woocommerce', name: 'WooCommerce', category: 'commerce', tier: 1, status: 'planned',
  authMode: 'api_key', brandColor: '#7F54B3', iconName: 'ShoppingCart',
  shortDescription: 'D2C alternative to Shopify (very common in IN). REST API key + URL.',
  docsUrl: 'https://woocommerce.github.io/woocommerce-rest-api-docs/',
  capabilities: [],
}
const ZOHO: ConnectorDef = {
  key: 'zoho_crm', name: 'Zoho CRM', category: 'crm', tier: 1, status: 'planned',
  authMode: 'oauth', brandColor: '#C8202F', iconName: 'Briefcase',
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
  // Channel apps first
  WHATSAPP, INSTAGRAM, TELEGRAM,
  // Ads
  META_ADS,
  // Productivity / data
  GOOGLE_DRIVE, GOOGLE_SHEETS, GOOGLE_CALENDAR, GMAIL,
  RAZORPAY, AIRTABLE, SHOPIFY,
  // Tier 1 planned
  STRIPE, CALENDLY, TYPEFORM, MAILCHIMP, HUBSPOT, SLACK, NOTION, WOOCOMMERCE, ZOHO,
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
    isChannel: !!c.isChannel,
    channelFeatures: c.channelFeatures ?? [],
  }))
}
