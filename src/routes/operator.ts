/**
 * Operator router — HTTP surface for the autonomous operator agent.
 *
 *   GET    /api/operator/tools                 catalog (op, title, risk) + health
 *   POST   /api/operator/runs                  start a run { goal, autonomy?, max_steps? }
 *   GET    /api/operator/runs                  list recent runs (this tenant)
 *   GET    /api/operator/runs/:id              run + ordered steps (FE polls this)
 *   POST   /api/operator/runs/:id/approve      approve the parked step → resume
 *   POST   /api/operator/runs/:id/reject       reject the parked step → resume (adapt)
 *   POST   /api/operator/runs/:id/cancel       cancel a run
 *
 * Runs are driven in the background (fire-and-forget) so the HTTP request
 * returns immediately; the FE polls GET /runs/:id for the live trace. All
 * errors inside the loop are caught and persisted to the run row.
 *
 * Tenant isolation: tenantId comes from identifyTenant middleware and is the
 * filter on every query (service-role bypasses RLS — same boundary as the
 * rest of the server).
 */

import express from 'express'
import { SupabaseClient } from '@supabase/supabase-js'
import Anthropic from '@anthropic-ai/sdk'
import { apiError } from '../lib/api-error'
import { OPERATOR_TOOLS, catalogHealth } from '../operator/tool-catalog'
import {
  createRun, getRun, listRuns, getSteps, patchRun, findPendingApprovalStep, updateStep,
  type Autonomy,
} from '../operator/store'
import { driveOperator } from '../operator/loop'

type Middleware = (req: express.Request, res: express.Response, next: express.NextFunction) => void | Promise<void>

interface Deps {
  supabase: SupabaseClient
  requireAuth: Middleware
  identifyTenant: Middleware
  checkPermission: (feature: string, action: 'view' | 'edit' | 'delete' | string) => Middleware
}

const anthropic = process.env.ANTHROPIC_API_KEY
  ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
  : null

const VALID_AUTONOMY: Autonomy[] = ['suggest', 'approve', 'auto']

export function createOperatorRouter(deps: Deps): express.Router {
  const r = express.Router()
  const { supabase, requireAuth, identifyTenant, checkPermission } = deps

  /** Background driver — never throws to the caller; persists failures. */
  function driveInBackground(tenantId: string, runId: string, opts: { resume?: boolean; rejected?: boolean } = {}) {
    if (!anthropic) return
    void driveOperator({ supabase, anthropic }, tenantId, runId, opts).catch(async (e: any) => {
      try {
        await patchRun(supabase, tenantId, runId, { status: 'failed', error: e?.message ?? String(e) })
      } catch { /* swallow — best effort */ }
    })
  }

  // ── GET /api/operator/tools ──────────────────────────────────────────────
  r.get('/api/operator/tools', requireAuth, identifyTenant, checkPermission('whatsapp_automation', 'view'), (_req, res) => {
    res.json({
      tools: OPERATOR_TOOLS.map(t => ({ op: t.op, title: t.title, description: t.description, risk: t.riskTier })),
      health: catalogHealth(),
      enabled: !!anthropic,
    })
  })

  // ── POST /api/operator/runs ──────────────────────────────────────────────
  r.post('/api/operator/runs', requireAuth, identifyTenant, checkPermission('whatsapp_automation', 'edit'), async (req, res) => {
    const tenantId = (req as any).tenantId
    const userId = (req as any).user?.id ?? null
    if (!tenantId) { apiError(res, 401, 'no_tenant', 'No tenant resolved.'); return }
    if (!anthropic) { apiError(res, 503, 'operator_disabled', 'Operator is unavailable (ANTHROPIC_API_KEY not set).'); return }

    const goal = String(req.body?.goal ?? '').trim()
    if (!goal) { apiError(res, 400, 'goal_required', 'A goal is required.'); return }
    if (goal.length > 2000) { apiError(res, 400, 'goal_too_long', 'Goal must be ≤ 2000 characters.'); return }

    const autonomy: Autonomy = VALID_AUTONOMY.includes(req.body?.autonomy) ? req.body.autonomy : 'approve'
    const maxSteps = Math.min(Math.max(Number(req.body?.max_steps) || 8, 1), 20)

    try {
      const run = await createRun(supabase, {
        tenantId, userId, goal, autonomy,
        model: 'claude-opus-4-7', maxSteps,
      })
      // Seed the conversation with the goal, then drive in the background.
      await patchRun(supabase, tenantId, run.id, { messages: [{ role: 'user', content: goal }] })
      driveInBackground(tenantId, run.id)
      res.status(202).json({ run_id: run.id, status: 'running' })
    } catch (e: any) {
      apiError(res, 500, 'run_create_failed', e?.message ?? String(e))
    }
  })

  // ── GET /api/operator/runs ───────────────────────────────────────────────
  r.get('/api/operator/runs', requireAuth, identifyTenant, checkPermission('whatsapp_automation', 'view'), async (req, res) => {
    const tenantId = (req as any).tenantId
    if (!tenantId) { apiError(res, 401, 'no_tenant', 'No tenant resolved.'); return }
    try {
      res.json({ runs: await listRuns(supabase, tenantId) })
    } catch (e: any) {
      apiError(res, 500, 'list_failed', e?.message ?? String(e))
    }
  })

  // ── GET /api/operator/runs/:id ───────────────────────────────────────────
  r.get('/api/operator/runs/:id', requireAuth, identifyTenant, checkPermission('whatsapp_automation', 'view'), async (req, res) => {
    const tenantId = (req as any).tenantId
    if (!tenantId) { apiError(res, 401, 'no_tenant', 'No tenant resolved.'); return }
    try {
      const run = await getRun(supabase, tenantId, String(req.params.id))
      if (!run) { apiError(res, 404, 'run_not_found', 'Run not found.'); return }
      const steps = await getSteps(supabase, tenantId, String(req.params.id))
      // Don't leak the raw model transcript to the FE — only the trace + meta.
      const { messages, ...meta } = run as any
      res.json({ run: meta, steps })
    } catch (e: any) {
      apiError(res, 500, 'get_failed', e?.message ?? String(e))
    }
  })

  // ── POST /api/operator/runs/:id/approve ──────────────────────────────────
  r.post('/api/operator/runs/:id/approve', requireAuth, identifyTenant, checkPermission('whatsapp_automation', 'edit'), async (req, res) => {
    const tenantId = (req as any).tenantId
    if (!tenantId) { apiError(res, 401, 'no_tenant', 'No tenant resolved.'); return }
    try {
      const run = await getRun(supabase, tenantId, String(req.params.id))
      if (!run) { apiError(res, 404, 'run_not_found', 'Run not found.'); return }
      if (run.status !== 'awaiting_approval') { apiError(res, 409, 'not_awaiting', 'Run is not waiting for approval.'); return }
      const pending = await findPendingApprovalStep(supabase, tenantId, run.id)
      if (pending?.id) await updateStep(supabase, tenantId, pending.id, { status: 'approved' })
      driveInBackground(tenantId, run.id, { resume: true })
      res.json({ status: 'running' })
    } catch (e: any) {
      apiError(res, 500, 'approve_failed', e?.message ?? String(e))
    }
  })

  // ── POST /api/operator/runs/:id/reject ───────────────────────────────────
  r.post('/api/operator/runs/:id/reject', requireAuth, identifyTenant, checkPermission('whatsapp_automation', 'edit'), async (req, res) => {
    const tenantId = (req as any).tenantId
    if (!tenantId) { apiError(res, 401, 'no_tenant', 'No tenant resolved.'); return }
    try {
      const run = await getRun(supabase, tenantId, String(req.params.id))
      if (!run) { apiError(res, 404, 'run_not_found', 'Run not found.'); return }
      if (run.status !== 'awaiting_approval') { apiError(res, 409, 'not_awaiting', 'Run is not waiting for approval.'); return }
      const pending = await findPendingApprovalStep(supabase, tenantId, run.id)
      if (pending?.id) await updateStep(supabase, tenantId, pending.id, { status: 'rejected' })
      driveInBackground(tenantId, run.id, { resume: true, rejected: true })
      res.json({ status: 'running' })
    } catch (e: any) {
      apiError(res, 500, 'reject_failed', e?.message ?? String(e))
    }
  })

  // ── POST /api/operator/runs/:id/cancel ───────────────────────────────────
  r.post('/api/operator/runs/:id/cancel', requireAuth, identifyTenant, checkPermission('whatsapp_automation', 'edit'), async (req, res) => {
    const tenantId = (req as any).tenantId
    if (!tenantId) { apiError(res, 401, 'no_tenant', 'No tenant resolved.'); return }
    try {
      await patchRun(supabase, tenantId, String(req.params.id), { status: 'cancelled' })
      res.json({ status: 'cancelled' })
    } catch (e: any) {
      apiError(res, 500, 'cancel_failed', e?.message ?? String(e))
    }
  })

  return r
}
