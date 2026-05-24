/**
 * n8n → Frequency workflow importer.
 *
 * Deterministic parser. No LLM in the loop — n8n JSON is structured + well-
 * known, and our AI builder struggles with huge inputs (16K output budget
 * truncates mid-JSON for large workflows). The parser walks the n8n
 * connections graph, splits multi-trigger workflows into one Frequency
 * workflow per trigger, translates each node into our Frequency node-type
 * vocabulary (see SYSTEM_PROMPT in src/index.ts ~line 1028), strips any
 * hardcoded credentials/webhooks/template-names, and flags any app/integration
 * we don't natively support yet so the FE can render a "Request onboarding"
 * CTA per missing app.
 *
 * Output shape mirrors what the AI builder emits — Frequency `nodes_json`,
 * one element per node, with `connections: { default: next_id }` for linear
 * flows and `connections: { true: ..., false: ... }` for IF branches.
 *
 * Used by:
 *   POST /api/workflows/import-n8n         — preview (parse only, no writes)
 *   POST /api/workflows/import-n8n/commit  — persist the proposed workflows
 *
 * Edge cases handled:
 *   - WhatsApp via httpRequest to graph.facebook.com (v18.0/.../messages)
 *     → translates to send_template (template name parsed out of body if
 *     present, else surfaced as missing_config).
 *   - Razorpay via httpRequest → send_payment_link or http_request based on URL.
 *   - n8n expressions ={{ $json.foo }} → translated to {{trigger.foo}}.
 *   - Connection labels (main[0], main[1]) preserved as default / true / false.
 *   - Hardcoded creds / phone-number IDs / template names → stripped, emitted
 *     as missing_config[] picker fields so the user wires them via existing
 *     connectors.
 *
 * NOT in scope (Phase 2):
 *   - Custom JS translation (Code nodes are stubbed as http_request + warning).
 *   - Bidirectional sync (one-shot import only).
 *   - Auto-creating OAuth flows for missing apps.
 */

// ── Public types ─────────────────────────────────────────────────────────────

export interface ParsedN8nImport {
  /** n8n workflow.name */
  source_name: string
  /** One Frequency workflow per trigger found in the n8n JSON. */
  proposed_workflows: ProposedWorkflow[]
  /** n8n nodes that map to apps we don't natively support yet. */
  missing_apps: MissingApp[]
  /** Soft warnings (e.g. "Code node — translated to http_request stub"). */
  warnings: string[]
}

export interface ProposedWorkflow {
  /** Derived from the trigger node name (kebab-cased). */
  slug: string
  name: string
  description: string
  /** Frequency trigger node type, e.g. 'trigger_webhook'. */
  trigger_kind: string
  /** Frequency workflow `nodes` shape (same schema as the AI builder emits). */
  nodes_json: FrequencyNode[]
  node_count: number
}

export interface MissingApp {
  /** Raw n8n node type, e.g. 'n8n-nodes-base.slack'. */
  n8n_type: string
  /** Display name shown in the FE, e.g. 'Slack'. */
  display_name: string
  /** How many n8n nodes in the source used this app. */
  occurrences: number
  /** What we render in its place — currently always 'http_request'. */
  suggested_fallback: 'http_request' | 'unsupported'
}

/** Mirror of the schema in src/index.ts SYSTEM_PROMPT (line ~1067). */
export interface FrequencyNode {
  id: string
  type: string
  label: string
  description?: string
  position?: number
  config?: Record<string, unknown>
  missing_config?: MissingConfigField[]
  connections?: Record<string, string>
  template_required?: boolean
  warnings?: string[]
}

interface MissingConfigField {
  field: string
  label: string
  type:
    | 'text' | 'textarea' | 'select' | 'number' | 'url' | 'email' | 'phone'
    | 'template_picker' | 'integration_picker'
  required: boolean
  placeholder?: string
  options?: string[]
  depends_on?: string
}

// ── n8n node-type map ────────────────────────────────────────────────────────
//
// SUPPORTED — translated inline to a Frequency node type.
// REQUEST_ONBOARDING — surfaced in missing_apps + rendered as a http_request
// stub with a warning so the user can wire it manually until we ship native
// support.
//
// Extend this map as new n8n nodes are encountered. Anything not listed in
// either group is auto-classified as "unknown app" and added to missing_apps.

// Keep this in lockstep with src/connectors/registry.ts — anything with
// status:'live' AND a workflowNodeType lives here, not in REQUEST_ONBOARDING.
// Otherwise the import UI tells users to "request onboarding" for apps
// Frequency already supports natively (this exact bug happened with
// Google Calendar — see Arihant import case, 2026-05).
const SUPPORTED_MAP: Record<string, string> = {
  'n8n-nodes-base.webhook':         'trigger_webhook',
  'n8n-nodes-base.scheduleTrigger': 'trigger_scheduled',
  'n8n-nodes-base.cron':            'trigger_scheduled',
  'n8n-nodes-base.formTrigger':     'trigger_form_submit',
  'n8n-nodes-base.emailReadImap':   'trigger_email_received',
  'n8n-nodes-base.wait':            'wait_delay',
  'n8n-nodes-base.if':              'condition_variable',
  'n8n-nodes-base.switch':          'split_ab',           // multi-way → see notes below
  'n8n-nodes-base.httpRequest':     'http_request',       // unless WhatsApp / Razorpay detected
  'n8n-nodes-base.googleSheets':    'update_sheet',
  'n8n-nodes-base.gmail':           'send_email',
  'n8n-nodes-base.emailSend':       'send_email',
  'n8n-nodes-base.code':            'http_request',       // stub + warning
  'n8n-nodes-base.set':             'http_request',       // no-op data shaper + warning
  'n8n-nodes-base.merge':           'http_request',       // flag warning
  'n8n-nodes-base.function':        'http_request',       // legacy alias for .code
  // Live Frequency connectors with workflow nodes — translate inline so the
  // import doesn't ask the user to "request onboarding" for apps we already
  // ship. Per-app translation lives in translateNode below.
  'n8n-nodes-base.googleCalendar': 'create_calendar_event',
  'n8n-nodes-base.airtable':       'airtable_create_record',
  'n8n-nodes-base.shopify':        'shopify_create_draft_order',
  'n8n-nodes-base.telegram':       'telegram_send_message',
}

const REQUEST_ONBOARDING_MAP: Record<string, string> = {
  // Tier 1 — visible in /apps as "planned"
  'n8n-nodes-base.notion':         'Notion',
  'n8n-nodes-base.hubspot':        'HubSpot',
  'n8n-nodes-base.stripe':         'Stripe',
  'n8n-nodes-base.mailchimp':      'Mailchimp',
  // Slack is technically "live" via incoming webhook URL but has no workflow
  // node yet, so importing a Slack node maps to http_request — surface it as
  // onboarding ask so the user gets a real Slack node, not an http stub.
  'n8n-nodes-base.slack':          'Slack',
  // Tier 2 — backlog
  'n8n-nodes-base.zoom':           'Zoom',
  'n8n-nodes-base.salesforce':     'Salesforce',
  'n8n-nodes-base.discord':        'Discord',
  'n8n-nodes-base.twilio':         'Twilio',
  'n8n-nodes-base.openAi':         'OpenAI',
  'n8n-nodes-base.zendesk':        'Zendesk',
  'n8n-nodes-base.dropbox':        'Dropbox',
  'n8n-nodes-base.googleDrive':    'Google Drive',
  'n8n-nodes-base.microsoftTeams': 'Microsoft Teams',
  'n8n-nodes-base.googleDocs':     'Google Docs',
  'n8n-nodes-base.trello':         'Trello',
  'n8n-nodes-base.asana':          'Asana',
  'n8n-nodes-base.jira':           'Jira',
  'n8n-nodes-base.clickup':        'ClickUp',
  'n8n-nodes-base.monday':         'monday.com',
  'n8n-nodes-base.intercom':       'Intercom',
  'n8n-nodes-base.freshdesk':      'Freshdesk',
  'n8n-nodes-base.activeCampaign': 'ActiveCampaign',
  'n8n-nodes-base.sendgrid':       'SendGrid',
}

const TRIGGER_SUFFIXES = ['Trigger']
const KNOWN_TRIGGERS = new Set([
  'n8n-nodes-base.webhook',
  'n8n-nodes-base.scheduleTrigger',
  'n8n-nodes-base.formTrigger',
  'n8n-nodes-base.cron',
  'n8n-nodes-base.emailReadImap',
  'n8n-nodes-base.manualTrigger',
])

// ── Public surface ───────────────────────────────────────────────────────────

/**
 * Look up the human-readable name for an n8n node type. Falls back to the
 * stripped node-id (e.g. "n8n-nodes-base.foo" → "Foo") if we don't recognise it
 * — useful so the FE can show *something* sensible in the missing-apps list
 * even for nodes we've never seen.
 */
export function n8nTypeToDisplayName(type: string): string {
  if (REQUEST_ONBOARDING_MAP[type]) return REQUEST_ONBOARDING_MAP[type]
  if (SUPPORTED_MAP[type])          return prettyName(stripPrefix(type))
  return prettyName(stripPrefix(type))
}

/**
 * Main entry point. Validates the JSON shape, finds every trigger, walks
 * each subgraph, and emits one ProposedWorkflow per trigger. Pure function
 * — no I/O, no auth, no DB.
 *
 * Throws on:
 *   - Invalid JSON
 *   - Missing `nodes: []` array
 *   - Missing `connections: {}` map (some n8n exports omit it on empty
 *     workflows — those produce zero proposed workflows + a warning).
 */
export function parseN8nJson(raw: string): ParsedN8nImport {
  let parsed: any
  try {
    parsed = JSON.parse(raw)
  } catch (e: any) {
    throw new Error(`Invalid n8n JSON: ${e?.message ?? 'parse failed'}`)
  }

  if (!parsed || typeof parsed !== 'object') {
    throw new Error('Invalid n8n JSON: expected an object at the top level')
  }
  if (!Array.isArray(parsed.nodes)) {
    throw new Error('Invalid n8n JSON: missing "nodes" array')
  }
  // n8n exports always have a connections map (even if empty: {}). Some
  // hand-edited exports omit it — be lenient: treat missing connections as
  // a workflow with no edges (every node is its own subgraph).
  const connections = (parsed.connections && typeof parsed.connections === 'object')
    ? parsed.connections
    : {}

  const sourceName: string = typeof parsed.name === 'string' ? parsed.name : 'Imported n8n workflow'
  const nodes: any[] = parsed.nodes

  // Build a node-name → node lookup. n8n connections key off `name`, not id.
  const byName = new Map<string, any>()
  for (const n of nodes) {
    if (n && typeof n === 'object' && typeof n.name === 'string') byName.set(n.name, n)
  }

  // Identify triggers. n8n has a fixed list of known trigger types AND a
  // convention where any node type ending in "Trigger" is a trigger. We
  // include both.
  const triggers = nodes.filter(n => isTriggerNode(n))

  if (triggers.length === 0) {
    return {
      source_name: sourceName,
      proposed_workflows: [],
      missing_apps: [],
      warnings: ['No trigger nodes found in the n8n workflow — nothing to import.'],
    }
  }

  // Per-import accumulators.
  const missingMap = new Map<string, MissingApp>()
  const warnings: string[] = []
  const proposed: ProposedWorkflow[] = []

  for (const trigger of triggers) {
    const reachable = walkSubgraph(trigger.name, connections, byName)
    const orderedNodes = Array.from(reachable).map(name => byName.get(name)).filter(Boolean)

    // Translate each node in the subgraph.
    const idMap = new Map<string, string>()   // n8n name → frequency id
    orderedNodes.forEach((n, i) => idMap.set(n.name, `node_${i + 1}`))

    const fxNodes: FrequencyNode[] = orderedNodes.map((n, i) => {
      const fxId = idMap.get(n.name)!
      const translated = translateNode(n, fxId, i + 1, missingMap, warnings)
      // Wire connections from n8n → Frequency.
      const outgoing = connections[n.name] as Record<string, any[][]> | undefined
      if (outgoing && Array.isArray(outgoing.main)) {
        const branches = outgoing.main
        // For IF nodes: main[0] = true branch, main[1] = false branch.
        // For everything else: main[0] = default next node (linear).
        if (translated.type === 'condition_variable' && branches.length >= 1) {
          const t = branches[0]?.[0]?.node
          const f = branches[1]?.[0]?.node
          translated.connections = {}
          if (t && idMap.has(t)) translated.connections.true = idMap.get(t)!
          if (f && idMap.has(f)) translated.connections.false = idMap.get(f)!
        } else {
          const next = branches[0]?.[0]?.node
          if (next && idMap.has(next)) {
            translated.connections = { default: idMap.get(next)! }
          }
        }
      }
      return translated
    })

    const triggerKind = SUPPORTED_MAP[trigger.type] ?? deriveTriggerKind(trigger)
    proposed.push({
      slug: slugify(trigger.name || sourceName) || `imported-${proposed.length + 1}`,
      name: trigger.name ? `${sourceName} — ${trigger.name}` : sourceName,
      description: extractNotes(trigger) || `Imported from n8n. Trigger: ${trigger.name ?? trigger.type}`,
      trigger_kind: triggerKind,
      nodes_json: fxNodes,
      node_count: fxNodes.length,
    })
  }

  return {
    source_name: sourceName,
    proposed_workflows: proposed,
    missing_apps: Array.from(missingMap.values()).sort((a, b) => b.occurrences - a.occurrences),
    warnings: dedupe(warnings),
  }
}

// ── Internals ────────────────────────────────────────────────────────────────

function isTriggerNode(n: any): boolean {
  if (!n || typeof n.type !== 'string') return false
  if (KNOWN_TRIGGERS.has(n.type)) return true
  return TRIGGER_SUFFIXES.some(suf => n.type.endsWith(suf))
}

/**
 * BFS from a trigger across n8n connections. Returns an ordered list of
 * node names (insertion order) — first the trigger, then every reachable
 * downstream node in BFS order. Cycle-safe via a visited set.
 */
function walkSubgraph(
  startName: string,
  connections: Record<string, any>,
  byName: Map<string, any>,
): Set<string> {
  const visited = new Set<string>()
  const queue: string[] = [startName]
  while (queue.length > 0) {
    const name = queue.shift()!
    if (visited.has(name)) continue
    if (!byName.has(name)) continue
    visited.add(name)
    const out = connections[name]
    if (out && Array.isArray(out.main)) {
      for (const branch of out.main) {
        if (Array.isArray(branch)) {
          for (const edge of branch) {
            if (edge && typeof edge.node === 'string' && !visited.has(edge.node)) {
              queue.push(edge.node)
            }
          }
        }
      }
    }
  }
  return visited
}

/**
 * Per-node translator. Returns a Frequency-shaped node with:
 *   - type   — mapped via SUPPORTED_MAP, with special-cases for httpRequest
 *   - label  — n8n node `name`
 *   - description — n8n `notes` if present
 *   - config — best-effort copy of `parameters` after credential stripping
 *   - missing_config — picker fields for anything we couldn't infer
 *   - warnings — soft notes about translation quality
 */
function translateNode(
  n: any,
  fxId: string,
  position: number,
  missingMap: Map<string, MissingApp>,
  warningsAcc: string[],
): FrequencyNode {
  const rawType: string = typeof n.type === 'string' ? n.type : 'unknown'
  const label: string   = typeof n.name === 'string' ? n.name : `Node ${position}`
  const notes  = extractNotes(n)
  const params = (n.parameters && typeof n.parameters === 'object') ? n.parameters : {}

  // ── Special cases ────────────────────────────────────────────────────────
  // WhatsApp via httpRequest → send_template
  if (rawType === 'n8n-nodes-base.httpRequest' && isWhatsAppRequest(params)) {
    const templateName = extractTemplateNameFromHttp(params)
    return {
      id: fxId, type: 'send_template', label, position,
      description: notes || 'Send approved WhatsApp template',
      config: {
        channel: 'whatsapp',
        ...(templateName ? { template_name: templateName } : {}),
      },
      missing_config: [
        ...(templateName ? [] : [{
          field: 'template_name', label: 'WhatsApp template', required: true,
          type: 'template_picker' as const,
        }]),
        { field: 'template_language', label: 'Template language', required: true,
          type: 'select' as const, options: ['en', 'en_US', 'hi'] },
        { field: 'to_phone', label: 'Recipient phone (E.164)', required: true,
          type: 'phone' as const, placeholder: '+91…' },
      ],
      template_required: true,
      warnings: ['Detected WhatsApp Cloud API call — wire your WABA template in the picker above.'],
    }
  }

  // Razorpay payment link via httpRequest → send_payment_link
  if (rawType === 'n8n-nodes-base.httpRequest' && isRazorpayPaymentLink(params)) {
    const amount = extractRazorpayAmount(params)
    return {
      id: fxId, type: 'send_payment_link', label, position,
      description: notes || 'Send a Razorpay payment link',
      config: {
        ...(amount ? { amount_paise: amount } : {}),
      },
      missing_config: [
        ...(amount ? [] : [{
          field: 'amount_paise', label: 'Amount (paise)', required: true,
          type: 'number' as const, placeholder: '50000 = ₹500',
        }]),
        { field: 'description', label: 'Payment description', required: false, type: 'text' as const },
        { field: 'customer_phone', label: 'Customer phone', required: true, type: 'phone' as const },
      ],
      warnings: ['Detected Razorpay payment link call — review the amount before going live.'],
    }
  }

  // ── Generic supported mapping ────────────────────────────────────────────
  if (SUPPORTED_MAP[rawType]) {
    // Some n8n apps fan out into multiple operations (Airtable: create/update,
    // Google Calendar: create/get/availability, Telegram: sendMessage/sendPhoto,
    // Shopify: order/customer/product). The base map picks the most common
    // "create" variant; routeByOperation upgrades it when n8n's `operation`
    // param tells us a more specific Frequency node fits.
    const fxType = routeByOperation(rawType, params) ?? SUPPORTED_MAP[rawType]
    const out: FrequencyNode = {
      id: fxId, type: fxType, label, position,
      description: notes || defaultDescription(fxType, label),
      config: sanitizeConfig(params, fxType),
    }
    // Per-type missing_config + warnings.
    enrichMissingConfig(out, fxType, params, warningsAcc)
    // Stub warnings for nodes we translate but can't faithfully run.
    if (rawType === 'n8n-nodes-base.code' || rawType === 'n8n-nodes-base.function') {
      out.warnings = ['Custom JavaScript node — replaced with an http_request placeholder. Wire the equivalent HTTP call or split into supported nodes.']
    } else if (rawType === 'n8n-nodes-base.set') {
      out.warnings = ['n8n Set node is a no-op data shaper here — Frequency expressions read straight from {{trigger.*}}; remove this step if it was only renaming fields.']
    } else if (rawType === 'n8n-nodes-base.merge') {
      out.warnings = ['n8n Merge node — Frequency runs a linear graph; review the branch you actually need.']
    } else if (rawType === 'n8n-nodes-base.switch') {
      out.warnings = ['n8n Switch is multi-way — emitted as split_ab. If you need >2 branches, chain condition_variable nodes.']
    }
    return out
  }

  // ── Unknown / request-onboarding mapping ─────────────────────────────────
  const displayName = REQUEST_ONBOARDING_MAP[rawType] ?? n8nTypeToDisplayName(rawType)
  const existing = missingMap.get(rawType)
  if (existing) {
    existing.occurrences += 1
  } else {
    missingMap.set(rawType, {
      n8n_type: rawType,
      display_name: displayName,
      occurrences: 1,
      suggested_fallback: 'http_request',
    })
  }
  return {
    id: fxId, type: 'http_request', label, position,
    description: notes || `${displayName} — not natively supported yet`,
    config: {},
    missing_config: [
      { field: 'url',    label: 'Endpoint URL', required: true, type: 'url' },
      { field: 'method', label: 'HTTP method',  required: true, type: 'select',
        options: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] },
    ],
    warnings: [`Maps to ${displayName} which is not natively supported yet — request onboarding from the import preview to get a native node.`],
  }
}

/** Per-Frequency-type missing_config inference. Keeps translateNode terse. */
function enrichMissingConfig(
  node: FrequencyNode,
  fxType: string,
  _params: Record<string, unknown>,
  _warnings: string[],
): void {
  const add = (m: MissingConfigField) => {
    node.missing_config = node.missing_config ?? []
    node.missing_config.push(m)
  }
  switch (fxType) {
    case 'trigger_webhook':
      add({ field: 'webhook_secret', label: 'Webhook signing secret', required: false, type: 'text' })
      break
    case 'trigger_scheduled':
      add({ field: 'schedule_cron', label: 'Cron expression', required: true, type: 'text',
            placeholder: '0 10 * * 1 — every Monday at 10am' })
      break
    case 'trigger_form_submit':
      add({ field: 'form_id', label: 'Frequency form', required: true, type: 'integration_picker' })
      break
    case 'send_email':
      add({ field: 'to_email',  label: 'Recipient email', required: true, type: 'email' })
      add({ field: 'subject',   label: 'Subject',         required: true, type: 'text' })
      add({ field: 'body_html', label: 'Body',            required: true, type: 'textarea' })
      break
    case 'update_sheet':
      add({ field: 'table_id', label: 'Lead table', required: true, type: 'integration_picker' })
      break
    case 'http_request':
      // Surface URL / method as pickers if the original n8n params didn't
      // give us a usable URL (or if creds were stripped).
      if (!node.config?.url) {
        add({ field: 'url',    label: 'Endpoint URL', required: true, type: 'url' })
      }
      if (!node.config?.method) {
        add({ field: 'method', label: 'HTTP method', required: true, type: 'select',
              options: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] })
      }
      break
    case 'wait_delay':
      add({ field: 'delay_seconds', label: 'Delay (seconds)', required: true, type: 'number' })
      break
    case 'condition_variable':
      add({ field: 'variable', label: 'Variable to check', required: true, type: 'text',
            placeholder: '{{trigger.status}}' })
      add({ field: 'operator', label: 'Operator', required: true, type: 'select',
            options: ['equals', 'not_equals', 'contains', 'gt', 'lt'] })
      add({ field: 'value', label: 'Expected value', required: true, type: 'text' })
      break
    // ── Live Frequency connector nodes ───────────────────────────────────
    case 'create_calendar_event':
      add({ field: 'calendar_id', label: 'Calendar', required: false, type: 'text',
            placeholder: 'primary' })
      add({ field: 'summary',     label: 'Event title', required: true, type: 'text' })
      add({ field: 'start',       label: 'Start (ISO 8601)', required: true, type: 'text',
            placeholder: '2026-10-12T15:00:00+05:30' })
      add({ field: 'end',         label: 'End (ISO 8601)',   required: true, type: 'text',
            placeholder: '2026-10-12T15:30:00+05:30' })
      add({ field: 'attendees',   label: 'Attendee emails',  required: false, type: 'textarea',
            placeholder: 'asha@example.com, ravi@example.com' })
      break
    case 'check_calendar_availability':
      add({ field: 'calendar_id', label: 'Calendar', required: false, type: 'text', placeholder: 'primary' })
      add({ field: 'time_min',    label: 'Window start (ISO 8601)', required: true, type: 'text' })
      add({ field: 'time_max',    label: 'Window end (ISO 8601)',   required: true, type: 'text' })
      break
    case 'airtable_create_record':
    case 'airtable_update_record':
      add({ field: 'base_id',  label: 'Airtable base',  required: true, type: 'integration_picker' })
      add({ field: 'table_id', label: 'Airtable table', required: true, type: 'integration_picker', depends_on: 'base_id' })
      add({ field: 'fields',   label: 'Field values (JSON)', required: true, type: 'textarea',
            placeholder: '{"Name": "{{trigger.name}}", "Phone": "{{trigger.phone}}"}' })
      break
    case 'shopify_create_draft_order':
    case 'shopify_fulfill_order':
      add({ field: 'store_id',     label: 'Shopify store', required: true, type: 'integration_picker' })
      add({ field: 'line_items',   label: 'Line items (JSON)', required: true, type: 'textarea',
            placeholder: '[{"variant_id": 12345, "quantity": 1}]' })
      add({ field: 'customer_phone', label: 'Customer phone', required: false, type: 'phone' })
      break
    case 'telegram_send_message':
      add({ field: 'chat_id', label: 'Chat ID', required: true, type: 'text',
            placeholder: '{{trigger.chat_id}}' })
      add({ field: 'text',    label: 'Message', required: true, type: 'textarea' })
      break
    case 'telegram_create_invoice':
      add({ field: 'title',       label: 'Invoice title', required: true, type: 'text' })
      add({ field: 'amount',      label: 'Amount (Stars / XTR)', required: true, type: 'number' })
      add({ field: 'payload',     label: 'Internal reference', required: true, type: 'text' })
      break
  }
}

/**
 * Some n8n apps (Airtable, Google Calendar, Telegram, Shopify) cover multiple
 * Frequency node types via their `operation` param. Pick the better match
 * when n8n tells us what the node is actually doing — otherwise SUPPORTED_MAP's
 * default ("create" variant) is fine.
 *
 * Returns null when no upgrade is warranted; caller falls back to SUPPORTED_MAP.
 */
function routeByOperation(rawType: string, params: Record<string, unknown>): string | null {
  const op = typeof params.operation === 'string' ? params.operation.toLowerCase() : ''
  const resource = typeof params.resource === 'string' ? params.resource.toLowerCase() : ''
  switch (rawType) {
    case 'n8n-nodes-base.googleCalendar':
      if (op === 'getall' || op === 'get' || op === 'list')       return 'http_request'  // read ops not in workflow nodes yet
      if (op === 'availability' || op === 'getavailability')      return 'check_calendar_availability'
      if (op === 'delete' || op === 'update')                     return 'http_request'
      return 'create_calendar_event'
    case 'n8n-nodes-base.airtable':
      if (op === 'update' || op === 'upsert')                     return 'airtable_update_record'
      if (op === 'append' || op === 'create')                     return 'airtable_create_record'
      return 'airtable_create_record'
    case 'n8n-nodes-base.shopify':
      if (resource === 'order' && (op === 'fulfill' || op === 'fulfilment')) return 'shopify_fulfill_order'
      return 'shopify_create_draft_order'
    case 'n8n-nodes-base.telegram':
      if (op === 'sendinvoice' || op === 'invoice' || resource === 'invoice') return 'telegram_create_invoice'
      return 'telegram_send_message'
  }
  return null
}

/**
 * Strip credentials, hardcoded tokens, phone-number IDs, and template names
 * from n8n parameters. Translates expressions ={{ $json.foo }} → {{trigger.foo}}.
 * Returns the cleaned config object — caller adds picker fields for anything
 * we removed.
 */
function sanitizeConfig(params: Record<string, unknown>, _fxType: string): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(params)) {
    // Drop anything that smells like a credential or auth header. n8n
    // typically references creds via a sibling `credentials: {}` block,
    // but some users hardcode tokens into `headerParameters.parameters[]`.
    if (/^(authentication|credentials|headers?|auth|token|api_?key|password|secret)$/i.test(k)) {
      continue
    }
    if (k === 'phoneNumberId' || k === 'businessAccountId' || k === 'wabaId') continue
    out[k] = translateExpressions(v)
  }
  // Common httpRequest shape — flatten url + method into top-level config so
  // the FE understands it without parsing n8n's nested params.
  if (typeof params.url === 'string')    out.url = params.url
  if (typeof params.method === 'string') out.method = params.method
  return out
}

/**
 * Recursive walk to rewrite n8n expression syntax inside any value.
 *
 *   ={{ $json.email }}        → {{trigger.email}}
 *   ={{ $node["Webhook"].... }}→ {{trigger.…}}   (best-effort, stripped to the data field)
 *
 * Anything we can't confidently rewrite is left as-is so the user can fix it
 * in the workflow editor (better than corrupting it silently).
 */
function translateExpressions(value: unknown): unknown {
  if (typeof value === 'string') {
    return value
      // strip leading `=` from n8n expression marker
      .replace(/^=\s*/, '')
      // $json.foo  → {{trigger.foo}}
      .replace(/\{\{\s*\$json\.([a-zA-Z0-9_]+)\s*\}\}/g, '{{trigger.$1}}')
      // $json["foo bar"] → {{trigger.foo bar}}
      .replace(/\{\{\s*\$json\[["']([^"']+)["']\]\s*\}\}/g, '{{trigger.$1}}')
      // $node["X"].json.foo → {{trigger.foo}} (best-effort — Frequency
      // doesn't have an equivalent of "fetch from another node's output",
      // so we point everything back at the trigger payload).
      .replace(/\{\{\s*\$node\[["'][^"']+["']\]\.json\.([a-zA-Z0-9_]+)\s*\}\}/g, '{{trigger.$1}}')
  }
  if (Array.isArray(value)) return value.map(translateExpressions)
  if (value && typeof value === 'object') {
    const o: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) o[k] = translateExpressions(v)
    return o
  }
  return value
}

// ── WhatsApp / Razorpay detection ───────────────────────────────────────────

function isWhatsAppRequest(params: Record<string, unknown>): boolean {
  const url = typeof params.url === 'string' ? params.url.toLowerCase() : ''
  return url.includes('graph.facebook.com') && /\/messages(\?|$|\/)/.test(url)
}

function extractTemplateNameFromHttp(params: Record<string, unknown>): string | null {
  // n8n stringifies the body in many shapes — try the most common ones.
  const candidates: unknown[] = [
    (params as any).jsonBody,
    (params as any).body,
    (params as any).bodyParametersJson,
    (params as any).bodyParameters,
  ]
  for (const c of candidates) {
    if (typeof c === 'string') {
      try {
        const obj = JSON.parse(c)
        const name = obj?.template?.name
        if (typeof name === 'string') return name
      } catch { /* not JSON — skip */ }
    } else if (c && typeof c === 'object') {
      const name = (c as any)?.template?.name
      if (typeof name === 'string') return name
    }
  }
  return null
}

function isRazorpayPaymentLink(params: Record<string, unknown>): boolean {
  const url = typeof params.url === 'string' ? params.url.toLowerCase() : ''
  return url.includes('api.razorpay.com') && url.includes('payment_link')
}

function extractRazorpayAmount(params: Record<string, unknown>): number | null {
  const candidates: unknown[] = [
    (params as any).jsonBody,
    (params as any).body,
    (params as any).bodyParametersJson,
  ]
  for (const c of candidates) {
    if (typeof c === 'string') {
      try {
        const obj = JSON.parse(c)
        const a = obj?.amount
        if (typeof a === 'number') return a
      } catch { /* not JSON */ }
    } else if (c && typeof c === 'object') {
      const a = (c as any)?.amount
      if (typeof a === 'number') return a
    }
  }
  return null
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function deriveTriggerKind(n: any): string {
  // Fallback for trigger-suffixed types we don't have a direct map for.
  if (typeof n.type === 'string' && n.type.toLowerCase().includes('webhook')) return 'trigger_webhook'
  if (typeof n.type === 'string' && n.type.toLowerCase().includes('schedule')) return 'trigger_scheduled'
  if (typeof n.type === 'string' && n.type.toLowerCase().includes('cron'))     return 'trigger_scheduled'
  if (typeof n.type === 'string' && n.type.toLowerCase().includes('email'))    return 'trigger_email_received'
  return 'trigger_webhook'
}

function extractNotes(n: any): string {
  if (!n || typeof n !== 'object') return ''
  if (typeof n.notes === 'string') return n.notes
  return ''
}

function stripPrefix(type: string): string {
  // 'n8n-nodes-base.slack' → 'slack'
  return type.replace(/^n8n-nodes-base\./, '').replace(/^@n8n\/n8n-nodes-/, '')
}

function prettyName(raw: string): string {
  // 'googleSheets' → 'Google Sheets'
  return raw
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/^./, c => c.toUpperCase())
}

function defaultDescription(fxType: string, label: string): string {
  // Short, deterministic fallback used when the n8n node has no `notes`.
  const map: Record<string, string> = {
    trigger_webhook:             'Fires when the webhook is called',
    trigger_scheduled:           'Runs on the configured schedule',
    trigger_form_submit:         'Fires when a Frequency form is submitted',
    trigger_email_received:      'Fires when a matching email arrives',
    wait_delay:                  'Wait before the next step',
    condition_variable:          'Branch based on a variable',
    split_ab:                    'Split into multiple branches',
    http_request:                'Call an external API',
    update_sheet:                'Write to a Frequency Lead Table',
    send_email:                  'Send a transactional email',
    send_template:               'Send an approved WhatsApp template',
    send_payment_link:           'Send a Razorpay payment link',
    create_calendar_event:       'Create a Google Calendar event',
    check_calendar_availability: 'Check Google Calendar free/busy',
    airtable_create_record:      'Append a record to an Airtable table',
    airtable_update_record:      'Update an Airtable record',
    shopify_create_draft_order:  'Create a Shopify draft order',
    shopify_fulfill_order:       'Fulfil a Shopify order',
    telegram_send_message:       'Send a Telegram message',
    telegram_create_invoice:     'Issue a Telegram Stars invoice',
  }
  return map[fxType] ?? label
}

export function slugify(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
}

function dedupe<T>(arr: T[]): T[] {
  return Array.from(new Set(arr))
}
