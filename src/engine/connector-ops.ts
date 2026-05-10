/**
 * Connector-ops dispatcher — workflow nodes' bridge to connector APIs.
 *
 * The connector route files (routes/connectors/*.ts) handle HTTP requests
 * from the FE. Workflow nodes need the SAME provider calls without the
 * HTTP middleware in between. Rather than duplicate the auth + fetch +
 * error-handling code in two places, this module wraps each connector's
 * exported helpers with a uniform `execute(supabase, tenantId, op, args)`
 * surface that the executor can call from a single `connector_call` node
 * type or from semantic shortcut nodes (airtable_create_record, etc.).
 *
 * Why a registry pattern (vs hand-writing one executor case per op):
 *   - Adding a new op = one entry in the registry. Executor doesn't change.
 *   - The FE / AI can author `connector_call` with any op without us
 *     needing to ship a new node type.
 *   - Semantic shortcut cases (case 'airtable_create_record':) just call
 *     into the same registry — they're sugar, not parallel impls.
 *
 * Errors propagate up to the executor. The executor wraps them in
 * `{ kind: 'error' }` so the workflow execution row records the failure
 * with the right node id (good for debugging in the FE inspector).
 */

import type { SupabaseClient } from '@supabase/supabase-js'

const RZP   = 'https://api.razorpay.com/v1'
const SHOP  = (shop: string) => `https://${shop}/admin/api/2024-01`
const AIR   = 'https://api.airtable.com/v0'
const GRAPH = 'https://graph.facebook.com/v18.0'

export type ConnectorKey = 'airtable' | 'shopify' | 'razorpay' | 'slack' | 'gmail'

/** What a connector op handler returns to the executor. */
export interface ConnectorOpResult {
  /** Raw response body — workflow puts this in node output for downstream. */
  output: any
  /** Optional convenience extraction (e.g. `id`, `link`) for variableUpdates. */
  primary?: any
}

type OpHandler = (
  supabase: SupabaseClient,
  tenantId: string,
  args: Record<string, any>,
) => Promise<ConnectorOpResult>

// ── Registry ────────────────────────────────────────────────────────────────
//
// Adding a new op: add one entry. The executor doesn't need to change.
// Op names match the connector registry's capability keys 1:1 so the AI
// generating workflows from the catalog uses the same vocabulary the FE shows.
const OPS: Record<string, OpHandler> = {

  // ── Airtable ──────────────────────────────────────────────────────────────
  'airtable.list_records':   async (supabase, tenantId, args) => {
    const { getValidToken } = await import('../routes/connectors/airtable')
    const token = await getValidToken(supabase, tenantId)
    const params = new URLSearchParams()
    if (args.view)        params.set('view', String(args.view))
    if (args.maxRecords)  params.set('maxRecords', String(args.maxRecords))
    if (args.filterByFormula) params.set('filterByFormula', String(args.filterByFormula))
    const url = `${AIR}/${args.base_id}/${encodeURIComponent(args.table_id)}?${params}`
    const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } })
    const body = await r.json() as any
    if (!r.ok) throw new Error(`Airtable list_records ${r.status}: ${body.error?.message ?? 'failed'}`)
    return { output: body, primary: body.records ?? [] }
  },

  'airtable.create_record':  async (supabase, tenantId, args) => {
    const { getValidToken } = await import('../routes/connectors/airtable')
    const token = await getValidToken(supabase, tenantId)
    const r = await fetch(`${AIR}/${args.base_id}/${encodeURIComponent(args.table_id)}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ fields: args.fields ?? {} }),
    })
    const body = await r.json() as any
    if (!r.ok) throw new Error(`Airtable create_record ${r.status}: ${body.error?.message ?? 'failed'}`)
    return { output: body, primary: body.id }
  },

  'airtable.update_record':  async (supabase, tenantId, args) => {
    const { getValidToken } = await import('../routes/connectors/airtable')
    const token = await getValidToken(supabase, tenantId)
    const r = await fetch(`${AIR}/${args.base_id}/${encodeURIComponent(args.table_id)}/${args.record_id}`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ fields: args.fields ?? {} }),
    })
    const body = await r.json() as any
    if (!r.ok) throw new Error(`Airtable update_record ${r.status}: ${body.error?.message ?? 'failed'}`)
    return { output: body, primary: body.id }
  },

  // ── Shopify ───────────────────────────────────────────────────────────────
  'shopify.list_orders':     async (supabase, tenantId, args) => {
    const { loadCreds } = await import('../routes/connectors/shopify')
    const { token, shop } = await loadCreds(supabase, tenantId)
    const params = new URLSearchParams({ limit: String(Math.min(Number(args.limit ?? 25), 250)) })
    if (args.status) params.set('status', String(args.status))
    if (args.financial_status) params.set('financial_status', String(args.financial_status))
    const r = await fetch(`${SHOP(shop)}/orders.json?${params}`, {
      headers: { 'X-Shopify-Access-Token': token },
    })
    const body = await r.json() as any
    if (!r.ok) throw new Error(`Shopify list_orders ${r.status}: ${body.errors ?? 'failed'}`)
    return { output: body, primary: body.orders ?? [] }
  },

  'shopify.get_order':       async (supabase, tenantId, args) => {
    const { loadCreds } = await import('../routes/connectors/shopify')
    const { token, shop } = await loadCreds(supabase, tenantId)
    const r = await fetch(`${SHOP(shop)}/orders/${args.order_id}.json`, {
      headers: { 'X-Shopify-Access-Token': token },
    })
    const body = await r.json() as any
    if (!r.ok) throw new Error(`Shopify get_order ${r.status}: ${body.errors ?? 'failed'}`)
    return { output: body, primary: body.order }
  },

  'shopify.list_products':   async (supabase, tenantId, args) => {
    const { loadCreds } = await import('../routes/connectors/shopify')
    const { token, shop } = await loadCreds(supabase, tenantId)
    const params = new URLSearchParams({ limit: String(Math.min(Number(args.limit ?? 25), 250)) })
    const r = await fetch(`${SHOP(shop)}/products.json?${params}`, {
      headers: { 'X-Shopify-Access-Token': token },
    })
    const body = await r.json() as any
    if (!r.ok) throw new Error(`Shopify list_products ${r.status}: ${body.errors ?? 'failed'}`)
    return { output: body, primary: body.products ?? [] }
  },

  'shopify.create_draft_order': async (supabase, tenantId, args) => {
    const { loadCreds } = await import('../routes/connectors/shopify')
    const { token, shop } = await loadCreds(supabase, tenantId)
    const r = await fetch(`${SHOP(shop)}/draft_orders.json`, {
      method: 'POST',
      headers: { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ draft_order: args.draft_order ?? {} }),
    })
    const body = await r.json() as any
    if (!r.ok) throw new Error(`Shopify create_draft_order ${r.status}: ${body.errors ?? 'failed'}`)
    return { output: body, primary: body.draft_order }
  },

  // ── Razorpay (beyond the dedicated `payment` node which creates payment_links) ──
  'razorpay.list_payments':  async (supabase, tenantId, args) => {
    const { getRazorpayAuthHeader } = await import('../routes/connectors/razorpay')
    const auth = await getRazorpayAuthHeader(supabase, tenantId)
    const params = new URLSearchParams({ count: String(Math.min(Number(args.count ?? 25), 100)) })
    if (args.from) params.set('from', String(args.from))
    if (args.to)   params.set('to',   String(args.to))
    const r = await fetch(`${RZP}/payments?${params}`, { headers: { Authorization: auth } })
    const body = await r.json() as any
    if (!r.ok) throw new Error(`Razorpay list_payments ${r.status}: ${body.error?.description ?? 'failed'}`)
    return { output: body, primary: body.items ?? [] }
  },

  'razorpay.get_payment':    async (supabase, tenantId, args) => {
    const { getRazorpayAuthHeader } = await import('../routes/connectors/razorpay')
    const auth = await getRazorpayAuthHeader(supabase, tenantId)
    const r = await fetch(`${RZP}/payments/${args.payment_id}`, { headers: { Authorization: auth } })
    const body = await r.json() as any
    if (!r.ok) throw new Error(`Razorpay get_payment ${r.status}: ${body.error?.description ?? 'failed'}`)
    return { output: body, primary: body }
  },

  'razorpay.refund_payment': async (supabase, tenantId, args) => {
    const { getRazorpayAuthHeader } = await import('../routes/connectors/razorpay')
    const auth = await getRazorpayAuthHeader(supabase, tenantId)
    const r = await fetch(`${RZP}/payments/${args.payment_id}/refund`, {
      method: 'POST',
      headers: { Authorization: auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        amount: args.amount,           // optional; omit for full refund
        speed:  args.speed ?? 'normal',
        notes:  args.notes,
      }),
    })
    const body = await r.json() as any
    if (!r.ok) throw new Error(`Razorpay refund_payment ${r.status}: ${body.error?.description ?? 'failed'}`)
    return { output: body, primary: body.id }
  },

  'razorpay.list_subscriptions': async (supabase, tenantId, args) => {
    const { getRazorpayAuthHeader } = await import('../routes/connectors/razorpay')
    const auth = await getRazorpayAuthHeader(supabase, tenantId)
    const params = new URLSearchParams({ count: String(Math.min(Number(args.count ?? 25), 100)) })
    const r = await fetch(`${RZP}/subscriptions?${params}`, { headers: { Authorization: auth } })
    const body = await r.json() as any
    if (!r.ok) throw new Error(`Razorpay list_subscriptions ${r.status}: ${body.error?.description ?? 'failed'}`)
    return { output: body, primary: body.items ?? [] }
  },

  // ── Slack (workflow action: post to the connected webhook channel) ────────
  // Different from the notification dispatcher in routes/notifications.ts —
  // that one routes per-event-type prefs. This one is "post this text to my
  // Slack channel right now from a workflow step".
  'slack.send_message':      async (supabase, tenantId, args) => {
    const { getTenantSlackWebhook, sendSlackNotification } = await import('../lib/slack')
    const url = await getTenantSlackWebhook(supabase, tenantId)
    if (!url) throw new Error('Slack not connected for this tenant')
    await sendSlackNotification({
      webhookUrl: url,
      title:      args.title ?? 'Workflow alert',
      body:       args.body  ?? args.text ?? null,
      link:       args.link  ?? null,
      severity:   (args.severity as any) ?? 'info',
    })
    return { output: { ok: true } }
  },

  // ── Gmail — uses tenant's own Gmail OAuth, not Resend ────────────────────
  // For tenants who connected Google with gmail.modify scope (which we
  // request by default on /api/auth/google). Workflow can send AS the
  // tenant's Gmail address so replies land in their inbox + match their
  // brand. Falls back to Resend in the executor if Gmail isn't connected
  // (handled at the message-sender email branch, not here).
  'gmail.send_email':        async (supabase, tenantId, args) => {
    const { gmailSendEmail } = await import('../google')
    const { data: tenant } = await supabase.from('tenants')
      .select('google_access_token, google_refresh_token, google_token_expiry')
      .eq('id', tenantId).maybeSingle()
    if (!tenant?.google_access_token) throw new Error('Gmail not connected — connect Google first')
    const result = await gmailSendEmail(tenant, args.to, args.subject, args.body ?? args.html ?? '')
    return { output: result, primary: result.id }
  },
}

/**
 * Public dispatcher used by the executor. `op` MUST be in the form
 * "connector.operation" (e.g. "airtable.create_record"). Returns the
 * handler result for the executor to merge into node output / variables.
 */
export async function dispatchConnectorOp(
  supabase: SupabaseClient,
  tenantId: string,
  op: string,
  args: Record<string, any> = {},
): Promise<ConnectorOpResult> {
  const handler = OPS[op]
  if (!handler) {
    throw new Error(`Unknown connector op: ${op}. Known ops: ${Object.keys(OPS).join(', ')}`)
  }
  return await handler(supabase, tenantId, args)
}

/** For the /api/connector-ops introspection endpoint — lists what's available. */
export function listAvailableOps(): string[] {
  return Object.keys(OPS).sort()
}
