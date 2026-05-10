/**
 * WhatsApp notification delivery.
 *
 * Sends a notification's title to the recipient's personal WhatsApp number
 * (`profiles.wa_number`) using the TENANT's WhatsApp Business Account. This
 * is meta-notification: tenant Acme Corp tells its team member Priya about
 * a `lead.assigned` event by sending Priya a WhatsApp message FROM Acme's
 * WABA TO Priya's personal phone number.
 *
 * ─── Why templates, not free-form text ──────────────────────────────────
 *
 * Meta requires WhatsApp messages to a user OUTSIDE the 24h conversation
 * window to use a pre-approved Utility template. Notifications are by
 * definition outside that window (they fire whenever, including overnight),
 * so we MUST use a template. We can't just send `body_template` text —
 * that's an opt-in marketing-style send that Meta will block 9 times in 10.
 *
 * The template is registered once per tenant under a fixed name — default
 * `frequency_notification` — with the body `*{{1}}*\n{{2}}` (title in bold,
 * body underneath). The template name is configurable via env
 * `WA_NOTIFICATION_TEMPLATE_NAME` if a tenant has a custom approved one.
 *
 * If the template isn't approved yet (new tenant), we fail-soft: log a
 * 'failed' delivery row with the reason so the user can see in
 * Settings → Notifications why their WhatsApp delivery isn't landing.
 *
 * ─── Why not the message-sender worker ───────────────────────────────────
 *
 * message-sender is for outbound business → contact messages (broadcasts,
 * campaign sends, agent replies). Notifications are platform → user
 * (Frequency telling Priya about a lead). They share the same Meta endpoint
 * but have different routing (notification destination is the user's own
 * number, not a contact in the CRM) and different audit trail (notifications
 * log to notification_delivery_log, not messages).
 *
 * Inlining the send keeps notification dispatch decoupled from the BullMQ
 * queue — if Redis is down, in-app + email still work; WhatsApp degrades
 * but the 'failed' row tells us why.
 */

import type { SupabaseClient } from '@supabase/supabase-js'

const GRAPH = 'https://graph.facebook.com/v18.0'

export interface WaNotificationArgs {
  /** Tenant id — used to resolve WABA credentials. */
  tenantId: string
  /** Recipient user id — used to resolve their personal wa_number. */
  userId:   string
  title:    string
  body?:    string | null
  /** Optional context vars for the template body if it has more than 2 params. */
  extraTemplateParams?: string[]
}

export interface WaNotificationResult {
  ok:          true
  waMessageId: string | null
}

/**
 * Send the WhatsApp notification template to a single recipient. Throws on
 * any failure (caller catches + logs). Returns the wa_message_id for audit.
 *
 * Preflight order (each step short-circuits with a clear, actionable error):
 *   1. Recipient has wa_number on profile
 *   2. Tenant has WABA linked + status≠'disconnected'
 *   3. The notification template exists for this tenant AND status='approved'
 *      (rejecting pending/rejected/paused/draft/in_appeal/deleted prevents
 *      the noisy "template doesn't exist" 132001 error from Meta and gives
 *      the user a clear next step: get the template approved first)
 *   4. Send via Meta Graph API
 */
export async function sendWaNotification(
  supabase: SupabaseClient,
  args: WaNotificationArgs,
): Promise<WaNotificationResult> {
  // 1. Resolve recipient's personal phone number.
  const { data: profile } = await supabase.from('profiles')
    .select('wa_number').eq('id', args.userId).maybeSingle()
  const waNumber = (profile as any)?.wa_number as string | null | undefined
  if (!waNumber) {
    throw new Error('Recipient has no wa_number on profile (Settings → Profile → WhatsApp number)')
  }
  // Strip leading + because the WhatsApp Cloud API rejects it.
  const to = waNumber.replace(/^\+/, '').trim()
  if (!/^\d{10,15}$/.test(to)) {
    throw new Error(`Invalid wa_number on profile: '${waNumber}' (digits only, 10–15 chars)`)
  }

  // 2. Resolve tenant's WABA credentials. Same shape as workers/message-sender.ts.
  const { data: tenant } = await supabase.from('tenants')
    .select('phone_number_id, access_token, status')
    .eq('id', args.tenantId).maybeSingle()
  if (!tenant?.phone_number_id || !tenant?.access_token) {
    throw new Error('Tenant WhatsApp not configured (no WABA linked)')
  }
  if ((tenant as any).status === 'disconnected') {
    throw new Error('Tenant WhatsApp is disconnected — reconnect from Settings → Channels')
  }

  const templateName = process.env.WA_NOTIFICATION_TEMPLATE_NAME || 'frequency_notification'
  const templateLang = process.env.WA_NOTIFICATION_TEMPLATE_LANG || 'en'

  // 3. Template approval preflight. wa_templates.status mirrors Meta's enum:
  //   'approved' | 'pending' | 'rejected' | 'paused' | 'in_appeal' | 'draft' | 'deleted'
  // Only 'approved' is sendable. The template-sync worker (every 15min)
  // keeps this column fresh from Meta's API, so a freshly-approved template
  // becomes notification-eligible without a server restart.
  //
  // We check by (tenant_id, name, language) — the same uniqueness key the
  // sync worker upserts on. If no row exists, the template was never
  // submitted on this WABA — point the user to the Templates UI to submit.
  const { data: tpl } = await supabase.from('wa_templates')
    .select('status, rejection_reason')
    .eq('tenant_id', args.tenantId)
    .eq('name',     templateName)
    .eq('language', templateLang)
    .maybeSingle()
  if (!tpl) {
    throw new Error(
      `Notification template '${templateName}' (${templateLang}) is not registered on this WABA. ` +
      `Submit it in Channels → WhatsApp → Templates with body "*{{1}}*\\n{{2}}" and wait for Meta approval.`
    )
  }
  if (tpl.status !== 'approved') {
    const detail = tpl.status === 'rejected' && tpl.rejection_reason
      ? ` Rejection reason: ${tpl.rejection_reason}`
      : ''
    throw new Error(
      `Notification template '${templateName}' (${templateLang}) is '${tpl.status}', not 'approved'. ` +
      `Meta only delivers approved templates outside the 24h window. ` +
      `Check Channels → WhatsApp → Templates.${detail}`
    )
  }

  // 4. Build template payload. Template body is `*{{1}}*\n{{2}}` — 2 params
  // by default. If extraTemplateParams is set, append more (caller is
  // responsible for matching template body shape).
  const params = [args.title, args.body ?? '', ...(args.extraTemplateParams ?? [])]
    .map(text => ({ type: 'text', text: String(text).slice(0, 1024) }))

  const payload = {
    messaging_product: 'whatsapp',
    to,
    type: 'template',
    template: {
      name: templateName,
      language: { code: templateLang },
      components: params.length > 0 ? [{ type: 'body', parameters: params }] : [],
    },
  }

  // 4. Send via Meta Graph API.
  const r = await fetch(`${GRAPH}/${tenant.phone_number_id}/messages`, {
    method: 'POST',
    headers: {
      Authorization:  `Bearer ${tenant.access_token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  })
  const body = await r.json().catch(() => ({} as any))
  if (!r.ok || (body as any).error) {
    const msg = (body as any)?.error?.message ?? `${r.status} ${r.statusText}`
    // Map common Meta errors into clearer messages so the FE can surface
    // them in the delivery log without the user having to read Meta docs.
    if ((body as any)?.error?.code === 132001) {
      throw new Error(`WhatsApp notification template '${templateName}' is not approved on this WABA. Submit it in Channels → WhatsApp → Templates.`)
    }
    throw new Error(`Meta WhatsApp send failed: ${msg}`)
  }
  const waMessageId = (body as any)?.messages?.[0]?.id ?? null
  return { ok: true, waMessageId }
}
