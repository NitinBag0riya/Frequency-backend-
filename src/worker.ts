/**
 * Worker entry point — runs separately from the API process.
 *
 * Local dev:   npm run dev:worker   (in a second terminal)
 * Production:  npm run start:worker (Railway / Render service: command = node dist/worker.js)
 *
 * Why separate from index.ts?
 *   - Horizontal scaling: spin up N worker dynos without scaling the HTTP API.
 *   - Crash isolation: a runaway node handler can't take the API offline.
 *   - Resource budgeting: workers do CPU + outbound HTTP; API does fast I/O only.
 *
 * If you don't have Redis available locally, set DISABLE_WORKERS=1 and the
 * process exits cleanly without crashing the dev loop.
 */

import './env'
import { startWorkflowExecutorWorker } from './workers/workflow-executor'
import { startMessageSenderWorker }    from './workers/message-sender'
import { startSchedulePollerWorker }   from './workers/schedule-poller'
import { startBroadcastWorker }        from './workers/broadcast-worker'
import { startTemplateSyncWorker }     from './workers/template-sync'
import { startDataSourceSyncWorker }   from './workers/data-source-sync'
import { startTrialEndingWorker }      from './workers/trial-ending'
import { startConsentExpirySweepWorker } from './workers/consent-expiry-sweep'
import { startGmailPollerWorker }      from './workers/gmail-poller'
import { startLookalikeRefreshWorker } from './workers/lookalike-refresh'
// P0.9 — Instagram comment poller (60s tick, safety net for webhook gaps)
import { startInstagramCommentPollerWorker } from './workers/instagram-comment-poller'
// P0.7 — DPDPA breach notification fan-out (migration 075)
import { startBreachNotificationSenderWorker } from './workers/breach-notification-sender'
// WA Business Calling — migration 035
import { startCallDispatchWorker }         from './workers/call-dispatch'
import { startCallEventIngestWorker }      from './workers/call-event-ingest'
import { startCallRecordingArchiveWorker } from './workers/call-recording-archive'
import { startCallTranscribeWorker }       from './workers/call-transcribe'
// Webhook retry queues — migration 064
import { startWebhookInboundWorker, startWebhookOutboundWorker } from './workers/webhook-retry'
// P1 #11 — Shopify abandoned-cart poller (migration 078)
import { startShopifyAbandonedCartPollerWorker } from './workers/shopify-abandoned-cart-poller'
// P1 #12 — Agency monthly revshare payout aggregator (migration 079)
import { startAgencyPayoutAggregatorWorker } from './workers/agency-payout-aggregator'
// Phase 3 — SLA monitor (migration 095). Every 30s scans open
// conversations + emits sla_breaches rows on threshold crossings.
import { startSlaMonitorWorker } from './workers/sla-monitor'
// P1 #18 — Bulk contact import processor (migration 084)
import { startContactImportProcessorWorker } from './workers/contact-import-processor'
// P2 #20 — Voice note transcription (migration 086)
import { startVoiceNoteTranscribeWorker } from './workers/voice-note-transcribe'
import { createClient } from '@supabase/supabase-js'
import { closeQueues, attachCallDispatchFailureListener } from './queue'

if (process.env.DISABLE_WORKERS === '1') {
  console.log('[worker] DISABLE_WORKERS=1 — exiting without starting any workers')
  process.exit(0)
}

async function main() {
  const wf  = startWorkflowExecutorWorker()
  const ms  = startMessageSenderWorker()
  const bw  = startBroadcastWorker()
  const sp  = await startSchedulePollerWorker()
  const ts  = await startTemplateSyncWorker()
  const ds  = await startDataSourceSyncWorker()
  const te  = await startTrialEndingWorker()
  const ces = await startConsentExpirySweepWorker()
  const gp  = await startGmailPollerWorker()
  const lr  = await startLookalikeRefreshWorker()
  const igp = await startInstagramCommentPollerWorker()
  const bns = await startBreachNotificationSenderWorker()

  // WA Calling workers — concurrency per env (defaults in `01-backend-design.md` §11).
  const cd = startCallDispatchWorker()
  const ce = startCallEventIngestWorker()
  const ca = startCallRecordingArchiveWorker()
  const ct = startCallTranscribeWorker()

  // Webhook retry / DLQ workers (migration 064). Always run when the worker
  // process is up — the WEBHOOK_QUEUE_ENABLED flag gates the *route* side
  // (whether handlers enqueue or run inline), not the worker side. Keeping
  // the workers running unconditionally means a flip-the-switch cutover
  // doesn't require a worker redeploy.
  const wi = startWebhookInboundWorker()
  const wo = startWebhookOutboundWorker()

  // P1 #11 — Shopify abandoned-cart poller. Runs every 5 min; fires the
  // shopify_abandoned_cart trigger for checkouts older than 10 min that
  // have a phone number and haven't been recovered or nudged yet.
  const sac = await startShopifyAbandonedCartPollerWorker()

  // P1 #12 — Agency revshare monthly payout aggregator. Daily 24h tick;
  // gates on date-of-month=1 inside the handler. Emits one agency_payouts
  // row per agency aggregating last month's accrued ledger entries.
  const apa = await startAgencyPayoutAggregatorWorker()

  // Phase 3 — SLA monitor. Runs every 30s, computes breach state for
  // every open conversation in every tenant with sla_configs rows.
  const slam = await startSlaMonitorWorker()

  // P1 #18 — Bulk contact import processor. BullMQ-driven; one job per
  // contact_import_jobs row. Two phases: dry-run (parse + validate +
  // preview) and execute (UPSERT contacts + INSERT per-contact consent_events).
  const cip = startContactImportProcessorWorker()

  // P2 #20 — Voice note transcription. BullMQ worker; one job per inbound
  // audio message. Calls OpenAI Whisper, writes voice_note_transcripts.
  // Best-effort — failures here never affect message persistence.
  const vnt = startVoiceNoteTranscribeWorker()

  // Failure listener for call.dispatch — when BullMQ permanently fails a
  // dispatch job, flip call_sessions.status='failed' so the agent's UI
  // doesn't sit on "Connecting…" forever.
  const dispatchFailureSb = createClient(
    process.env.SUPABASE_URL || 'https://yiicpndeggaedxobyopu.supabase.co',
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  )
  const dispatchFailureListener = attachCallDispatchFailureListener(async (_jobId, callSessionId, reason) => {
    if (!callSessionId) return
    const nowIso = new Date().toISOString()
    await dispatchFailureSb.from('call_sessions').update({
      status:         'failed',
      failure_reason: reason || 'dispatch_exhausted',
      ended_at:       nowIso,
      ended_by:       'system',
      updated_at:     nowIso,
    }).eq('id', callSessionId)
  })

  const shutdown = async (signal: string) => {
    console.log(`[worker] received ${signal} — draining…`)
    await Promise.allSettled([
      wf.close(), ms.close(), bw.close(),
      sp.close(), ts.close(), ds.close(), te.close(), ces.close(), gp.close(), lr.close(), igp.close(), bns.close(),
      // WA Calling
      cd.close(), ce.close(), ca.close(), ct.close(),
      dispatchFailureListener.close(),
      // Webhook retry / DLQ
      wi.close(), wo.close(),
      // Shopify abandoned-cart poller (P1 #11)
      sac.close(),
      // Agency payout aggregator (P1 #12)
      apa.close(),
      // Bulk contact import processor (P1 #18)
      cip.close(),
      // Voice note transcription (P2 #20)
      vnt.close(),
    ])
    await closeQueues()
    process.exit(0)
  }
  process.on('SIGTERM', () => shutdown('SIGTERM'))
  process.on('SIGINT',  () => shutdown('SIGINT'))

  console.log('[worker] all workers running. press Ctrl+C to stop.')
}

main().catch((err) => {
  console.error('[worker] fatal:', err)
  process.exit(1)
})
