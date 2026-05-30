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

  // ── Razorpay ──────────────────────────────────────────────────────────────
  // create_payment_link — registry-aligned name for the workflow node that
  // generates a hosted payment URL. The dedicated legacy `payment` node also
  // creates payment_links + sends the URL on the session's channel; this op
  // returns the link to the caller (executor) without auto-sending, so the
  // next workflow node can branch on the response (e.g. log to Sheet,
  // assign to agent, then conditionally send the link).
  //
  // Idempotency / lineage: Razorpay charges nothing for create, so we don't
  // dedupe — but we attach `notes: { run_id, node_id, ... }` so the
  // Razorpay dashboard's payment-link detail page shows exactly which
  // workflow run created the link. Helpful when reconciling failed runs.
  'razorpay.create_payment_link': async (supabase, tenantId, args) => {
    const { getRazorpayAuthHeader, buildPaymentLinkWirePayload } = await import('../routes/connectors/razorpay')
    const auth = await getRazorpayAuthHeader(supabase, tenantId)
    const wire = buildPaymentLinkWirePayload(args as any)
    const r = await fetch(`${RZP}/payment_links`, {
      method: 'POST',
      headers: { Authorization: auth, 'Content-Type': 'application/json' },
      body: JSON.stringify(wire),
    })
    const body = await r.json() as any
    if (!r.ok) throw new Error(`Razorpay create_payment_link ${r.status}: ${body.error?.description ?? 'failed'}`)
    // Surface the most-used fields as `primary` so the executor's
    // response_variable cfg can pull just the link without an extra hop.
    return {
      output: {
        payment_link_id: body.id,
        short_url:       body.short_url ?? body.url ?? null,
        amount:          typeof body.amount === 'number' ? body.amount / 100 : null,
        currency:        body.currency ?? 'INR',
        status:          body.status ?? null,
      },
      primary: body.short_url ?? body.url ?? body.id,
    }
  },

  // ── Razorpay (beyond create_payment_link) ─────────────────────────────────
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

  // ── WooCommerce ───────────────────────────────────────────────────────────
  // Mirrors the HTTP route handlers in routes/connectors/woocommerce.ts but
  // callable from a workflow node. loadCreds returns the canonical store base
  // URL + a ready Basic auth header (consumer_key:consumer_secret).
  'woocommerce.list_orders': async (supabase, tenantId, args) => {
    const { loadCreds } = await import('../routes/connectors/woocommerce')
    const { store, auth } = await loadCreds(supabase, tenantId)
    const params = new URLSearchParams()
    params.set('per_page', String(Math.min(Number(args.limit ?? 50), 100)))
    if (args.status) params.set('status', String(args.status))
    const r = await fetch(`${store}/wp-json/wc/v3/orders?${params}`, { headers: { Authorization: auth } })
    const body = await r.json() as any
    if (!r.ok) throw new Error(`WooCommerce list_orders ${r.status}: ${body?.message ?? 'failed'}`)
    return { output: body, primary: body }
  },

  'woocommerce.get_order': async (supabase, tenantId, args) => {
    const { loadCreds } = await import('../routes/connectors/woocommerce')
    const { store, auth } = await loadCreds(supabase, tenantId)
    const id = encodeURIComponent(String(args.id ?? args.order_id ?? ''))
    const r = await fetch(`${store}/wp-json/wc/v3/orders/${id}`, { headers: { Authorization: auth } })
    const body = await r.json() as any
    if (!r.ok) throw new Error(`WooCommerce get_order ${r.status}: ${body?.message ?? 'failed'}`)
    return { output: body, primary: body?.id }
  },

  'woocommerce.list_products': async (supabase, tenantId, args) => {
    const { loadCreds } = await import('../routes/connectors/woocommerce')
    const { store, auth } = await loadCreds(supabase, tenantId)
    const params = new URLSearchParams()
    params.set('per_page', String(Math.min(Number(args.limit ?? 50), 100)))
    if (args.search) params.set('search', String(args.search))
    const r = await fetch(`${store}/wp-json/wc/v3/products?${params}`, { headers: { Authorization: auth } })
    const body = await r.json() as any
    if (!r.ok) throw new Error(`WooCommerce list_products ${r.status}: ${body?.message ?? 'failed'}`)
    return { output: body, primary: body }
  },

  'woocommerce.create_order': async (supabase, tenantId, args) => {
    const { loadCreds } = await import('../routes/connectors/woocommerce')
    const { store, auth } = await loadCreds(supabase, tenantId)
    // `line_items` may arrive as a JSON string from a workflow field — coerce.
    const payload: Record<string, any> = { ...args }
    if (typeof payload.line_items === 'string') {
      try { payload.line_items = JSON.parse(payload.line_items) } catch { /* leave as-is; WC will reject */ }
    }
    if (typeof payload.billing === 'string')  { try { payload.billing = JSON.parse(payload.billing) } catch {} }
    if (typeof payload.shipping === 'string') { try { payload.shipping = JSON.parse(payload.shipping) } catch {} }
    const r = await fetch(`${store}/wp-json/wc/v3/orders`, {
      method: 'POST',
      headers: { Authorization: auth, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
    const body = await r.json() as any
    if (!r.ok) throw new Error(`WooCommerce create_order ${r.status}: ${body?.message ?? 'failed'}`)
    return { output: body, primary: body?.id }
  },

  // ── Brevo ─────────────────────────────────────────────────────────────────
  // loadKey returns the decrypted xkeysib- API key; header is `api-key`.
  'brevo.create_contact': async (supabase, tenantId, args) => {
    const { loadKey } = await import('../routes/connectors/brevo')
    const apiKey = await loadKey(supabase, tenantId)
    const payload: Record<string, any> = { ...args }
    if (typeof payload.attributes === 'string') { try { payload.attributes = JSON.parse(payload.attributes) } catch {} }
    if (typeof payload.listIds === 'string')    { try { payload.listIds = JSON.parse(payload.listIds) } catch {} }
    const r = await fetch('https://api.brevo.com/v3/contacts', {
      method: 'POST',
      headers: { 'api-key': apiKey, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(payload),
    })
    if (r.status === 204) return { output: { updated: true }, primary: null }
    const body = await r.json().catch(() => ({})) as any
    if (!r.ok) throw new Error(`Brevo create_contact ${r.status}: ${body?.message ?? 'failed'}`)
    return { output: body, primary: body?.id }
  },

  'brevo.send_email': async (supabase, tenantId, args) => {
    const { loadKey } = await import('../routes/connectors/brevo')
    const apiKey = await loadKey(supabase, tenantId)
    const payload: Record<string, any> = { ...args }
    if (typeof payload.to === 'string')     { try { payload.to = JSON.parse(payload.to) } catch {} }
    if (typeof payload.sender === 'string') { try { payload.sender = JSON.parse(payload.sender) } catch {} }
    if (typeof payload.templateId === 'string' && payload.templateId.trim()) payload.templateId = Number(payload.templateId)
    const r = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: { 'api-key': apiKey, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(payload),
    })
    const body = await r.json().catch(() => ({})) as any
    if (!r.ok) throw new Error(`Brevo send_email ${r.status}: ${body?.message ?? 'failed'}`)
    return { output: body, primary: body?.messageId }
  },

  'brevo.send_sms': async (supabase, tenantId, args) => {
    const { loadKey } = await import('../routes/connectors/brevo')
    const apiKey = await loadKey(supabase, tenantId)
    const payload = { type: 'transactional', sender: 'Brevo', ...args }
    const r = await fetch('https://api.brevo.com/v3/transactionalSMS/sms', {
      method: 'POST',
      headers: { 'api-key': apiKey, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(payload),
    })
    const body = await r.json().catch(() => ({})) as any
    if (!r.ok) throw new Error(`Brevo send_sms ${r.status}: ${body?.message ?? 'failed'}`)
    return { output: body, primary: body?.messageId ?? body?.reference }
  },

  // ── MSG91 (India SMS / OTP) ───────────────────────────────────────────────
  // loadKey returns the decrypted Auth Key; header is `authkey`. India SMS
  // requires a DLT-approved template_id — passed through from the workflow.
  'msg91.send_sms': async (supabase, tenantId, args) => {
    const { loadKey } = await import('../routes/connectors/msg91')
    const authKey = await loadKey(supabase, tenantId)
    const payload: Record<string, any> = { ...args }
    if (typeof payload.recipients === 'string') { try { payload.recipients = JSON.parse(payload.recipients) } catch {} }
    const r = await fetch('https://control.msg91.com/api/v5/flow/', {
      method: 'POST',
      headers: { authkey: authKey, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(payload),
    })
    const body = await r.json().catch(() => ({})) as any
    if (!r.ok || body?.type === 'error') throw new Error(`MSG91 send_sms ${r.status}: ${body?.message ?? 'failed'}`)
    return { output: body, primary: body?.type ?? body }
  },

  'msg91.send_otp': async (supabase, tenantId, args) => {
    const { loadKey } = await import('../routes/connectors/msg91')
    const authKey = await loadKey(supabase, tenantId)
    const { template_id, mobile, ...rest } = args
    const qs = new URLSearchParams({ template_id: String(template_id ?? ''), mobile: String(mobile ?? '') })
    const r = await fetch(`https://control.msg91.com/api/v5/otp?${qs}`, {
      method: 'POST',
      headers: { authkey: authKey, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(rest),
    })
    const body = await r.json().catch(() => ({})) as any
    if (!r.ok || body?.type === 'error') throw new Error(`MSG91 send_otp ${r.status}: ${body?.message ?? 'failed'}`)
    return { output: body, primary: body?.request_id ?? body?.type }
  },

  'msg91.verify_otp': async (supabase, tenantId, args) => {
    const { loadKey } = await import('../routes/connectors/msg91')
    const authKey = await loadKey(supabase, tenantId)
    const qs = new URLSearchParams({ mobile: String(args.mobile ?? ''), otp: String(args.otp ?? '') })
    const r = await fetch(`https://control.msg91.com/api/v5/otp/verify?${qs}`, {
      headers: { authkey: authKey, Accept: 'application/json' },
    })
    const body = await r.json().catch(() => ({})) as any
    if (!r.ok || body?.type === 'error') throw new Error(`MSG91 verify_otp ${r.status}: ${body?.message ?? 'failed'}`)
    return { output: body, primary: body?.type === 'success' }
  },

  // ── Shiprocket (India D2C shipping) ───────────────────────────────────────
  // loadToken returns a valid JWT (refreshing via the stored API-user creds
  // when needed); calls use Bearer auth.
  'shiprocket.list_orders': async (supabase, tenantId, args) => {
    const { loadToken } = await import('../routes/connectors/shiprocket')
    const token = await loadToken(supabase, tenantId)
    const params = new URLSearchParams()
    params.set('per_page', String(Math.min(Number(args.limit ?? 50), 100)))
    if (args.page)   params.set('page', String(args.page))
    if (args.search) params.set('search', String(args.search))
    const r = await fetch(`https://apiv2.shiprocket.in/v1/external/orders?${params}`, { headers: { Authorization: `Bearer ${token}` } })
    const body = await r.json() as any
    if (!r.ok) throw new Error(`Shiprocket list_orders ${r.status}: ${body?.message ?? 'failed'}`)
    return { output: body, primary: body?.data ?? body }
  },

  'shiprocket.create_order': async (supabase, tenantId, args) => {
    const { loadToken } = await import('../routes/connectors/shiprocket')
    const token = await loadToken(supabase, tenantId)
    const payload: Record<string, any> = { ...args }
    if (typeof payload.order_items === 'string') { try { payload.order_items = JSON.parse(payload.order_items) } catch {} }
    const r = await fetch('https://apiv2.shiprocket.in/v1/external/orders/create/adhoc', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
    const body = await r.json() as any
    if (!r.ok) throw new Error(`Shiprocket create_order ${r.status}: ${body?.message ?? JSON.stringify(body?.errors ?? '') ?? 'failed'}`)
    return { output: body, primary: body?.order_id ?? body?.shipment_id }
  },

  'shiprocket.track_awb': async (supabase, tenantId, args) => {
    const { loadToken } = await import('../routes/connectors/shiprocket')
    const token = await loadToken(supabase, tenantId)
    const awb = encodeURIComponent(String(args.awb ?? ''))
    const r = await fetch(`https://apiv2.shiprocket.in/v1/external/courier/track/awb/${awb}`, { headers: { Authorization: `Bearer ${token}` } })
    const body = await r.json() as any
    if (!r.ok) throw new Error(`Shiprocket track_awb ${r.status}: ${body?.message ?? 'failed'}`)
    return { output: body, primary: body?.tracking_data?.shipment_status ?? body }
  },

  'shiprocket.check_serviceability': async (supabase, tenantId, args) => {
    const { loadToken } = await import('../routes/connectors/shiprocket')
    const token = await loadToken(supabase, tenantId)
    const params = new URLSearchParams()
    for (const k of ['pickup_postcode', 'delivery_postcode', 'weight', 'cod', 'order_id']) {
      if (args[k] != null) params.set(k, String(args[k]))
    }
    const r = await fetch(`https://apiv2.shiprocket.in/v1/external/courier/serviceability/?${params}`, { headers: { Authorization: `Bearer ${token}` } })
    const body = await r.json() as any
    if (!r.ok) throw new Error(`Shiprocket check_serviceability ${r.status}: ${body?.message ?? 'failed'}`)
    return { output: body, primary: body?.data?.available_courier_companies ?? body }
  },

  // ── Cashfree (India payments) ─────────────────────────────────────────────
  'cashfree.create_order': async (supabase, tenantId, args) => {
    const { loadCreds } = await import('../routes/connectors/cashfree')
    const { appId, secret, base } = await loadCreds(supabase, tenantId)
    const payload: Record<string, any> = { ...args }
    if (typeof payload.customer_details === 'string') { try { payload.customer_details = JSON.parse(payload.customer_details) } catch {} }
    if (payload.order_amount != null) payload.order_amount = Number(payload.order_amount)
    payload.order_currency = payload.order_currency || 'INR'
    const r = await fetch(`${base}/orders`, { method: 'POST', headers: cashfreeHeaders(appId, secret), body: JSON.stringify(payload) })
    const body = await r.json().catch(() => ({})) as any
    if (!r.ok) throw new Error(`Cashfree create_order ${r.status}: ${body?.message ?? 'failed'}`)
    return { output: body, primary: body?.payment_session_id ?? body?.order_id ?? body }
  },

  'cashfree.create_payment_link': async (supabase, tenantId, args) => {
    const { loadCreds } = await import('../routes/connectors/cashfree')
    const { appId, secret, base } = await loadCreds(supabase, tenantId)
    const payload: Record<string, any> = { ...args }
    if (typeof payload.customer_details === 'string') { try { payload.customer_details = JSON.parse(payload.customer_details) } catch {} }
    if (typeof payload.link_notify === 'string') { try { payload.link_notify = JSON.parse(payload.link_notify) } catch {} }
    if (payload.link_amount != null) payload.link_amount = Number(payload.link_amount)
    payload.link_currency = payload.link_currency || 'INR'
    const r = await fetch(`${base}/links`, { method: 'POST', headers: cashfreeHeaders(appId, secret), body: JSON.stringify(payload) })
    const body = await r.json().catch(() => ({})) as any
    if (!r.ok) throw new Error(`Cashfree create_payment_link ${r.status}: ${body?.message ?? 'failed'}`)
    return { output: body, primary: body?.link_url ?? body?.link_id ?? body }
  },

  'cashfree.get_order': async (supabase, tenantId, args) => {
    const { loadCreds } = await import('../routes/connectors/cashfree')
    const { appId, secret, base } = await loadCreds(supabase, tenantId)
    const id = encodeURIComponent(String(args.order_id ?? ''))
    const r = await fetch(`${base}/orders/${id}`, { headers: cashfreeHeaders(appId, secret) })
    const body = await r.json().catch(() => ({})) as any
    if (!r.ok) throw new Error(`Cashfree get_order ${r.status}: ${body?.message ?? 'failed'}`)
    return { output: body, primary: body?.order_status ?? body }
  },

  'cashfree.create_refund': async (supabase, tenantId, args) => {
    const { loadCreds } = await import('../routes/connectors/cashfree')
    const { appId, secret, base } = await loadCreds(supabase, tenantId)
    const { order_id, ...rest } = args
    const payload: Record<string, any> = { ...rest }
    if (payload.refund_amount != null) payload.refund_amount = Number(payload.refund_amount)
    const id = encodeURIComponent(String(order_id ?? ''))
    const r = await fetch(`${base}/orders/${id}/refunds`, { method: 'POST', headers: cashfreeHeaders(appId, secret), body: JSON.stringify(payload) })
    const body = await r.json().catch(() => ({})) as any
    if (!r.ok) throw new Error(`Cashfree create_refund ${r.status}: ${body?.message ?? 'failed'}`)
    return { output: body, primary: body?.refund_status ?? body?.refund_id ?? body }
  },

  // ── Gupshup (India WhatsApp/SMS BSP) ──────────────────────────────────────
  'gupshup.send_message': async (supabase, tenantId, args) => {
    const { loadCreds } = await import('../routes/connectors/gupshup')
    const { apiKey, appName, source } = await loadCreds(supabase, tenantId)
    const body = new URLSearchParams({
      channel: 'whatsapp', source, destination: String(args.destination ?? ''),
      'src.name': appName,
      message: JSON.stringify({ type: 'text', text: String(args.text ?? '') }),
    }).toString()
    const r = await fetch('https://api.gupshup.io/wa/api/v1/msg', {
      method: 'POST', headers: { apikey: apiKey, 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' }, body,
    })
    const out = await r.json().catch(() => ({})) as any
    if (!r.ok || out?.status === 'error') throw new Error(`Gupshup send_message ${r.status}: ${out?.message ?? 'failed'}`)
    return { output: out, primary: out?.messageId ?? out?.status ?? out }
  },

  'gupshup.send_template': async (supabase, tenantId, args) => {
    const { loadCreds } = await import('../routes/connectors/gupshup')
    const { apiKey, appName, source } = await loadCreds(supabase, tenantId)
    let params: any[] = []
    if (Array.isArray(args.params)) params = args.params
    else if (typeof args.params === 'string' && args.params.trim()) { try { params = JSON.parse(args.params) } catch {} }
    const body = new URLSearchParams({
      channel: 'whatsapp', source, destination: String(args.destination ?? ''),
      'src.name': appName,
      template: JSON.stringify({ id: String(args.template_id ?? ''), params }),
    }).toString()
    const r = await fetch('https://api.gupshup.io/wa/api/v1/template/msg', {
      method: 'POST', headers: { apikey: apiKey, 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' }, body,
    })
    const out = await r.json().catch(() => ({})) as any
    if (!r.ok || out?.status === 'error') throw new Error(`Gupshup send_template ${r.status}: ${out?.message ?? 'failed'}`)
    return { output: out, primary: out?.messageId ?? out?.status ?? out }
  },

  'gupshup.opt_in_user': async (supabase, tenantId, args) => {
    const { loadCreds } = await import('../routes/connectors/gupshup')
    const { apiKey, appName } = await loadCreds(supabase, tenantId)
    const r = await fetch(`https://api.gupshup.io/sm/api/v1/app/opt/in/${encodeURIComponent(appName)}`, {
      method: 'POST', headers: { apikey: apiKey, 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams({ user: String(args.user ?? '') }).toString(),
    })
    const out = await r.json().catch(() => ({})) as any
    if (!r.ok || out?.status === 'error') throw new Error(`Gupshup opt_in_user ${r.status}: ${out?.message ?? 'failed'}`)
    return { output: out, primary: out?.status ?? out }
  },

  // ── Exotel (India cloud telephony) ────────────────────────────────────────
  'exotel.make_call': async (supabase, tenantId, args) => {
    const { loadCreds } = await import('../routes/connectors/exotel')
    const { authHeader, base, sid } = await loadCreds(supabase, tenantId)
    const body = new URLSearchParams({ From: String(args.from ?? ''), To: String(args.to ?? ''), CallerId: String(args.caller_id ?? '') }).toString()
    const r = await fetch(`${base}/v1/Accounts/${encodeURIComponent(sid)}/Calls/connect.json`, {
      method: 'POST', headers: { Authorization: authHeader, 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' }, body,
    })
    const out = await r.json().catch(() => ({})) as any
    if (!r.ok) throw new Error(`Exotel make_call ${r.status}: ${out?.RestException?.Message ?? out?.Message ?? 'failed'}`)
    return { output: out, primary: out?.Call?.Sid ?? out }
  },

  'exotel.send_sms': async (supabase, tenantId, args) => {
    const { loadCreds } = await import('../routes/connectors/exotel')
    const { authHeader, base, sid } = await loadCreds(supabase, tenantId)
    const params: Record<string, string> = { To: String(args.to ?? ''), Body: String(args.body ?? '') }
    if (args.from) params.From = String(args.from)
    const r = await fetch(`${base}/v1/Accounts/${encodeURIComponent(sid)}/Sms/send.json`, {
      method: 'POST', headers: { Authorization: authHeader, 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams(params).toString(),
    })
    const out = await r.json().catch(() => ({})) as any
    if (!r.ok) throw new Error(`Exotel send_sms ${r.status}: ${out?.RestException?.Message ?? out?.Message ?? 'failed'}`)
    return { output: out, primary: out?.SMSMessage?.Sid ?? out }
  },

  'exotel.get_call_details': async (supabase, tenantId, args) => {
    const { loadCreds } = await import('../routes/connectors/exotel')
    const { authHeader, base, sid } = await loadCreds(supabase, tenantId)
    const callSid = encodeURIComponent(String(args.call_sid ?? ''))
    const r = await fetch(`${base}/v1/Accounts/${encodeURIComponent(sid)}/Calls/${callSid}.json`, {
      headers: { Authorization: authHeader, Accept: 'application/json' },
    })
    const out = await r.json().catch(() => ({})) as any
    if (!r.ok) throw new Error(`Exotel get_call_details ${r.status}: ${out?.RestException?.Message ?? out?.Message ?? 'failed'}`)
    return { output: out, primary: out?.Call?.Status ?? out }
  },

  // ── PayU (India payments, hash-based) ─────────────────────────────────────
  'payu.generate_payment_hash': async (supabase, tenantId, args) => {
    const { loadCreds, paymentHash } = await import('../routes/connectors/payu')
    const { key, salt, payUrl } = await loadCreds(supabase, tenantId)
    const hash = paymentHash(key, salt, args)
    const fields: Record<string, string> = {
      key, txnid: String(args.txnid ?? ''), amount: String(args.amount ?? ''),
      productinfo: String(args.productinfo ?? ''), firstname: String(args.firstname ?? ''),
      email: String(args.email ?? ''), hash,
    }
    for (const k of ['phone', 'surl', 'furl', 'udf1', 'udf2', 'udf3', 'udf4', 'udf5']) if (args[k]) fields[k] = String(args[k])
    return { output: { hash, action: payUrl, fields }, primary: hash }
  },

  'payu.verify_payment': async (supabase, tenantId, args) => {
    const { loadCreds, commandHash } = await import('../routes/connectors/payu')
    const { key, salt, infoUrl } = await loadCreds(supabase, tenantId)
    const txnid = String(args.txnid ?? '')
    const body = new URLSearchParams({ key, command: 'verify_payment', var1: txnid, hash: commandHash(key, salt, 'verify_payment', txnid) }).toString()
    const r = await fetch(infoUrl, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' }, body })
    const out = await r.json().catch(() => ({})) as any
    if (String(out?.status) !== '1') throw new Error(`PayU verify_payment failed: ${out?.msg ?? r.status}`)
    return { output: out, primary: out?.transaction_details?.[txnid]?.status ?? out }
  },

  'payu.refund_payment': async (supabase, tenantId, args) => {
    const { loadCreds, commandHash } = await import('../routes/connectors/payu')
    const { key, salt, infoUrl } = await loadCreds(supabase, tenantId)
    const command = 'cancel_refund_transaction'
    const mihpayid = String(args.mihpayid ?? '')
    const body = new URLSearchParams({ key, command, var1: mihpayid, var2: String(args.token ?? ''), var3: String(args.refund_amount ?? ''), hash: commandHash(key, salt, command, mihpayid) }).toString()
    const r = await fetch(infoUrl, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' }, body })
    const out = await r.json().catch(() => ({})) as any
    if (String(out?.status) !== '1') throw new Error(`PayU refund_payment failed: ${out?.msg ?? r.status}`)
    return { output: out, primary: out?.request_id ?? out }
  },

  // ── LeadSquared (India CRM) ───────────────────────────────────────────────
  'leadsquared.create_or_update_lead': async (supabase, tenantId, args) => {
    const { loadCreds, leadAttributes } = await import('../routes/connectors/leadsquared')
    const { accessKey, secretKey, host } = await loadCreds(supabase, tenantId)
    const qs = new URLSearchParams({ accessKey, secretKey })
    if (args.search_by) qs.set('SearchBy', String(args.search_by))
    else if (args.email) qs.set('SearchBy', 'EmailAddress')
    const r = await fetch(`https://${host}/v2/LeadManagement.svc/Lead.Capture?${qs}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(leadAttributes(args as any)),
    })
    const out = await r.json().catch(() => ({})) as any
    if (!r.ok || out?.Status === 'Error') throw new Error(`LeadSquared create_or_update_lead: ${out?.ExceptionMessage ?? out?.Message ?? r.status}`)
    return { output: out, primary: out?.Message?.RelatedId ?? out?.Status ?? out }
  },

  'leadsquared.get_lead_by_email': async (supabase, tenantId, args) => {
    const { loadCreds } = await import('../routes/connectors/leadsquared')
    const { accessKey, secretKey, host } = await loadCreds(supabase, tenantId)
    const qs = new URLSearchParams({ accessKey, secretKey, emailaddress: String(args.email ?? '') })
    const r = await fetch(`https://${host}/v2/LeadManagement.svc/Leads.GetByEmailaddress?${qs}`, { headers: { Accept: 'application/json' } })
    const out = await r.json().catch(() => ({})) as any
    if (!r.ok || out?.Status === 'Error') throw new Error(`LeadSquared get_lead_by_email: ${out?.ExceptionMessage ?? out?.Message ?? r.status}`)
    const first = Array.isArray(out) ? out[0] : out
    return { output: { leads: out }, primary: first?.ProspectID ?? first }
  },

  'leadsquared.post_activity': async (supabase, tenantId, args) => {
    const { loadCreds } = await import('../routes/connectors/leadsquared')
    const { accessKey, secretKey, host } = await loadCreds(supabase, tenantId)
    let fields: any = args.fields
    if (typeof fields === 'string' && fields.trim()) { try { fields = JSON.parse(fields) } catch {} }
    const payload: Record<string, any> = {
      RelatedProspectId: String(args.related_prospect_id ?? ''),
      ActivityEvent: Number(args.activity_event),
      ActivityNote: String(args.activity_note ?? ''),
    }
    if (Array.isArray(fields)) payload.Fields = fields
    const qs = new URLSearchParams({ accessKey, secretKey })
    const r = await fetch(`https://${host}/v2/ProspectActivity.svc/Activity/Create?${qs}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(payload),
    })
    const out = await r.json().catch(() => ({})) as any
    if (!r.ok || out?.Status === 'Error') throw new Error(`LeadSquared post_activity: ${out?.ExceptionMessage ?? out?.Message ?? r.status}`)
    return { output: out, primary: out?.Message?.Id ?? out?.Status ?? out }
  },

  'kylas.create_lead': async (supabase, tenantId, args) => {
    const { loadKey, KYLAS_BASE, personPayload, kylasErr } = await import('../routes/connectors/kylas')
    const apiKey = await loadKey(supabase, tenantId)
    const r = await fetch(`${KYLAS_BASE}/v1/leads`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'api-key': apiKey },
      body: JSON.stringify(personPayload(args as any)),
    })
    const out = await r.json().catch(() => ({})) as any
    if (!r.ok) throw new Error(`Kylas create_lead: ${kylasErr(r, out)}`)
    return { output: out, primary: out?.id ?? out }
  },

  'kylas.create_contact': async (supabase, tenantId, args) => {
    const { loadKey, KYLAS_BASE, personPayload, kylasErr } = await import('../routes/connectors/kylas')
    const apiKey = await loadKey(supabase, tenantId)
    const r = await fetch(`${KYLAS_BASE}/v1/contacts`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'api-key': apiKey },
      body: JSON.stringify(personPayload(args as any)),
    })
    const out = await r.json().catch(() => ({})) as any
    if (!r.ok) throw new Error(`Kylas create_contact: ${kylasErr(r, out)}`)
    return { output: out, primary: out?.id ?? out }
  },

  'kylas.create_deal': async (supabase, tenantId, args) => {
    const { loadKey, KYLAS_BASE, asObject, kylasErr } = await import('../routes/connectors/kylas')
    const apiKey = await loadKey(supabase, tenantId)
    const r = await fetch(`${KYLAS_BASE}/v1/deals`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'api-key': apiKey },
      body: JSON.stringify({ name: String(args.name ?? ''), ...asObject(args.fields) }),
    })
    const out = await r.json().catch(() => ({})) as any
    if (!r.ok) throw new Error(`Kylas create_deal: ${kylasErr(r, out)}`)
    return { output: out, primary: out?.id ?? out }
  },

  'kylas.search_leads': async (supabase, tenantId, args) => {
    const { loadKey, KYLAS_BASE, searchPayload, kylasErr } = await import('../routes/connectors/kylas')
    const apiKey = await loadKey(supabase, tenantId)
    const r = await fetch(`${KYLAS_BASE}/v1/search/lead`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'api-key': apiKey },
      body: JSON.stringify(searchPayload(args as any)),
    })
    const out = await r.json().catch(() => ({})) as any
    if (!r.ok) throw new Error(`Kylas search_leads: ${kylasErr(r, out)}`)
    const first = Array.isArray(out?.content) ? out.content[0] : undefined
    return { output: out, primary: first?.id ?? out?.totalElements ?? out }
  },

  'indiamart.fetch_leads': async (supabase, tenantId, args) => {
    const { loadKey, pullUrl, imRejected, imMessage } = await import('../routes/connectors/indiamart')
    const key = await loadKey(supabase, tenantId)
    const r = await fetch(pullUrl(key, args.start_time ? String(args.start_time) : undefined, args.end_time ? String(args.end_time) : undefined), { headers: { Accept: 'application/json' } })
    const out = await r.json().catch(() => ({})) as any
    if (!r.ok || imRejected(out)) throw new Error(`IndiaMART fetch_leads: ${imMessage(out, r.status)}`)
    return { output: out, primary: out?.TOTAL_RECORDS ?? (Array.isArray(out?.RESPONSE) ? out.RESPONSE.length : out) }
  },

  'tradeindia.fetch_leads': async (supabase, tenantId, args) => {
    const { loadCreds, pullUrl, tiMissingParams, tiInvalidCreds } = await import('../routes/connectors/tradeindia')
    const c = await loadCreds(supabase, tenantId)
    const r = await fetch(pullUrl(c, args.from_date ? String(args.from_date) : undefined, args.to_date ? String(args.to_date) : undefined), { headers: { Accept: 'application/json' } })
    const out = await r.json().catch(() => null) as any
    if (!r.ok) throw new Error(`TradeIndia fetch_leads: ${r.status}`)
    if (tiMissingParams(out) || tiInvalidCreds(out)) throw new Error(`TradeIndia fetch_leads: ${String(out)}`)
    return { output: { inquiries: out }, primary: Array.isArray(out) ? out.length : out }
  },
}

function cashfreeHeaders(appId: string, secret: string): Record<string, string> {
  return {
    'x-client-id': appId,
    'x-client-secret': secret,
    'x-api-version': '2023-08-01',
    'Content-Type': 'application/json',
    Accept: 'application/json',
  }
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
