/**
 * Worker: consent-expiry-sweep (singleton repeatable, every 24h)
 *
 * DPDPA §6(8) requires consent to be "as may be necessary" and renewed
 * after a reasonable interval. The Indian SMB compliance convention is
 * to treat marketing consent as stale after 12 months. This worker scans
 * contact_consent_state for opted-in marketing rows older than 12 months
 * and inserts an `expired` consent_events row for each — the AFTER INSERT
 * trigger then flips the state to 'expired', which the message-sender
 * worker's consent gate reads as "do not send marketing".
 *
 * Singleton via cronQueue + jobId, same pattern as trial-ending and
 * schedule-poller. Idempotent because we only ever insert events for
 * rows still in 'opted_in' status — a second tick will find no rows.
 */

import '../env'
import { Worker, Job } from 'bullmq'
import { createClient } from '@supabase/supabase-js'
import { Q, connection, cronQueue } from '../queue'

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://yiicpndeggaedxobyopu.supabase.co'
const supabase = createClient(SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY!)

const TICK_INTERVAL_MS = Number(process.env.CONSENT_EXPIRY_INTERVAL_MS ?? 24 * 60 * 60 * 1000)
const EXPIRY_MONTHS = 12
const BATCH_SIZE = 500

export async function startConsentExpirySweepWorker() {
  await cronQueue.add(
    'consent-expiry-sweep',
    {},
    {
      jobId: 'singleton-consent-expiry-sweep',
      repeat: { every: TICK_INTERVAL_MS },
      removeOnComplete: { count: 50 },
      removeOnFail:     { count: 50 },
    },
  )

  const worker = new Worker(
    Q.cron,
    async (job: Job) => {
      if (job.name !== 'consent-expiry-sweep') return { skipped: 'not for me' }
      return runTick()
    },
    { connection, concurrency: 1 },
  )

  worker.on('failed', (job, err) => {
    if (job?.name === 'consent-expiry-sweep') {
      console.warn(`[consent-expiry-sweep] tick failed: ${err.message}`)
    }
  })

  console.log(`[worker:consent-expiry-sweep] started, interval=${TICK_INTERVAL_MS}ms, horizon=${EXPIRY_MONTHS}mo`)
  return worker
}

async function runTick(): Promise<{ expired: number; considered: number }> {
  const startedAt = Date.now()
  const horizon = new Date()
  horizon.setMonth(horizon.getMonth() - EXPIRY_MONTHS)
  const horizonIso = horizon.toISOString()

  // 1. Find expired marketing opt-ins. We need tenant_id to write the
  //    consent_events row; join through contacts.
  const { data: stale, error } = await supabase
    .from('contact_consent_state')
    .select('contact_id, channel, purpose, effective_at, contacts!inner(tenant_id)')
    .eq('status', 'opted_in')
    .eq('purpose', 'marketing')
    .lt('effective_at', horizonIso)
    .limit(BATCH_SIZE)
  if (error) {
    console.warn(`[consent-expiry-sweep] query failed: ${error.message}`)
    return { expired: 0, considered: 0 }
  }
  if (!stale || stale.length === 0) {
    console.log(`[consent-expiry-sweep] tick done — nothing to expire`)
    return { expired: 0, considered: 0 }
  }

  // 2. Bulk insert expiry events. The trigger fires per row and updates
  //    state to 'expired'. We batch in 100s to keep the insert payload sane.
  let expired = 0
  for (let i = 0; i < stale.length; i += 100) {
    const chunk = stale.slice(i, i + 100)
    const rows = chunk.map((s: any) => ({
      tenant_id:    s.contacts.tenant_id,
      contact_id:   s.contact_id,
      channel:      s.channel,
      event_type:   'expired',
      purpose:      s.purpose,
      source:       'expiry_sweep',
      source_detail: { previous_effective_at: s.effective_at, horizon_months: EXPIRY_MONTHS },
      proof_text:   `Marketing consent stale (>${EXPIRY_MONTHS} months since ${s.effective_at}); auto-expired per DPDPA §6(8).`,
    }))
    const { error: insErr } = await supabase.from('consent_events').insert(rows)
    if (insErr) {
      console.warn(`[consent-expiry-sweep] insert batch failed: ${insErr.message}`)
      continue
    }
    expired += chunk.length
  }

  const ms = Date.now() - startedAt
  console.log(`[consent-expiry-sweep] tick done — expired=${expired}/${stale.length} ${ms}ms`)
  return { expired, considered: stale.length }
}
