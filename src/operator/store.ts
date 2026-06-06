/**
 * Operator persistence — thin Supabase helpers for operator_runs / operator_steps.
 *
 * The server uses the service-role client, which bypasses RLS, so the
 * `.eq('tenant_id', tenantId)` filter in every read/write IS the security
 * boundary (same pattern as routes/ai-responder.ts). Callers must always pass
 * a tenantId that came from auth middleware, never from the request body.
 */

import type { SupabaseClient } from '@supabase/supabase-js'

export type RunStatus = 'running' | 'awaiting_approval' | 'completed' | 'failed' | 'cancelled'
export type Autonomy = 'suggest' | 'approve' | 'auto'
export type StepKind = 'reasoning' | 'tool_call' | 'tool_result' | 'approval' | 'final' | 'error'
export type StepStatus = 'ok' | 'awaiting_approval' | 'approved' | 'rejected' | 'error'

export interface OperatorRun {
  id: string
  tenant_id: string
  created_by: string | null
  goal: string
  autonomy: Autonomy
  status: RunStatus
  model: string | null
  messages: any[]
  result: string | null
  error: string | null
  max_steps: number
  step_count: number
  created_at: string
  updated_at: string
}

export interface OperatorStep {
  id?: string
  run_id: string
  tenant_id: string
  idx: number
  kind: StepKind
  title?: string | null
  thought?: string | null
  tool_op?: string | null
  tool_args?: any
  tool_output?: any
  risk_tier?: 'read' | 'reversible' | 'irreversible' | null
  approval_request_id?: string | null
  status?: StepStatus
  created_at?: string
}

export async function createRun(
  supabase: SupabaseClient,
  args: { tenantId: string; userId: string | null; goal: string; autonomy: Autonomy; model: string; maxSteps?: number },
): Promise<OperatorRun> {
  const { data, error } = await supabase
    .from('operator_runs')
    .insert({
      tenant_id: args.tenantId,
      created_by: args.userId,
      goal: args.goal,
      autonomy: args.autonomy,
      model: args.model,
      max_steps: args.maxSteps ?? 12,
      status: 'running',
    })
    .select('*')
    .single()
  if (error) throw new Error(`createRun failed: ${error.message}`)
  return data as OperatorRun
}

export async function getRun(
  supabase: SupabaseClient,
  tenantId: string,
  runId: string,
): Promise<OperatorRun | null> {
  const { data, error } = await supabase
    .from('operator_runs')
    .select('*')
    .eq('tenant_id', tenantId)
    .eq('id', runId)
    .maybeSingle()
  if (error) throw new Error(`getRun failed: ${error.message}`)
  return (data as OperatorRun) ?? null
}

export async function listRuns(
  supabase: SupabaseClient,
  tenantId: string,
  limit = 30,
): Promise<OperatorRun[]> {
  const { data, error } = await supabase
    .from('operator_runs')
    .select('id, goal, autonomy, status, result, step_count, created_at, updated_at')
    .eq('tenant_id', tenantId)
    .order('created_at', { ascending: false })
    .limit(limit)
  if (error) throw new Error(`listRuns failed: ${error.message}`)
  return (data as OperatorRun[]) ?? []
}

export async function getSteps(
  supabase: SupabaseClient,
  tenantId: string,
  runId: string,
): Promise<OperatorStep[]> {
  const { data, error } = await supabase
    .from('operator_steps')
    .select('*')
    .eq('tenant_id', tenantId)
    .eq('run_id', runId)
    .order('idx', { ascending: true })
  if (error) throw new Error(`getSteps failed: ${error.message}`)
  return (data as OperatorStep[]) ?? []
}

export async function appendStep(
  supabase: SupabaseClient,
  step: OperatorStep,
): Promise<OperatorStep> {
  const { data, error } = await supabase
    .from('operator_steps')
    .insert(step)
    .select('*')
    .single()
  if (error) throw new Error(`appendStep failed: ${error.message}`)
  return data as OperatorStep
}

export async function updateStep(
  supabase: SupabaseClient,
  tenantId: string,
  stepId: string,
  patch: Partial<OperatorStep>,
): Promise<void> {
  const { error } = await supabase
    .from('operator_steps')
    .update(patch)
    .eq('tenant_id', tenantId)
    .eq('id', stepId)
  if (error) throw new Error(`updateStep failed: ${error.message}`)
}

export async function patchRun(
  supabase: SupabaseClient,
  tenantId: string,
  runId: string,
  patch: Partial<OperatorRun>,
): Promise<void> {
  const { error } = await supabase
    .from('operator_runs')
    .update(patch)
    .eq('tenant_id', tenantId)
    .eq('id', runId)
  if (error) throw new Error(`patchRun failed: ${error.message}`)
}

/** Find the single step a run is paused on (status='awaiting_approval'). */
export async function findPendingApprovalStep(
  supabase: SupabaseClient,
  tenantId: string,
  runId: string,
): Promise<OperatorStep | null> {
  const { data, error } = await supabase
    .from('operator_steps')
    .select('*')
    .eq('tenant_id', tenantId)
    .eq('run_id', runId)
    .eq('status', 'awaiting_approval')
    .order('idx', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (error) throw new Error(`findPendingApprovalStep failed: ${error.message}`)
  return (data as OperatorStep) ?? null
}
