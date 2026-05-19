/**
 * Worker: kb-embed (DEPRECATED — kept as a no-op shim)
 *
 * The AI Agent moved to a Claude-only retrieval design in v1.2 — see
 * routes/ai-agent.ts:/api/ai-agent/test for the two-stage rerank +
 * answer flow that uses ANTHROPIC_API_KEY exclusively.
 *
 * This module is retained so that:
 *   - imports from queue.ts (Q.kbEmbed) continue to resolve cleanly
 *   - tenants that still have rows queued from the OpenAI-era can be
 *     drained without crashes (the worker silently drops jobs)
 *
 * The `embedText()` helper is retained as a `null`-returning stub so
 * any straggler caller in the codebase gets a graceful "embeddings not
 * supported" outcome instead of a hard error.
 *
 * Migration 100 drops the kb_chunks.embedding column + HNSW index and
 * the match_kb_chunks RPC. After 100 is applied, this worker can be
 * deleted entirely; we leave it in place for one release for safety.
 */

import '../env'
import { Worker, type Job } from 'bullmq'
import { Q, connection, type KbEmbedJob } from '../queue'
import { logger } from '../lib/logger'

/**
 * Drop-in replacement for the OpenAI embedText() that always returns
 * null. Callers must handle null as "embeddings unavailable — fall back
 * to keyword/Claude retrieval".
 */
export async function embedText(_text: string): Promise<number[] | null> {
  return null
}

export async function startKbEmbedWorker() {
  // Drain any straggler kbEmbed jobs without doing work. Concurrency 1
  // because there's nothing to do per job — just acknowledge.
  const processor = new Worker<KbEmbedJob>(
    Q.kbEmbed,
    async (_job: Job<KbEmbedJob>) => {
      return { skipped: 'kb-embed deprecated; using Claude-based retrieval' }
    },
    { connection, concurrency: 1 },
  )

  processor.on('failed', (_job, err) => {
    // Non-fatal — the shim shouldn't fail. Log so we know if BullMQ
    // surfaces something unexpected.
    logger.warn(`[kb-embed:shim] unexpected failure: ${err.message}`)
  })

  console.log('[worker:kb-embed] started in shim mode (Claude-based retrieval active)')
  return { processor }
}
