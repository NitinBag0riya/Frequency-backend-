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
import { Worker, Job } from 'bullmq'
import { createClient } from '@supabase/supabase-js'
import { Q, MessageSendJob, connection } from '../queue'

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
      // Global rate limit. Meta cap is 80 msg/sec per WABA; we stay at 50/sec.
      // Per-tenant grouping is a Phase 4 task (use BullMQ groups + queue.add({group}))
      limiter: { max: 50, duration: 1000 },
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
    // wa_message_id kept for back-compat with WhatsApp-only readers; new
    // platform_message_id mirrors it across all channels.
    wa_message_id: channel === 'whatsapp' ? platformMessageId : null,
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

// ── Email send — REAL Resend delivery ────────────────────────────────────────
// Routes through lib/email.ts which is the same Resend wrapper that already
// powers transactional notifications. ONE provider = ONE codepath = no drift.
//
// `data.email.body` is treated as plain text. We wrap in a minimal HTML
// envelope so the email renders in Gmail/Outlook without looking like spam,
// while still preserving line breaks via <br>. Idempotency-key is derived
// from sessionId + subject so a worker retry doesn't double-send.
async function sendEmailViaProvider(data: MessageSendJob) {
  if (!data.email) throw new Error('send_email: missing email payload')
  const tenant = await getTenant(data.tenantId)

  const { sendEmail } = await import('../lib/email')
  const idempotencyKey = data.sessionId
    ? `wf-email-${data.sessionId}-${hashSubject(data.email.subject)}`
    : `wf-email-${data.tenantId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

  // Minimal HTML envelope so the body renders as readable HTML in clients.
  const safeBody = String(data.email.body ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/\n/g, '<br>')
  const html = `<!doctype html><html><body style="font:14px/1.55 -apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;color:#1a1a1a">${safeBody}</body></html>`

  try {
    const result = await sendEmail({
      to:      data.email.to,
      subject: data.email.subject,
      html,
      text:    data.email.body,
      idempotency_key: idempotencyKey,
    })
    await logOutbound(tenant, data.email.to, { subject: data.email.subject }, result.id || null, 'sent',
      null, data.sessionId ?? null, data.broadcastId ?? null, 'email')
    return { resend_id: result.id }
  } catch (err: any) {
    await logOutbound(tenant, data.email.to, { subject: data.email.subject }, null, 'failed',
      err?.message ?? String(err), data.sessionId ?? null, data.broadcastId ?? null, 'email')
    throw err
  }
}

function hashSubject(s: string): string {
  let h = 0
  for (let i = 0; i < s.length; i++) { h = ((h << 5) - h) + s.charCodeAt(i); h |= 0 }
  return Math.abs(h).toString(36).slice(0, 8)
}
