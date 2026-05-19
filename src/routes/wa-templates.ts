/**
 * Template Approval Assistant — three endpoints that bolt onto the existing
 * WA Templates CRUD (which lives inline in src/index.ts). All three are
 * NEW routes — the original create / list / delete in index.ts is
 * untouched.
 *
 *   POST /api/wa-templates/policy-check
 *     Lints a draft body against Meta-policy rules (variable count,
 *     promotional words in UTILITY, phone numbers in body, etc.) and
 *     returns { checks: [...], can_submit }. Runs in <50ms with no
 *     network calls. Every call is appended to wa_template_policy_checks
 *     for the rejection-rate-over-time chart in the admin dashboard.
 *
 *   GET  /api/wa-templates/:name/explain-rejection
 *     For a REJECTED template, returns Meta's verbatim rejection_reason
 *     plus a plain-English translation + suggested edits. Read-through
 *     cached in wa_template_rejection_explanations for forward-looking
 *     LLM-assisted explanations (today: deterministic rule table).
 *
 *   POST /api/wa-templates/:name/resubmit-draft
 *     Takes a rejected template + applies conservative auto-edits derived
 *     from the rejection reason. Returns the NEW draft body for the user
 *     to review (side-by-side diff in the FE) before re-submitting. We
 *     never auto-submit — the user always reviews.
 *
 * Mounting: index.ts already serves /api/wa-templates (GET / POST /
 * DELETE) inline. This router adds the three /api/wa-templates/* sub-
 * paths above without colliding because Express matches exact paths and
 * none of the existing routes share these suffixes.
 */

import express from 'express'
import crypto from 'crypto'
import { SupabaseClient } from '@supabase/supabase-js'
import { runPolicyChecks, type PolicyCheckInput, type PolicyCategory } from '../lib/wa-template-policy'
import { explainRejection, applySuggestedEdits } from '../lib/wa-rejection-explainer'
import { apiError } from '../lib/api-error'

type Middleware = (req: express.Request, res: express.Response, next: express.NextFunction) => void | Promise<void>

interface Deps {
  supabase:        SupabaseClient
  requireAuth:     Middleware
  identifyTenant:  Middleware
  checkPermission: (feature: string, action: 'view' | 'edit' | 'delete') => Middleware
}

/** Hash Meta's rejection_reason for the cache lookup. Lowercased + trimmed
 *  so cosmetic whitespace differences don't multiply rows. */
function hashReason(reason: string): string {
  return crypto.createHash('sha256').update(reason.toLowerCase().trim()).digest('hex')
}

export function createWaTemplatesRouter(deps: Deps): express.Router {
  const r = express.Router()
  const { supabase, requireAuth, identifyTenant, checkPermission } = deps
  const guardView = [requireAuth, identifyTenant, checkPermission('whatsapp_automation', 'view')]
  const guardEdit = [requireAuth, identifyTenant, checkPermission('whatsapp_automation', 'edit')]

  // ── POST /api/wa-templates/policy-check ──────────────────────────────────
  //
  // Body: { template_name?, body, category, language?, buttons?, has_header?,
  //         has_footer? }
  //
  // Returns the policy-check result + the audit row id (so the FE can
  // correlate the next create call to this exact check for the "ignored
  // ERRORs → still rejected by Meta" tuning signal).
  r.post('/api/wa-templates/policy-check', ...guardEdit, async (req, res) => {
    const tenantId = (req as any).tenantId as string
    const userId   = (req as any).user?.id as string | undefined

    const body         = String(req.body?.body ?? '')
    const categoryRaw  = String(req.body?.category ?? 'MARKETING').toUpperCase()
    const language     = String(req.body?.language ?? 'en_US')
    const templateName = String(req.body?.template_name ?? '').slice(0, 512)
    const buttons      = Array.isArray(req.body?.buttons) ? req.body.buttons : []
    const has_header   = Boolean(req.body?.has_header)
    const has_footer   = Boolean(req.body?.has_footer)

    if (!['MARKETING', 'UTILITY', 'AUTHENTICATION'].includes(categoryRaw)) {
      apiError(res, 400, 'invalid_category', 'category must be MARKETING, UTILITY, or AUTHENTICATION')
      return
    }
    const category = categoryRaw as PolicyCategory

    // Guard rail — keep the audit table light. Templates over 8k bytes
    // would have already been rejected by Meta's 1024-char body cap so
    // this is purely a defence-in-depth check.
    if (body.length > 8000) {
      apiError(res, 400, 'body_too_long', 'body must be under 8000 characters')
      return
    }

    const input: PolicyCheckInput = {
      body,
      category,
      language,
      buttons,
      has_header,
      has_footer,
    }
    const result = runPolicyChecks(input)

    // Best-effort audit insert — never fail the user-visible response on
    // a logging miss. The wa_template_policy_checks RLS denies INSERT to
    // authenticated, so we go through the service_role supabase client
    // (which is what `deps.supabase` is).
    let auditId: string | null = null
    try {
      const { data, error } = await supabase
        .from('wa_template_policy_checks')
        .insert({
          tenant_id:       tenantId,
          template_name:   templateName || '(unnamed)',
          draft_body:      body,
          category:        category,
          language:        language,
          errors_count:    result.errors_count,
          warnings_count:  result.warnings_count,
          infos_count:     result.infos_count,
          submitted:       false,
          checked_by:      userId ?? null,
        })
        .select('id')
        .single()
      if (!error && data) auditId = (data as any).id ?? null
    } catch (e: any) {
      // Swallow — policy check itself succeeded; audit miss isn't fatal.
      console.warn('[wa-templates/policy-check] audit insert failed:', e?.message ?? e)
    }

    res.json({
      checks:         result.checks,
      can_submit:     result.can_submit,
      errors_count:   result.errors_count,
      warnings_count: result.warnings_count,
      infos_count:    result.infos_count,
      policy_check_id: auditId,
    })
  })

  // ── GET /api/wa-templates/:name/explain-rejection ────────────────────────
  //
  // Reads the tenant-scoped wa_templates row, looks up the cached
  // explanation if present, otherwise generates one fresh from the rule
  // table. Returns:
  //   { original_reason, plain_english, suggested_edits: [...], code }
  //
  // 404 if the template doesn't exist for this tenant.
  // 204 (treated as 200 with code='no_reason') if the template is not
  // REJECTED — the FE handles both cases (the CTA only renders for
  // REJECTED templates anyway).
  r.get('/api/wa-templates/:name/explain-rejection', ...guardView, async (req, res) => {
    const tenantId     = (req as any).tenantId as string
    const templateName = req.params.name

    const { data: tpl, error } = await supabase
      .from('wa_templates')
      .select('id, name, status, rejection_reason, category, body')
      .eq('tenant_id', tenantId)
      .eq('name', templateName)
      .maybeSingle()
    if (error) {
      apiError(res, 500, 'lookup_failed', error.message)
      return
    }
    if (!tpl) {
      apiError(res, 404, 'template_not_found', `Template "${templateName}" not found in this workspace`)
      return
    }

    const reason = (tpl as any).rejection_reason ?? ''
    if (!reason) {
      // Not rejected (or no reason yet). Still return a structured payload
      // so the FE doesn't need a separate handler.
      res.json({
        template_name:    templateName,
        status:           (tpl as any).status ?? null,
        original_reason:  '',
        plain_english:    'This template has no rejection reason on file. It may still be PENDING with Meta, or it was approved.',
        suggested_edits:  [],
        code:             'no_reason',
        from_cache:       false,
      })
      return
    }

    // Cache lookup first — see wa_template_rejection_explanations in
    // migration 082. Read is allowed to every authenticated user (the
    // reason text is Meta's global phrase, not tenant-scoped).
    const reasonHash = hashReason(reason)
    const { data: cached } = await supabase
      .from('wa_template_rejection_explanations')
      .select('plain_english, suggested_edits')
      .eq('reason_hash', reasonHash)
      .maybeSingle()

    if (cached) {
      res.json({
        template_name:    templateName,
        status:           (tpl as any).status ?? null,
        original_reason:  reason,
        plain_english:    (cached as any).plain_english,
        suggested_edits:  (cached as any).suggested_edits ?? [],
        code:             'cached',
        from_cache:       true,
      })
      return
    }

    // Generate fresh from rule table.
    const expl = explainRejection(reason)

    // Write-through cache (service_role only — authenticated has no
    // INSERT grant). Best-effort; we still return the explanation if the
    // cache write fails.
    try {
      await supabase
        .from('wa_template_rejection_explanations')
        .insert({
          reason_hash:     reasonHash,
          plain_english:   expl.plain_english,
          suggested_edits: expl.suggested_edits as any,
        })
    } catch {
      // Duplicate key (race condition with another tenant inserting the
      // same reason at the same time) is fine — the next read sees it.
    }

    res.json({
      template_name:    templateName,
      status:           (tpl as any).status ?? null,
      original_reason:  reason,
      plain_english:    expl.plain_english,
      suggested_edits:  expl.suggested_edits,
      code:             expl.code,
      from_cache:       false,
    })
  })

  // ── POST /api/wa-templates/:name/resubmit-draft ──────────────────────────
  //
  // For a REJECTED template, returns a NEW draft body (the user's body
  // with conservative edits applied based on the rejection reason). The
  // FE renders a side-by-side diff so the user reviews + tweaks before
  // hitting the existing POST /api/wa-templates create endpoint.
  //
  // Body (optional): { body: string }  — lets the FE pass a body that
  // differs from what's stored (e.g. the user already started editing).
  // If omitted, we use the stored body.
  //
  // Returns:
  //   { original_body, suggested_body, edits: [...], suggested_category? }
  r.post('/api/wa-templates/:name/resubmit-draft', ...guardEdit, async (req, res) => {
    const tenantId     = (req as any).tenantId as string
    const templateName = req.params.name

    const { data: tpl, error } = await supabase
      .from('wa_templates')
      .select('id, name, status, rejection_reason, category, body')
      .eq('tenant_id', tenantId)
      .eq('name', templateName)
      .maybeSingle()
    if (error) {
      apiError(res, 500, 'lookup_failed', error.message)
      return
    }
    if (!tpl) {
      apiError(res, 404, 'template_not_found', `Template "${templateName}" not found in this workspace`)
      return
    }

    const reason = (tpl as any).rejection_reason ?? ''
    if (!reason) {
      apiError(res, 400, 'no_rejection_reason', 'Template has no rejection reason. Resubmit drafts are only available for REJECTED templates.')
      return
    }

    const passedBody = typeof req.body?.body === 'string' ? req.body.body : null
    const originalBody = (passedBody ?? (tpl as any).body ?? '').toString()

    const expl = explainRejection(reason)
    const suggestedBody = applySuggestedEdits(originalBody, expl.suggested_edits)

    const suggestedCategory = expl.suggested_edits.find(e => e.kind === 'category_change')?.target_category ?? null

    res.json({
      template_name:       templateName,
      original_body:       originalBody,
      suggested_body:      suggestedBody,
      original_category:   (tpl as any).category ?? null,
      suggested_category:  suggestedCategory,
      rejection_reason:    reason,
      plain_english:       expl.plain_english,
      edits:               expl.suggested_edits,
      changed:             suggestedBody !== originalBody,
    })
  })

  return r
}
