/**
 * Operator tool catalog — the risk-tiered tool layer the autonomous agent
 * reasons over. This is the "Phase 0 / Phase 1" piece from the SellerAI plan:
 * we don't write new provider integrations, we *expose the ones we already
 * have* (engine/connector-ops.ts) to an LLM as callable tools, each tagged
 * with a risk tier and (when risky) an approval action_type.
 *
 * Design:
 *   - Every tool maps 1:1 to an existing connector op id (e.g. 'shopify.list_orders')
 *     so the agent's vocabulary matches the workflow builder + FE picker.
 *   - riskTier drives the approval gate in loop.ts:
 *       'read'         → never gated (no side effects)
 *       'reversible'   → gated only in 'suggest' autonomy
 *       'irreversible' → gated unless autonomy='auto' (spends money / fans out)
 *   - approvalActionType lines up with the existing approval_rules.action_type
 *     vocabulary so requireApproval() can find a matching rule.
 *
 * Adding a tool = add one entry here. The loop and FE don't change.
 *
 * NOTE: input schemas are deliberately permissive (the connector op does its
 * own validation and throws on bad args — the executor records the failure).
 */

import { listAvailableOps } from '../engine/connector-ops'

export type RiskTier = 'read' | 'reversible' | 'irreversible'

export interface OperatorTool {
  /** connector op id passed to dispatchConnectorOp() */
  op: string
  /** short label shown in the trace */
  title: string
  /** description the LLM sees — be explicit about side effects */
  description: string
  riskTier: RiskTier
  /** maps to approval_rules.action_type when the op should be gated */
  approvalActionType?: string
  /** JSON-schema-ish input for the Anthropic tool definition */
  input: {
    type: 'object'
    properties: Record<string, { type: string; description?: string }>
    required?: string[]
  }
}

/**
 * Curated catalog. Only ops that are safe + useful for autonomous operation
 * are surfaced. We intentionally keep this smaller than listAvailableOps() —
 * the agent should not, say, refund a payment unless we deliberately add it
 * with an irreversible tier + approval gate.
 */
export const OPERATOR_TOOLS: OperatorTool[] = [
  // ── Reads (never gated) ────────────────────────────────────────────────────
  {
    op: 'shopify.list_orders',
    title: 'List Shopify orders',
    description: 'Read recent orders from a connected Shopify store. No side effects.',
    riskTier: 'read',
    input: {
      type: 'object',
      properties: {
        store_id: { type: 'string', description: 'Connected Shopify store id (optional; defaults to the tenant\'s primary store).' },
        limit: { type: 'number', description: 'Max orders to return (default 25).' },
      },
    },
  },
  {
    op: 'shopify.list_products',
    title: 'List Shopify products',
    description: 'Read products from a connected Shopify store. No side effects.',
    riskTier: 'read',
    input: {
      type: 'object',
      properties: {
        store_id: { type: 'string' },
        limit: { type: 'number' },
      },
    },
  },
  {
    op: 'razorpay.list_payments',
    title: 'List Razorpay payments',
    description: 'Read recent payments. No side effects.',
    riskTier: 'read',
    input: { type: 'object', properties: { count: { type: 'number' } } },
  },

  // ── Reversible writes (gated only in suggest mode) ──────────────────────────
  {
    op: 'shopify.create_draft_order',
    title: 'Create Shopify draft order',
    description: 'Create a DRAFT order (not charged, not fulfilled). Reversible — drafts can be deleted.',
    riskTier: 'reversible',
    approvalActionType: 'shopify_create_draft_order',
    input: {
      type: 'object',
      properties: {
        store_id: { type: 'string' },
        line_items: { type: 'array', description: 'Array of { variant_id, quantity }.' },
        customer_email: { type: 'string' },
      },
      required: ['line_items'],
    },
  },
  {
    op: 'brevo.create_contact',
    title: 'Create email contact',
    description: 'Upsert a contact into Brevo. Reversible.',
    riskTier: 'reversible',
    approvalActionType: 'create_contact',
    input: {
      type: 'object',
      properties: { email: { type: 'string' }, attributes: { type: 'object' } },
      required: ['email'],
    },
  },

  // ── Irreversible / spend / fan-out (gated unless autonomy='auto') ───────────
  {
    op: 'slack.send_message',
    title: 'Send Slack message',
    description: 'Post a message to a Slack channel. Fans out to people — gated.',
    riskTier: 'irreversible',
    approvalActionType: 'send_message',
    input: {
      type: 'object',
      properties: { channel: { type: 'string' }, text: { type: 'string' } },
      required: ['channel', 'text'],
    },
  },
  {
    op: 'gmail.send_email',
    title: 'Send email',
    description: 'Send an email via the connected Gmail account. Irreversible — gated.',
    riskTier: 'irreversible',
    approvalActionType: 'send_email',
    input: {
      type: 'object',
      properties: { to: { type: 'string' }, subject: { type: 'string' }, body: { type: 'string' } },
      required: ['to', 'subject', 'body'],
    },
  },
  {
    op: 'brevo.send_email',
    title: 'Send marketing email',
    description: 'Send a transactional/marketing email via Brevo. Fans out — gated.',
    riskTier: 'irreversible',
    approvalActionType: 'broadcast_send',
    input: {
      type: 'object',
      properties: { to: { type: 'string' }, subject: { type: 'string' }, htmlContent: { type: 'string' } },
      required: ['to', 'subject', 'htmlContent'],
    },
  },
]

/** Fast lookup by op id. */
export const TOOL_BY_OP: Record<string, OperatorTool> =
  Object.fromEntries(OPERATOR_TOOLS.map(t => [t.op, t]))

/**
 * Build Anthropic tool definitions from the catalog. Tool `name` must match
 * ^[a-zA-Z0-9_-]{1,64}$, so we replace the '.' in op ids with '__' and map
 * back when a tool_use arrives.
 */
export function toAnthropicTools() {
  return OPERATOR_TOOLS.map(t => ({
    name: t.op.replace(/\./g, '__'),
    description: `[risk: ${t.riskTier}] ${t.description}`,
    input_schema: t.input as unknown as Record<string, unknown>,
  }))
}

/** Map an Anthropic tool name (with '__') back to the connector op id. */
export function toolNameToOp(name: string): string {
  return name.replace(/__/g, '.')
}

/**
 * Sanity guard surfaced by the /api/operator/tools endpoint: which catalog
 * tools are actually backed by a live connector op right now. Helps the FE
 * warn "this tool's connector isn't wired" instead of failing at runtime.
 */
export function catalogHealth(): { op: string; backed: boolean }[] {
  const live = new Set(listAvailableOps())
  return OPERATOR_TOOLS.map(t => ({ op: t.op, backed: live.has(t.op) }))
}
