/**
 * Workflow versions, revert, publish-preview, explain, execution-trace.
 * Ships as part of P1 #14 (AI workflow author v1 improvements).
 *
 *   POST   /api/workflows/:id/publish-preview
 *   GET    /api/workflows/:id/versions
 *   POST   /api/workflows/:id/revert            { version_id }
 *   POST   /api/workflows/:id/explain
 *   GET    /api/workflows/:id/executions/:execution_id/trace
 *
 * Design notes:
 *   • Versions are append-only (see migration 081). We always INSERT, never
 *     mutate history — even a revert creates a NEW version with the old
 *     nodes_json, preserving the audit trail.
 *   • Every write goes through service-role (the `supabase` client passed in
 *     deps is the SR client used by index.ts) so the RLS revoke on
 *     authenticated stays intact.
 *   • Plain-English explainer is cached on workflow_versions.explainer_text;
 *     repeated /explain calls for the same version are free.
 *   • publish-preview validates against the connector registry BEFORE
 *     writing the row — invalid graphs come back as 422 with the actual
 *     ValidationReport so the FE can highlight bad node references.
 *   • NO visual canvas anywhere — endpoints return JSON only. The FE
 *     renders the diff as plain English with a collapsible JSON fallback.
 */

import express from 'express'
import { SupabaseClient } from '@supabase/supabase-js'
import Anthropic from '@anthropic-ai/sdk'

type Middleware = (req: express.Request, res: express.Response, next: express.NextFunction) => void | Promise<void>
type PermChecker = (feature: string, op: 'view' | 'edit' | 'delete') => Middleware

interface Deps {
  supabase: SupabaseClient
  requireAuth: Middleware
  identifyTenant: Middleware
  checkPermission: PermChecker
}

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY ?? '' })

/** Cap explainer prompt size — keep AI cost predictable. */
const EXPLAIN_NODE_CAP = 80

export function createWorkflowVersionsRouter(deps: Deps): express.Router {
  const r = express.Router()
  const { supabase, requireAuth, identifyTenant, checkPermission } = deps

  // ──────────────────────────────────────────────────────────────────────────
  // GET /api/workflows/:id/versions — list versions newest-first.
  // Returns version_number, change_note, created_at, is_published, and the
  // creator's id (FE can join with team-members for the display name later).
  // ──────────────────────────────────────────────────────────────────────────
  r.get(
    '/api/workflows/:id/versions',
    requireAuth, identifyTenant, checkPermission('whatsapp_automation', 'view'),
    async (req, res) => {
      const tenantId = (req as any).tenantId as string
      const wfId = req.params.id

      // Confirm workflow belongs to tenant before listing — defence in depth
      // on top of the RLS read policy.
      const { data: wf, error: wfErr } = await supabase
        .from('workflows')
        .select('id')
        .eq('id', wfId)
        .eq('tenant_id', tenantId)
        .maybeSingle()
      if (wfErr) { res.status(500).json({ error: wfErr.message }); return }
      if (!wf)   { res.status(404).json({ error: 'Workflow not found' }); return }

      const { data, error } = await supabase
        .from('workflow_versions')
        .select('id, version_number, change_note, is_published, created_by, created_at, explainer_text')
        .eq('workflow_id', wfId)
        .eq('tenant_id', tenantId)
        .order('version_number', { ascending: false })
        .limit(100)
      if (error) { res.status(500).json({ error: error.message }); return }
      res.json({ versions: data ?? [] })
    },
  )

  // ──────────────────────────────────────────────────────────────────────────
  // POST /api/workflows/:id/publish-preview
  //   body: { nodes_json: [...], change_note?: string, source_chat_message_id?: string }
  //
  // Validates the proposed graph against the connector registry. If valid:
  //   1. Insert a new workflow_versions row with is_published=true
  //   2. Flip the previously-published row (if any) to is_published=false
  //   3. Copy nodes_json into workflows.nodes + point current_version_id
  //
  // If invalid: 422 with the full ValidationReport so the FE chat can
  // surface "this node references shopify_create_order which doesn't exist".
  // ──────────────────────────────────────────────────────────────────────────
  r.post(
    '/api/workflows/:id/publish-preview',
    requireAuth, identifyTenant, checkPermission('whatsapp_automation', 'edit'),
    async (req, res) => {
      const tenantId = (req as any).tenantId as string
      const userId   = (req as any).user?.id ?? null
      const wfId     = req.params.id

      const body = (req.body ?? {}) as {
        nodes_json?: unknown
        change_note?: string
        source_chat_message_id?: string
      }
      if (!Array.isArray(body.nodes_json)) {
        res.status(400).json({ error: 'nodes_json (array) is required' }); return
      }
      // Sanity cap — prevents a runaway client from posting a giant blob.
      if (body.nodes_json.length > 200) {
        res.status(400).json({ error: 'Workflow too large: max 200 nodes' }); return
      }

      // Tenant ownership check.
      const { data: wf, error: wfErr } = await supabase
        .from('workflows')
        .select('id, tenant_id, nodes')
        .eq('id', wfId)
        .eq('tenant_id', tenantId)
        .maybeSingle()
      if (wfErr) { res.status(500).json({ error: wfErr.message }); return }
      if (!wf)   { res.status(404).json({ error: 'Workflow not found' }); return }

      // Connector-registry validation.
      const { validateWorkflow } = await import('../engine/workflow-validator')
      const report = await validateWorkflow(supabase, tenantId, body.nodes_json as any[])

      // Block on structural errors — missing connectors are surfaced as
      // a UI step, not a publish blocker (the workflow can be saved as a
      // draft version even before Razorpay is connected). The PATCH-status-to-live
      // gate already enforces missing_connectors elsewhere.
      const hasError = report.node_issues.some(i => i.severity === 'error')
      if (hasError) {
        res.status(422).json({
          error: 'Workflow has structural issues — fix the nodes listed below',
          code:  'workflow_validation_failed',
          report,
        })
        return
      }

      // Compute next version_number deterministically.
      const { data: tip } = await supabase
        .from('workflow_versions')
        .select('version_number')
        .eq('workflow_id', wfId)
        .order('version_number', { ascending: false })
        .limit(1)
        .maybeSingle()
      const nextVersion = (tip?.version_number ?? 0) + 1

      // Demote currently-published version (if any).
      await supabase
        .from('workflow_versions')
        .update({ is_published: false })
        .eq('workflow_id', wfId)
        .eq('is_published', true)

      // Insert new version.
      const { data: inserted, error: insErr } = await supabase
        .from('workflow_versions')
        .insert({
          workflow_id:            wfId,
          tenant_id:              tenantId,
          version_number:         nextVersion,
          nodes_json:             body.nodes_json,
          change_note:            body.change_note ?? null,
          is_published:           true,
          source_chat_message_id: body.source_chat_message_id ?? null,
          created_by:             userId,
        })
        .select('id, version_number, created_at, is_published, change_note')
        .single()
      if (insErr || !inserted) {
        res.status(500).json({ error: insErr?.message ?? 'failed to insert version' })
        return
      }

      // Mirror into workflows.nodes + pointer for execution-engine consumers.
      await supabase
        .from('workflows')
        .update({
          nodes:              body.nodes_json,
          current_version_id: inserted.id,
          updated_at:         new Date().toISOString(),
        })
        .eq('id', wfId)
        .eq('tenant_id', tenantId)

      res.json({ version: inserted, validation: report })
    },
  )

  // ──────────────────────────────────────────────────────────────────────────
  // POST /api/workflows/:id/revert  { version_id }
  //
  // Copies the target version's nodes_json into a NEW version (append-only,
  // history is preserved), publishes it, and points workflows.current_version_id.
  // Single-tap undo = revert to the second-newest published version.
  // ──────────────────────────────────────────────────────────────────────────
  r.post(
    '/api/workflows/:id/revert',
    requireAuth, identifyTenant, checkPermission('whatsapp_automation', 'edit'),
    async (req, res) => {
      const tenantId = (req as any).tenantId as string
      const userId   = (req as any).user?.id ?? null
      const wfId     = req.params.id
      const { version_id } = (req.body ?? {}) as { version_id?: string }
      if (!version_id || typeof version_id !== 'string') {
        res.status(400).json({ error: 'version_id (uuid) is required' }); return
      }

      // Fetch target version + confirm tenant ownership.
      const { data: target, error: vErr } = await supabase
        .from('workflow_versions')
        .select('id, workflow_id, tenant_id, nodes_json, version_number')
        .eq('id', version_id)
        .eq('workflow_id', wfId)
        .eq('tenant_id', tenantId)
        .maybeSingle()
      if (vErr)    { res.status(500).json({ error: vErr.message }); return }
      if (!target) { res.status(404).json({ error: 'Version not found' }); return }

      // Compute next version_number.
      const { data: tip } = await supabase
        .from('workflow_versions')
        .select('version_number')
        .eq('workflow_id', wfId)
        .order('version_number', { ascending: false })
        .limit(1)
        .maybeSingle()
      const nextVersion = (tip?.version_number ?? 0) + 1

      // Demote currently-published version.
      await supabase
        .from('workflow_versions')
        .update({ is_published: false })
        .eq('workflow_id', wfId)
        .eq('is_published', true)

      const { data: inserted, error: insErr } = await supabase
        .from('workflow_versions')
        .insert({
          workflow_id:    wfId,
          tenant_id:      tenantId,
          version_number: nextVersion,
          nodes_json:     target.nodes_json,
          change_note:    `Reverted to v${target.version_number}`,
          is_published:   true,
          created_by:     userId,
        })
        .select('id, version_number, created_at, is_published, change_note')
        .single()
      if (insErr || !inserted) {
        res.status(500).json({ error: insErr?.message ?? 'failed to insert revert version' })
        return
      }

      await supabase
        .from('workflows')
        .update({
          nodes:              target.nodes_json,
          current_version_id: inserted.id,
          updated_at:         new Date().toISOString(),
        })
        .eq('id', wfId)
        .eq('tenant_id', tenantId)

      res.json({ version: inserted })
    },
  )

  // ──────────────────────────────────────────────────────────────────────────
  // POST /api/workflows/:id/explain
  //
  // 2-3 sentence plain-English summary of the current published version.
  // Cached on workflow_versions.explainer_text → never re-bill the LLM for
  // the same nodes_json.
  // ──────────────────────────────────────────────────────────────────────────
  r.post(
    '/api/workflows/:id/explain',
    requireAuth, identifyTenant, checkPermission('whatsapp_automation', 'view'),
    async (req, res) => {
      const tenantId = (req as any).tenantId as string
      const wfId     = req.params.id

      // Find the currently-published version (or fall back to the newest one
      // for workflows that haven't been published yet).
      const { data: pub } = await supabase
        .from('workflow_versions')
        .select('id, nodes_json, explainer_text')
        .eq('workflow_id', wfId)
        .eq('tenant_id', tenantId)
        .order('is_published', { ascending: false })
        .order('version_number', { ascending: false })
        .limit(1)
        .maybeSingle()

      // Cache hit.
      if (pub?.explainer_text) {
        res.json({ explanation: pub.explainer_text, cached: true })
        return
      }

      // No version yet? Fall back to workflows.nodes for in-flight drafts.
      let nodes: any[] = []
      let versionRowId: string | null = pub?.id ?? null
      if (pub?.nodes_json && Array.isArray(pub.nodes_json)) {
        nodes = pub.nodes_json as any[]
      } else {
        const { data: wf } = await supabase
          .from('workflows')
          .select('nodes')
          .eq('id', wfId)
          .eq('tenant_id', tenantId)
          .maybeSingle()
        nodes = Array.isArray(wf?.nodes) ? wf!.nodes as any[] : []
      }

      if (nodes.length === 0) {
        res.json({ explanation: 'This workflow has no steps yet. Tell the chat what should happen and we\'ll build it.', cached: false })
        return
      }

      if (!process.env.ANTHROPIC_API_KEY) {
        // Graceful fallback when AI is offline — deterministic summary derived
        // from the node graph. Less polished but never broken.
        res.json({ explanation: fallbackExplainer(nodes), cached: false, source: 'fallback' })
        return
      }

      try {
        const compact = nodes.slice(0, EXPLAIN_NODE_CAP).map(n => ({
          id: n?.id, type: n?.type, label: n?.label, description: n?.description,
          config: redactConfig(n?.config ?? {}),
        }))
        const result = await anthropic.messages.create({
          model: 'claude-haiku-4-5',
          max_tokens: 250,
          system: 'You are a friendly assistant that explains WhatsApp / multi-channel automation workflows to small-business owners. Write 2-3 sentences in plain English (no jargon, no node IDs). Start with the trigger, then the main actions. Keep it under 500 characters. Do NOT use markdown.',
          messages: [
            { role: 'user', content: `Explain this workflow in 2-3 sentences:\n\n${JSON.stringify(compact)}` },
          ],
        })
        const text = result.content
          .filter(b => b.type === 'text')
          .map(b => (b as any).text as string)
          .join('')
          .trim()
          .slice(0, 600)

        // Cache on the version row when we have one.
        if (versionRowId && text) {
          await supabase
            .from('workflow_versions')
            .update({ explainer_text: text, explainer_at: new Date().toISOString() })
            .eq('id', versionRowId)
        }

        // Token accounting — same path as parse-workflow.
        void import('../lib/ai-usage')
          .then(({ recordAiUsage }) => recordAiUsage(supabase, tenantId, result.usage as any, 'explain_workflow', 'claude-haiku-4-5'))
          .catch(() => {})

        res.json({ explanation: text || fallbackExplainer(nodes), cached: false })
      } catch (err: any) {
        // LLM hiccup → degrade to the deterministic fallback.
        res.json({ explanation: fallbackExplainer(nodes), cached: false, source: 'fallback', warning: err?.message?.slice(0, 120) })
      }
    },
  )

  // ──────────────────────────────────────────────────────────────────────────
  // GET /api/workflows/:id/executions/:execution_id/trace
  //
  // Per-node execution log for one run. We read from workflow_executions
  // (migration 010) and group rows by node_id, returning a flat list ordered
  // by created_at. The FE renders this as an expandable list in the
  // "Execution log" drawer.
  // ──────────────────────────────────────────────────────────────────────────
  r.get(
    '/api/workflows/:id/executions/:execution_id/trace',
    requireAuth, identifyTenant, checkPermission('whatsapp_automation', 'view'),
    async (req, res) => {
      const tenantId = (req as any).tenantId as string
      const wfId     = req.params.id
      const sessionId = req.params.execution_id

      // Tenant ownership check.
      const { data: wf } = await supabase
        .from('workflows')
        .select('id')
        .eq('id', wfId)
        .eq('tenant_id', tenantId)
        .maybeSingle()
      if (!wf) { res.status(404).json({ error: 'Workflow not found' }); return }

      const { data, error } = await supabase
        .from('workflow_executions')
        .select('id, node_id, node_type, status, attempt, duration_ms, error, output, created_at')
        .eq('workflow_id', wfId)
        .eq('tenant_id', tenantId)
        .eq('session_id', sessionId)
        .order('created_at', { ascending: true })
        .limit(500)
      if (error) { res.status(500).json({ error: error.message }); return }
      res.json({ session_id: sessionId, steps: data ?? [] })
    },
  )

  // GET /api/workflows/:id/executions — last 10 sessions for the FE drawer.
  // Convenience surface so the drawer doesn't need a separate query.
  r.get(
    '/api/workflows/:id/executions',
    requireAuth, identifyTenant, checkPermission('whatsapp_automation', 'view'),
    async (req, res) => {
      const tenantId = (req as any).tenantId as string
      const wfId     = req.params.id

      // Distinct session_ids ordered by latest activity. Two-step query
      // because PostgREST can't do a DISTINCT-ON in one shot.
      const { data: latest } = await supabase
        .from('workflow_executions')
        .select('session_id, created_at, status')
        .eq('workflow_id', wfId)
        .eq('tenant_id', tenantId)
        .not('session_id', 'is', null)
        .order('created_at', { ascending: false })
        .limit(200)

      const seen = new Set<string>()
      const sessions: Array<{ session_id: string; last_at: string; last_status: string }> = []
      for (const row of latest ?? []) {
        const sid = (row as any).session_id as string | null
        if (!sid || seen.has(sid)) continue
        seen.add(sid)
        sessions.push({
          session_id:  sid,
          last_at:     (row as any).created_at,
          last_status: (row as any).status,
        })
        if (sessions.length >= 10) break
      }
      res.json({ sessions })
    },
  )

  return r
}

// ─── helpers ────────────────────────────────────────────────────────────────

/** Strip obvious-secrets from node config before shipping to the LLM. */
function redactConfig(cfg: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(cfg)) {
    if (/secret|token|key|password|webhook_secret/i.test(k)) { out[k] = '[redacted]'; continue }
    if (typeof v === 'string' && v.length > 200) { out[k] = v.slice(0, 200) + '…'; continue }
    out[k] = v
  }
  return out
}

/**
 * Deterministic 1-sentence explainer used when the LLM is offline / errors.
 * Reads node labels in order — not as polished as the AI version but never
 * leaves the user with a "could not explain" empty state.
 */
function fallbackExplainer(nodes: any[]): string {
  const trigger = nodes.find(n => typeof n?.type === 'string' && n.type.startsWith('trigger_'))
  const actions = nodes.filter(n => typeof n?.type === 'string' && !n.type.startsWith('trigger_'))
  const triggerWord = trigger?.label || (trigger?.type ?? 'an event').replace('trigger_', '').replace(/_/g, ' ')
  const actionWords = actions
    .slice(0, 3)
    .map(n => n?.label || (n?.type ?? 'a step').replace(/_/g, ' '))
    .join(', then ')
  if (!actions.length) {
    return `When ${triggerWord} happens, this workflow currently has no actions configured.`
  }
  const more = actions.length > 3 ? ` …and ${actions.length - 3} more step${actions.length - 3 === 1 ? '' : 's'}` : ''
  return `When ${triggerWord} happens, the workflow will ${actionWords}${more}.`
}
