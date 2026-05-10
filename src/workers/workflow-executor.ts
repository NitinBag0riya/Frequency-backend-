/**
 * Worker: workflow.execute
 *
 *   1. Loads session + workflow + tenant from DB.
 *   2. Calls engine.executeNode().
 *   3. Acts on the result:
 *        advance     → enqueue next-node execution (may end if next is null)
 *        wait_input  → halt; session stays 'active', current_node_id = this node
 *        wait_delay  → INSERT scheduled_jobs row, halt
 *        end         → mark session 'completed'
 *        error       → log execution row with status=failed; rethrow so BullMQ retries
 *   4. Logs every attempt to workflow_executions.
 */

import '../env'
import { Worker, Job } from 'bullmq'
import { createClient } from '@supabase/supabase-js'
import {
  Q, WorkflowExecuteJob, connection, enqueueWorkflowExecution,
} from '../queue'
import { executeNode, findNode } from '../engine/executor'
import { dispatchDownstreamForCompletedSession } from '../engine/chaining'

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://yiicpndeggaedxobyopu.supabase.co'
const supabase = createClient(SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY!)

export function startWorkflowExecutorWorker() {
  const worker = new Worker<WorkflowExecuteJob>(
    Q.workflow,
    async (job: Job<WorkflowExecuteJob>) => {
      const { sessionId, nodeId, reply } = job.data
      const startedAt = Date.now()

      // Load the session + workflow + tenant.
      const { data: session, error: sErr } = await supabase
        .from('workflow_sessions')
        .select('*, workflow:workflows(*), tenant:tenants(*)')
        .eq('id', sessionId)
        .maybeSingle()
      if (sErr) throw new Error(`load session: ${sErr.message}`)
      if (!session) throw new Error(`session ${sessionId} not found`)
      if (session.status !== 'active') {
        // Already completed/failed — drop silently.
        return { skipped: `session status=${session.status}` }
      }

      const tenant   = (session as any).tenant
      const workflow = (session as any).workflow
      if (!tenant || !workflow) throw new Error('session missing tenant or workflow relation')

      const node = findNode(workflow, nodeId)
      if (!node) throw new Error(`node ${nodeId} not found in workflow ${workflow.id}`)

      // Log start
      const execStart = await supabase.from('workflow_executions').insert({
        tenant_id: tenant.id,
        session_id: session.id,
        workflow_id: workflow.id,
        node_id: nodeId,
        node_type: node.type,
        status: 'started',
        attempt: job.attemptsMade + 1,
      }).select('id').single()

      const ctx = { tenant, session, workflow, reply: reply ?? null }
      const result = await executeNode(ctx, node)

      // Merge variable updates back to session
      if (result.variableUpdates && Object.keys(result.variableUpdates).length > 0) {
        const newVars = { ...(session.variables ?? {}), ...result.variableUpdates }
        await supabase.from('workflow_sessions')
          .update({ variables: newVars, updated_at: new Date().toISOString() })
          .eq('id', session.id)
        session.variables = newVars
      }

      // Act on result kind
      switch (result.kind) {
        case 'advance': {
          const next = result.nextNodeId
          if (next) {
            await supabase.from('workflow_sessions').update({
              current_node_id: next,
              last_node_executed_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
            }).eq('id', session.id)
            await enqueueWorkflowExecution({ sessionId: session.id, nodeId: next })
          } else {
            // No next node = implicit end. Mark complete + fire any
            // downstream workflows chained to this one (best-effort).
            await supabase.from('workflow_sessions').update({
              status: 'completed', updated_at: new Date().toISOString(),
            }).eq('id', session.id)
            await dispatchDownstreamForCompletedSession(supabase, {
              id:            session.id,
              workflow_id:   workflow.id,
              tenant_id:     tenant.id,
              contact_phone: session.contact_phone,
              variables:     session.variables ?? {},
            })
          }
          break
        }

        case 'wait_input':
          // Stay active, don't change current_node_id (it's the collect_input node).
          await supabase.from('workflow_sessions').update({
            current_node_id: nodeId,
            last_node_executed_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          }).eq('id', session.id)
          break

        case 'wait_delay': {
          const resumeAt = new Date(Date.now() + (result.delayMs ?? 0)).toISOString()
          await supabase.from('scheduled_jobs').insert({
            tenant_id: tenant.id,
            kind: 'workflow_resume',
            payload: { sessionId: session.id, nodeId: result.nextNodeId },
            resume_at: resumeAt,
          })
          await supabase.from('workflow_sessions').update({
            current_node_id: nodeId,
            last_node_executed_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          }).eq('id', session.id)
          break
        }

        case 'end':
          await supabase.from('workflow_sessions').update({
            status: 'completed', updated_at: new Date().toISOString(),
          }).eq('id', session.id)
          await dispatchDownstreamForCompletedSession(supabase, {
            id:            session.id,
            workflow_id:   workflow.id,
            tenant_id:     tenant.id,
            contact_phone: session.contact_phone,
            variables:     session.variables ?? {},
          })
          break

        case 'error':
          // Log the failure and let BullMQ handle retries by throwing.
          await supabase.from('workflow_executions').insert({
            tenant_id: tenant.id,
            session_id: session.id,
            workflow_id: workflow.id,
            node_id: nodeId,
            node_type: node.type,
            status: 'failed',
            attempt: job.attemptsMade + 1,
            duration_ms: Date.now() - startedAt,
            error: result.error,
          })
          throw new Error(result.error ?? 'node execution failed')
      }

      // Log success row
      await supabase.from('workflow_executions').insert({
        tenant_id: tenant.id,
        session_id: session.id,
        workflow_id: workflow.id,
        node_id: nodeId,
        node_type: node.type,
        status: 'succeeded',
        attempt: job.attemptsMade + 1,
        duration_ms: Date.now() - startedAt,
        output: result.output ?? null,
      })

      return { kind: result.kind, nextNodeId: result.nextNodeId ?? null, execId: execStart.data?.id }
    },
    {
      connection,
      concurrency: Number(process.env.WORKFLOW_CONCURRENCY ?? 10),
    }
  )

  worker.on('failed', async (job, err) => {
    if (!job) return
    const exhausted = (job.attemptsMade ?? 0) >= (job.opts.attempts ?? 1)
    console.warn(`[worker:workflow] ✗ job=${job.id} attempt=${job.attemptsMade}/${job.opts.attempts} — ${err.message}${exhausted ? ' [DLQ]' : ''}`)
    // When retries are exhausted, also mark the session as failed so the UI
    // doesn't show a perpetual "active" status. The per-attempt log row was
    // written by the executor itself; this is the terminal marker.
    if (exhausted && job.data?.sessionId) {
      try {
        await supabase.from('workflow_sessions').update({
          status: 'failed',
          updated_at: new Date().toISOString(),
        }).eq('id', job.data.sessionId).eq('status', 'active')
      } catch { /* swallow — already in failure path */ }
    }
  })
  worker.on('completed', (job) => {
    console.log(`[worker:workflow] ✓ job=${job.id} session=${job.data.sessionId} node=${job.data.nodeId}`)
  })
  console.log('[worker:workflow] started, concurrency=', process.env.WORKFLOW_CONCURRENCY ?? 10)
  return worker
}
