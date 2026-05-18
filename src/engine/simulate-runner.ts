/**
 * Workflow simulation runner.
 *
 * Drives the same executeNode() that the live workflow worker drives, but
 * with `ExecCtx.simulate = true`. The executor short-circuits every
 * side-effecting branch and returns synthetic output; this runner walks the
 * graph, collects per-node trace entries, and persists the whole run into
 * the `workflow_simulation_runs` table.
 *
 * Why a runner separate from the workflow-executor worker:
 *   - The live worker is BullMQ-driven (one node per job). For a simulation
 *     we want a single end-to-end pass that returns when the workflow
 *     terminates — async polling of N jobs would make the FE UX awful.
 *   - The trace is the product. The live worker writes one row per node into
 *     workflow_executions; here we want one row per RUN with the whole trace
 *     embedded so the FE can poll a single row.
 *   - Simulation must never touch live BullMQ queues, scheduled_jobs, or
 *     workflow_sessions. The runner uses an in-memory session shape instead.
 *
 * Safety:
 *   - Hard step cap (DEFAULT_MAX_STEPS) so a workflow with a cycle can't
 *     loop forever. The runner records a synthetic error step and exits.
 *   - Total wall-clock cap so a workflow with a bunch of slow nodes (we
 *     don't fire HTTP, but variable interpolation on huge contexts could
 *     in theory be slow) can't pin a Node.js worker thread for hours.
 *   - All persistence (final write of the run row) uses the service-role
 *     client passed in — the caller is the route handler.
 *
 * Concurrency:
 *   - The route handler runs this synchronously inside the request because
 *     simulations are short by design (no real I/O = no real latency). If a
 *     future workflow ever takes >5s to simulate we'll move this onto a
 *     dedicated BullMQ queue, but right now the request finishes inside
 *     the request-response lifecycle which simplifies the FE polling story.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { executeNode, findNode, type ExecCtx, type NodeResult } from './executor'

const DEFAULT_MAX_STEPS = 100
const DEFAULT_MAX_WALL_MS = 30_000   // 30s — generous; real cap is step count

/** A single per-node trace entry that gets appended to wsr.steps. */
export interface SimulationStep {
  step_index: number
  node_id: string
  node_type: string
  started_at: string
  finished_at: string
  duration_ms: number
  /** Interpolated cfg the executor saw — captured before the call. */
  input: Record<string, any>
  /** Synthetic output from sample data or the deterministic branch helper. */
  simulated_output: any
  /** Human-readable line ("would have sent template X to Y"). */
  would_have_done: string
  /** Mirrors NodeResult.kind so the FE can render the icon correctly. */
  kind: NodeResult['kind']
  /** Populated when kind='error' so the FE can show the failing reason. */
  error?: string
  /** Variable updates the node merged into session.variables — useful for
   *  the FE inspector to show "this step set {{name}} to 'Asha'". */
  variable_updates?: Record<string, any>
}

export interface SimulationResult {
  status: 'succeeded' | 'failed'
  steps: SimulationStep[]
  final_context: Record<string, any>
  error?: string
}

export interface RunSimulationOpts {
  tenant: any
  workflow: any
  /** Caller-provided trigger input — seeded into session.variables before step 1. */
  triggerInput: Record<string, any>
  /** Optional: pin the first node id (otherwise the runner picks the first
   *  non-trigger node). */
  startNodeId?: string | null
  /** Optional override for the step / wall-clock cap. */
  maxSteps?: number
  maxWallMs?: number
}

/**
 * Run a workflow end-to-end in simulation mode and return the trace.
 *
 * Does NOT persist to DB — the route handler owns the write so the runner
 * stays testable in isolation.
 */
export async function runSimulation(opts: RunSimulationOpts): Promise<SimulationResult> {
  const { tenant, workflow, triggerInput } = opts
  const maxSteps  = opts.maxSteps  ?? DEFAULT_MAX_STEPS
  const maxWallMs = opts.maxWallMs ?? DEFAULT_MAX_WALL_MS
  const t0 = Date.now()

  const nodes: any[] = workflow?.nodes ?? []
  if (nodes.length === 0) {
    return { status: 'failed', steps: [], final_context: {}, error: 'workflow has no nodes' }
  }

  // Resolve the first actionable node — skip trigger_* markers because the
  // live executor's "fire" path always lands on the first non-trigger node.
  let currentNodeId: string | null = opts.startNodeId
    ?? nodes.find((n: any) => !String(n.type ?? '').startsWith('trigger_'))?.id
    ?? null
  if (!currentNodeId) {
    return { status: 'failed', steps: [], final_context: {}, error: 'workflow has no actionable nodes (all triggers?)' }
  }

  // In-memory session shape — mirrors the columns the executor reads from
  // workflow_sessions. We seed variables with the trigger input so step 1
  // can interpolate {{name}}, {{phone}}, etc. The phone is sourced from
  // triggerInput.phone with a clearly-fake fallback so the trace's "to"
  // lines are non-empty and the user can see the recipient.
  const session: any = {
    id: 'simulated-session',
    tenant_id: tenant.id,
    workflow_id: workflow.id,
    contact_phone: String(triggerInput.phone ?? triggerInput.contact_phone ?? '+91SIMULATED'),
    current_node_id: currentNodeId,
    variables: { ...triggerInput },
    status: 'active',
    channel: triggerInput.channel ?? 'whatsapp',
  }

  const steps: SimulationStep[] = []
  let stepIndex = 0

  while (currentNodeId) {
    if (stepIndex >= maxSteps) {
      steps.push(errorStep(stepIndex, currentNodeId, 'unknown', `simulation aborted: exceeded ${maxSteps} steps (possible cycle)`))
      return { status: 'failed', steps, final_context: session.variables, error: 'step cap exceeded' }
    }
    if (Date.now() - t0 > maxWallMs) {
      steps.push(errorStep(stepIndex, currentNodeId, 'unknown', `simulation aborted: wall-clock exceeded ${maxWallMs}ms`))
      return { status: 'failed', steps, final_context: session.variables, error: 'wall clock cap exceeded' }
    }

    const node = findNode(workflow, currentNodeId)
    if (!node) {
      steps.push(errorStep(stepIndex, currentNodeId, 'unknown', `node ${currentNodeId} not found in workflow`))
      return { status: 'failed', steps, final_context: session.variables, error: 'node id not found' }
    }

    // Skip trigger_* nodes if we somehow landed on one (e.g. user pinned a
    // trigger as start). Triggers are no-ops in the executor's default branch.
    if (String(node.type ?? '').startsWith('trigger_')) {
      currentNodeId = node.connections?.default ?? node.connections?.next ?? null
      continue
    }

    // Per-step trace recorder — the executor calls this when it short-circuits
    // a side-effect, passing the human-readable "would have done X" line.
    // We close over a local so the runner can pick it up after the call.
    let wouldHaveDone = ''
    const recordWouldHaveDone = (line: string) => { wouldHaveDone = line }

    const ctx: ExecCtx = {
      tenant,
      session,
      workflow,
      simulate: true,
      recordWouldHaveDone,
    }

    const stepStart = Date.now()
    const startedAt = new Date(stepStart).toISOString()

    // Snapshot the interpolated input BEFORE the call so the trace shows what
    // the executor actually saw (after variable substitution). The executor
    // doesn't expose this directly, so we approximate by deep-interpolating
    // cfg here. This is a parallel `interpolateDeep` (read-only) — it never
    // mutates anything.
    let input: Record<string, any> = {}
    try {
      const { interpolateDeep } = await import('./interpolator')
      input = interpolateDeep(node.config ?? {}, session.variables ?? {})
    } catch {
      input = node.config ?? {}
    }

    let result: NodeResult
    try {
      result = await executeNode(ctx, node)
    } catch (err: any) {
      const msg = err?.message ?? String(err)
      steps.push({
        step_index: stepIndex,
        node_id: node.id,
        node_type: node.type,
        started_at: startedAt,
        finished_at: new Date().toISOString(),
        duration_ms: Date.now() - stepStart,
        input,
        simulated_output: null,
        would_have_done: wouldHaveDone || `(no trace line — node threw)`,
        kind: 'error',
        error: msg,
      })
      return { status: 'failed', steps, final_context: session.variables, error: msg }
    }

    // Merge variableUpdates back into the simulated session so subsequent
    // nodes see them. Mirrors the live worker's behaviour exactly.
    if (result.variableUpdates && Object.keys(result.variableUpdates).length > 0) {
      session.variables = { ...(session.variables ?? {}), ...result.variableUpdates }
    }

    const step: SimulationStep = {
      step_index: stepIndex,
      node_id: node.id,
      node_type: node.type,
      started_at: startedAt,
      finished_at: new Date().toISOString(),
      duration_ms: Date.now() - stepStart,
      input,
      simulated_output: result.output ?? null,
      would_have_done: wouldHaveDone || defaultWouldHaveDone(node.type, result),
      kind: result.kind,
      error: result.error,
      variable_updates: result.variableUpdates,
    }
    steps.push(step)
    stepIndex += 1

    // Decide what to do next, MIRRORING the live worker switch but without
    // any persistence side effects.
    switch (result.kind) {
      case 'advance':
        currentNodeId = result.nextNodeId ?? null
        break
      case 'wait_delay':
        // Simulation collapses delays — the executor itself converts these
        // to 'advance' when ctx.simulate=true, so we shouldn't hit this case
        // in practice. But if a future node type emits wait_delay directly,
        // honour it as advance to keep the trace flowing.
        currentNodeId = result.nextNodeId ?? null
        break
      case 'wait_input':
        // The executor converts collect_input to 'end' in simulate mode, so
        // this branch is defensive. Treat any wait_input as a terminal step.
        return { status: 'succeeded', steps, final_context: session.variables }
      case 'end':
        return { status: 'succeeded', steps, final_context: session.variables }
      case 'error':
        return { status: 'failed', steps, final_context: session.variables, error: result.error }
    }
  }

  // Hit a null nextNodeId — workflow ended naturally.
  return { status: 'succeeded', steps, final_context: session.variables }
}

/**
 * Persist a finished simulation result into `workflow_simulation_runs`.
 *
 * Two-phase write (the route handler INSERTs a 'running' row first, then
 * calls this to UPDATE) means the FE can poll the run_id immediately and
 * see status transition.
 */
export async function persistSimulationResult(
  supabase: SupabaseClient,
  runId: string,
  result: SimulationResult,
): Promise<void> {
  const { error } = await supabase.from('workflow_simulation_runs').update({
    status: result.status,
    finished_at: new Date().toISOString(),
    steps: result.steps,
    final_context: result.final_context,
    error: result.error ?? null,
  }).eq('id', runId)
  if (error) {
    console.error(`[simulate-runner] failed to persist run ${runId}:`, error.message)
    throw new Error(`persist simulation run: ${error.message}`)
  }
}

// ── Internal helpers ─────────────────────────────────────────────────────────

function errorStep(idx: number, nodeId: string, nodeType: string, msg: string): SimulationStep {
  const now = new Date().toISOString()
  return {
    step_index: idx,
    node_id: nodeId,
    node_type: nodeType,
    started_at: now,
    finished_at: now,
    duration_ms: 0,
    input: {},
    simulated_output: null,
    would_have_done: msg,
    kind: 'error',
    error: msg,
  }
}

/** Trace lines for nodes that didn't call recordWouldHaveDone (control-flow
 *  nodes like condition_variable, condition_reply, end_flow). */
function defaultWouldHaveDone(nodeType: string, result: NodeResult): string {
  switch (nodeType) {
    case 'condition_variable':
    case 'condition_reply':
    case 'condition_button_click':
      return `branched to node ${result.nextNodeId ?? '(none)'}`
    case 'end_flow':
      return `flow ended`
    case 'wait_delay':
      return `wait skipped in simulation`
    default:
      if (String(nodeType).startsWith('trigger_')) return `trigger node (no-op)`
      return `executed (no side effect to report)`
  }
}
