/**
 * Worker: trial-ending (singleton repeatable, every 6 hours)
 *
 * Scans `tenant_subscriptions` for trials ending in the next 7 days and
 * fires `billing.trial_ending` notifications to all billing-eligible
 * recipients in each affected tenant.
 *
 * Dedup: queries `notifications` for an existing row with the same
 * `event_key + tenant_id + data.trial_ends_at`. Without this, every 6h
 * tick would re-send for the entire 7-day window — annoying at best,
 * spam-grade at worst. Embedding the trial_ends_at in data lets re-runs
 * and DB restores stay idempotent — the same trial-end can't double-warn.
 *
 * Singleton via the same `cronQueue` + `jobId` pattern that template-sync
 * and data-source-sync use.
 */

import '../env'
import { Worker, Job } from 'bullmq'
import { createClient } from '@supabase/supabase-js'
import { Q, connection, cronQueue } from '../queue'
import { emitNotification } from '../routes/notifications'
import { isPollerEnabled, cleanRepeatablesByName, STUB_WORKER, logGate } from '../lib/poller-gate'

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://yiicpndeggaedxobyopu.supabase.co'
const supabase = createClient(SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY!)

const TICK_INTERVAL_MS = Number(process.env.TRIAL_ENDING_INTERVAL_MS ?? 6 * 60 * 60 * 1000)
const WARN_DAYS_AHEAD  = 7

export async function startTrialEndingWorker() {
  const enabled = isPollerEnabled('TRIAL_ENDING')
  logGate('TRIAL_ENDING', enabled)
  if (!enabled) {
    await cleanRepeatablesByName(cronQueue, 'trial-ending-check')
    return STUB_WORKER
  }

  // Same singleton-repeatable pattern as the other cron workers — add once
  // with a stable jobId so concurrent server boots don't multiply ticks.
  await cronQueue.add(
    'trial-ending-check',
    {},
    {
      jobId: 'singleton-trial-ending',
      repeat: { every: TICK_INTERVAL_MS },
      removeOnComplete: { count: 50 },
      removeOnFail:     { count: 50 },
    }
  )

  const worker = new Worker(
    Q.cron,
    async (job: Job) => {
      if (job.name !== 'trial-ending-check') return { skipped: 'not for me' }
      return runTick()
    },
    { connection, concurrency: 1 },
  )

  worker.on('failed', (job, err) => {
    if (job?.name === 'trial-ending-check') {
      console.warn(`[trial-ending] tick failed: ${err.message}`)
    }
  })

  console.log(`[worker:trial-ending] started, interval=${TICK_INTERVAL_MS}ms`)
  return worker
}

async function runTick() {
  const startedAt = Date.now()
  const nowIso  = new Date().toISOString()
  const horizon = new Date(Date.now() + WARN_DAYS_AHEAD * 24 * 60 * 60 * 1000).toISOString()

  const { data: trials, error } = await supabase.from('tenant_subscriptions')
    .select('tenant_id, trial_ends_at, plan_id')
    .eq('status', 'trial')
    .gt('trial_ends_at', nowIso)
    .lte('trial_ends_at', horizon)
  if (error) throw new Error(`load trials: ${error.message}`)
  if (!trials || trials.length === 0) {
    return { warned: 0, skipped_existing: 0 }
  }

  let warned = 0
  let skippedExisting = 0
  let skippedNoRecipients = 0
  for (const sub of trials) {
    if (!sub.tenant_id || !sub.trial_ends_at) continue
    const msRemaining = new Date(sub.trial_ends_at).getTime() - Date.now()
    const daysRemaining = Math.max(1, Math.ceil(msRemaining / (24 * 60 * 60 * 1000)))

    // Dedup: have we already fired this exact (tenant, trial_ends_at)?
    // Embedded in `notifications.data.trial_ends_at` for query-by-jsonb.
    // Cheap check — index on (tenant_id, event_key) makes this O(handful).
    //
    // CRITICAL: capture + bail on dedup query errors. If the jsonb filter
    // ever errors (PostgREST timeout, malformed `data` row, etc.) and we
    // silently treat that as "no existing notification", we'll re-fire
    // every 6h for the entire 7-day window — spam-grade.
    const dedupRes = await supabase.from('notifications')
      .select('id')
      .eq('tenant_id', sub.tenant_id)
      .eq('event_key', 'billing.trial_ending')
      .filter('data->>trial_ends_at', 'eq', sub.trial_ends_at)
      .limit(1)
      .maybeSingle()
    if (dedupRes.error) {
      console.warn(`[trial-ending] dedup query failed for tenant ${sub.tenant_id}: ${dedupRes.error.message} — skipping to avoid duplicate fires`)
      continue  // fail-closed: skip rather than risk a duplicate notification
    }
    if (dedupRes.data) { skippedExisting++; continue }

    // Resolve recipients = tenant owner + anyone with billing.view perm.
    // Same shape as billing.ts notifyBillingRoles — kept inline since this
    // worker can't import a route helper without pulling in Express.
    const [{ data: tenant }, { data: roleRows }] = await Promise.all([
      supabase.from('tenants').select('user_id').eq('id', sub.tenant_id).maybeSingle(),
      supabase.from('user_role_assignments')
        .select('user_id, role_definitions!inner(permissions)')
        .eq('tenant_id', sub.tenant_id)
        .is('disabled_at', null),
    ])
    const recipients = new Set<string>()
    if (tenant?.user_id) recipients.add(tenant.user_id)
    for (const r of (roleRows ?? []) as any[]) {
      const rd = Array.isArray(r.role_definitions) ? r.role_definitions[0] : r.role_definitions
      if (rd?.permissions?.billing?.view === true && r.user_id) recipients.add(r.user_id)
    }
    if (recipients.size === 0) { skippedNoRecipients++; continue }

    try {
      await emitNotification(supabase, {
        tenant_id: sub.tenant_id,
        event_key: 'billing.trial_ending',
        recipient_user_ids: Array.from(recipients),
        // trial_ends_at embedded so the next tick's dedup query above finds it.
        data: { days: String(daysRemaining), plan: sub.plan_id ?? 'your plan', trial_ends_at: sub.trial_ends_at },
        link: '/settings/billing',
      })
      warned++
    } catch (e: any) {
      console.warn(`[trial-ending] failed for tenant ${sub.tenant_id}: ${e?.message ?? e}`)
    }
  }

  const ms = Date.now() - startedAt
  console.log(`[trial-ending] tick done — warned=${warned} skipped_existing=${skippedExisting} skipped_no_recipients=${skippedNoRecipients} ${ms}ms`)
  return { warned, skipped_existing: skippedExisting, skipped_no_recipients: skippedNoRecipients, durationMs: ms }
}
