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
import { startGmailPollerWorker }      from './workers/gmail-poller'
import { startLookalikeRefreshWorker } from './workers/lookalike-refresh'
// WA Business Calling — migration 035
import { startCallDispatchWorker }         from './workers/call-dispatch'
import { startCallEventIngestWorker }      from './workers/call-event-ingest'
import { startCallRecordingArchiveWorker } from './workers/call-recording-archive'
import { startCallTranscribeWorker }       from './workers/call-transcribe'
// Webhook retry queues — migration 064
import { startWebhookInboundWorker, startWebhookOutboundWorker } from './workers/webhook-retry'
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
  const gp  = await startGmailPollerWorker()
  const lr  = await startLookalikeRefreshWorker()

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
      sp.close(), ts.close(), ds.close(), te.close(), gp.close(), lr.close(),
      // WA Calling
      cd.close(), ce.close(), ca.close(), ct.close(),
      dispatchFailureListener.close(),
      // Webhook retry / DLQ
      wi.close(), wo.close(),
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
