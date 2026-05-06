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
import { closeQueues } from './queue'

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

  const shutdown = async (signal: string) => {
    console.log(`[worker] received ${signal} — draining…`)
    await Promise.allSettled([wf.close(), ms.close(), bw.close(), sp.close(), ts.close(), ds.close()])
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
