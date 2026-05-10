/**
 * Workflow chaining — fire downstream workflows when an upstream session
 * completes.
 *
 * The /create context picker (FE: WorkflowContextPicker.tsx) lets a user
 * pin "Trigger from {upstream workflow}" when generating a new workflow.
 * Until now, that selection was sent only as text context to the AI parser
 * and never persisted as a real trigger — generated workflows referenced
 * the upstream by name in their description but had no actual trigger
 * mechanism.
 *
 * This module closes that loop. Migration 028 adds
 * `workflows.triggered_by_workflow_id`. The workflow-executor calls
 * `dispatchDownstreamForCompletedSession` at every point a session's
 * status flips to 'completed' (advance-with-no-next, explicit end node).
 *
 * For each downstream workflow:
 *   1. Create a new `workflow_sessions` row with status='active'
 *   2. Copy the upstream session's variables into the new session's
 *      variables under an `upstream` key — `${upstream.budget}` works in
 *      downstream node configs without explicit field mapping
 *   3. Find the first action node and enqueue it
 *
 * Errors during dispatch are logged but don't fail the upstream session —
 * the upstream completed successfully regardless of downstream wiring.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { enqueueWorkflowExecution } from '../queue'

interface UpstreamSession {
  id: string
  workflow_id: string
  tenant_id: string
  contact_phone: string
  variables?: Record<string, unknown>
}

export async function dispatchDownstreamForCompletedSession(
  supabase: SupabaseClient,
  upstream: UpstreamSession,
): Promise<{ dispatched: number }> {
  // 1. Find downstream workflows. Same tenant + chained to this upstream
  // workflow + currently 'live' (don't fire drafts/paused/archived).
  const { data: downstreams, error } = await supabase
    .from('workflows')
    .select('id, nodes, status')
    .eq('triggered_by_workflow_id', upstream.workflow_id)
    .eq('status', 'live')
  if (error) {
    console.warn('[chaining] failed to lookup downstreams:', error.message)
    return { dispatched: 0 }
  }
  if (!downstreams || downstreams.length === 0) return { dispatched: 0 }

  let dispatched = 0
  for (const wf of downstreams) {
    try {
      // 2. Find the first action node (skip pure trigger nodes — they don't
      // execute, they just identify the entry point). If no action node,
      // skip; the workflow has no body to run.
      const nodes = (wf.nodes as any[]) ?? []
      const firstAction = nodes.find(n => n.type && n.type !== 'trigger')
      if (!firstAction?.id) {
        console.info(`[chaining] downstream ${wf.id} has no action nodes — skipping`)
        continue
      }

      // 3. Create the new session. Variables namespace upstream output under
      // `upstream` so downstream nodes can reference `{{upstream.budget}}`
      // without us having to compute a per-tenant field-mapping config.
      const { data: newSession, error: insErr } = await supabase
        .from('workflow_sessions')
        .insert({
          tenant_id:        upstream.tenant_id,
          workflow_id:      wf.id,
          contact_phone:    upstream.contact_phone,
          current_node_id:  firstAction.id,
          status:           'active',
          variables:        {
            upstream: upstream.variables ?? {},
            // Track the chain origin for debugging / analytics. Not used
            // by the executor itself.
            _chained_from_session: upstream.id,
            _chained_from_workflow: upstream.workflow_id,
          },
          started_at:       new Date().toISOString(),
        })
        .select('id')
        .single()
      if (insErr) {
        console.warn(`[chaining] failed to create downstream session for workflow ${wf.id}:`, insErr.message)
        continue
      }

      // 4. Enqueue. The executor picks up from the worker pool.
      await enqueueWorkflowExecution({ sessionId: newSession.id, nodeId: firstAction.id })
      dispatched++
    } catch (e: any) {
      console.warn(`[chaining] dispatch failed for downstream ${wf.id}:`, e?.message ?? e)
    }
  }

  return { dispatched }
}

/**
 * Detect cycles in the chaining graph. Used at workflow create/update time
 * to refuse a triggered_by_workflow_id that would form a cycle (A → B → A
 * or longer chains).
 *
 * Walks UP the chain from the proposed parent, looking for the candidate
 * child. If found, the chain would loop back. Capped at 50 hops as a
 * safety against pathological data — anyone with a >50-deep chain has
 * bigger problems.
 */
export async function chainWouldCycle(
  supabase: SupabaseClient,
  childId: string | null,
  proposedParentId: string,
): Promise<boolean> {
  if (!childId) return false              // brand-new workflow can't be in any chain yet
  if (childId === proposedParentId) return true  // direct self-reference (also blocked at DB)
  let cursor: string | null = proposedParentId
  for (let i = 0; i < 50 && cursor; i++) {
    const result: { data: { triggered_by_workflow_id?: string | null } | null } =
      await supabase.from('workflows')
        .select('triggered_by_workflow_id').eq('id', cursor).maybeSingle()
    cursor = result.data?.triggered_by_workflow_id ?? null
    if (cursor === childId) return true   // cycle: walking up reached back to us
  }
  return false
}
