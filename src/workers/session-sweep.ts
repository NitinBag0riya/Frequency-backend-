/**
 * Worker: session-sweep (singleton repeatable, every 15 minutes in prod)
 *
 * Marks workflow sessions that have stalled mid-flow as `abandoned`.
 *
 * Why this exists
 *   A workflow_session is `active` from the moment the engine starts
 *   running nodes for a contact until the engine reaches an `end` node
 *   or hits a terminal error. If the workflow is waiting for an inbound
 *   reply (e.g. send_message → wait_for_reply → branch), the session
 *   sits in `active` until the customer responds. Customers ghost flows
 *   all the time — the session never advances, and the contact stays
 *   pinned to that session forever. Two real consequences:
 *
 *     1. The keyword-router refuses to start a *new* flow for that
 *        contact while an active session exists. A ghosted "Welcome
 *        menu" silently swallows every future "hi" the customer types.
 *     2. Analytics over-counts "active sessions" because dead ones
 *        never close.
 *
 *   wacrm hit this exact bug in their 0.2.0 release and added a
 *   `/api/flows/cron` sweep; we adopt the same pattern, BullMQ-driven.
 *
 * What we sweep
 *   - status = 'active' (only).
 *   - last_node_executed_at < NOW() - SESSION_TIMEOUT (or, if null,
 *     updated_at as a fallback — older sessions from before migration
 *     010 don't have last_node_executed_at).
 *   - NOT linked to a still-pending scheduled_jobs row. Long-wait
 *     nodes (wait_delay > timeout) are legitimate "active" sessions —
 *     a delivery_at in the future means the schedule-poller hasn't
 *     reached this session yet, and timing it out would silently
 *     swallow the scheduled side. We exclude those.
 *
 * Per-tenant timeout
 *   Default 24h. Tenants can override via tenants.metadata
 *   ->> 'session_timeout_hours' (positive integer). A "lead capture"
 *   flow asking for an address may legitimately wait 3 days; a
 *   "support bot" flow should probably time out in 2 hours.
 *
 * Idempotent — running the sweep twice produces the same result. The
 * status=abandoned filter on UPDATE means already-swept rows are no-ops.
 */

import '../env'
import { Worker, Job } from 'bullmq'
import { createClient } from '@supabase/supabase-js'
import { Q, connection, cronQueue } from '../queue'
import { isPollerEnabled, cleanRepeatablesByName, STUB_WORKER, logGate, pollIntervalMs } from '../lib/poller-gate'

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://yiicpndeggaedxobyopu.supabase.co'
const supabase = createClient(SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY!)

// 15 min prod · 60 min dev. The sweep is cheap (one indexed UPDATE per
// tick) and the cost of running stale is moderate (a ghosted session
// keeps a contact pinned), so prod gets a tighter cadence than the
// 5-min default of pollers that need real-time-ish feel.
const SWEEP_INTERVAL_MS = pollIntervalMs('SESSION_SWEEP_INTERVAL_MS', {
  prod: 15 * 60_000,
  dev:  60 * 60_000,
})

// Default session timeout — 24h matches wacrm's default and is the
// commonly cited "if they haven't replied in a day, they ghosted you"
// rule of thumb. Tenants override via metadata.session_timeout_hours.
const DEFAULT_TIMEOUT_HOURS = 24

// Hard cap so a misconfigured tenant.metadata can't disable the sweep
// entirely. A "long" flow should fall back to a more durable mechanism
// (scheduled_jobs or a dedicated reminder workflow), not an unbounded
// active session.
const MAX_TIMEOUT_HOURS = 30 * 24

interface TenantRow {
  id: string
  metadata: Record<string, any> | null
}

function timeoutHoursForTenant(t: TenantRow): number {
  const raw = (t.metadata as any)?.session_timeout_hours
  if (typeof raw === 'number' && raw > 0 && raw <= MAX_TIMEOUT_HOURS) return Math.floor(raw)
  if (typeof raw === 'string' && /^\d+$/.test(raw)) {
    const n = Number(raw)
    if (n > 0 && n <= MAX_TIMEOUT_HOURS) return n
  }
  return DEFAULT_TIMEOUT_HOURS
}

async function runTick(): Promise<{ swept: number; tenants: number }> {
  const tickStart = Date.now()
  // We sweep per-tenant so each can have its own threshold. Cheap
  // enough — even 10k tenants is one indexed lookup + one UPDATE each.
  const { data: tenants, error: tenantErr } = await supabase
    .from('tenants')
    .select('id, metadata')
    .eq('status', 'active')
  if (tenantErr) {
    console.warn(`[session-sweep] tenant list failed: ${tenantErr.message}`)
    return { swept: 0, tenants: 0 }
  }

  let totalSwept = 0
  for (const t of (tenants ?? []) as TenantRow[]) {
    const timeoutH = timeoutHoursForTenant(t)
    const cutoff = new Date(Date.now() - timeoutH * 60 * 60 * 1000).toISOString()

    // First find candidates so we can exclude those with pending
    // scheduled_jobs. Doing it as one query via PostgREST anti-join
    // would be cleaner but supabase-js doesn't support NOT EXISTS
    // directly — two-step works fine at this scale.
    const { data: candidates, error: findErr } = await supabase
      .from('workflow_sessions')
      .select('id')
      .eq('tenant_id', t.id)
      .eq('status', 'active')
      // last_node_executed_at filter — fall back to updated_at when
      // null. PostgREST `or` syntax: comma-separated, parenthesised.
      .or(`last_node_executed_at.lt.${cutoff},and(last_node_executed_at.is.null,updated_at.lt.${cutoff})`)
      .limit(500)
    if (findErr) {
      console.warn(`[session-sweep] tenant=${t.id} candidate find failed: ${findErr.message}`)
      continue
    }
    if (!candidates || candidates.length === 0) continue

    const ids = candidates.map(c => (c as any).id as string)

    // Exclude sessions with a still-pending scheduled_job. The poller
    // will run those when their delivery_at fires; sweeping them would
    // cancel a legit long-wait flow. Tolerate the lookup failing —
    // safer to skip the sweep cycle than to flip a long-wait session.
    let excludeIds = new Set<string>()
    try {
      const { data: scheduled } = await supabase
        .from('scheduled_jobs')
        .select('session_id')
        .in('session_id', ids)
        .in('status', ['pending', 'queued'])
      for (const row of (scheduled ?? []) as any[]) {
        if (row.session_id) excludeIds.add(row.session_id as string)
      }
    } catch (e: any) {
      console.warn(`[session-sweep] tenant=${t.id} scheduled_jobs lookup failed (skipping tick): ${e?.message ?? e}`)
      continue
    }

    const toSweep = ids.filter(id => !excludeIds.has(id))
    if (toSweep.length === 0) continue

    const { error: upErr, count } = await supabase
      .from('workflow_sessions')
      .update({ status: 'abandoned', updated_at: new Date().toISOString() }, { count: 'exact' })
      .in('id', toSweep)
      .eq('status', 'active') // race guard — only sweep rows still active
    if (upErr) {
      console.warn(`[session-sweep] tenant=${t.id} update failed: ${upErr.message}`)
      continue
    }
    const sweptCount = count ?? toSweep.length
    if (sweptCount > 0) {
      totalSwept += sweptCount
      console.log(`[session-sweep] tenant=${t.id} swept=${sweptCount} timeout_h=${timeoutH}`)
    }
  }

  console.log(`[session-sweep] tick done in ${Date.now() - tickStart}ms · tenants=${tenants?.length ?? 0} · swept=${totalSwept}`)
  return { swept: totalSwept, tenants: tenants?.length ?? 0 }
}

export async function startSessionSweepWorker() {
  const enabled = isPollerEnabled('SESSION_SWEEP')
  logGate('SESSION_SWEEP', enabled)
  if (!enabled) {
    await cleanRepeatablesByName(cronQueue, 'session-sweep')
    return STUB_WORKER
  }

  // Singleton repeatable — same dedupe pattern as data-source-sync.
  await cronQueue.add(
    'session-sweep',
    {},
    {
      jobId: 'singleton-session-sweep',
      repeat: { every: SWEEP_INTERVAL_MS },
      removeOnComplete: { count: 50 },
      removeOnFail:     { count: 50 },
    }
  )

  const worker = new Worker(
    Q.cron,
    async (job: Job) => {
      if (job.name !== 'session-sweep') return { skipped: 'not for me' }
      return runTick()
    },
    { connection, concurrency: 1 },
  )

  worker.on('failed', (job, err) => {
    if (job?.name === 'session-sweep') {
      console.warn(`[session-sweep] tick failed: ${err.message}`)
    }
  })

  console.log(`[worker:session-sweep] started, interval=${SWEEP_INTERVAL_MS}ms`)
  return worker
}
