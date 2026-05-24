/**
 * n8n import routes — parse n8n JSON, propose Frequency workflows, persist
 * them as drafts. Pairs with src/lib/n8n-import.ts (the deterministic parser).
 *
 *   POST /api/workflows/import-n8n          — parse only (no DB writes)
 *   POST /api/workflows/import-n8n/commit   — insert each ProposedWorkflow
 *                                              as a DRAFT workflow row
 *
 * Why two endpoints (parse + commit) instead of one parse-and-write call:
 *   - The FE renders a preview between Step 1 (paste) and Step 3 (success)
 *     so the user can see exactly what we're about to create and tick off
 *     the missing-app onboarding requests first. Splitting parse/commit
 *     keeps the flow recoverable — a parse can succeed even if the user
 *     decides not to commit (e.g. they spot a typo and re-paste).
 *
 * No plan-limit enforcement at commit time: the drafts created here count
 * against the workflows_max limit only when the user later flips one to
 * 'live' (see PATCH /api/workflows/:id in src/index.ts — the limit gate is
 * status === 'live'). Drafts are free so users can iterate.
 *
 * Cap: 500KB JSON payload. Bigger paste = surface a 413 with a friendly
 * "split into smaller chunks" hint instead of OOM'ing the parser.
 */

import express from 'express'
import { SupabaseClient } from '@supabase/supabase-js'
import { apiError } from '../lib/api-error'
import { parseN8nJson, slugify, type ProposedWorkflow } from '../lib/n8n-import'

type Middleware = (req: express.Request, res: express.Response, next: express.NextFunction) => void | Promise<void>
type PermChecker = (feature: string, op: 'view' | 'edit' | 'delete') => Middleware

interface Deps {
  supabase:        SupabaseClient
  requireAuth:     Middleware
  identifyTenant:  Middleware
  checkPermission: PermChecker
}

const MAX_BYTES = 500 * 1024  // 500KB — guard against accidental paste of a huge n8n export

export function createN8nImportRouter(deps: Deps): express.Router {
  const r = express.Router()
  const { supabase, requireAuth, identifyTenant, checkPermission } = deps

  // ── Parse ──────────────────────────────────────────────────────────────
  // Body shape: { source_json: string }
  // Returns the full ParsedN8nImport so the FE can render the preview UI.
  r.post(
    '/api/workflows/import-n8n',
    express.json({ limit: '600kb' }),                  // a bit above the 500KB byte cap
    requireAuth, identifyTenant, checkPermission('whatsapp_automation', 'edit'),
    async (req, res) => {
      const raw = (req.body as any)?.source_json
      if (typeof raw !== 'string' || raw.length === 0) {
        return apiError(res, 400, 'invalid_body', 'source_json must be a non-empty string')
      }
      if (Buffer.byteLength(raw, 'utf8') > MAX_BYTES) {
        return apiError(res, 413, 'payload_too_large',
          `n8n JSON exceeds ${MAX_BYTES / 1024}KB — split the workflow into smaller chunks and import them separately`)
      }
      try {
        const parsed = parseN8nJson(raw)
        return res.json(parsed)
      } catch (e: any) {
        return apiError(res, 400, 'parse_failed', e?.message ?? 'Failed to parse n8n JSON')
      }
    },
  )

  // ── Commit ─────────────────────────────────────────────────────────────
  // Body shape: { proposed_workflows: ProposedWorkflow[] }
  // Inserts each as a DRAFT workflow row. Returns the created ids + names
  // + slugs so the FE can deep-link to /workflows and highlight the new ones.
  r.post(
    '/api/workflows/import-n8n/commit',
    express.json({ limit: '2mb' }),                    // generous — multi-trigger imports can be big
    requireAuth, identifyTenant, checkPermission('whatsapp_automation', 'edit'),
    async (req, res) => {
      const tenantId = (req as any).tenantId as string
      const userId   = (req as any).user?.id as string | undefined
      if (!userId) return apiError(res, 401, 'auth_required', 'auth.uid() missing')

      const proposals = (req.body as any)?.proposed_workflows as ProposedWorkflow[] | undefined
      if (!Array.isArray(proposals) || proposals.length === 0) {
        return apiError(res, 400, 'invalid_body', 'proposed_workflows must be a non-empty array')
      }
      if (proposals.length > 20) {
        return apiError(res, 400, 'too_many_workflows',
          'Refusing to import more than 20 workflows in one call. Split your n8n export and re-import.')
      }

      const created: Array<{ id: string; name: string; slug: string }> = []
      for (const p of proposals) {
        if (!p || typeof p.name !== 'string' || !Array.isArray(p.nodes_json)) continue
        // workflows.user_id is NOT NULL (migration 001) — always set it from
        // the authenticated session. Status defaults to 'draft' so plan
        // limits don't kick in until the user later flips to 'live'.
        const row = {
          tenant_id:   tenantId,
          user_id:     userId,
          name:        p.name.slice(0, 200),
          description: (p.description ?? '').slice(0, 2000),
          status:      'draft' as const,
          nodes:       p.nodes_json,
          // Reuse the existing `blueprint` jsonb column to carry import
          // metadata so a future "show me where this came from" surface can
          // light up without a schema change.
          blueprint: {
            source: 'n8n_import',
            imported_at: new Date().toISOString(),
            slug: slugify(p.slug || p.name),
            trigger_kind: p.trigger_kind,
            node_count: p.node_count,
          },
          intent_text: `Imported from n8n: ${p.name}`,
        }
        const { data, error } = await supabase
          .from('workflows')
          .insert(row)
          .select('id, name')
          .single()
        if (error) {
          // Don't fail the whole batch — report what we did + what failed.
          // (Common case: a workflow exceeds nodes-per-flow limits — the
          //  others should still import.)
          console.warn('[n8n-import] failed to insert workflow', p.name, error.message)
          continue
        }
        created.push({ id: data.id, name: data.name, slug: slugify(p.slug || p.name) })
      }

      if (created.length === 0) {
        return apiError(res, 500, 'commit_failed', 'No workflows could be created — check server logs.')
      }
      return res.json({ created })
    },
  )

  return r
}
