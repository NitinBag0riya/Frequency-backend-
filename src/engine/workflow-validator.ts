/**
 * Pre-flight workflow validator — answers "will this workflow execute?"
 * BEFORE the user hits save / first run.
 *
 * Two failure modes to surface up-front:
 *
 *   1. Missing connections — workflow has a node that needs Razorpay /
 *      Airtable / etc. but the tenant hasn't connected that service yet.
 *      Without this preview, the user would only find out when the node
 *      runs in production and writes a 'Razorpay not connected' error
 *      to workflow_executions. By then it's too late — the customer was
 *      mid-conversation.
 *
 *   2. Structural issues — orphaned trigger, missing required cfg fields,
 *      reference to a node id that doesn't exist in the same workflow,
 *      cycles in start_workflow chains. Each one returned with the
 *      offending node id so the FE inspector can highlight it.
 *
 * Two API surfaces use this:
 *   - POST /api/workflows/:id/dry-run    — validates a saved workflow
 *   - POST /api/workflows/preview         — validates an unsaved nodes[]
 *     array (called from the FE while the user is still authoring)
 *
 * The validator is PURE w.r.t. the nodes argument — no DB writes. It DOES
 * query the DB to check connection state, but that's read-only.
 */

import type { SupabaseClient } from '@supabase/supabase-js'

export type ConnectorKey =
  | 'whatsapp' | 'instagram' | 'telegram'
  | 'google' | 'razorpay' | 'airtable' | 'shopify' | 'slack'

export interface NodeIssue {
  node_id:   string
  node_type: string
  severity:  'error' | 'warning'
  message:   string
}

export interface MissingConnector {
  key:         ConnectorKey
  /** Friendly label shown in the upgrade modal. */
  label:       string
  /** Which node ids in this workflow need this connector. */
  needed_for:  Array<{ node_id: string; node_type: string }>
  /** FE deep-link to the right Settings/Apps surface. */
  connect_url: string
}

export interface ValidationReport {
  /** Can the workflow execute as-is (all required connectors present, no
   *  blocking structural errors)? */
  ok: boolean
  /** Triggers found in the workflow. Empty array = workflow has no entry
   *  point and will never fire. */
  triggers: Array<{ node_id: string; type: string; summary: string }>
  /** All connectors any node references. */
  required_connectors: ConnectorKey[]
  /** Subset of required_connectors that aren't connected for this tenant. */
  missing_connectors: MissingConnector[]
  /** Per-node issues (errors block execution, warnings don't). */
  node_issues: NodeIssue[]
  /** High-level workflow summary for the FE preview header. */
  summary: {
    node_count:        number
    action_node_count: number
    trigger_count:     number
    estimated_complexity: 'simple' | 'medium' | 'complex'
  }
}

// ── Node → connector mapping ─────────────────────────────────────────────────
//
// For each node type we know about, which connector does it require? This
// is the source of truth — keep in sync with src/engine/executor.ts.
//
// `null` means the node has no external dependency (HTTP request, conditions,
// AI responder, contact mutations, etc.).
//
// `'channel:dynamic'` means the requirement depends on the workflow's trigger
// channel — those nodes (`send_text`, `send_template`, etc.) work on any
// connected channel; the validator handles them specially.
type NodeConnectorReq = ConnectorKey | 'channel:dynamic' | null

const NODE_CONNECTOR_MAP: Record<string, NodeConnectorReq> = {
  // Channel-dependent (resolved against the workflow's actual trigger channels)
  send_text:                'channel:dynamic',
  send_template:            'channel:dynamic',
  send_interactive:         'channel:dynamic',
  send_media:               'channel:dynamic',
  collect_input:            'channel:dynamic',

  // Email — Resend is the global fallback so technically nothing is required;
  // we surface a soft warning (not error) if Google's not connected so the
  // user knows email will go from our domain, not theirs.
  send_email:    null,
  forward_email: null,

  // Google-specific
  gmail_send_email:           'google',
  update_sheet:               'google',
  create_calendar_event:      'google',
  check_calendar_availability:'google',

  // Connector-specific
  payment:                    'razorpay',
  razorpay_list_payments:     'razorpay',
  razorpay_get_payment:       'razorpay',
  razorpay_refund_payment:    'razorpay',
  razorpay_list_subscriptions:'razorpay',
  airtable_list_records:      'airtable',
  airtable_create_record:     'airtable',
  airtable_update_record:     'airtable',
  shopify_list_orders:        'shopify',
  shopify_get_order:          'shopify',
  shopify_list_products:      'shopify',
  shopify_create_draft_order: 'shopify',
  slack_send_message:         'slack',

  // No external dependency
  http_request:    null,
  run_ai_responder:null,
  add_tag:         null,
  assign_agent:    null,
  update_crm:      null,
  condition_reply: null,
  condition_button_click: null,
  condition_variable: null,
  wait_delay:      null,
  followup:        null,
  end_flow:        null,
  start_workflow:  null,
  notify_human:    null,
}

// Triggers — what channel each requires.
const TRIGGER_CHANNEL_MAP: Record<string, ConnectorKey | null> = {
  trigger_inbound_keyword: null,           // depends on cfg.channels filter
  trigger_inbound_email:   'google',
  // Future: trigger_inbound_comment (instagram), trigger_telegram_command, etc.
}

// FE deep links — where to send the user to fix a missing connection.
const CONNECTOR_LABEL: Record<ConnectorKey, { label: string; url: string }> = {
  whatsapp:  { label: 'WhatsApp Business', url: '/settings?tab=apps&app=whatsapp' },
  instagram: { label: 'Instagram',         url: '/settings?tab=apps&app=instagram' },
  telegram:  { label: 'Telegram',          url: '/settings?tab=apps&app=telegram' },
  google:    { label: 'Google',            url: '/settings?tab=apps&app=google_drive' },
  razorpay:  { label: 'Razorpay',          url: '/settings?tab=apps&app=razorpay' },
  airtable:  { label: 'Airtable',          url: '/settings?tab=apps&app=airtable' },
  shopify:   { label: 'Shopify',           url: '/settings?tab=apps&app=shopify' },
  slack:     { label: 'Slack',             url: '/settings?tab=apps&app=slack' },
}

// ── Connection state probe ───────────────────────────────────────────────────
// Reads the DB once per validation call to figure out which connectors the
// tenant actually has wired up. Each check mirrors the read pattern used by
// the corresponding sender / op handler — if the read returns truthy here
// AND the connection is healthy enough for the sender to use it, we say
// "connected".
async function loadConnectionState(
  supabase: SupabaseClient,
  tenantId: string,
): Promise<Record<ConnectorKey, boolean>> {
  const state: Record<ConnectorKey, boolean> = {
    whatsapp: false, instagram: false, telegram: false,
    google: false, razorpay: false, airtable: false, shopify: false, slack: false,
  }

  // WhatsApp + Google live on the tenants row.
  const { data: tenant } = await supabase.from('tenants')
    .select('phone_number_id, access_token, status, google_access_token')
    .eq('id', tenantId).maybeSingle()
  if (tenant) {
    state.whatsapp = !!tenant.phone_number_id && !!tenant.access_token && tenant.status !== 'disconnected'
    state.google   = !!tenant.google_access_token
  }

  // Telegram lives in tg_bots.
  const { data: tg } = await supabase.from('tg_bots')
    .select('tenant_id').eq('tenant_id', tenantId).maybeSingle()
  state.telegram = !!tg

  // Everything else lives in tenant_integrations as (tenant_id, key) rows
  // with status='active'. One query covers all.
  const { data: integrations } = await supabase.from('tenant_integrations')
    .select('key, status')
    .eq('tenant_id', tenantId)
  for (const row of (integrations ?? []) as any[]) {
    if (row.status && row.status !== 'active') continue
    if (row.key === 'instagram') state.instagram = true
    if (row.key === 'razorpay')  state.razorpay  = true
    if (row.key === 'airtable')  state.airtable  = true
    if (row.key === 'shopify')   state.shopify   = true
    if (row.key === 'slack')     state.slack     = true
  }

  return state
}

// ── Per-node config validators ────────────────────────────────────────────────
// Each function returns an issue if the cfg is missing required fields for
// THAT node type. Don't over-validate — the executor's `interpolate()` is
// forgiving for missing variable expansions.
function validateNodeConfig(node: any): NodeIssue[] {
  const issues: NodeIssue[] = []
  const cfg = node.config ?? {}
  const nid = node.id ?? '(unnamed)'
  const t   = node.type

  const err = (message: string): NodeIssue => ({ node_id: nid, node_type: t, severity: 'error', message })
  const warn = (message: string): NodeIssue => ({ node_id: nid, node_type: t, severity: 'warning', message })

  switch (t) {
    case 'send_text':
      if (!cfg.text) issues.push(err('send_text: cfg.text is required'))
      break
    case 'send_template':
      if (!cfg.template_name) issues.push(err('send_template: cfg.template_name is required'))
      break
    case 'send_media':
      if (!cfg.media_type && !cfg.type) issues.push(err('send_media: cfg.media_type required (image|video|audio|document)'))
      if (!cfg.link && !cfg.media_id && !cfg.id)
        issues.push(err('send_media: cfg.link OR cfg.media_id required'))
      break
    case 'send_email':
    case 'forward_email':
      if (!cfg.to_email) issues.push(err(`${t}: cfg.to_email is required`))
      if (!cfg.subject)  issues.push(warn(`${t}: cfg.subject is empty — will send "(no subject)"`))
      if (!cfg.body && !cfg.body_template) issues.push(err(`${t}: cfg.body or cfg.body_template is required`))
      break
    case 'wait_delay': {
      const m = Number(cfg.delay_minutes ?? 0), s = Number(cfg.delay_seconds ?? 0)
      if (m + s <= 0) issues.push(err('wait_delay: cfg.delay_minutes or cfg.delay_seconds must be > 0'))
      break
    }
    case 'condition_variable':
      if (!cfg.variable) issues.push(err('condition_variable: cfg.variable is required'))
      if (!cfg.operator) issues.push(err('condition_variable: cfg.operator is required (equals|not_equals|contains|gt|lt|exists|empty)'))
      break
    case 'http_request':
      if (!cfg.url)    issues.push(err('http_request: cfg.url is required'))
      if (!cfg.method) issues.push(warn('http_request: cfg.method missing — will default to GET'))
      break
    case 'update_sheet':
      if (!cfg.spreadsheet_id) issues.push(err('update_sheet: cfg.spreadsheet_id is required'))
      if (!cfg.range && cfg.mode !== 'append') issues.push(err('update_sheet: cfg.range is required for update mode'))
      break
    case 'create_calendar_event':
      if (!cfg.summary)    issues.push(err('create_calendar_event: cfg.summary is required'))
      if (!cfg.start_time) issues.push(err('create_calendar_event: cfg.start_time is required'))
      if (!cfg.end_time)   issues.push(err('create_calendar_event: cfg.end_time is required'))
      break
    case 'add_tag':
      if (!cfg.tag) issues.push(err('add_tag: cfg.tag is required'))
      break
    case 'payment':
      if (!cfg.amount)      issues.push(err('payment: cfg.amount (INR rupees) is required'))
      if (!cfg.description) issues.push(warn('payment: cfg.description is empty — Razorpay will show generic label'))
      break
    case 'followup': {
      const m = Number(cfg.delay_minutes ?? 0), s = Number(cfg.delay_seconds ?? 0)
      if (m + s <= 0) issues.push(err('followup: delay_minutes or delay_seconds must be > 0'))
      if (!cfg.text && !cfg.media) issues.push(err('followup: cfg.text or cfg.media is required'))
      break
    }
    case 'connector_call':
      if (!cfg.op || !String(cfg.op).includes('.'))
        issues.push(err("connector_call: cfg.op must be 'connector.operation' (e.g. 'airtable.create_record')"))
      break
    case 'trigger_inbound_keyword': {
      const kws: string[] = cfg.keywords ?? []
      if (kws.length === 0) issues.push(err('trigger_inbound_keyword: cfg.keywords[] cannot be empty'))
      break
    }
    case 'trigger_inbound_email':
      if (!cfg.keywords && !cfg.subject_keywords && !cfg.from)
        issues.push(warn('trigger_inbound_email: no filters set — will fire on EVERY inbound email'))
      break
  }
  return issues
}

// ── Reference checking ──────────────────────────────────────────────────────
function validateConnections(nodes: any[]): NodeIssue[] {
  const issues: NodeIssue[] = []
  const idSet = new Set(nodes.map(n => n.id).filter(Boolean))
  for (const n of nodes) {
    const conns: Record<string, string> = n.connections ?? {}
    for (const [branch, targetId] of Object.entries(conns)) {
      if (targetId && !idSet.has(targetId)) {
        issues.push({
          node_id:   n.id ?? '(unnamed)',
          node_type: n.type,
          severity:  'error',
          message:   `Connection '${branch}' → '${targetId}' references a node that doesn't exist in this workflow`,
        })
      }
    }
  }
  return issues
}

// ── Channel inference for `channel:dynamic` nodes ───────────────────────────
// Look at the workflow's triggers — what channels can fire it? A `send_text`
// node only needs each of those channels connected (since it'll route via
// session.channel back to the trigger channel).
function inferTriggerChannels(nodes: any[]): ConnectorKey[] {
  const channels = new Set<ConnectorKey>()
  for (const n of nodes) {
    if (n.type === 'trigger_inbound_keyword') {
      const cfgChannels: string[] | undefined = n.config?.channels
      if (cfgChannels && cfgChannels.length > 0) {
        for (const c of cfgChannels) {
          if (c === 'whatsapp' || c === 'instagram' || c === 'telegram') channels.add(c)
        }
      } else {
        // No channel filter → trigger fires on any connected channel.
        // We can't know in advance which one the user will end up using,
        // so report all three as potentially needed.
        channels.add('whatsapp'); channels.add('instagram'); channels.add('telegram')
      }
    }
    if (n.type === 'trigger_inbound_email') {
      // Email-triggered workflow → still uses 'whatsapp' as channel placeholder
      // for session.channel today, but downstream sends won't actually use it
      // unless authored with a channel-aware node. Report whatsapp as the
      // implicit reply channel.
      channels.add('whatsapp')
    }
  }
  // No triggers found → assume any of the 3 (the user might wire it manually
  // via /api/workflows/:id/start later).
  if (channels.size === 0) {
    channels.add('whatsapp')
  }
  return Array.from(channels)
}

// ── Public entry point ──────────────────────────────────────────────────────
export async function validateWorkflow(
  supabase: SupabaseClient,
  tenantId: string,
  nodes: any[],
): Promise<ValidationReport> {
  const safeNodes: any[] = Array.isArray(nodes) ? nodes : []

  // ── 1. Per-node validation ──────────────────────────────────────────────
  const nodeIssues: NodeIssue[] = []
  for (const n of safeNodes) {
    if (!n?.type) {
      nodeIssues.push({ node_id: n?.id ?? '(unnamed)', node_type: '(missing)', severity: 'error',
        message: 'Node has no type field' })
      continue
    }
    nodeIssues.push(...validateNodeConfig(n))
  }

  // Reference integrity (connections.targetId → must exist).
  nodeIssues.push(...validateConnections(safeNodes))

  // ── 2. Triggers ─────────────────────────────────────────────────────────
  const triggers = safeNodes
    .filter(n => typeof n.type === 'string' && n.type.startsWith('trigger_'))
    .map(n => ({
      node_id: n.id ?? '(unnamed)',
      type:    n.type,
      summary: triggerSummary(n),
    }))
  if (triggers.length === 0 && safeNodes.length > 0) {
    nodeIssues.push({
      node_id: '(workflow)', node_type: '(workflow)', severity: 'error',
      message: 'Workflow has no trigger node — it will never fire automatically. Add a trigger_inbound_keyword or trigger_inbound_email node.',
    })
  }

  // ── 3. Required connectors ──────────────────────────────────────────────
  const triggerChannels = inferTriggerChannels(safeNodes)
  const required = new Set<ConnectorKey>()
  const requiredBy = new Map<ConnectorKey, Array<{ node_id: string; node_type: string }>>()

  const addRequirement = (k: ConnectorKey, nodeId: string, nodeType: string) => {
    required.add(k)
    if (!requiredBy.has(k)) requiredBy.set(k, [])
    requiredBy.get(k)!.push({ node_id: nodeId, node_type: nodeType })
  }

  for (const n of safeNodes) {
    const t = n.type
    const nid = n.id ?? '(unnamed)'

    // Trigger requirements.
    if (typeof t === 'string' && t.startsWith('trigger_')) {
      const tReq = TRIGGER_CHANNEL_MAP[t]
      if (tReq) addRequirement(tReq, nid, t)
      continue
    }

    // Action requirements.
    const req = NODE_CONNECTOR_MAP[t]
    if (req == null) continue
    if (req === 'channel:dynamic') {
      // Channel-dependent send needs at least one of the trigger channels.
      for (const c of triggerChannels) addRequirement(c, nid, t)
      continue
    }
    if (req) addRequirement(req, nid, t)

    // connector_call: derive connector from cfg.op prefix.
    if (t === 'connector_call') {
      const op = String(n.config?.op ?? '')
      const prefix = op.split('.')[0] as ConnectorKey
      if (prefix && (CONNECTOR_LABEL as any)[prefix]) {
        addRequirement(prefix, nid, t)
      }
    }
  }

  // ── 4. Probe connection state ───────────────────────────────────────────
  const state = await loadConnectionState(supabase, tenantId)

  const missing: MissingConnector[] = []
  for (const k of required) {
    if (state[k]) continue
    const meta = CONNECTOR_LABEL[k]
    missing.push({
      key:         k,
      label:       meta.label,
      needed_for:  requiredBy.get(k) ?? [],
      connect_url: meta.url,
    })
  }

  // ── 5. Summary ──────────────────────────────────────────────────────────
  const actionCount = safeNodes.filter(n => !n?.type?.startsWith('trigger_')).length
  const complexity: ValidationReport['summary']['estimated_complexity'] =
    safeNodes.length <= 5  ? 'simple'
    : safeNodes.length <= 15 ? 'medium'
    :                          'complex'

  const blockingErrors = nodeIssues.some(i => i.severity === 'error')
  const ok = !blockingErrors && missing.length === 0

  return {
    ok,
    triggers,
    required_connectors: Array.from(required),
    missing_connectors:  missing,
    node_issues:         nodeIssues,
    summary: {
      node_count:           safeNodes.length,
      action_node_count:    actionCount,
      trigger_count:        triggers.length,
      estimated_complexity: complexity,
    },
  }
}

function triggerSummary(n: any): string {
  const cfg = n.config ?? {}
  if (n.type === 'trigger_inbound_keyword') {
    const kws = (cfg.keywords ?? []).slice(0, 3).join(', ')
    const channels = cfg.channels?.length > 0 ? ` (${cfg.channels.join('/')})` : ''
    return `Inbound message containing: ${kws || '(no keywords set)'}${channels}`
  }
  if (n.type === 'trigger_inbound_email') {
    const filters: string[] = []
    if (cfg.from) filters.push(`from ~ ${cfg.from}`)
    if (cfg.subject_keywords?.length) filters.push(`subject ~ ${cfg.subject_keywords.join(', ')}`)
    if (cfg.keywords?.length) filters.push(`body ~ ${cfg.keywords.join(', ')}`)
    return `Inbound Gmail: ${filters.join(' AND ') || 'ALL emails'}`
  }
  return n.type
}
