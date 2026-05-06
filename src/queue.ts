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
  to: string                          // E.164-ish phone, no leading +
  channel: 'whatsapp' | 'email'
  // For whatsapp:
  kind?: 'text' | 'template' | 'interactive'
  text?: string
  template?: { name: string; language: string; parameters: string[] }
  interactive?: any
  // For email:
  email?: { to: string; subject: string; body: string; provider?: string }
  // Bookkeeping
  sessionId?: string | null
  broadcastId?: string | null
}

export interface BroadcastBatchJob {
  broadcastId: string
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
  ])
  await connection.quit().catch(() => {})
}
