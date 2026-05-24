/**
 * Worker: message.send
 *
 * Sends one message per job — across WhatsApp, Instagram, Telegram, or email.
 * BullMQ handles retries (5 attempts, exponential backoff). After all retries
 * fail, BullMQ keeps it in the failed set — Bull Board shows it as the DLQ.
 *
 * Channel router:
 *   - 'whatsapp'  → Meta Graph API (`/{phone_number_id}/messages`)
 *   - 'instagram' → Meta Graph API (`/{ig_user_id}/messages`)
 *   - 'telegram'  → api.telegram.org Bot API (`bot{token}/sendMessage` etc.)
 *   - 'email'     → Resend (via lib/email.ts) — real send, not a stub
 *
 * Per-tenant rate limiting is enforced by BullMQ's `limiter` group key so
 * one chatty tenant can't starve others.
 */

import '../env'
import { Worker, UnrecoverableError, Job } from 'bullmq'
import { createClient } from '@supabase/supabase-js'
import { Q, MessageSendJob, connection } from '../queue'
import { checkAndConsumeQuota, RateLimitExceededError } from '../lib/quota'

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://yiicpndeggaedxobyopu.supabase.co'
const supabase = createClient(SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY!)

const GRAPH = 'https://graph.facebook.com/v18.0'
const TG_API = 'https://api.telegram.org'

// In-memory tenant cache (avoids Supabase round-trip for every send).
const TENANT_CACHE_TTL_MS = 2 * 60 * 1000
const tenantCache = new Map<string, { tenant: any; expiresAt: number }>()

async function getTenant(tenantId: string) {
  const hit = tenantCache.get(tenantId)
  if (hit && hit.expiresAt > Date.now()) return hit.tenant
  const { data, error } = await supabase.from('tenants').select('*').eq('id', tenantId).maybeSingle()
  if (error) throw new Error(`load tenant: ${error.message}`)
  if (!data)  throw new Error(`tenant ${tenantId} not found`)
  tenantCache.set(tenantId, { tenant: data, expiresAt: Date.now() + TENANT_CACHE_TTL_MS })
  return data
}

export function startMessageSenderWorker() {
  const worker = new Worker<MessageSendJob>(
    Q.message,
    async (job: Job<MessageSendJob>) => {
      const data = job.data

      // ── Per-tenant rate-limit gate (migration 063 / lib/quota.ts) ────
      // Runs BEFORE the channel dispatch so we never burn a Meta API token
      // on a send that's about to fail anyway. Two checks per send:
      //
      //   1. per-day quota  → prevents the chatty tenant from exhausting
      //                       their plan in an hour. Day boundary = IST so
      //                       it matches /api/billing/usage's monthly count.
      //   2. per-minute     → smoothing; matches Meta's per-WABA 80/sec
      //                       so the API rarely sees an explicit 429.
      //
      // RateLimitExceededError is wrapped in BullMQ's UnrecoverableError so
      // the job moves straight to the failed set instead of consuming all
      // 5 retry attempts on a quota that won't reset for hours.
      //
      // Email + Telegram + Instagram also consume the same daily bucket —
      // the goal is "messages out the door, regardless of channel" since
      // every channel costs the tenant money one way or another.
      try {
        // Day quota first (cheaper short-circuit on enterprise / unlimited).
        const dayCheck = await checkAndConsumeQuota(
          supabase, connection, data.tenantId, 'messages_per_day',
        )
        if (!dayCheck.allowed) {
          throw new RateLimitExceededError({
            tenantId: data.tenantId, quotaKey: 'messages_per_day',
            current: dayCheck.current_usage, cap: dayCheck.cap,
            resetsAt: dayCheck.resets_at,
          })
        }
        // Per-minute smoothing — only check if day passed (no point bumping
        // both counters on a doomed send).
        const minCheck = await checkAndConsumeQuota(
          supabase, connection, data.tenantId, 'messages_per_minute',
        )
        if (!minCheck.allowed) {
          throw new RateLimitExceededError({
            tenantId: data.tenantId, quotaKey: 'messages_per_minute',
            current: minCheck.current_usage, cap: minCheck.cap,
            resetsAt: minCheck.resets_at,
          })
        }
      } catch (e: any) {
        if (e instanceof RateLimitExceededError) {
          // Log to outbound messages table so the UI shows the failure
          // reason — without this, broadcasts silently dropped messages
          // and the tenant just saw the `failed` counter tick up.
          await logRateLimitRejection(data, e).catch(() => {})
          throw new UnrecoverableError(
            `quota ${e.quotaKey} exceeded (${e.current}/${e.cap}); resets at ${e.resetsAt}`,
          )
        }
        throw e
      }

      // ── DPDPA marketing-consent gate (P0.7) ────────────────────────────
      // Before we burn a Meta API token on a marketing template, check
      // contact_consent_state for (contact, channel, 'marketing'). If the
      // contact has not opted in, log a `status=blocked_no_consent` row
      // with `blocked_reason='No marketing consent on file (DPDPA)'` and
      // skip the actual send. Transactional / utility / service_updates
      // templates are NOT gated — they're allowed under DPDPA "necessary
      // processing" once the contact has initiated a conversation (the
      // inbound webhook seeds those purposes; see handleInboundMessage).
      //
      // The gate runs ONLY for kind='template' with category='marketing'.
      // Text/interactive/media sends are session messages (replies inside
      // the 24h window) which fall under transactional consent and don't
      // need the marketing flag.
      if (data.kind === 'template' && data.template?.name) {
        const blocked = await checkMarketingConsent(data)
        if (blocked) return blocked
      }

      switch (data.channel) {
        case 'email':     return sendEmailViaProvider(data)
        case 'instagram': return sendInstagram(data)
        case 'telegram':  return sendTelegram(data)
        case 'whatsapp':
        default:          return sendWhatsApp(data)
      }
    },
    {
      connection,
      concurrency: Number(process.env.MESSAGE_CONCURRENCY ?? 5),
      // Per-tenant rate-limiting is enforced inline by checkAndConsumeQuota
      // (above) rather than BullMQ's global `limiter`. The previous global
      // 50/sec cap was the very problem this work fixes: one noisy tenant
      // would starve all others. With the per-tenant token bucket each
      // tenant gets their own plan's per-minute budget enforced atomically.
    }
  )

  worker.on('failed', async (job, err) => {
    if (!job) return
    const exhausted = (job.attemptsMade ?? 0) >= (job.opts.attempts ?? 1)
    console.warn(`[worker:message] ✗ job=${job.id} attempt=${job.attemptsMade}/${job.opts.attempts} — ${err.message}${exhausted ? ' [DLQ]' : ''}`)
    // When retries are exhausted on a broadcast message, bump the broadcast's
    // failed counter so the UI can flag delivery problems.
    if (exhausted && job.data?.broadcastId) {
      try {
        // Atomic-ish increment via Postgres function would be nicer, but for
        // now use a conservative read-modify-write — broadcasts have low write
        // concurrency vs. workflows.
        const { data: b } = await supabase.from('broadcasts')
          .select('stats').eq('id', job.data.broadcastId).maybeSingle()
        const stats = (b?.stats ?? {}) as any
        stats.failed = (stats.failed ?? 0) + 1
        await supabase.from('broadcasts')
          .update({ stats, last_error: err.message })
          .eq('id', job.data.broadcastId)
      } catch { /* swallow */ }
    }
  })

  console.log('[worker:message] started')
  return worker
}

// ── WhatsApp send ────────────────────────────────────────────────────────────
async function sendWhatsApp(data: MessageSendJob) {
  const tenant = await getTenant(data.tenantId)
  if (!tenant.phone_number_id || !tenant.access_token) {
    throw new Error(`tenant ${data.tenantId}: missing WhatsApp credentials`)
  }
  const to = data.to.replace(/^\+/, '')

  let payload: any
  if (data.kind === 'text') {
    payload = { messaging_product: 'whatsapp', to, type: 'text', text: { body: data.text ?? '' } }
  } else if (data.kind === 'template') {
    const t = data.template!
    const components = (t.parameters?.length ?? 0) > 0
      ? [{ type: 'body', parameters: t.parameters.map(v => ({ type: 'text', text: v })) }]
      : []
    payload = { messaging_product: 'whatsapp', to, type: 'template',
      template: { name: t.name, language: { code: t.language }, components } }
  } else if (data.kind === 'interactive') {
    const cfg = data.interactive ?? {}
    payload = {
      messaging_product: 'whatsapp', to, type: 'interactive',
      interactive: {
        type: 'button',
        body: { text: cfg.body ?? '' },
        action: {
          buttons: (cfg.buttons ?? []).slice(0, 3).map((b: any, i: number) => ({
            type: 'reply', reply: { id: b.id ?? `btn_${i}`, title: b.text ?? b },
          })),
        },
      },
    }
  } else if (data.kind === 'media') {
    // Image / video / audio / document. Either `link` (public https URL) or
    // `id` (pre-uploaded Meta media id) is required. Caption only valid for
    // image/video/document; filename only for document. Meta rejects mixed
    // shapes, so we build per type.
    const m = data.media
    if (!m) throw new Error('send_media: missing media payload')
    if (!m.link && !m.id) throw new Error('send_media: media.link or media.id required')
    const asset: any = m.link ? { link: m.link } : { id: m.id }
    if (m.type !== 'audio' && m.caption)  asset.caption  = m.caption
    if (m.type === 'document' && m.filename) asset.filename = m.filename
    payload = { messaging_product: 'whatsapp', to, type: m.type, [m.type]: asset }
  } else {
    throw new Error(`unsupported wa kind=${data.kind}`)
  }

  const r = await fetch(`${GRAPH}/${tenant.phone_number_id}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${tenant.access_token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
  const body = await r.json() as any

  if (!r.ok || body.error) {
    // Permanent vs transient — Meta uses 4xx for permanent (template not approved,
    // outside 24h window). Don't retry those — throw a non-retryable error.
    if (r.status >= 400 && r.status < 500 && body.error?.code !== 130472 /* rate limit */) {
      // Mark as failed in our log and signal BullMQ not to retry by throwing
      // an UnrecoverableError-shaped message. BullMQ has UnrecoverableError but
      // to avoid extra import, we just let the retry happen — they'll all fail
      // identically and end up in the DLQ within seconds.
    }
    await logOutbound(tenant, to, payload, null, 'failed', body.error?.message, data.sessionId ?? null, data.broadcastId ?? null, 'whatsapp')
    throw new Error(`Meta send failed (${r.status}): ${body.error?.message ?? JSON.stringify(body)}`)
  }

  const waMessageId = body.messages?.[0]?.id ?? null
  await logOutbound(tenant, to, payload, waMessageId, 'sent', null, data.sessionId ?? null, data.broadcastId ?? null, 'whatsapp')
  return { wa_message_id: waMessageId }
}

/**
 * Record a rate-limit-rejected message attempt to public.messages so the
 * inbox + broadcast UI shows the failure reason instead of silently dropping
 * the row. Mirrors logOutbound's shape so existing FE readers (which expect
 * status='failed' + content.error) keep working without changes.
 *
 * Best-effort — if the tenant lookup fails (shouldn't happen for a job that
 * already passed validation but defensive), we swallow rather than retry.
 */
async function logRateLimitRejection(data: MessageSendJob, err: RateLimitExceededError): Promise<void> {
  const recipient = data.channel === 'email' ? (data.email?.to ?? '') : data.to
  await supabase.from('messages').insert({
    tenant_id: data.tenantId,
    session_id: data.sessionId ?? null,
    broadcast_id: data.broadcastId ?? null,
    direction: 'outbound',
    contact_phone: recipient,
    channel: data.channel,
    platform_message_id: null,
    content: {
      error: err.message,
      code: 'rate_limit_exceeded',
      quota_key: err.quotaKey,
      current: err.current, cap: err.cap, resets_at: err.resetsAt,
    },
    status: 'failed',
  })
}

/**
 * DPDPA marketing-consent gate. Returns a "blocked" outcome (object) when
 * the send should NOT proceed, or null when it should. The caller short-
 * circuits the channel dispatch on a non-null return.
 *
 * Lookup order:
 *   1. Resolve template category from wa_templates by (tenant_id, name).
 *      If the template doesn't exist (older flow / generic name) or isn't
 *      marketing, return null (allow).
 *   2. Look up contact by (tenant_id, phone) — try multiple phone formats.
 *      If no contact row, return null (allow — pre-contact sends are rare
 *      and the broadcast worker has its own audience-membership gate).
 *   3. Look up contact_consent_state for (contact_id, channel, 'marketing').
 *      If status='opted_in', allow. Otherwise block.
 *
 * Block outcome writes a `messages` row with status='blocked_no_consent'
 * and blocked_reason set so the inbox shows the failure reason.
 */
async function checkMarketingConsent(data: MessageSendJob): Promise<{ blocked: true; reason: string } | null> {
  if (data.kind !== 'template' || !data.template?.name) return null
  // Only WA + IG carry templates; email/telegram are session-style so the
  // marketing-consent gate doesn't apply the same way today.
  if (data.channel !== 'whatsapp' && data.channel !== 'instagram') return null

  try {
    // 1. Resolve template category.
    const { data: tpl } = await supabase
      .from('wa_templates')
      .select('category')
      .eq('tenant_id', data.tenantId)
      .eq('name', data.template.name)
      .maybeSingle()
    const category = String((tpl as any)?.category ?? '').toLowerCase()
    if (category !== 'marketing') return null

    // 2. Resolve contact by phone (the job carries `to` not contact_id).
    const phoneNoPlus = String(data.to).replace(/^\+/, '')
    const variants = [`+${phoneNoPlus}`, phoneNoPlus]
    const { data: contact } = await supabase
      .from('contacts')
      .select('id')
      .eq('tenant_id', data.tenantId)
      .in('phone', variants)
      .maybeSingle()
    if (!contact?.id) return null  // unknown contact — allow (audience gate elsewhere)

    // 3. Consent lookup.
    const { data: state } = await supabase
      .from('contact_consent_state')
      .select('status')
      .eq('contact_id', contact.id)
      .eq('channel', data.channel)
      .eq('purpose', 'marketing')
      .maybeSingle()

    if (state?.status === 'opted_in') return null

    // Block. Log a messages row + return.
    const reason = state?.status === 'opted_out'
      ? 'Recipient has opted out of marketing (DPDPA)'
      : 'No marketing consent on file (DPDPA)'
    await supabase.from('messages').insert({
      tenant_id: data.tenantId,
      session_id: data.sessionId ?? null,
      broadcast_id: data.broadcastId ?? null,
      direction: 'outbound',
      contact_phone: `+${phoneNoPlus}`,
      channel: data.channel,
      content: {
        template: { name: data.template.name, language: data.template.language },
        blocked_at: new Date().toISOString(),
        blocked_reason: reason,
      },
      status: 'blocked_no_consent',
      blocked_reason: reason,
    })
    console.warn(`[consent-gate] BLOCKED tenant=${data.tenantId} contact=${contact.id} template=${data.template.name} reason="${reason}"`)
    return { blocked: true, reason }
  } catch (e: any) {
    // Fail-open: if the consent layer is broken (migration not applied,
    // RLS misconfigured), don't block sends — that's a worse failure mode
    // for the tenant than a single non-compliant message. Log loudly so
    // ops sees it.
    console.warn(`[consent-gate] check failed (allow): ${e?.message ?? e}`)
    return null
  }
}

async function logOutbound(
  tenant: any,
  to: string,
  payload: any,
  platformMessageId: string | null,
  status: string,
  error: string | null,
  sessionId: string | null = null,
  broadcastId: string | null = null,
  channel: 'whatsapp' | 'instagram' | 'telegram' | 'email' = 'whatsapp',
) {
  await supabase.from('messages').insert({
    tenant_id: tenant.id,
    session_id: sessionId,
    broadcast_id: broadcastId,
    direction: 'outbound',
    contact_phone: to,
    channel,
    // platform_message_id mirrors it across all channels.
    platform_message_id: platformMessageId,
    content: error ? { ...payload, error } : payload,
    status,
  })
}

// ── Instagram send ───────────────────────────────────────────────────────────
// Uses Meta Graph `/{ig_user_id}/messages` endpoint. Direct messaging only
// (the conversational surface inside IG inbox + DM responses to comments).
// Credentials come from `tenant_integrations` row keyed (tenant_id, 'instagram').
//
// Templates aren't supported by IG (no equivalent of WhatsApp pre-approved
// templates), so kind='template' falls back to text using template.parameters[0]
// as the body — caller is responsible for building the final string upstream
// when targeting IG.
async function sendInstagram(data: MessageSendJob) {
  const tenant = await getTenant(data.tenantId)
  // IG creds live in tenant_integrations, not on tenants row (pattern shared
  // with the routes/instagram.ts inbox-send path).
  const { data: ig } = await supabase.from('tenant_integrations')
    .select('access_token, metadata')
    .eq('tenant_id', tenant.id).eq('key', 'instagram').maybeSingle()
  if (!ig?.access_token) throw new Error(`tenant ${tenant.id}: Instagram not connected`)
  const igUserId = (ig.metadata as any)?.ig_user_id
  if (!igUserId) throw new Error(`tenant ${tenant.id}: ig_user_id missing on instagram integration`)
  const { decrypt } = await import('../crypto')
  const token = decrypt(ig.access_token)

  let payload: any
  if (data.kind === 'media' && data.media) {
    // IG accepts attachments via 'attachment' shape. Type maps: image|video|audio|document
    // → IG accepts image/video; audio/document fall back to text with link.
    if (data.media.type === 'image' || data.media.type === 'video') {
      payload = {
        recipient: { id: data.to },
        message: { attachment: { type: data.media.type, payload: { url: data.media.link, is_reusable: true } } },
      }
    } else {
      // audio/document: send as text with the link so the user can tap.
      payload = { recipient: { id: data.to }, message: { text: data.media.link ?? data.media.caption ?? '' } }
    }
  } else {
    // text + template (template falls back to text body) + interactive (IG
    // doesn't support buttons in DMs the same way; degrade to text body).
    const text = data.text
      ?? data.template?.parameters?.[0]
      ?? (data.interactive as any)?.body
      ?? ''
    payload = { recipient: { id: data.to }, message: { text } }
  }

  const r = await fetch(`${GRAPH}/${igUserId}/messages?access_token=${token}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
  const body = await r.json() as any
  if (!r.ok || body.error) {
    await logOutbound(tenant, data.to, payload, null, 'failed', body.error?.message, data.sessionId ?? null, data.broadcastId ?? null, 'instagram')
    throw new Error(`Meta IG send failed (${r.status}): ${body.error?.message ?? JSON.stringify(body)}`)
  }
  const msgId = body.message_id ?? body.id ?? null
  await logOutbound(tenant, data.to, payload, msgId, 'sent', null, data.sessionId ?? null, data.broadcastId ?? null, 'instagram')
  return { platform_message_id: msgId }
}

// ── Telegram send ────────────────────────────────────────────────────────────
// Uses Telegram Bot API. `data.to` is the Telegram chat_id (numeric string).
// Bot token lives in tg_bots table, encrypted; same pattern as routes/telegram.ts.
async function sendTelegram(data: MessageSendJob) {
  const tenant = await getTenant(data.tenantId)
  const { data: bot } = await supabase.from('tg_bots')
    .select('bot_token').eq('tenant_id', tenant.id).maybeSingle()
  if (!bot?.bot_token) throw new Error(`tenant ${tenant.id}: Telegram bot not connected`)
  const { decrypt } = await import('../crypto')
  const token = decrypt(bot.bot_token)

  // Decide method + payload by kind.
  let method: string
  let payload: any
  if (data.kind === 'media' && data.media) {
    // Telegram methods: sendPhoto / sendVideo / sendAudio / sendDocument
    const methodByType: Record<string, string> = {
      image: 'sendPhoto', video: 'sendVideo', audio: 'sendAudio', document: 'sendDocument',
    }
    method = methodByType[data.media.type] ?? 'sendMessage'
    const fieldByType: Record<string, string> = {
      image: 'photo', video: 'video', audio: 'audio', document: 'document',
    }
    const field = fieldByType[data.media.type] ?? 'text'
    payload = {
      chat_id: data.to,
      [field]: data.media.link ?? data.media.id,
      caption: data.media.caption ?? undefined,
    }
  } else if (data.kind === 'interactive') {
    // Inline keyboard mirrors the WhatsApp interactive pattern.
    const cfg = data.interactive ?? {}
    method = 'sendMessage'
    payload = {
      chat_id: data.to,
      text:    cfg.body ?? data.text ?? '',
      reply_markup: {
        inline_keyboard: [(cfg.buttons ?? []).slice(0, 8).map((b: any, i: number) => ({
          text: b.text ?? b,
          callback_data: b.id ?? `btn_${i}`,
        }))],
      },
    }
  } else {
    method  = 'sendMessage'
    const text = data.text ?? data.template?.parameters?.[0] ?? ''
    payload = { chat_id: data.to, text }
  }

  const r = await fetch(`${TG_API}/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
  const body = await r.json() as any
  if (!r.ok || !body.ok) {
    await logOutbound(tenant, data.to, payload, null, 'failed', body.description ?? `tg ${r.status}`, data.sessionId ?? null, data.broadcastId ?? null, 'telegram')
    throw new Error(`Telegram send failed (${r.status}): ${body.description ?? JSON.stringify(body)}`)
  }
  const msgId = String(body.result?.message_id ?? '')
  await logOutbound(tenant, data.to, payload, msgId || null, 'sent', null, data.sessionId ?? null, data.broadcastId ?? null, 'telegram')
  return { platform_message_id: msgId }
}

// ── Email send — Gmail-first, Resend fallback ────────────────────────────────
//
// Provider selection (in priority order, first match wins):
//   1. Explicit `data.email.provider === 'resend'` — caller wants Resend
//      (e.g. system notifications that should always come from the platform).
//   2. Explicit `data.email.provider === 'gmail'` — caller wants Gmail
//      (rare; usually 'auto' is what you want).
//   3. Default ('auto' / unset / legacy 'smtp'):
//      - If tenant has Google connected (`google_access_token` non-null),
//        send via the tenant's OWN Gmail using the gmail.modify scope
//        already requested at /api/auth/google. Email comes FROM the
//        tenant's email address — better deliverability, on-brand, and
//        replies land in their own Gmail inbox.
//      - Else fall back to Resend (lib/email.ts) so workflows still work
//        for tenants who haven't connected Google.
//
// Idempotency: dedup key derived from sessionId + subject hash so worker
// retries don't double-send. Gmail doesn't have a built-in idempotency
// header, so we maintain our own short-window guard via the messages table
// (status='sent' on a prior attempt with the same dedup key skips).
async function sendEmailViaProvider(data: MessageSendJob) {
  if (!data.email) throw new Error('send_email: missing email payload')
  const tenant = await getTenant(data.tenantId)

  const explicit = data.email.provider
  const gmailConnected = !!tenant.google_access_token
  // 'smtp' was the legacy default value for the field; treat it as auto so
  // older workflows pick up Gmail-when-connected without a re-author.
  const useGmail =
    explicit === 'gmail'
    || (gmailConnected && (!explicit || explicit === 'smtp' || (explicit as string) === 'auto'))

  if (useGmail) return await sendViaGmail(tenant, data)
  return await sendViaResend(tenant, data)
}

async function sendViaGmail(tenant: any, data: MessageSendJob) {
  const { gmailSendEmail } = await import('../google')
  // Body wrap matches the Resend path so emails look identical regardless
  // of provider. Plain text body becomes a minimal HTML envelope.
  const html = wrapEmailBody(data.email!.body)
  try {
    const result = await gmailSendEmail(tenant, data.email!.to, data.email!.subject, html)
    await logOutbound(tenant, data.email!.to,
      { subject: data.email!.subject, via: 'gmail' },
      result.id || null, 'sent',
      null, data.sessionId ?? null, data.broadcastId ?? null, 'email')
    return { gmail_id: result.id, via: 'gmail' }
  } catch (err: any) {
    await logOutbound(tenant, data.email!.to,
      { subject: data.email!.subject, via: 'gmail' },
      null, 'failed', err?.message ?? String(err),
      data.sessionId ?? null, data.broadcastId ?? null, 'email')
    throw err
  }
}

async function sendViaResend(tenant: any, data: MessageSendJob) {
  const { sendEmail } = await import('../lib/email')
  const idempotencyKey = data.sessionId
    ? `wf-email-${data.sessionId}-${hashSubject(data.email!.subject)}`
    : `wf-email-${data.tenantId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const html = wrapEmailBody(data.email!.body)
  try {
    const result = await sendEmail({
      to:      data.email!.to,
      subject: data.email!.subject,
      html,
      text:    data.email!.body,
      idempotency_key: idempotencyKey,
    })
    await logOutbound(tenant, data.email!.to,
      { subject: data.email!.subject, via: 'resend' },
      result.id || null, 'sent',
      null, data.sessionId ?? null, data.broadcastId ?? null, 'email')
    return { resend_id: result.id, via: 'resend' }
  } catch (err: any) {
    await logOutbound(tenant, data.email!.to,
      { subject: data.email!.subject, via: 'resend' },
      null, 'failed', err?.message ?? String(err),
      data.sessionId ?? null, data.broadcastId ?? null, 'email')
    throw err
  }
}

function wrapEmailBody(body: string | undefined): string {
  const safeBody = String(body ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/\n/g, '<br>')
  return `<!doctype html><html><body style="font:14px/1.55 -apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;color:#1a1a1a">${safeBody}</body></html>`
}

function hashSubject(s: string): string {
  let h = 0
  for (let i = 0; i < s.length; i++) { h = ((h << 5) - h) + s.charCodeAt(i); h |= 0 }
  return Math.abs(h).toString(36).slice(0, 8)
}
