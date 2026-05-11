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

export async function enqueueCallDispatch(payload: CallDispatchJob) {
  return callDispatchQueue.add('dispatch', payload, {
    jobId: `call.dispatch:${payload.callSessionId}`,
  })
}

export async function enqueueCallEventIngest(payload: CallEventIngestJob) {
  return callEventIngestQueue.add('ingest', payload, {
    jobId: `call.event.ingest:${payload.callEventId}`,
  })
}

export async function enqueueCallRecordingArchive(payload: CallRecordingArchiveJob) {
  return callRecordingArchiveQueue.add('archive', payload, {
    jobId: `call.recording.archive:${payload.callSessionId}`,
  })
}

export async function enqueueCallTranscribe(payload: CallTranscribeJob) {
  return callTranscribeQueue.add('transcribe', payload, {
    jobId: `call.transcribe:${payload.callSessionId}`,
  })
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
