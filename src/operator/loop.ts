/**
 * Operator loop — the autonomous agent that reasons over the tool catalog and
 * acts via the existing connector layer (engine/connector-ops.ts).
 *
 * This is the SellerClaw-style "reason → call tool → observe → repeat" loop,
 * adapted to Frequency. It is intentionally model-driven but tightly bounded:
 *
 *   • Tools are limited to OPERATOR_TOOLS (no arbitrary code, no shell).
 *   • Risk tiers + autonomy decide what executes vs what pauses for a human.
 *   • Every reasoning block and tool call is persisted to operator_steps so the
 *     FE can render the live trace and so runs are fully auditable.
 *   • Human-in-the-loop: when a gated tool comes up, the run is parked at
 *     status='awaiting_approval' between the assistant's tool_use turn and the
 *     tool_result turn. Anthropic places no time limit on that gap, so resume
 *     is just "execute the approved call, send the result, keep going".
 *
 * Approval is implemented self-contained on operator_steps (approve/reject
 * endpoints flip the step). We ALSO best-effort register the action in the
 * existing approvals inbox via requireApproval() when a matching rule exists,
 * so it shows up where teams already look — but the operator never depends on
 * that table's schema.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import type Anthropic from '@anthropic-ai/sdk'
import {
  OPERATOR_TOOLS, TOOL_BY_OP, toAnthropicTools, toolNameToOp, type RiskTier,
} from './tool-catalog'
import { dispatchConnectorOp } from '../engine/connector-ops'
import {
  type OperatorRun, type Autonomy, type OperatorStep,
  getRun, appendStep, patchRun,
} from './store'

export interface LoopDeps {
  supabase: SupabaseClient
  anthropic: Anthropic
}

/** Optional live callback — the router uses it to stream steps over SSE. */
export type StepEmitter = (step: OperatorStep) => void

const MAX_TOOL_RESULT_CHARS = 4000

function truncate(value: unknown): string {
  let s: string
  try { s = typeof value === 'string' ? value : JSON.stringify(value) } catch { s = String(value) }
  return s.length > MAX_TOOL_RESULT_CHARS ? s.slice(0, MAX_TOOL_RESULT_CHARS) + '…[truncated]' : s
}

/** Operator policy: does this risk tier require a human under this autonomy? */
function needsApproval(autonomy: Autonomy, risk: RiskTier): boolean {
  if (risk === 'read') return false
  if (autonomy === 'auto') return false
  if (autonomy === 'approve') return risk === 'irreversible'
  return true // 'suggest' → gate every write
}

const SYSTEM_PROMPT = `You are the Frequency Operator — an autonomous operator that runs parts of a
business's omnichannel commerce + CRM workspace on the user's behalf.

How you work:
- You are given a GOAL. Break it into steps. Think briefly out loud before each tool call.
- Use ONLY the provided tools. Each tool's description starts with its risk tier.
- Prefer reading/inspecting before writing. Never invent ids — discover them via read tools.
- Some write tools are gated and will pause for human approval; that is expected. Plan as if
  they will be approved.
- When the goal is achieved (or cannot be), stop calling tools and write a short final summary
  of what you did and what (if anything) needs the human's attention.

Be concise. Do not narrate every field — explain your reasoning at the level a busy operator
would want to skim.`

interface DriveResult {
  status: OperatorRun['status']
  result?: string | null
  pendingStepId?: string
}

/**
 * Drive a run forward until it completes, fails, hits max steps, or parks on an
 * approval. Safe to call repeatedly: on `resume` it executes the parked tool
 * call(s) from the last assistant turn, then continues.
 */
export async function driveOperator(
  deps: LoopDeps,
  tenantId: string,
  runId: string,
  opts: { resume?: boolean; rejected?: boolean } = {},
): Promise<DriveResult> {
  const { supabase, anthropic } = deps
  const run = await getRun(supabase, tenantId, runId)
  if (!run) throw new Error('run_not_found')

  const tools = toAnthropicTools()
  const messages: any[] = Array.isArray(run.messages) ? [...run.messages] : []
  let idx = run.step_count ?? 0
  const model = run.model || 'claude-opus-4-7'

  const emit = (deps as any).__emit as StepEmitter | undefined
  const record = async (s: Omit<OperatorStep, 'run_id' | 'tenant_id' | 'idx'>) => {
    const step = await appendStep(supabase, { run_id: runId, tenant_id: tenantId, idx: idx++, ...s })
    emit?.(step)
    return step
  }

  await patchRun(supabase, tenantId, runId, { status: 'running' })

  // ── RESUME: the last assistant turn holds approved tool_use block(s). Execute
  //    them now and feed the results back before continuing the normal loop. ──
  if (opts.resume) {
    const last = messages[messages.length - 1]
    if (last?.role === 'assistant') {
      const toolUses = (last.content as any[]).filter(b => b?.type === 'tool_use')
      if (opts.rejected) {
        // Human said no. Tell the model so it can adapt instead of retrying.
        await record({ kind: 'approval', title: 'Rejected by human', status: 'rejected' })
        const results = toolUses.map(tu => ({
          type: 'tool_result', tool_use_id: tu.id, is_error: true,
          content: 'Rejected by the human operator. Do not retry this exact action — find another approach or stop and summarize.',
        }))
        if (results.length) messages.push({ role: 'user', content: results })
      } else {
        const results = await executeToolUses(deps, tenantId, runId, toolUses, record, () => idx)
        if (results.length) messages.push({ role: 'user', content: results })
      }
    }
  }

  // ── Main loop ───────────────────────────────────────────────────────────────
  while (idx < run.max_steps) {
    let resp
    try {
      resp = await anthropic.messages.create({
        model,
        max_tokens: 1024,
        system: SYSTEM_PROMPT,
        tools: tools as any,
        messages,
      })
    } catch (e: any) {
      const msg = e?.message ?? String(e)
      await record({ kind: 'error', title: 'Model call failed', thought: msg, status: 'error' })
      await patchRun(supabase, tenantId, runId, { status: 'failed', error: msg, messages, step_count: idx })
      return { status: 'failed' }
    }

    // Surface the reasoning text blocks as trace rows.
    const textBlocks = (resp.content as any[]).filter(b => b.type === 'text')
    for (const b of textBlocks) {
      if (b.text?.trim()) await record({ kind: 'reasoning', title: 'Thinking', thought: b.text, status: 'ok' })
    }

    // Commit the assistant turn (text + any tool_use) to history.
    messages.push({ role: 'assistant', content: resp.content })

    const toolUses = (resp.content as any[]).filter(b => b.type === 'tool_use')

    // No tools requested → the agent is done.
    if (resp.stop_reason !== 'tool_use' || toolUses.length === 0) {
      const finalText = textBlocks.map(b => b.text).join('\n').trim() || 'Done.'
      await record({ kind: 'final', title: 'Final summary', thought: finalText, status: 'ok' })
      await patchRun(supabase, tenantId, runId, { status: 'completed', result: finalText, messages, step_count: idx })
      return { status: 'completed', result: finalText }
    }

    // Gating: if ANY tool in this turn needs approval, park the whole turn.
    const gated = toolUses.find(tu => {
      const tool = TOOL_BY_OP[toolNameToOp(tu.name)]
      return tool && needsApproval(run.autonomy, tool.riskTier)
    })

    if (gated) {
      const op = toolNameToOp(gated.name)
      const tool = TOOL_BY_OP[op]
      // Best-effort: register in the existing approvals inbox (non-fatal).
      let approvalRequestId: string | null = null
      try {
        const { requireApproval } = await import('../routes/approvals')
        const r = await requireApproval(supabase, {
          tenant_id: tenantId,
          requested_by: run.created_by ?? tenantId,
          action_type: tool?.approvalActionType ?? 'operator_step',
          target_payload: { op, args: gated.input, run_id: runId },
          requested_by_name: 'Frequency Operator',
        })
        approvalRequestId = r.request_id ?? null
      } catch { /* approvals inbox integration is optional */ }

      const step = await record({
        kind: 'approval',
        title: `Approval needed: ${tool?.title ?? op}`,
        tool_op: op,
        tool_args: gated.input,
        risk_tier: tool?.riskTier ?? 'irreversible',
        approval_request_id: approvalRequestId,
        status: 'awaiting_approval',
      })
      await patchRun(supabase, tenantId, runId, { status: 'awaiting_approval', messages, step_count: idx })
      return { status: 'awaiting_approval', pendingStepId: step.id }
    }

    // No gating → execute every tool in the turn and feed results back.
    const results = await executeToolUses(deps, tenantId, runId, toolUses, record, () => idx)
    messages.push({ role: 'user', content: results })
    await patchRun(supabase, tenantId, runId, { messages, step_count: idx })
  }

  // Hit the step budget.
  await record({ kind: 'error', title: 'Step budget reached', thought: `Stopped after ${run.max_steps} steps.`, status: 'error' })
  await patchRun(supabase, tenantId, runId, { status: 'completed', result: 'Stopped: reached the step limit before finishing.', messages, step_count: idx })
  return { status: 'completed', result: 'Stopped: reached the step limit.' }
}

/** Execute a set of tool_use blocks → returns Anthropic tool_result blocks. */
async function executeToolUses(
  deps: LoopDeps,
  tenantId: string,
  runId: string,
  toolUses: any[],
  record: (s: Omit<OperatorStep, 'run_id' | 'tenant_id' | 'idx'>) => Promise<OperatorStep>,
  _idx: () => number,
): Promise<any[]> {
  const out: any[] = []
  for (const tu of toolUses) {
    const op = toolNameToOp(tu.name)
    const tool = TOOL_BY_OP[op]
    await record({
      kind: 'tool_call', title: tool?.title ?? op,
      tool_op: op, tool_args: tu.input, risk_tier: tool?.riskTier ?? null, status: 'ok',
    })
    try {
      const result = await dispatchConnectorOp(deps.supabase, tenantId, op, tu.input ?? {})
      await record({
        kind: 'tool_result', title: `${tool?.title ?? op} → ok`,
        tool_op: op, tool_output: result.output ?? result, status: 'ok',
      })
      out.push({ type: 'tool_result', tool_use_id: tu.id, content: truncate(result.primary ?? result.output ?? result) })
    } catch (e: any) {
      const msg = e?.message ?? String(e)
      await record({ kind: 'tool_result', title: `${tool?.title ?? op} → error`, tool_op: op, thought: msg, status: 'error' })
      out.push({ type: 'tool_result', tool_use_id: tu.id, is_error: true, content: `Error: ${msg}` })
    }
  }
  return out
}

/** Names of every tool the operator can use (for the FE catalog view). */
export function operatorToolSummary() {
  return OPERATOR_TOOLS.map(t => ({ op: t.op, title: t.title, risk: t.riskTier }))
}
