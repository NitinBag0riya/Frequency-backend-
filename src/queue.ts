/**
 * BullMQ queues + ioredis connection.
 *
 * Four queues:
 *   - workflow.execute  → executes one node of a workflow session
 *   - message.send      → sends a single WA / email message (with retry + DLQ)
 *   - broadcast.batch   → fans a broadcast out into per-contact message.send jobs
 *   - system.cron       → singleton repeatable poller (scheduled_jobs table)
 *
 * Both the API process (src/index.ts) and worker process (src/worker.ts)
 * import this file. The API enqueues; the worker subscribes.
 */

import './env'
import IORedis from 'ioredis'
import { Queue, QueueEvents } from 'bullmq'

// ── Redis connection ──────────────────────────────────────────────────────────
// Supports either:
//   REDIS_URL=rediss://default:pwd@host:port    (Upstash, Railway)
// or discrete: REDIS_HOST / REDIS_PORT / REDIS_PASSWORD / REDIS_TLS=1
const REDIS_URL = process.env.REDIS_URL

function buildConnection(): IORedis {
  const opts = {
    // BullMQ requires this to be null so blocking commands work.
    maxRetriesPerRequest: null as null,
    enableReadyCheck: false,
  }
  if (REDIS_URL) return new IORedis(REDIS_URL, opts)
  return new IORedis({
    host: process.env.REDIS_HOST || '127.0.0.1',
    port: Number(process.env.REDIS_PORT || 6379),
    password: process.env.REDIS_PASSWORD || undefined,
    tls: process.env.REDIS_TLS === '1' ? {} : undefined,
    ...opts,
  })
}

// One shared connection for queue *publishing*; workers create their own.
export const connection = buildConnection()

connection.on('error', (err) => {
  // Don't spam — print once per connection drop.
  console.warn('[redis] error:', err.message)
})

// ── Queue names (exported as constants to avoid typos) ────────────────────────
export const Q = {
  workflow: 'workflow.execute',
  message:  'message.send',
  broadcast:'broadcast.batch',
  cron:     'system.cron',
  // ── WA Business Calling (migration 035) ───────────────────────────────────
  // dispatch:      agent click → Meta POST /<phone_number_id>/calls
  // event_ingest:  Meta webhook fan-in → state-machine transitions
  // recording_archive: pull recording from Meta CDN → Supabase Storage
  // transcribe:    Anthropic call against archived audio → call_transcripts
  callDispatch:         'call.dispatch',
  callEventIngest:      'call.event.ingest',
  callRecordingArchive: 'call.recording.archive',
  callTranscribe:       'call.transcribe',
  // ── Webhook reliability (migration 064) ──────────────────────────────────
  // inbound:  payloads we RECEIVE from external systems (Meta WA / IG /
  //           Telegram / Razorpay / wa-calls). Route handlers verify the
  //           signature inline, enqueue the raw bytes, then 200 OK so the
  //           sender never sees a slow Supabase write.
  // outbound: payloads we SEND (workflow http_request nodes, tenant
  //           assignment-notification webhooks, etc).
  // *.dead:   permanent failure sink for super-admin replay UI. We don't
  //           consume these queues directly — the per-side worker writes a
  //           webhook_dead_letter row + adds the job to *.dead so Bull
  //           Board has it too for cross-reference.
  webhookInbound:       'webhook.inbound',
  webhookOutbound:      'webhook.outbound',
  webhookInboundDead:   'webhook.inbound.dead',
  webhookOutboundDead:  'webhook.outbound.dead',
  // ── Voice note transcription (migration 086) ───────────────────────────
  // Inbound WA / IG / Telegram voice notes get queued here after the
  // messages row lands. Worker downloads the audio, calls OpenAI Whisper,
  // writes the transcript to voice_note_transcripts. Best-effort — a
  // failure here NEVER blocks message persistence.
  voiceNoteTranscribe:  'voice-note.transcribe',
  // ── DPDPA §8(6) breach fan-out (migration 075) ──────────────────────────
  // One job per breach. Worker expands the breach into per-tenant per-
  // recipient sends, inserts breach_notification_recipients rows, and
  // emails via Resend. jobId = `breach-notification:${breach_id}` for
  // idempotency — BullMQ rejects duplicate adds for the same logical
  // breach, the enqueuer swallows the error.
  breachNotification:   'breach-notification',
  // ── AI Agent KB embeddings (migration 096 + 099) ─────────────────────────
  // Fired when a new kb_chunks row needs an embedding. Worker calls
  // OpenAI text-embedding-3-small (1536 dim → matches schema), writes
  // the vector back, and the /api/ai-agent/test endpoint switches to
  // vector retrieval via match_kb_chunks RPC. Keyword overlap remains
  // the fallback when chunks haven't been embedded yet.
  kbEmbed:              'kb.embed',
} as const

// ── Job payload types ─────────────────────────────────────────────────────────
export interface WorkflowExecuteJob {
  sessionId: string
  nodeId: string
  // Optional inbound message that triggered this execution (for condition nodes
  // and collect_input variable assignment).
  reply?: { text: string; raw?: any } | null
}

export interface MessageSendJob {
  tenantId: string
  /** WhatsApp/IG: E.164-ish phone (no +). Telegram: chat_id. Email: ignored
   *  (email body has its own `to` field). */
  to: string
  /** Channel router. 'whatsapp' | 'instagram' | 'telegram' | 'email'.
   *  Sender-worker dispatches to the right per-channel function. */
  channel: 'whatsapp' | 'instagram' | 'telegram' | 'email'
  /** Common message shape across messaging channels. 'media' covers
   *  image/video/audio/document (kind further qualified by `media.type`). */
  kind?: 'text' | 'template' | 'interactive' | 'media'
  text?: string
  template?: { name: string; language: string; parameters: string[] }
  interactive?: any
  /** Media payload — used when kind='media'. type narrows to the actual
   *  asset; either link OR id (pre-uploaded Meta media id) must be set. */
  media?: {
    type:     'image' | 'video' | 'audio' | 'document'
    link?:    string                  // public https URL
    id?:      string                  // pre-uploaded Meta media id
    caption?: string                  // image/video/document only
    filename?: string                 // document only
  }
  // For email — Gmail-first when tenant has Google connected, Resend fallback.
  // See workers/message-sender.ts:sendEmailViaProvider for routing rules.
  email?: {
    to:        string
    subject:   string
    body:      string                 // plain text or simple HTML
    /** Provider override:
     *   'auto' / unset / 'smtp' (legacy) → Gmail if connected, else Resend
     *   'gmail'                          → Force Gmail (errors if not connected)
     *   'resend'                         → Force Resend (system / branded mail)
     *   'sendgrid' / 'mailgun'           → reserved keys; not yet wired
     */
    provider?: 'auto' | 'gmail' | 'resend' | 'smtp' | 'sendgrid' | 'mailgun'
  }
  // Bookkeeping
  sessionId?: string | null
  broadcastId?: string | null
}

export interface BroadcastBatchJob {
  broadcastId: string
}

// ── WA Calling job payload types (migration 035) ─────────────────────────────
// Keep payloads small — workers re-read state from DB to avoid stale-job
// drift. Job IDs are stable per logical event so BullMQ dedupes retries.

export interface CallDispatchJob {
  tenantId:        string
  callSessionId:   string
  // Optional: the intent_id row that materialised this call. Worker checks
  // and stamps `used_at` defensively.
  consentLogId?:   string
}

export interface CallEventIngestJob {
  tenantId:    string
  callEventId: string
}

export interface CallRecordingArchiveJob {
  tenantId:         string
  callSessionId:    string
  metaRecordingUrl: string
  metaRecordingId?: string
}

export interface CallTranscribeJob {
  tenantId:       string
  callSessionId:  string
  recordingId:    string
  storagePath:    string
}

// ── Voice note transcription payload (migration 086) ───────────────────────
// Tiny payload — the worker re-reads the message row from DB to pick up
// content.media_url (or WA media id). jobId is the message_id so BullMQ
// dedupes retries / accidental double-enqueues from the inbound webhook
// (Meta legitimately resends a webhook on receipt timeout).
export interface VoiceNoteTranscribeJob {
  tenantId:  string
  messageId: string
}

// ── Webhook job payload types (migration 064) ───────────────────────────────
/**
 * Inbound webhook job. The route handler verifies the signature (HMAC for
 * Meta/Razorpay, secret-token for Telegram) THEN enqueues. We carry the raw
 * verified bytes so the worker can JSON.parse without re-verifying.
 *
 *   source       'meta_whatsapp' | 'meta_instagram' | 'telegram' |
 *                'razorpay' | 'wa_calls'
 *   rawBodyB64   base64 of the exact signed bytes (Buffer.from(rawBody)
 *                .toString('base64')). Worker reverses with Buffer.from(
 *                rawBodyB64, 'base64').
 *   headers      stringified relevant headers (signature already verified —
 *                kept for debugging + replay only)
 *   query        ?tenant_id=… for Telegram, ?hub.* for Meta verification
 *   receivedAt   ISO string set at enqueue time; worker uses it to detect
 *                stale jobs (>30min old → log and drop)
 */
export interface WebhookInboundJob {
  source:       'meta_whatsapp' | 'meta_instagram' | 'telegram' | 'razorpay' | 'wa_calls'
  rawBodyB64:   string
  headers?:     Record<string, string>
  query?:       Record<string, string>
  receivedAt:   string
  // For Telegram (carries tenant in query) we lift it here so the DLQ row
  // gets stamped immediately on dead-letter even if the worker never ran.
  tenantId?:    string | null
  // True when re-enqueued from the super-admin replay endpoint. Workers can
  // skip Meta-style "stale (>30min)" gating for replays.
  isReplay?:    boolean
}

/**
 * Outbound webhook job. The enqueuer is anything that wants to POST to a
 * tenant-supplied URL with retry + DLQ guarantees — workflow http_request
 * nodes, lead-assignment notification pings, etc.
 *
 *   tenantId   nullable — system-level outbound (super-admin probes) leaves
 *              it null. DLQ rows inherit this so the per-tenant view filters
 *              correctly.
 *   source     short label that groups related outbound URLs in the DLQ
 *              UI ('workflow_http', 'lead_assignment_webhook', …)
 *   url        full https URL
 *   method     POST | PUT | PATCH | DELETE (GET typically doesn't need DLQ;
 *              we accept it for completeness)
 *   headers    arbitrary; never store secrets here — pass them via a
 *              token-resolver hook on the worker side instead
 *   body       string body (workflow node already interpolates {{vars}})
 *   timeoutMs  per-attempt timeout; default 10000
 *   idempotencyKey  optional — added as an `Idempotency-Key` header so
 *              third-party endpoints can dedupe across retries
 */
export interface WebhookOutboundJob {
  tenantId:        string | null
  source:          string
  url:             string
  method:          'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  headers?:        Record<string, string>
  body?:           string
  timeoutMs?:      number
  idempotencyKey?: string
  isReplay?:       boolean
}

// ── Breach notification fan-out job (migration 075) ────────────────────────
// Tiny payload — worker re-reads the breach row to avoid stale-job drift if
// the super-admin edits the breach between enqueue and run.
export interface BreachNotificationJob {
  breachId: string
}

// ── Queue instances ───────────────────────────────────────────────────────────
const defaultJobOpts = {
  removeOnComplete: { count: 1000, age: 24 * 60 * 60 },  // keep last 1000 / 24h
  removeOnFail:     { count: 5000, age: 7 * 24 * 60 * 60 },
}

export const workflowQueue = new Queue<WorkflowExecuteJob>(Q.workflow, {
  connection,
  defaultJobOptions: { ...defaultJobOpts, attempts: 3, backoff: { type: 'exponential', delay: 1000 } },
})

export const messageQueue = new Queue<MessageSendJob>(Q.message, {
  connection,
  defaultJobOptions: { ...defaultJobOpts, attempts: 5, backoff: { type: 'exponential', delay: 2000 } },
})

export const broadcastQueue = new Queue<BroadcastBatchJob>(Q.broadcast, {
  connection,
  defaultJobOptions: { ...defaultJobOpts, attempts: 2 },
})

export const cronQueue = new Queue(Q.cron, {
  connection,
  defaultJobOptions: { ...defaultJobOpts, attempts: 1 },
})

// ── WA Calling queues (migration 035) ──────────────────────────────────────
// Retries / backoff match `01-backend-design.md` §6:
//   dispatch:          3 attempts, 2s/8s/30s
//   event.ingest:      5 attempts, 1s → 60s
//   recording.archive: 5 attempts, 5s → 5m
//   transcribe:        3 attempts, 10s/60s/5m; AI-cap-exceeded is terminal
//                      (the worker throws non-retryable on that branch)

export const callDispatchQueue = new Queue<CallDispatchJob>(Q.callDispatch, {
  connection,
  defaultJobOptions: { ...defaultJobOpts, attempts: 3, backoff: { type: 'exponential', delay: 2000 } },
})

export const callEventIngestQueue = new Queue<CallEventIngestJob>(Q.callEventIngest, {
  connection,
  defaultJobOptions: { ...defaultJobOpts, attempts: 5, backoff: { type: 'exponential', delay: 1000 } },
})

export const callRecordingArchiveQueue = new Queue<CallRecordingArchiveJob>(Q.callRecordingArchive, {
  connection,
  defaultJobOptions: { ...defaultJobOpts, attempts: 5, backoff: { type: 'exponential', delay: 5000 } },
})

export const callTranscribeQueue = new Queue<CallTranscribeJob>(Q.callTranscribe, {
  connection,
  defaultJobOptions: { ...defaultJobOpts, attempts: 3, backoff: { type: 'exponential', delay: 10000 } },
})

// ── Voice note transcription queue (migration 086) ─────────────────────────
// 2 attempts only — Whisper failures are mostly permanent (corrupted audio,
// unsupported format, expired media URL). Hammering OpenAI with retries on
// a bad file just burns budget. 30s backoff between the two tries handles
// transient OpenAI 5xx.
export const voiceNoteTranscribeQueue = new Queue<VoiceNoteTranscribeJob>(Q.voiceNoteTranscribe, {
  connection,
  defaultJobOptions: { ...defaultJobOpts, attempts: 2, backoff: { type: 'exponential', delay: 30_000 } },
})

// ── Webhook queues (migration 064) ────────────────────────────────────────
// Retry schedule per spec: 5 attempts, ~1s → 5s → 30s → 5m → 30m.
// BullMQ exponential backoff uses delay * 2^(attempt-1), which doesn't fit
// the 1s/5s/30s/5m/30m shape exactly. We use `type: 'custom'` via a small
// backoff strategy registered on the Worker side (see workers/webhook-
// retry.ts). Here we set `delay` to a sentinel and let the worker compute.
//
// Larger removeOnFail window than the default — we WANT to keep failed jobs
// visible in Bull Board for ~14d alongside the webhook_dead_letter row, so
// operators have two cross-referenceable sources of truth.

const WEBHOOK_RETRY_SCHEDULE_MS = [1_000, 5_000, 30_000, 5 * 60_000, 30 * 60_000] as const
export const WEBHOOK_RETRY_ATTEMPTS = WEBHOOK_RETRY_SCHEDULE_MS.length

const webhookJobOpts = {
  removeOnComplete: { count: 1000, age: 24 * 60 * 60 },
  removeOnFail:     { count: 5000, age: 14 * 24 * 60 * 60 },
  attempts:         WEBHOOK_RETRY_ATTEMPTS,
  // 'webhookRetry' is the strategy name registered on each worker via
  // `settings.backoffStrategies`. We bake the schedule above into that
  // strategy so it stays in lockstep with this constant.
  backoff:          { type: 'webhookRetry' } as const,
}

export const webhookInboundQueue = new Queue<WebhookInboundJob>(Q.webhookInbound, {
  connection,
  defaultJobOptions: webhookJobOpts,
})

export const webhookOutboundQueue = new Queue<WebhookOutboundJob>(Q.webhookOutbound, {
  connection,
  defaultJobOptions: webhookJobOpts,
})

// Dead-letter queues — write-only; we add a job here when a worker
// permanently fails so Bull Board has a peer record of the
// webhook_dead_letter row. No worker consumes these.
export const webhookInboundDeadQueue = new Queue<WebhookInboundJob & { deadLetterId: string; lastError: string }>(
  Q.webhookInboundDead, { connection, defaultJobOptions: {
    removeOnComplete: false,
    removeOnFail: false,
    attempts: 1,
  }},
)
export const webhookOutboundDeadQueue = new Queue<WebhookOutboundJob & { deadLetterId: string; lastError: string }>(
  Q.webhookOutboundDead, { connection, defaultJobOptions: {
    removeOnComplete: false,
    removeOnFail: false,
    attempts: 1,
  }},
)

// ── Breach notification fan-out queue (migration 075) ──────────────────────
// 3 attempts, 30s/2m/10m backoff. The PER-RECIPIENT send-status is tracked
// in breach_notification_recipients (worker writes 'sent' / 'failed'); the
// JOB itself only fails if the whole expansion + iteration crashes (DB
// outage, etc.) — Resend send errors are caught per-recipient.
export const breachNotificationQueue = new Queue<BreachNotificationJob>(Q.breachNotification, {
  connection,
  defaultJobOptions: { ...defaultJobOpts, attempts: 3, backoff: { type: 'exponential', delay: 30_000 } },
})

// ── KB embedding queue (migration 099) ─────────────────────────────────────
// One job per kb_chunks row that lacks an embedding. The route handlers
// (POST /api/ai-agent/sources/qa) enqueue immediately after insert; a
// backfill cron in workers/kb-embed.ts scans for stale rows every 5min.
// Idempotency: jobId = `kb-embed:${chunk_id}` so an in-flight or queued
// job for the same chunk dedupes.
export interface KbEmbedJob {
  chunk_id: string
}
export const kbEmbedQueue = new Queue<KbEmbedJob>(Q.kbEmbed, {
  connection,
  defaultJobOptions: { ...defaultJobOpts, attempts: 3, backoff: { type: 'exponential', delay: 5_000 } },
})

/**
 * BullMQ custom backoff strategy used by webhook.inbound + webhook.outbound
 * workers. Returns ms to wait before the NEXT attempt. attemptsMade is the
 * 1-based count of attempts that have *already* completed (BullMQ semantics).
 *
 * Schedule: 1s → 5s → 30s → 5m → 30m. After the 5th failure BullMQ marks
 * the job 'failed' and the failed-listener in workers/webhook-retry.ts
 * writes the DLQ row.
 */
export function webhookRetryBackoff(attemptsMade: number): number {
  const idx = Math.max(0, Math.min(WEBHOOK_RETRY_SCHEDULE_MS.length - 1, attemptsMade - 1))
  return WEBHOOK_RETRY_SCHEDULE_MS[idx]
}

// ── Convenience helpers used by routes / engine ───────────────────────────────
export async function enqueueWorkflowExecution(payload: WorkflowExecuteJob, delayMs = 0) {
  return workflowQueue.add('execute', payload, {
    delay: delayMs > 0 ? delayMs : undefined,
    jobId: undefined, // let BullMQ generate; sessions can repeat the same node legitimately
  })
}

export async function enqueueMessageSend(payload: MessageSendJob) {
  return messageQueue.add('send', payload, {
    // Per-tenant rate limit is configured on the Worker side (limiter groupKey).
  })
}

export async function enqueueBroadcast(broadcastId: string) {
  return broadcastQueue.add('batch', { broadcastId })
}

// ── WA Calling enqueue helpers ─────────────────────────────────────────────
// jobId uses the call_session_id / call_event_id so retries of the same
// logical event collapse instead of producing duplicates. BullMQ rejects
// adds for an existing jobId — the route/worker callers swallow that and
// treat as already-enqueued.

// IMPORTANT: jobIds below use `--` separator, not `:`. BullMQ 5.x
// rejects custom jobIds containing `:` because the Lua scripts treat
// `:` as a Redis-key delimiter (`bull:<queue>:<jobId>:<phase>`) — an
// embedded colon corrupts the parse and the add silently no-ops. This
// regression caught us out: a parallel agent on voice-note-transcribe
// flagged it after observing breach-notification deduplication failing
// in the wild. The pattern below mirrors what the voice-note helper
// uses (`voice-note-transcribe--<id>`) and what `enqueueBreachNotification`
// was updated to use; the underscore variant keeps the visual prefix-id
// separation while staying inside BullMQ's allowed jobId charset.
export async function enqueueCallDispatch(payload: CallDispatchJob) {
  return callDispatchQueue.add('dispatch', payload, {
    jobId: `call-dispatch--${payload.callSessionId}`,
  })
}

export async function enqueueCallEventIngest(payload: CallEventIngestJob) {
  return callEventIngestQueue.add('ingest', payload, {
    jobId: `call-event-ingest--${payload.callEventId}`,
  })
}

export async function enqueueCallRecordingArchive(payload: CallRecordingArchiveJob) {
  return callRecordingArchiveQueue.add('archive', payload, {
    jobId: `call-recording-archive--${payload.callSessionId}`,
  })
}

export async function enqueueCallTranscribe(payload: CallTranscribeJob) {
  return callTranscribeQueue.add('transcribe', payload, {
    jobId: `call-transcribe--${payload.callSessionId}`,
  })
}

// ── Voice note transcribe enqueue helper (migration 086) ───────────────────
// jobId keys on message_id so a duplicate enqueue from the same inbound
// webhook retry collapses to the same job. BullMQ rejects duplicate adds —
// we swallow the conflict and treat as already-queued.
export async function enqueueVoiceNoteTranscribe(payload: VoiceNoteTranscribeJob) {
  try {
    return await voiceNoteTranscribeQueue.add('transcribe', payload, {
      // BullMQ 5.x rejects `:` in custom jobIds (regression vs older v4).
      // Use a `--` separator instead so the per-message dedupe still works.
      jobId: `voice-note-transcribe--${payload.messageId}`,
    })
  } catch (err: any) {
    if (String(err?.message ?? err).toLowerCase().includes('already')) return null
    throw err
  }
}

// ── Webhook enqueue helpers ────────────────────────────────────────────────
/**
 * Enqueue a verified inbound webhook. Caller MUST have already validated
 * the signature — we treat the bytes as trusted from this point.
 *
 * We do NOT dedupe via jobId here because Meta + Razorpay can legitimately
 * resend the same body (network blip + retry), and we want both copies in
 * the failed set if the worker breaks. Idempotency happens downstream in
 * the worker via per-event keys (platform_message_id, event_id, …).
 */
export async function enqueueWebhookInbound(payload: WebhookInboundJob) {
  return webhookInboundQueue.add(payload.source, payload, {
    // Soft cap on the per-job priority — keeps healthy traffic from
    // starving small tenants on shared workers. All inbound is priority 1
    // (highest) by default; bump only if a queue is backed up.
    priority: 1,
  })
}

export async function enqueueWebhookOutbound(payload: WebhookOutboundJob) {
  return webhookOutboundQueue.add(payload.source, payload, {
    priority: 2, // outbound is lower-priority than inbound
  })
}

// ── Breach notification enqueue helper ─────────────────────────────────────
// jobId is the breach id — BullMQ rejects duplicate adds, so a re-PATCH that
// somehow gets past the fanout_queued_at guard still can't double-enqueue.
// We catch the duplicate-id error and treat it as "already enqueued".
//
// Separator is `--` not `:` — BullMQ 5.x rejects `:` in custom jobIds
// because the Lua scripts treat it as a Redis-key delimiter.
export async function enqueueBreachNotification(payload: BreachNotificationJob) {
  try {
    return await breachNotificationQueue.add('fanout', payload, {
      jobId: `breach-notification--${payload.breachId}`,
    })
  } catch (err: any) {
    // BullMQ throws when adding a job with an existing jobId — treat as
    // already-queued and return null. The DB column fanout_queued_at is the
    // primary guard; this is just a belt-and-braces dedupe.
    if (String(err?.message ?? err).toLowerCase().includes('already')) return null
    throw err
  }
}

// Optional: queue events listener for diagnostics in dev. Disabled in prod.
export function attachDebugListeners() {
  if (process.env.NODE_ENV === 'production') return
  const we = new QueueEvents(Q.workflow, { connection: buildConnection() })
  we.on('completed', ({ jobId }) => console.log(`[queue:workflow] ✓ ${jobId}`))
  we.on('failed',    ({ jobId, failedReason }) => console.warn(`[queue:workflow] ✗ ${jobId} — ${failedReason}`))
  const me = new QueueEvents(Q.message, { connection: buildConnection() })
  me.on('failed',    ({ jobId, failedReason }) => console.warn(`[queue:message]  ✗ ${jobId} — ${failedReason}`))
}

// Graceful shutdown — call from process signal handlers.
export async function closeQueues() {
  await Promise.allSettled([
    workflowQueue.close(),
    messageQueue.close(),
    broadcastQueue.close(),
    cronQueue.close(),
    // WA Calling queues
    callDispatchQueue.close(),
    callEventIngestQueue.close(),
    callRecordingArchiveQueue.close(),
    callTranscribeQueue.close(),
    // Voice note transcription
    voiceNoteTranscribeQueue.close(),
    // Webhook queues
    webhookInboundQueue.close(),
    webhookOutboundQueue.close(),
    webhookInboundDeadQueue.close(),
    webhookOutboundDeadQueue.close(),
  ])
  await connection.quit().catch(() => {})
}

/**
 * Attach a QueueEvents listener on call.dispatch — when a dispatch job
 * permanently exhausts its retries (attemptsMade >= attempts), flip
 * call_sessions.status='failed' so the agent's UI doesn't sit on
 * "Connecting…" forever. The listener is mounted from src/worker.ts on
 * boot; we keep the wiring here so the queue topology stays in one file.
 *
 * Returns the QueueEvents instance so the caller can close() it on
 * graceful shutdown.
 */
export function attachCallDispatchFailureListener(
  onPermanentFail: (jobId: string, callSessionId: string | undefined, reason: string) => Promise<void>
) {
  const qe = new QueueEvents(Q.callDispatch, { connection: buildConnection() })
  qe.on('failed', async ({ jobId, failedReason, prev }) => {
    // BullMQ emits one `failed` event per attempt. We only act on the LAST
    // attempt — by then BullMQ has moved the job to `failed` state, which is
    // what `prev === 'active'` indicates on a terminal failure.
    if (prev !== 'active') return
    try {
      const job = await callDispatchQueue.getJob(jobId)
      if (!job) return
      // attemptsMade is incremented before this event; once it equals the
      // configured attempts, this was the final retry.
      const attempts = job.opts.attempts ?? 1
      if ((job.attemptsMade ?? 0) < attempts) return
      const callSessionId = (job.data as CallDispatchJob | undefined)?.callSessionId
      await onPermanentFail(jobId, callSessionId, failedReason ?? 'dispatch_exhausted')
    } catch (e: any) {
      console.warn(`[queue:call.dispatch] failure listener errored: ${e?.message ?? e}`)
    }
  })
  return qe
}
