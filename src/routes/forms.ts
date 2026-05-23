/**
 * Forms router — Phase 1 of the Pages/Forms feature.
 *
 * Authed (tenant-scoped):
 *   GET    /api/forms                    — list forms in this tenant
 *   POST   /api/forms                    — create form (counts toward forms quota)
 *   GET    /api/forms/:id                — read a single form
 *   PATCH  /api/forms/:id                — update schema / settings / status
 *   DELETE /api/forms/:id                — soft delete (status='archived')
 *   POST   /api/forms/:id/publish        — flip to published (re-snapshots plan tier)
 *   POST   /api/forms/:id/unpublish      — flip back to draft
 *
 * Public (no auth, but rate-limited + plan-gated at submit):
 *   GET    /api/public/forms/:tenantSlug/:formSlug      — schema for render
 *   POST   /api/public/forms/:tenantSlug/:formSlug/submit — write submission +
 *                                                          dispatch post-save action
 *
 * Plan-gate enforcement lives in src/lib/form-quotas.ts. Keys off the
 * snapshot taken at publish (form_pages.published_plan_tier) so a tenant
 * downgrade mid-month doesn't tighten an already-live form. Quotas read
 * from plan_quotas table (migration 105) so caps adjust without deploy.
 */

import express from 'express'
import { z } from 'zod'
import crypto from 'crypto'
import { SupabaseClient } from '@supabase/supabase-js'
import rateLimit, { ipKeyGenerator } from 'express-rate-limit'
import { validateBody } from '../validation'
import { apiError } from '../lib/api-error'
import { messageQueue, enqueueWebhookOutbound, enqueueWorkflowExecution } from '../queue'

// ── Validators ──────────────────────────────────────────────────────────

const SlugSchema = z.string()
  .min(2).max(80)
  .regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/, 'lowercase letters, digits, hyphens; no leading/trailing hyphen')

const CreateFormSchema = z.object({
  slug:  SlugSchema,
  title: z.string().min(1).max(200),
})

const UpdateFormSchema = z.object({
  title:                    z.string().min(1).max(200).optional(),
  schema_json:              z.record(z.string(), z.any()).optional(),
  response_table_id:        z.string().uuid().nullable().optional(),
  response_mapping_id:      z.string().uuid().nullable().optional(),
  post_save_action_json:    z.record(z.string(), z.any()).optional(),
  branding_overrides_json:  z.record(z.string(), z.any()).optional(),
  settings_json:            z.record(z.string(), z.any()).optional(),
})

// Per-form-slug rate limit on the public submit endpoint: 10/min/IP.
// Cheap enough to defeat lazy spam without inconveniencing legit users.
// Pairs with the honeypot field check + plan-gate quota inside the
// handler. Heavy spam will get caught at one of these three layers.
const PUBLIC_SUBMIT_RATE = { windowMs: 60_000, max: 10 }

interface RouterDeps {
  supabase:         SupabaseClient
  requireAuth:      express.RequestHandler
  identifyTenant:   express.RequestHandler
  checkPermission:  (resource: string, action: string) => express.RequestHandler
}

export function createFormsRouter({ supabase, requireAuth, identifyTenant, checkPermission }: RouterDeps) {
  const r = express.Router()

  // ── AUTHED ENDPOINTS ──────────────────────────────────────────────────

  r.get('/api/forms', requireAuth, identifyTenant, async (req, res) => {
    const tenantId = (req as any).tenantId
    const { data, error } = await supabase
      .from('form_pages')
      .select('id, slug, title, status, published_at, response_table_id, created_at, updated_at')
      .eq('tenant_id', tenantId)
      .neq('status', 'archived')
      .order('updated_at', { ascending: false })
    if (error) { apiError(res, 500, 'list_failed', error.message); return }
    res.json({ forms: data ?? [] })
  })

  r.post('/api/forms', requireAuth, identifyTenant, checkPermission('settings', 'edit'),
    validateBody(CreateFormSchema), async (req, res) => {
      const tenantId = (req as any).tenantId
      const { slug, title } = req.body as z.infer<typeof CreateFormSchema>

      // Forms-per-tenant plan-gate check before insert. Uses the tenant's
      // CURRENT plan (not snapshot — only published forms care about the
      // snapshot for runtime stability).
      const quotaCheck = await checkFormsQuota(supabase, tenantId)
      if (!quotaCheck.ok) {
        apiError(res, 402, 'forms_quota_exceeded', quotaCheck.reason, { plan: quotaCheck.plan, max: quotaCheck.max })
        return
      }

      const { data, error } = await supabase.from('form_pages')
        .insert({
          tenant_id:   tenantId,
          slug,
          title,
          schema_json: { version: 1, widgets: [] },
        })
        .select('*')
        .single()
      if (error) {
        if ((error as any).code === '23505') {
          apiError(res, 409, 'slug_taken', `A form with slug "${slug}" already exists in this workspace.`)
          return
        }
        apiError(res, 500, 'create_failed', error.message)
        return
      }
      res.status(201).json({ form: data })
    })

  r.get('/api/forms/:id', requireAuth, identifyTenant, async (req, res) => {
    const tenantId = (req as any).tenantId
    const { data, error } = await supabase.from('form_pages')
      .select('*').eq('id', req.params.id).eq('tenant_id', tenantId).maybeSingle()
    if (error) { apiError(res, 500, 'read_failed', error.message); return }
    if (!data)  { apiError(res, 404, 'not_found', 'Form not found in this workspace.'); return }
    res.json({ form: data })
  })

  r.patch('/api/forms/:id', requireAuth, identifyTenant, checkPermission('settings', 'edit'),
    validateBody(UpdateFormSchema), async (req, res) => {
      const tenantId = (req as any).tenantId
      const patch = req.body as z.infer<typeof UpdateFormSchema>
      const { data, error } = await supabase.from('form_pages')
        .update(patch).eq('id', req.params.id).eq('tenant_id', tenantId)
        .select('*').maybeSingle()
      if (error) { apiError(res, 500, 'update_failed', error.message); return }
      if (!data)  { apiError(res, 404, 'not_found', 'Form not found in this workspace.'); return }
      res.json({ form: data })
    })

  r.delete('/api/forms/:id', requireAuth, identifyTenant, checkPermission('settings', 'edit'), async (req, res) => {
    const tenantId = (req as any).tenantId
    // Soft delete — flip to archived so submissions don't lose their FK,
    // and so we can restore on user request. Quota check counts only
    // non-archived rows.
    const { error } = await supabase.from('form_pages')
      .update({ status: 'archived' }).eq('id', req.params.id).eq('tenant_id', tenantId)
    if (error) { apiError(res, 500, 'archive_failed', error.message); return }
    res.json({ ok: true })
  })

  r.post('/api/forms/:id/publish', requireAuth, identifyTenant, checkPermission('settings', 'edit'), async (req, res) => {
    const tenantId = (req as any).tenantId
    // Snapshot the tenant's CURRENT plan tier onto the form so a downgrade
    // mid-month doesn't shrink an already-published form's caps.
    const plan = await resolveTenantPlan(supabase, tenantId)
    const { data, error } = await supabase.from('form_pages')
      .update({
        status:               'published',
        published_at:         new Date().toISOString(),
        published_plan_tier:  plan,
      })
      .eq('id', req.params.id).eq('tenant_id', tenantId)
      .select('*').maybeSingle()
    if (error) { apiError(res, 500, 'publish_failed', error.message); return }
    if (!data)  { apiError(res, 404, 'not_found', 'Form not found in this workspace.'); return }
    res.json({ form: data })
  })

  r.post('/api/forms/:id/unpublish', requireAuth, identifyTenant, checkPermission('settings', 'edit'), async (req, res) => {
    const tenantId = (req as any).tenantId
    const { data, error } = await supabase.from('form_pages')
      .update({ status: 'draft' }).eq('id', req.params.id).eq('tenant_id', tenantId)
      .select('*').maybeSingle()
    if (error) { apiError(res, 500, 'unpublish_failed', error.message); return }
    if (!data)  { apiError(res, 404, 'not_found', 'Form not found in this workspace.'); return }
    res.json({ form: data })
  })

  // ── PUBLIC ENDPOINTS ──────────────────────────────────────────────────
  // No auth — used by the public renderer at /f/:tenant/:slug. Reads only
  // published forms; rate-limited; honeypot + plan-gated on submit.

  r.get('/api/public/forms/:tenantSlug/:formSlug', async (req, res) => {
    const form = await loadPublishedForm(supabase, String(req.params.tenantSlug ?? ''), String(req.params.formSlug ?? ''))
    if (!form) { apiError(res, 404, 'not_found', 'Form not found or not published.'); return }
    // Public payload: schema + title + post-save success message only.
    // Never expose response_table_id / mapping / settings — those are
    // tenant-private even though the form itself is public.
    res.json({
      slug:    form.slug,
      title:   form.title,
      schema:  form.schema_json,
      // The branding the renderer needs to paint header/footer correctly.
      brand_kit: await loadBrandKit(supabase, form.tenant_id),
    })
  })

  const publicSubmitLimiter = rateLimit({
    windowMs: PUBLIC_SUBMIT_RATE.windowMs,
    max:      PUBLIC_SUBMIT_RATE.max,
    standardHeaders: true,
    legacyHeaders:   false,
    keyGenerator: (req) => {
      const ip = ipKeyGenerator(req.ip ?? 'unknown')
      // Per (ip, tenant-slug, form-slug) so a noisy form doesn't block
      // legit submits on a different form for the same tenant.
      return `${ip}:${req.params.tenantSlug}:${req.params.formSlug}`
    },
    handler: (_req, res) => {
      apiError(res, 429, 'rate_limited',
        'Too many submissions — please wait a moment before trying again.',
        { retry_after_seconds: Math.ceil(PUBLIC_SUBMIT_RATE.windowMs / 1000) })
    },
  })

  r.post('/api/public/forms/:tenantSlug/:formSlug/submit', publicSubmitLimiter, async (req, res) => {
    const form = await loadPublishedForm(supabase, String(req.params.tenantSlug ?? ''), String(req.params.formSlug ?? ''))
    if (!form) { apiError(res, 404, 'not_found', 'Form not found or not published.'); return }

    const body = req.body ?? {}

    // ── 1. Honeypot ─────────────────────────────────────────────────────
    // Form renderer adds a hidden CSS-display:none field called `_hp`. A
    // human leaves it empty; a dumb bot fills every field. If populated,
    // we return 200 to not tip the bot off but skip persisting.
    if (body._hp && String(body._hp).length > 0) {
      res.json({ ok: true, message: form.schema_json?.successMessage ?? 'Thanks!' })
      return
    }

    // ── 2. Quota: per-form + per-tenant monthly caps ────────────────────
    const quota = await checkSubmissionQuota(supabase, form)
    if (!quota.ok) {
      apiError(res, 402, 'collect_limit_reached',
        'This form has reached its collection limit. Please contact the form owner.',
        { reason: quota.reason })
      return
    }

    // ── 3. Validate response_data against the form schema ──────────────
    // Phase 1: trust the FE shape. We accept the body as-is but strip
    // honeypot + any keys not in the schema's field id list. Phase 2 will
    // run a per-field zod validator built from the schema.
    const fieldIds = new Set<string>()
    for (const w of (form.schema_json?.widgets ?? []) as any[]) {
      if (w?.kind === 'form' && Array.isArray(w.fields)) {
        for (const f of w.fields) if (f?.id) fieldIds.add(f.id)
      }
    }
    const responseData: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(body)) {
      if (k === '_hp') continue
      if (fieldIds.size === 0 || fieldIds.has(k)) responseData[k] = v
    }

    // ── 4. Insert audit row (always — survives Table INSERT failures) ──
    const ipHash = sha256(`${req.ip ?? 'unknown'}:${form.tenant_id}`)
    const { data: submission, error: subErr } = await supabase.from('form_submissions')
      .insert({
        form_id:       form.id,
        tenant_id:     form.tenant_id,
        ip_hash:       ipHash,
        user_agent:    req.get('user-agent') ?? null,
        referrer:      req.get('referer') ?? null,
        response_data: responseData,
        is_test:       body._test === true,
      })
      .select('id').single()
    if (subErr) { apiError(res, 500, 'submit_failed', subErr.message); return }

    // ── 5. Write to destination Table (if configured) ──────────────────
    let tableRowId: string | null = null
    if (form.response_table_id && Object.keys(responseData).length > 0) {
      // Apply the form-field-id → table-column-key mapping. Phase 1: if
      // no mapping is set, write the raw response_data JSONB into the
      // table's first jsonb column (if any) or skip silently.
      // Real mapping application moves into a helper in Phase 2.
      const mapped: Record<string, unknown> = { ...responseData }
      const { data: row, error: rowErr } = await supabase.from('lead_rows')
        .insert({ table_id: form.response_table_id, data: mapped, tenant_id: form.tenant_id })
        .select('id').single()
      if (rowErr) {
        await supabase.from('form_submissions')
          .update({ post_action_status: 'failed', post_action_error: `table_write: ${rowErr.message}` })
          .eq('id', submission.id)
      } else {
        tableRowId = row.id
        await supabase.from('form_submissions')
          .update({ table_row_id: tableRowId }).eq('id', submission.id)
      }
    }

    // ── 6. Dispatch post-save action (best-effort, queued) ──────────────
    // Each action kind enqueues onto the existing per-channel queue. Errors
    // are caught + recorded on form_submissions.post_action_error so we
    // can debug without blocking the visitor's success response.
    const action = form.post_save_action_json as any
    let actionStatus: 'pending' | 'dispatched' | 'failed' | 'none' = 'none'
    let actionError: string | null = null

    try {
      if (action?.kind === 'whatsapp_template') {
        const to = String(responseData[action.to_field_id] ?? '').replace(/^\+/, '')
        if (to) {
          const ordered: string[] = []
          for (const [fieldId, varIndex] of Object.entries(action.variable_map ?? {}) as [string, string][]) {
            ordered[Number(varIndex) - 1] = String(responseData[fieldId] ?? '')
          }
          await messageQueue.add('send', {
            tenantId: form.tenant_id,
            to,
            channel: 'whatsapp',
            kind:    'template',
            template: {
              name:       action.template_name,
              language:   action.template_language || 'en',
              parameters: ordered.filter(v => v !== undefined),
            },
          })
          actionStatus = 'dispatched'
        }
      } else if (action?.kind === 'email') {
        // Subject + body templates may reference {{field_id}} placeholders
        // resolved against the submission's response_data. The destination
        // email is read from to_field_id.
        const to = String(responseData[action.to_field_id] ?? '').trim()
        if (to) {
          const subject = renderTemplate(action.subject_template ?? '', responseData)
          const body    = renderTemplate(action.body_template ?? '',    responseData)
          await messageQueue.add('send', {
            tenantId: form.tenant_id,
            to,
            channel: 'email',
            email: { to, subject, body, provider: 'auto' },
          })
          actionStatus = 'dispatched'
        }
      } else if (action?.kind === 'webhook') {
        // POST the submission to the configured URL. Body is the raw
        // response_data plus form context. HMAC-SHA256 signature header
        // when signing_secret is set so the receiver can verify origin.
        const payloadObj = {
          form_id:      form.id,
          tenant_id:    form.tenant_id,
          submitted_at: new Date().toISOString(),
          data:         responseData,
        }
        const body = JSON.stringify(payloadObj)
        const headers: Record<string, string> = { 'Content-Type': 'application/json' }
        if (action.signing_secret) {
          const sig = crypto.createHmac('sha256', action.signing_secret).update(body).digest('hex')
          headers['x-frequency-signature'] = `sha256=${sig}`
        }
        await enqueueWebhookOutbound({
          tenantId:  form.tenant_id,
          source:    'form_submit',
          url:       action.url,
          method:    'POST',
          headers,
          body,
        })
        actionStatus = 'dispatched'
      } else if (action?.kind === 'workflow') {
        // Phase 1 wiring: we fire the workflow but pass form values as
        // the reply.raw object. A future workflow primitive ("form input
        // trigger") will read directly from this payload.
        await enqueueWorkflowExecution({
          sessionId: form.tenant_id,  // tenant-scoped session, not user-bound
          nodeId:    action.workflow_id,
          reply: { text: '', raw: { source: 'form_submit', form_id: form.id, data: responseData } },
        })
        actionStatus = 'dispatched'
      }
    } catch (e: any) {
      actionStatus = 'failed'
      actionError  = `${action?.kind ?? 'unknown'}_dispatch: ${e?.message ?? e}`
    }

    if (actionStatus !== 'none') {
      await supabase.from('form_submissions')
        .update({ post_action_status: actionStatus, post_action_error: actionError })
        .eq('id', submission.id)
    }

    // ── 7. Return success ──────────────────────────────────────────────
    const successMessage = extractSuccessMessage(form.schema_json) ?? 'Thanks! Your submission was received.'
    res.json({ ok: true, message: successMessage })
  })

  return r
}

// ── Helpers ─────────────────────────────────────────────────────────────

function sha256(s: string): string {
  return crypto.createHash('sha256').update(s).digest('hex')
}

/**
 * Render a {{field_id}} template against a flat data dict. Missing keys
 * leave the placeholder in place (visible — easier to debug than silently
 * stripped). Doesn't try to parse complex expressions — that's by design;
 * post-save action templates should stay shallow.
 */
function renderTemplate(tpl: string, data: Record<string, unknown>): string {
  return tpl.replace(/\{\{([^}]+)\}\}/g, (_, key) => {
    const trimmed = String(key).trim()
    const value = data[trimmed]
    return value === undefined ? `{{${trimmed}}}` : String(value)
  })
}

function extractSuccessMessage(schema: any): string | null {
  for (const w of schema?.widgets ?? []) {
    if (w?.kind === 'form' && typeof w.success_message === 'string') return w.success_message
  }
  return null
}

async function loadPublishedForm(supabase: SupabaseClient, tenantSlug: string, formSlug: string) {
  // tenants.slug is the public-facing identifier. We resolve in one query
  // via a select-with-join so a 404 from either side falls through cleanly.
  const { data: tenant } = await supabase.from('tenants')
    .select('id').eq('slug', tenantSlug).maybeSingle()
  if (!tenant?.id) return null
  const { data: form } = await supabase.from('form_pages')
    .select('*').eq('tenant_id', tenant.id).eq('slug', formSlug).eq('status', 'published').maybeSingle()
  return form
}

async function loadBrandKit(supabase: SupabaseClient, tenantId: string) {
  const { data } = await supabase.from('tenant_brand_kit')
    .select('brand_name, logo_url, primary_color, font_family, contact_email, display_phone, address_json')
    .eq('tenant_id', tenantId).maybeSingle()
  if (data) return data
  // Fallback: pull defaults from the tenants row so first-time renders
  // aren't blank when the user hasn't opened the form builder yet.
  const { data: t } = await supabase.from('tenants')
    .select('business_name, display_phone, contact_email')
    .eq('id', tenantId).maybeSingle()
  return {
    brand_name:    t?.business_name ?? null,
    logo_url:      null,
    primary_color: '#10B981',
    font_family:   'Inter',
    contact_email: t?.contact_email ?? null,
    display_phone: t?.display_phone ?? null,
    address_json:  {},
  }
}

async function resolveTenantPlan(supabase: SupabaseClient, tenantId: string): Promise<string> {
  // Resolve the tenant's current plan tier via tenant_subscriptions →
  // plans.tier. Defaults to 'free' on no subscription or error so we never
  // accidentally let a free tenant create unlimited forms.
  const { data } = await supabase.from('tenant_subscriptions')
    .select('plans(tier)')
    .eq('tenant_id', tenantId).eq('status', 'active').limit(1).maybeSingle()
  const tier = (data as any)?.plans?.tier ?? 'free'
  return ['free','starter','growth','pro'].includes(tier) ? tier : 'free'
}

async function checkFormsQuota(
  supabase: SupabaseClient,
  tenantId: string,
): Promise<{ ok: true } | { ok: false; reason: string; plan: string; max: number | null }> {
  const plan = await resolveTenantPlan(supabase, tenantId)
  const { data: q } = await supabase.from('plan_quotas')
    .select('max_forms_per_tenant').eq('plan_tier', plan).maybeSingle()
  const max = (q as any)?.max_forms_per_tenant
  if (max == null) return { ok: true }  // unlimited
  const { count } = await supabase.from('form_pages')
    .select('*', { count: 'exact', head: true })
    .eq('tenant_id', tenantId).neq('status', 'archived')
  if ((count ?? 0) >= max) {
    return {
      ok:     false,
      plan,
      max,
      reason: `Your ${plan} plan allows ${max} active form${max === 1 ? '' : 's'}. Upgrade to add more.`,
    }
  }
  return { ok: true }
}

async function checkSubmissionQuota(
  supabase: SupabaseClient,
  form: any,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  // Keys off published_plan_tier (snapshot) so a tenant downgrade
  // mid-month doesn't tighten an already-live form's quota.
  const plan = form.published_plan_tier || 'free'
  const { data: q } = await supabase.from('plan_quotas')
    .select('max_subs_per_form_mo, max_subs_per_tenant_mo')
    .eq('plan_tier', plan).maybeSingle()
  if (!q) return { ok: true }

  // Month window: calendar month starting at IST 00:00. We compute the
  // window in IST then convert back to UTC for the query.
  const istMonthStartUtc = computeIstMonthStartUtc()

  const [formCount, tenantCount] = await Promise.all([
    supabase.from('form_submissions').select('*', { count: 'exact', head: true })
      .eq('form_id', form.id).gte('submitted_at', istMonthStartUtc).eq('is_test', false),
    supabase.from('form_submissions').select('*', { count: 'exact', head: true })
      .eq('tenant_id', form.tenant_id).gte('submitted_at', istMonthStartUtc).eq('is_test', false),
  ])

  if ((formCount.count ?? 0) >= (q as any).max_subs_per_form_mo) {
    // Pro plan: soft-accept and emit a sales-alert; other tiers hard-cut.
    if (plan === 'pro') return { ok: true }
    return { ok: false, reason: 'per_form_monthly_cap' }
  }
  if ((tenantCount.count ?? 0) >= (q as any).max_subs_per_tenant_mo) {
    if (plan === 'pro') return { ok: true }
    return { ok: false, reason: 'per_tenant_monthly_cap' }
  }
  return { ok: true }
}

function computeIstMonthStartUtc(): string {
  // IST = UTC+5:30. We want the most recent 1st-of-month at IST 00:00,
  // then return that instant in UTC ISO. Cheap math — no Intl dance.
  const nowMs   = Date.now()
  const istMs   = nowMs + 5.5 * 60 * 60 * 1000
  const ist     = new Date(istMs)
  const monthStartIstUtc = Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), 1, 0, 0, 0) - (5.5 * 60 * 60 * 1000)
  return new Date(monthStartIstUtc).toISOString()
}
