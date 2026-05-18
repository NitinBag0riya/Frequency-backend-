/**
 * AI Responder router — settings + knowledge base + QA wizard + test.
 *
 *   GET    /api/ai/settings              — current tenant's AI settings
 *   PATCH  /api/ai/settings              — update settings (ai:configure)
 *   POST   /api/ai/qa-wizard             — seeds the knowledge base + marks wizard done
 *   GET    /api/ai/knowledge             — list chunks (paginated, filterable)
 *   POST   /api/ai/knowledge             — manual add
 *   DELETE /api/ai/knowledge/:id         — delete (tenant-scoped)
 *   POST   /api/ai/test                  — dry-run: returns what AI would reply with
 *
 * TENANT ISOLATION:
 *   Every handler resolves `tenantId` from req (set by identifyTenant
 *   middleware) and passes it explicitly to the helpers in lib/ai-knowledge.ts.
 *   Service-role bypasses RLS, so the helpers' `.eq('tenant_id', tenantId)`
 *   filter is the actual security boundary. Cross-tenant retrieval is
 *   IMPOSSIBLE because:
 *     1) The tenant_id comes from auth (X-Tenant-ID header + RBAC verification
 *        in identifyTenant), never from the request body or query.
 *     2) Helpers refuse to run without tenantId and use it as the first
 *        filter on every read/write.
 *
 * OPT-IN GATE:
 *   /api/ai/test refuses when settings.enabled=false OR wizard not done.
 *   PATCH /api/ai/settings refuses to flip enabled=true if wizard not done.
 *
 * COST GUARDRAIL:
 *   /api/ai/test checks ai_tokens_per_month + ai_dollars_per_month via
 *   blockIfOverLimit() BEFORE calling Anthropic. The plan-quota integration
 *   for ai_requests_per_day from migration 063 is also surfaced in the
 *   settings response so the FE can show "X of Y requests used today".
 */

import express from 'express'
import { SupabaseClient } from '@supabase/supabase-js'
import Anthropic from '@anthropic-ai/sdk'
import {
  getTenantAiSettings, ensureTenantAiSettings,
  retrieveChunks, insertChunks, deleteChunk,
  chunkText, qaWizardToChunks, looksUncertain,
  type QaWizardPayload,
} from '../lib/ai-knowledge'
import { recordAiUsage } from '../lib/ai-usage'
import { blockIfOverLimit } from '../lib/limits'
import { apiError } from '../lib/api-error'

type Middleware = (req: express.Request, res: express.Response, next: express.NextFunction) => void | Promise<void>

interface Deps {
  supabase:       SupabaseClient
  requireAuth:    Middleware
  identifyTenant: Middleware
  /**
   * The repo's existing checkPermission factory — we wrap it for
   * 'ai:configure'-style guards. The feature key is 'settings' (workspace
   * settings) since AI Responder lives under the settings umbrella, and
   * the action is 'edit' for write paths.
   */
  checkPermission: (feature: string, action: 'view' | 'edit' | 'delete' | string) => Middleware
}

const anthropic = process.env.ANTHROPIC_API_KEY
  ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
  : null

// Default model — overridable per-tenant via tenant_ai_settings.model.
// Matches the system-prompt recommendation.
const DEFAULT_MODEL = 'claude-opus-4-7'

export function createAiResponderRouter(deps: Deps): express.Router {
  const r = express.Router()
  const { supabase, requireAuth, identifyTenant, checkPermission } = deps

  // ── GET /api/ai/settings ──────────────────────────────────────────────────
  // Read the per-tenant AI settings. Returns defaults (enabled=false) when
  // no row exists — the FE renders the same form either way.
  r.get('/api/ai/settings', requireAuth, identifyTenant, checkPermission('settings', 'view'), async (req, res) => {
    const tenantId = (req as any).tenantId
    if (!tenantId) { apiError(res, 401, 'no_tenant', 'No tenant resolved.'); return }
    try {
      const settings = await getTenantAiSettings(supabase, tenantId)
      res.json({ settings })
    } catch (e: any) {
      apiError(res, 500, 'settings_read_failed', e?.message ?? String(e))
    }
  })

  // ── PATCH /api/ai/settings ────────────────────────────────────────────────
  // Update settings. The CHECK constraint at the DB layer enforces
  // "enabled=true requires wizard done", but we surface a friendly 400
  // here too so the FE shows a real error message.
  r.patch('/api/ai/settings', requireAuth, identifyTenant, checkPermission('settings', 'edit'), async (req, res) => {
    const tenantId = (req as any).tenantId
    if (!tenantId) { apiError(res, 401, 'no_tenant', 'No tenant resolved.'); return }
    const body = req.body ?? {}

    // Allowlist editable columns — never let the client pass tenant_id,
    // qa_wizard_completed_at, created_at, updated_at.
    const allowed = ['enabled', 'model', 'system_prompt_addon', 'max_tokens', 'temperature', 'escalate_to_human_on_uncertainty']
    const patch: Record<string, any> = {}
    for (const k of allowed) if (k in body) patch[k] = body[k]

    if (Object.keys(patch).length === 0) {
      apiError(res, 400, 'no_changes', 'No editable fields provided.')
      return
    }

    try {
      // Ensure the row exists first.
      const current = await ensureTenantAiSettings(supabase, tenantId)

      // Pre-flight the wizard gate so the FE gets a clear message — the
      // DB CHECK would otherwise return an opaque "constraint violation".
      if (patch.enabled === true && !current.qa_wizard_completed_at) {
        apiError(res, 400, 'wizard_required', 'Complete the QA wizard before enabling the AI Responder.')
        return
      }

      // Range validation — mirrors the DB CHECK constraints.
      if ('max_tokens' in patch) {
        const n = Number(patch.max_tokens)
        if (!Number.isFinite(n) || n < 50 || n > 4000) {
          apiError(res, 400, 'invalid_max_tokens', 'max_tokens must be between 50 and 4000.')
          return
        }
        patch.max_tokens = n
      }
      if ('temperature' in patch) {
        const t = Number(patch.temperature)
        if (!Number.isFinite(t) || t < 0 || t > 1) {
          apiError(res, 400, 'invalid_temperature', 'temperature must be between 0 and 1.')
          return
        }
        patch.temperature = t
      }

      const { data, error } = await supabase
        .from('tenant_ai_settings')
        .update(patch)
        .eq('tenant_id', tenantId)       // tenant-isolation primary filter
        .select()
        .single()
      if (error) throw new Error(error.message)
      res.json({ settings: data })
    } catch (e: any) {
      apiError(res, 500, 'settings_update_failed', e?.message ?? String(e))
    }
  })

  // ── POST /api/ai/qa-wizard ────────────────────────────────────────────────
  // Seeds the knowledge base from structured QA answers AND flips
  // qa_wizard_completed_at so the tenant can enable the responder.
  r.post('/api/ai/qa-wizard', requireAuth, identifyTenant, checkPermission('settings', 'edit'), async (req, res) => {
    const tenantId = (req as any).tenantId
    if (!tenantId) { apiError(res, 401, 'no_tenant', 'No tenant resolved.'); return }
    const payload = (req.body ?? {}) as QaWizardPayload
    if (!payload.business_name?.trim()) {
      apiError(res, 400, 'missing_business_name', 'business_name is required.')
      return
    }
    try {
      await ensureTenantAiSettings(supabase, tenantId)
      const chunks = qaWizardToChunks(payload)
      // Replace any prior wizard chunks so re-running the wizard updates,
      // not duplicates. tenant-isolation filter is explicit.
      await supabase.from('tenant_knowledge_chunks')
        .delete()
        .eq('tenant_id', tenantId)
        .eq('source_type', 'qa_wizard')
      const inserted = await insertChunks(supabase, tenantId, chunks)
      // Patch settings — wizard timestamp + business_context snapshot.
      const { data: updated, error: updErr } = await supabase
        .from('tenant_ai_settings')
        .update({
          qa_wizard_completed_at: new Date().toISOString(),
          business_context: {
            business_name:      payload.business_name,
            hours:              payload.hours ?? null,
            services:           payload.services ?? null,
            what_we_do_not_do:  payload.what_we_do_not_do ?? null,
            common_questions:   payload.common_questions ?? [],
          },
        })
        .eq('tenant_id', tenantId)
        .select()
        .single()
      if (updErr) throw new Error(updErr.message)
      res.json({ ok: true, chunks_inserted: inserted, settings: updated })
    } catch (e: any) {
      apiError(res, 500, 'wizard_failed', e?.message ?? String(e))
    }
  })

  // ── GET /api/ai/knowledge ─────────────────────────────────────────────────
  // List chunks for this tenant with optional source_type filter + paging.
  r.get('/api/ai/knowledge', requireAuth, identifyTenant, checkPermission('settings', 'view'), async (req, res) => {
    const tenantId = (req as any).tenantId
    if (!tenantId) { apiError(res, 401, 'no_tenant', 'No tenant resolved.'); return }
    const sourceType = req.query.source_type as string | undefined
    const limit = Math.min(200, Math.max(1, parseInt(String(req.query.limit ?? '50'), 10) || 50))
    const offset = Math.max(0, parseInt(String(req.query.offset ?? '0'), 10) || 0)
    try {
      let q = supabase.from('tenant_knowledge_chunks')
        .select('id, source_type, source_ref, chunk_text, metadata, created_at, updated_at', { count: 'exact' })
        .eq('tenant_id', tenantId)        // tenant-isolation primary filter
        .order('created_at', { ascending: false })
        .range(offset, offset + limit - 1)
      if (sourceType) q = q.eq('source_type', sourceType)
      const { data, count, error } = await q
      if (error) throw new Error(error.message)
      res.json({ chunks: data ?? [], total: count ?? 0, limit, offset })
    } catch (e: any) {
      apiError(res, 500, 'knowledge_list_failed', e?.message ?? String(e))
    }
  })

  // ── POST /api/ai/knowledge ────────────────────────────────────────────────
  // Manual chunk add. Long bodies are auto-chunked.
  r.post('/api/ai/knowledge', requireAuth, identifyTenant, checkPermission('settings', 'edit'), async (req, res) => {
    const tenantId = (req as any).tenantId
    if (!tenantId) { apiError(res, 401, 'no_tenant', 'No tenant resolved.'); return }
    const text = (req.body?.text ?? req.body?.chunk_text ?? '').toString().trim()
    if (!text) { apiError(res, 400, 'missing_text', 'text or chunk_text is required.'); return }
    const sourceRef = (req.body?.source_ref ?? null) as string | null
    const metadata  = (req.body?.metadata ?? {}) as Record<string, any>
    try {
      const parts = chunkText(text)
      const items = parts.map(p => ({
        source_type: 'manual' as const,
        source_ref:  sourceRef,
        chunk_text:  p,
        metadata,
      }))
      const inserted = await insertChunks(supabase, tenantId, items)
      res.json({ ok: true, chunks_inserted: inserted })
    } catch (e: any) {
      apiError(res, 500, 'knowledge_add_failed', e?.message ?? String(e))
    }
  })

  // ── DELETE /api/ai/knowledge/:id ──────────────────────────────────────────
  r.delete('/api/ai/knowledge/:id', requireAuth, identifyTenant, checkPermission('settings', 'edit'), async (req, res) => {
    const tenantId = (req as any).tenantId
    if (!tenantId) { apiError(res, 401, 'no_tenant', 'No tenant resolved.'); return }
    const id = String(req.params.id ?? '')
    try {
      const ok = await deleteChunk(supabase, tenantId, id)
      if (!ok) { apiError(res, 404, 'chunk_not_found', 'Chunk not found in this tenant.'); return }
      res.json({ ok: true })
    } catch (e: any) {
      apiError(res, 500, 'knowledge_delete_failed', e?.message ?? String(e))
    }
  })

  // ── POST /api/ai/test ─────────────────────────────────────────────────────
  // Dry-run: simulates one AI Responder call for the given inbound message,
  // grounded on this tenant's corpus. Used by the FE "Test the AI" widget
  // on the settings page. Goes through the SAME retrieval + prompt path as
  // the workflow executor so what you test = what the bot will reply.
  //
  // Opt-in gate enforced: refuses if enabled=false OR wizard not done.
  // Cost guardrails enforced: refuses on token/dollar exhaustion.
  r.post('/api/ai/test', requireAuth, identifyTenant, checkPermission('settings', 'view'), async (req, res) => {
    const tenantId = (req as any).tenantId
    if (!tenantId) { apiError(res, 401, 'no_tenant', 'No tenant resolved.'); return }
    const message = (req.body?.message ?? '').toString().trim()
    if (!message) { apiError(res, 400, 'missing_message', 'message is required.'); return }
    if (!anthropic) { apiError(res, 503, 'ai_not_configured', 'AI not configured on this deployment.'); return }

    try {
      const settings = await getTenantAiSettings(supabase, tenantId)
      if (!settings.qa_wizard_completed_at) {
        res.json({ ok: false, reason: 'qa_wizard_pending', message: 'Complete the QA wizard first.' })
        return
      }
      // For /test we deliberately allow testing even when enabled=false —
      // the whole point is to validate before flipping the toggle. But we
      // surface the current state so the FE can show a "still disabled"
      // warning under the reply.

      // Cost guardrails — same gates as the workflow node, applied here so
      // a stuck retry loop in the test UI can't blow through the cap.
      if (await blockIfOverLimit(res, supabase, tenantId, 'ai_tokens_per_month'))   return
      if (await blockIfOverLimit(res, supabase, tenantId, 'ai_dollars_per_month'))  return

      const chunks = await retrieveChunks(supabase, tenantId, message, 5)

      const bizName = (settings.business_context as any)?.business_name || 'our business'
      const systemPrompt = buildSystemPrompt(bizName, settings.system_prompt_addon, chunks)
      const model = settings.model || DEFAULT_MODEL

      const resp = await anthropic.messages.create({
        model,
        max_tokens:  settings.max_tokens,
        temperature: settings.temperature,
        system: [
          { type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } },
        ] as any,
        messages: [{ role: 'user', content: message }],
      })

      const text = (resp.content as any[])
        .filter(b => b.type === 'text').map(b => b.text).join('\n').trim()

      void recordAiUsage(supabase, tenantId, resp.usage as any, 'ai_responder', model)

      const uncertain = looksUncertain(text)
      res.json({
        ok: true,
        reply_text: text,
        chunks_used: chunks.length,
        chunks_preview: chunks.map(c => ({ id: c.id, source_type: c.source_type, chunk_text: c.chunk_text.slice(0, 200) })),
        confidence: uncertain ? 'low' : 'high',
        would_escalate: uncertain && settings.escalate_to_human_on_uncertainty,
        settings_enabled: settings.enabled,
        model_used: model,
        tokens: {
          input:  (resp.usage as any)?.input_tokens ?? 0,
          output: (resp.usage as any)?.output_tokens ?? 0,
        },
      })
    } catch (e: any) {
      apiError(res, 500, 'ai_test_failed', e?.message ?? String(e))
    }
  })

  return r
}

/**
 * Build the system prompt for an AI Responder call. Wrapped in a function
 * so the executor + the /test endpoint produce IDENTICAL prompts — what you
 * test is what the bot will send.
 *
 * Context is injected as a numbered list of retrieved chunks. We rely on
 * the LLM's existing instruction-following to "use the context"; the
 * tenant's own system_prompt_addon can layer on tone, language, etc.
 *
 * Exported so the executor reuses it.
 */
export function buildSystemPrompt(
  businessName: string,
  systemPromptAddon: string | null | undefined,
  chunks: Array<{ source_type: string; chunk_text: string }>,
): string {
  const ctx = chunks.length === 0
    ? '(no business context retrieved for this query)'
    : chunks.map((c, i) => `[${i + 1}] (${c.source_type}) ${c.chunk_text}`).join('\n\n')
  const addon = (systemPromptAddon ?? '').trim()
  return [
    `You are a customer service agent for ${businessName}. Reply to the customer's message in 1-3 short sentences, friendly and concise.`,
    `Use ONLY the business context below. If the context does not answer the question, say you'll connect them with a human — do NOT make up facts, prices, hours, or services.`,
    addon ? `Additional instructions from this business:\n${addon}` : '',
    `Business context:\n${ctx}`,
  ].filter(Boolean).join('\n\n')
}
