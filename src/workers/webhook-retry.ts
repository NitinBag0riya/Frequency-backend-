/**
 * Worker: webhook.inbound + webhook.outbound (migration 064)
 *
 * Two BullMQ workers in one file because they share the same DLQ machinery,
 * the same backoff strategy, and the same QueueEvents wiring.
 *
 * ── Inbound ────────────────────────────────────────────────────────────────
 *   Routes that previously did:
 *     verify(rawBody) → DB writes inline → 200
 *   now do:
 *     verify(rawBody) → enqueueWebhookInbound(...) → 200
 *
 *   The worker here dispatches by `source` to per-source processors:
 *     'meta_whatsapp'   → processMetaWhatsAppInbound
 *     'meta_instagram'  → processMetaInstagramInbound
 *     'telegram'        → processTelegramInbound
 *     'razorpay'        → processRazorpayInbound
 *     'wa_calls'        → processWACallsInbound
 *
 *   Each processor IS the same code path that used to live in the route
 *   handler — extracted to its own function so both the live route and the
 *   queue worker can call it. The route handler itself is now a thin
 *   wrapper that runs the processor inline when WEBHOOK_QUEUE_ENABLED=0,
 *   or enqueues when WEBHOOK_QUEUE_ENABLED=1.
 *
 * ── Outbound ───────────────────────────────────────────────────────────────
 *   Generic HTTP-with-retry. The job payload carries url, method, headers,
 *   body, timeoutMs. The worker:
 *     1. Issues the request with a per-attempt timeout
 *     2. Treats 2xx as success; 4xx as terminal (UnrecoverableError); 5xx +
 *        network errors as retryable (BullMQ re-queues with the next slot
 *        in the schedule).
 *     3. On final failure, the failed-listener writes a webhook_dead_letter
 *        row + adds a job to webhook.outbound.dead so Bull Board has a
 *        peer record.
 *
 * Retry schedule (both queues): 1s / 5s / 30s / 5m / 30m — registered as a
 * custom `webhookRetry` backoff strategy on each Worker.
 *
 * Feature flag: WEBHOOK_QUEUE_ENABLED. Workers always run when DISABLE_
 * WORKERS!=1 — the flag only gates whether route handlers route through
 * the queue or run inline. That way we can ship + smoke the worker without
 * forcing a cutover.
 */

import '../env'
import { Worker, Job, QueueEvents, UnrecoverableError } from 'bullmq'
import { createClient, SupabaseClient } from '@supabase/supabase-js'
import {
  Q,
  connection,
  webhookRetryBackoff,
  WEBHOOK_RETRY_ATTEMPTS,
  webhookInboundQueue,
  webhookOutboundQueue,
  webhookInboundDeadQueue,
  webhookOutboundDeadQueue,
  WebhookInboundJob,
  WebhookOutboundJob,
} from '../queue'

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://yiicpndeggaedxobyopu.supabase.co'
const supabase = createClient(SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY!)

// Stale-job guard. Meta won't replay a webhook after 24h; if a job has been
// stuck in our queue for >30min it's almost certainly because the worker
// was down — better to drop than to fire a long-stale workflow trigger.
// Replays from the super-admin endpoint set `isReplay=true` to bypass.
const STALE_THRESHOLD_MS = 30 * 60_000

// ─── Per-source processors ──────────────────────────────────────────────────
// Each takes the already-verified raw body + extras and returns a small
// summary object the BullMQ Job result can carry (for `completed` events).
// Throwing a regular Error triggers a retry; throwing UnrecoverableError
// (or any error with `.unrecoverable = true`) lands straight in DLQ.

type ProcessorResult = { ok: true; note?: string }

async function processMetaWhatsAppInbound(payload: WebhookInboundJob): Promise<ProcessorResult> {
  const body = JSON.parse(Buffer.from(payload.rawBodyB64, 'base64').toString('utf8'))
  if (body.object !== 'whatsapp_business_account') return { ok: true, note: 'non_wa_object' }

  // Lazy import to keep the worker boot light + avoid circular deps with
  // engine/inbound-router which pulls in queue.ts already.
  const { routeInboundToWorkflow } = await import('../engine/inbound-router')

  for (const entry of body.entry ?? []) {
    const wabaId: string = entry.id
    for (const change of entry.changes ?? []) {
      if (change.field !== 'messages') continue
      const value = change.value

      const { data: tenant, error: tenantErr } = await supabase.from('tenants')
        .select('*').eq('waba_id', wabaId).eq('status', 'active').maybeSingle()
      // Transient DB errors → retry. Missing tenant → drop (the WABA isn't
      // ours; replaying won't help).
      if (tenantErr) throw new Error(`tenant lookup failed: ${tenantErr.message}`)
      if (!tenant) continue

      for (const msg of value.messages ?? []) {
        const phone = msg.from
        const text  = msg.text?.body ?? msg.button?.text ?? msg.interactive?.button_reply?.title ?? ''
        const contactProfile = value.contacts?.[0]

        const { error: msgErr } = await supabase.from('messages').insert({
          tenant_id:           tenant.id,
          channel:             'whatsapp',
          direction:           'inbound',
          contact_phone:       phone,
          platform_message_id: msg.id,
          content:             msg,
        })
        // Unique constraint on platform_message_id means a retry that ran
        // after a partial success will conflict — treat as already-processed.
        if (msgErr && !/duplicate key|unique/i.test(msgErr.message)) {
          throw new Error(`messages insert failed: ${msgErr.message}`)
        }

        await supabase.from('contacts').upsert({
          tenant_id: tenant.id,
          user_id:   tenant.user_id,
          phone:     `+${phone}`,
          name:      contactProfile?.profile?.name ?? `+${phone}`,
        }, { onConflict: 'tenant_id,phone' })

        await routeInboundToWorkflow(supabase, tenant, 'whatsapp', phone, text, msg)
      }

      for (const status of value.statuses ?? []) {
        await supabase.from('messages')
          .update({ status: status.status })
          .eq('platform_message_id', status.id)
          .eq('tenant_id', tenant.id)
      }
    }
  }
  return { ok: true }
}

async function processMetaInstagramInbound(payload: WebhookInboundJob): Promise<ProcessorResult> {
  const body = JSON.parse(Buffer.from(payload.rawBodyB64, 'base64').toString('utf8'))
  const { routeInboundToWorkflow } = await import('../engine/inbound-router')

  for (const entry of body.entry ?? []) {
    const pageId = String(entry?.id ?? '')
    if (!pageId) continue
    const { data: integration } = await supabase.from('tenant_integrations')
      .select('tenant_id, metadata').eq('key', 'instagram')
      .filter('metadata->>page_id', 'eq', pageId).maybeSingle()
    if (!integration?.tenant_id) continue
    const { data: tenant } = await supabase.from('tenants')
      .select('*').eq('id', integration.tenant_id).maybeSingle()
    if (!tenant) continue

    for (const m of (entry.messaging ?? [])) {
      if (m.message?.is_echo) continue
      const senderId = String(m.sender?.id ?? '')
      const text     = m.message?.text ?? ''
      if (!senderId) continue

      const { error: msgErr } = await supabase.from('messages').insert({
        tenant_id:           tenant.id,
        channel:             'instagram',
        direction:           'inbound',
        contact_phone:       senderId,
        platform_message_id: String(m.message?.mid ?? ''),
        content:             { type: 'text', text, raw: m },
      })
      if (msgErr && !/duplicate key|unique/i.test(msgErr.message)) {
        throw new Error(`ig messages insert: ${msgErr.message}`)
      }
      await routeInboundToWorkflow(supabase, tenant, 'instagram', senderId, text, m)
    }
  }
  return { ok: true }
}

async function processTelegramInbound(payload: WebhookInboundJob): Promise<ProcessorResult> {
  const tenantId = payload.tenantId || payload.query?.tenant_id || ''
  if (!tenantId) {
    // No tenant — terminal; replay won't help unless the operator edits the
    // payload. Marking as UnrecoverableError lands it in DLQ on attempt #1
    // rather than burning 5 attempts.
    throw Object.assign(new UnrecoverableError('telegram payload missing tenant_id'), { unrecoverable: true })
  }
  const update = JSON.parse(Buffer.from(payload.rawBodyB64, 'base64').toString('utf8'))
  const msg = update.message ?? update.edited_message
  if (!msg) return { ok: true, note: 'non_message_update' }

  const fromId = String(msg.chat?.id ?? msg.from?.id ?? '')
  const username = msg.from?.username ?? null
  const name = [msg.from?.first_name, msg.from?.last_name].filter(Boolean).join(' ') || username || `Telegram ${fromId}`
  const text = msg.text ?? msg.caption ?? ''

  const { data: existing } = await supabase.from('contacts')
    .select('id').eq('tenant_id', tenantId).eq('telegram_id', fromId).maybeSingle()
  if (!existing) {
    await supabase.from('contacts').insert({
      tenant_id: tenantId, name, phone: `tg:${fromId}`, telegram_id: fromId,
      channel_primary: 'telegram',
    })
  }
  const { error: msgErr } = await supabase.from('messages').insert({
    tenant_id: tenantId, channel: 'telegram', direction: 'inbound',
    contact_phone: fromId,
    platform_message_id: String(msg.message_id),
    content: { type: 'text', text, raw: msg },
  })
  if (msgErr && !/duplicate key|unique/i.test(msgErr.message)) {
    throw new Error(`tg messages insert: ${msgErr.message}`)
  }

  if (text) {
    const { data: tenantRow } = await supabase.from('tenants')
      .select('*').eq('id', tenantId).maybeSingle()
    if (tenantRow) {
      const { routeInboundToWorkflow } = await import('../engine/inbound-router')
      await routeInboundToWorkflow(supabase, tenantRow, 'telegram', fromId, text, msg)
    }
  }
  return { ok: true }
}

async function processRazorpayInbound(payload: WebhookInboundJob): Promise<ProcessorResult> {
  // We re-import billing's processor at call time. The billing router used
  // to inline this — we now expose it as a named helper that both the route
  // (when flag=off) and this worker call.
  const { processRazorpayWebhookPayload } = await import('../lib/razorpay-webhook')
  const parsed = JSON.parse(Buffer.from(payload.rawBodyB64, 'base64').toString('utf8'))
  await processRazorpayWebhookPayload(supabase, parsed)
  return { ok: true }
}

async function processWACallsInbound(payload: WebhookInboundJob): Promise<ProcessorResult> {
  // The wa-calling route's inline ingest is also extracted to a helper that
  // accepts the parsed body. Keep the worker side lean — most of the work
  // already happens in dedicated WA-calling workers downstream.
  const { processWACallsWebhookPayload } = await import('../lib/wa-calls-webhook')
  const parsed = JSON.parse(Buffer.from(payload.rawBodyB64, 'base64').toString('utf8'))
  await processWACallsWebhookPayload(supabase, parsed)
  return { ok: true }
}

const INBOUND_PROCESSORS: Record<WebhookInboundJob['source'], (p: WebhookInboundJob) => Promise<ProcessorResult>> = {
  meta_whatsapp:  processMetaWhatsAppInbound,
  meta_instagram: processMetaInstagramInbound,
  telegram:       processTelegramInbound,
  razorpay:       processRazorpayInbound,
  wa_calls:       processWACallsInbound,
}

// ─── Outbound HTTP runner ───────────────────────────────────────────────────
async function runOutbound(job: Job<WebhookOutboundJob>): Promise<{ ok: true; status: number }> {
  const d = job.data
  const timeoutMs = d.timeoutMs ?? 10_000

  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'user-agent':   'Frequency-Webhook/1.0',
    ...(d.headers ?? {}),
  }
  if (d.idempotencyKey) headers['idempotency-key'] = d.idempotencyKey

  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), timeoutMs)
  try {
    const r = await fetch(d.url, {
      method:  d.method,
      headers,
      body:    d.method === 'GET' || d.method === 'DELETE' ? undefined : d.body,
      signal:  ctl.signal,
    })
    if (r.status >= 200 && r.status < 300) return { ok: true, status: r.status }
    // 4xx (except 408/429) → terminal; the URL is wrong / endpoint rejects.
    if (r.status >= 400 && r.status < 500 && r.status !== 408 && r.status !== 429) {
      const bodyTail = (await r.text().catch(() => '')).slice(0, 500)
      throw new UnrecoverableError(`outbound ${r.status}: ${bodyTail}`)
    }
    // 5xx / 408 / 429 → retryable
    const bodyTail = (await r.text().catch(() => '')).slice(0, 500)
    throw new Error(`outbound ${r.status}: ${bodyTail}`)
  } catch (e: any) {
    if (e?.name === 'AbortError') throw new Error(`outbound timeout after ${timeoutMs}ms`)
    throw e
  } finally {
    clearTimeout(timer)
  }
}

// ─── DLQ writer ────────────────────────────────────────────────────────────
async function recordDeadLetter(
  sb: SupabaseClient,
  args: {
    direction: 'inbound' | 'outbound'
    source:    string
    tenantId:  string | null
    payload:   any
    attempts:  number
    lastError: string
  }
): Promise<string | null> {
  try {
    const { data, error } = await sb.from('webhook_dead_letter').insert({
      tenant_id:  args.tenantId,
      source:     args.source,
      direction:  args.direction,
      payload:    args.payload,
      attempts:   args.attempts,
      last_error: args.lastError.slice(0, 4000),
    }).select('id').single()
    if (error) {
      console.error(`[webhook.dlq] insert failed: ${error.message}`)
      return null
    }
    return data.id
  } catch (e: any) {
    console.error(`[webhook.dlq] insert threw: ${e?.message ?? e}`)
    return null
  }
}

// ─── Worker starters ───────────────────────────────────────────────────────

export function startWebhookInboundWorker() {
  const concurrency = Number(process.env.WEBHOOK_INBOUND_CONCURRENCY ?? 20)
  const worker = new Worker<WebhookInboundJob>(
    Q.webhookInbound,
    async (job: Job<WebhookInboundJob>) => {
      const d = job.data
      // Stale-job guard — drop quietly. Don't throw (would burn an attempt).
      if (!d.isReplay && d.receivedAt) {
        const ageMs = Date.now() - new Date(d.receivedAt).getTime()
        if (Number.isFinite(ageMs) && ageMs > STALE_THRESHOLD_MS) {
          console.warn(`[webhook.inbound] dropping stale ${d.source} job age=${Math.round(ageMs/1000)}s`)
          return { ok: true, dropped: 'stale' }
        }
      }
      const fn = INBOUND_PROCESSORS[d.source]
      if (!fn) throw new UnrecoverableError(`unknown inbound source: ${d.source}`)
      return fn(d)
    },
    {
      connection,
      concurrency,
      settings: {
        backoffStrategy: (attemptsMade: number) => webhookRetryBackoff(attemptsMade),
      },
    },
  )

  worker.on('failed', async (job, err) => {
    if (!job) return
    const attemptsMade = job.attemptsMade ?? 0
    const isFinal = attemptsMade >= WEBHOOK_RETRY_ATTEMPTS
    console.warn(`[webhook.inbound] ✗ ${job.data?.source} attempt=${attemptsMade}/${WEBHOOK_RETRY_ATTEMPTS} — ${err.message}`)
    if (!isFinal) return
    // Final failure — persist DLQ row + Bull Board peer.
    const dlqId = await recordDeadLetter(supabase, {
      direction: 'inbound',
      source:    job.data?.source ?? 'unknown',
      tenantId:  job.data?.tenantId ?? null,
      payload:   job.data,
      attempts:  attemptsMade,
      lastError: err.message,
    })
    if (dlqId) {
      try {
        await webhookInboundDeadQueue.add('dead', { ...job.data, deadLetterId: dlqId, lastError: err.message })
      } catch (e: any) { console.warn(`[webhook.inbound] dead queue add failed: ${e?.message}`) }
    }
  })

  return worker
}

export function startWebhookOutboundWorker() {
  const concurrency = Number(process.env.WEBHOOK_OUTBOUND_CONCURRENCY ?? 10)
  const worker = new Worker<WebhookOutboundJob>(
    Q.webhookOutbound,
    runOutbound,
    {
      connection,
      concurrency,
      settings: {
        backoffStrategy: (attemptsMade: number) => webhookRetryBackoff(attemptsMade),
      },
    },
  )

  worker.on('failed', async (job, err) => {
    if (!job) return
    const attemptsMade = job.attemptsMade ?? 0
    const isFinal = attemptsMade >= WEBHOOK_RETRY_ATTEMPTS
    console.warn(`[webhook.outbound] ✗ ${job.data?.source} ${job.data?.url} attempt=${attemptsMade}/${WEBHOOK_RETRY_ATTEMPTS} — ${err.message}`)
    if (!isFinal && !(err instanceof UnrecoverableError)) return
    const dlqId = await recordDeadLetter(supabase, {
      direction: 'outbound',
      source:    job.data?.source ?? 'unknown',
      tenantId:  job.data?.tenantId ?? null,
      payload:   job.data,
      attempts:  attemptsMade,
      lastError: err.message,
    })
    if (dlqId) {
      try {
        await webhookOutboundDeadQueue.add('dead', { ...job.data, deadLetterId: dlqId, lastError: err.message })
      } catch (e: any) { console.warn(`[webhook.outbound] dead queue add failed: ${e?.message}`) }
    }
  })

  return worker
}

// Re-export the processors so the route handlers can also call them inline
// when WEBHOOK_QUEUE_ENABLED=0 (feature flag off).
export const inboundProcessors = INBOUND_PROCESSORS
