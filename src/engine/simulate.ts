/**
 * Workflow simulation helpers.
 *
 * The executor (engine/executor.ts) is a single switch statement. When the
 * `simulate` flag is set on ExecCtx, each side-effecting case short-circuits
 * via the helpers in this file:
 *
 *   - `simulatedConnectorOutput(op)` looks up the op in the connector
 *     registry's outputSchema.fields and returns an object mapping each
 *     field's `key` → `sample` value. That becomes the synthetic
 *     `result.output` the next workflow node sees in its input.
 *
 *   - `simulatedNodeOutput(nodeType)` does the same for node types that map
 *     1:1 to a capability (send_template, send_text, send_media, payment,
 *     update_sheet, …). When a node type doesn't have a registry entry, we
 *     fall back to a tiny shape that covers the common downstream branch
 *     (`{ ok: true, simulated: true }`).
 *
 *   - `wouldHaveDoneFor(nodeType, args)` builds a human-readable string for
 *     the simulation trace ("would have sent template 'lead_welcome_bhk' to
 *     +91…", "would have created Razorpay payment_link for ₹1499", "would
 *     have posted https://hooks.zapier.com/…"). The FE renders this verbatim
 *     in the step card.
 *
 * Design notes:
 *   - These helpers MUST be pure + sync — no DB, no fetch, no queue. The
 *     whole point of simulation is "executes without firing side effects".
 *   - Connector op resolution mirrors the executor's logic: explicit `cfg.op`
 *     for `connector_call`, else derive from node type by replacing the first
 *     underscore with a dot (airtable_create_record → airtable.create_record).
 *   - For nodes that genuinely can't be simulated cleanly (random_branch,
 *     anything with non-deterministic dispatch), we pick the first connection
 *     deterministically in the executor — that's not handled here.
 */

import { CONNECTOR_REGISTRY } from '../connectors/registry'

/** Op-name → capability lookup. Built once at module load. */
const CAPABILITY_BY_OP = (() => {
  const map = new Map<string, { key: string; outputSchema?: { fields: Array<{ key: string; sample?: any }> } }>()
  for (const c of CONNECTOR_REGISTRY) {
    for (const cap of c.capabilities) {
      // Op name in the executor's vocabulary: '<connector>.<capability>'
      map.set(`${c.key}.${cap.key}`, { key: cap.key, outputSchema: cap.outputSchema })
      // Some capabilities also expose a workflow node type — index by that
      // so node types like `send_template`, `razorpay_create_payment_link`,
      // `airtable_create_record` resolve directly without going through op.
      if (cap.workflowNodeType) {
        map.set(`__nodetype__:${cap.workflowNodeType}`, { key: cap.key, outputSchema: cap.outputSchema })
      }
    }
  }
  return map
})()

/**
 * Build a synthetic output object from a capability's outputSchema sample.
 * Returns `null` when no matching capability is found — caller decides the
 * fallback (typically `{ ok: true, simulated: true }`).
 */
function sampleFromOutputSchema(outputSchema?: { fields: Array<{ key: string; sample?: any }> }): Record<string, any> | null {
  if (!outputSchema || !Array.isArray(outputSchema.fields) || outputSchema.fields.length === 0) {
    return null
  }
  const out: Record<string, any> = {}
  for (const f of outputSchema.fields) {
    out[f.key] = f.sample ?? null
  }
  return out
}

/**
 * Synthetic output for a connector op (e.g. 'razorpay.create_payment_link').
 * Always returns a non-null object so the trace + downstream nodes always
 * have something to branch on. The `simulated: true` flag is included for
 * downstream nodes that want to know they're in simulation (e.g. to avoid
 * sending a real follow-up).
 */
export function simulatedConnectorOutput(op: string): Record<string, any> {
  const cap = CAPABILITY_BY_OP.get(op)
  const sample = sampleFromOutputSchema(cap?.outputSchema)
  return {
    simulated: true,
    op,
    ok: true,
    ...(sample ?? {}),
  }
}

/**
 * Synthetic output for a workflow node type (e.g. 'send_template',
 * 'send_text', 'http_request', 'payment'). Used by every side-effecting
 * case in the executor when ctx.simulate is true.
 */
export function simulatedNodeOutput(nodeType: string): Record<string, any> {
  const cap = CAPABILITY_BY_OP.get(`__nodetype__:${nodeType}`)
  const sample = sampleFromOutputSchema(cap?.outputSchema)
  return {
    simulated: true,
    node_type: nodeType,
    ok: true,
    ...(sample ?? {}),
  }
}

/**
 * Build a human-readable "would have done" line for the simulation trace.
 *
 * The FE renders this verbatim inside the step card, so it should read like
 * a sentence ("would have sent template 'lead_welcome_bhk' to +91…") rather
 * than a debug dump. Args are the post-interpolation cfg values — they hold
 * the actual resolved variables the live run would have used.
 */
export function wouldHaveDoneFor(nodeType: string, args: Record<string, any>): string {
  switch (nodeType) {
    case 'send_text':
      return `would have sent text "${truncate(args.text)}"${recipient(args)}`
    case 'send_template': {
      const params = Array.isArray(args.parameters) && args.parameters.length > 0
        ? ` with params [${args.parameters.map((p: any) => `"${truncate(p, 24)}"`).join(', ')}]`
        : ''
      return `would have sent template "${args.template_name ?? '(unknown)'}"${params}${recipient(args)}`
    }
    case 'send_interactive':
      return `would have sent interactive payload${recipient(args)}`
    case 'send_media': {
      const kind = args.media_type ?? args.type ?? 'media'
      const src  = args.link ?? args.media_id ?? args.id ?? '(unknown source)'
      return `would have sent ${kind} (${truncate(String(src))})${recipient(args)}`
    }
    case 'send_email':
    case 'forward_email':
      return `would have sent email "${truncate(args.subject ?? '(no subject)')}" to ${args.to ?? args.to_email ?? '(no recipient)'}`
    case 'http_request':
      return `would have made ${String(args.method ?? 'GET').toUpperCase()} ${truncate(args.url ?? '', 80)}`
    case 'payment':
      return `would have created Razorpay payment link for ₹${args.amount ?? '?'} ("${truncate(args.description ?? 'order')}")${recipient(args)}`
    case 'update_sheet':
      return `would have ${args.mode === 'update' ? 'updated' : 'appended'} row in sheet ${args.spreadsheet_id ?? '(unknown)'}@${args.range ?? '?'}`
    case 'create_calendar_event':
      return `would have created calendar event "${truncate(args.summary ?? '(no title)')}" at ${args.start_time ?? '(no start)'}`
    case 'check_calendar_availability':
      return `would have checked calendar availability ${args.start_time ?? '?'} → ${args.end_time ?? '?'} (simulating "yes")`
    case 'run_ai_responder':
      return `would have called Frequency AI (model ${args.model ?? 'claude-haiku-4-5'}) with system prompt "${truncate(args.system_prompt ?? '')}"`
    case 'update_crm':
      return `would have updated ${args.target === 'contact' || !args.table_id ? 'contact' : `lead row in table ${args.table_id}`} with ${JSON.stringify(args.updates ?? {})}`
    case 'add_tag':
      return `would have added tag "${args.tag ?? '?'}"`
    case 'assign_agent':
      return `would have assigned agent ${args.agent_user_id ?? args.agent ?? '?'}`
    case 'notify_human':
      return `would have paused bot + notified ${args.agent_id ? `agent ${args.agent_id}` : 'all inbox-viewers'} (reason: ${truncate(args.reason ?? '')})`
    case 'followup':
      return `would have scheduled followup ("${truncate(args.text ?? '')}") in ${args.delay_minutes ?? 0}m ${args.delay_seconds ?? 0}s`
    case 'start_workflow':
      return `would have started child workflow ${args.workflow_id ?? '(unknown)'} (simulation does NOT chain)`
    case 'connector_call':
      return `would have called connector op "${args.op ?? '(unknown)'}" with args ${truncate(JSON.stringify(args), 120)}`
    default:
      // Semantic shortcut nodes like 'airtable_create_record',
      // 'razorpay_create_payment_link', 'shopify_list_orders' all fall here.
      // Render the op derived from the node type.
      if (nodeType.includes('_')) {
        const i = nodeType.indexOf('_')
        const op = `${nodeType.slice(0, i)}.${nodeType.slice(i + 1)}`
        return `would have called connector op "${op}" with args ${truncate(JSON.stringify(args), 120)}`
      }
      return `would have run node type "${nodeType}"`
  }
}

function truncate(s: any, n = 60): string {
  const str = String(s ?? '')
  if (str.length <= n) return str
  return str.slice(0, n - 1) + '…'
}

function recipient(args: Record<string, any>): string {
  const to = args.to ?? args.phone ?? args.recipient_id
  return to ? ` to ${to}` : ''
}
