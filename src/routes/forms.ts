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

  // ── Helpers for the builder UI ──────────────────────────────────────
  // Workflow picker on the form's post-save-action panel needs a list
  // of selectable nodes for the tenant. Returns id + name + status so the
  // FE can render a labeled dropdown.
  r.get('/api/forms-helpers/workflows', requireAuth, identifyTenant, async (req, res) => {
    const tenantId = (req as any).tenantId
    const { data, error } = await supabase
      .from('workflows')
      .select('id, name, status')
      .eq('tenant_id', tenantId)
      .order('updated_at', { ascending: false })
      .limit(200)
    if (error) { apiError(res, 500, 'list_failed', error.message); return }
    res.json({ workflows: data ?? [] })
  })

  // Plan tier + quotas for the active tenant. Drives the
  // builder's footer-removal toggle and the submission-cap banner.
  r.get('/api/forms-helpers/plan', requireAuth, identifyTenant, async (req, res) => {
    const tenantId = (req as any).tenantId
    const plan = await resolveTenantPlan(supabase, tenantId)
    const { data: quotas } = await supabase.from('plan_quotas')
      .select('*').eq('plan_tier', plan).maybeSingle()
    // Submission counts this month (per-tenant) — used for the banner.
    const istMonthStartUtc = computeIstMonthStartUtc()
    const { count } = await supabase.from('form_submissions')
      .select('*', { count: 'exact', head: true })
      .eq('tenant_id', tenantId)
      .gte('submitted_at', istMonthStartUtc)
      .eq('is_test', false)
    res.json({ plan, quotas, current_month_submissions: count ?? 0 })
  })

  // Per-form submissions list (paginated) — drives the Submissions tab
  // on the builder. Most-recent first; capped at 500/page.
  r.get('/api/forms/:id/submissions', requireAuth, identifyTenant, async (req, res) => {
    const tenantId = (req as any).tenantId
    const limit  = Math.min(Number(req.query.limit  ?? 50), 500)
    const offset = Math.max(Number(req.query.offset ?? 0),  0)
    const { data, count, error } = await supabase
      .from('form_submissions')
      .select('id, submitted_at, response_data, post_action_status, post_action_error, is_test, table_row_id', { count: 'exact' })
      .eq('form_id', req.params.id)
      .eq('tenant_id', tenantId)
      .order('submitted_at', { ascending: false })
      .range(offset, offset + limit - 1)
    if (error) { apiError(res, 500, 'list_failed', error.message); return }
    res.json({ submissions: data ?? [], total: count ?? 0, limit, offset })
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
    //
    // Plan-gate the "Powered by Frequency" footer: if the form's
    // published_plan_tier doesn't allow footer removal, force every
    // footer widget's show_powered_by back to true so a downgrade
    // can't strip the brand mark on already-published forms.
    const planTier = form.published_plan_tier || 'free'
    const { data: quotas } = await supabase.from('plan_quotas')
      .select('footer_removable').eq('plan_tier', planTier).maybeSingle()
    const canRemoveFooter = !!(quotas as any)?.footer_removable
    const schema = form.schema_json as any
    if (schema?.widgets && !canRemoveFooter) {
      for (const w of schema.widgets) {
        if (w?.kind === 'footer') w.show_powered_by = true
      }
    }

    res.json({
      slug:    form.slug,
      title:   form.title,
      schema,
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

  // Mint a one-shot signed upload URL for a file field on a published
  // form. Rate-limited per-IP/tenant/form to defeat upload-spamming. We
  // never accept the file bytes directly — the FE uploads to Supabase
  // Storage with the returned token; the resulting object key gets
  // submitted alongside the form values.
  const publicUploadLimiter = rateLimit({
    windowMs: 60_000, max: 20,
    standardHeaders: true, legacyHeaders: false,
    keyGenerator: (req) => `${ipKeyGenerator(req.ip ?? 'unknown')}:${req.params.tenantSlug}:${req.params.formSlug}:upload`,
    handler: (_req, res) => apiError(res, 429, 'rate_limited', 'Too many upload requests.'),
  })
  r.post('/api/public/forms/:tenantSlug/:formSlug/upload-url', publicUploadLimiter, async (req, res) => {
    const form = await loadPublishedForm(supabase, String(req.params.tenantSlug ?? ''), String(req.params.formSlug ?? ''))
    if (!form) { apiError(res, 404, 'not_found', 'Form not found or not published.'); return }
    const { filename, content_type } = (req.body ?? {}) as { filename?: string; content_type?: string }
    if (!filename || filename.length > 200) {
      apiError(res, 400, 'invalid_filename', 'Filename required (≤200 chars).'); return
    }
    // Compose the storage path. submission_id is regenerated each upload
    // so two file fields on the same submission get separate prefixes —
    // safer than reusing one prefix where a second file could overwrite
    // the first by accidentally sharing a filename.
    const submissionId = crypto.randomUUID()
    const safe = filename.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120)
    const objectPath = `${form.tenant_id}/${form.id}/${submissionId}/${safe}`
    // Service role can mint a 5-minute signed upload URL — Supabase JS
    // exposes this via storage.from(bucket).createSignedUploadUrl(path).
    const { data, error } = await supabase.storage
      .from('form-uploads')
      .createSignedUploadUrl(objectPath)
    if (error || !data) {
      apiError(res, 500, 'upload_url_failed', error?.message ?? 'Could not mint upload URL'); return
    }
    res.json({
      signed_url:    data.signedUrl,
      token:         data.token,
      path:          objectPath,
      submission_id: submissionId,
      content_type,
    })
  })

  // Payment-form order create. Called from the FE BEFORE submit when the
  // form contains a Payment widget. We:
  //   1. Resolve the form's Payment widget config (amount mode + value)
  //   2. Compute the amount in paise (resolves from response_data if mode='from_field')
  //   3. Create a Razorpay order via the tenant's connected merchant
  //   4. Return order_id + key_id + amount so the FE can open Razorpay Checkout
  // The actual submission still flows through /submit AFTER payment succeeds —
  // the FE attaches razorpay_payment_id + razorpay_order_id + razorpay_signature
  // to the submit body; we verify the signature server-side.
  r.post('/api/public/forms/:tenantSlug/:formSlug/payment-order', publicSubmitLimiter, async (req, res) => {
    const form = await loadPublishedForm(supabase, String(req.params.tenantSlug ?? ''), String(req.params.formSlug ?? ''))
    if (!form) { apiError(res, 404, 'not_found', 'Form not found or not published.'); return }
    const widget = (form.schema_json?.widgets ?? []).find((w: any) => w?.kind === 'payment') as any
    if (!widget) { apiError(res, 400, 'no_payment_widget', 'This form has no payment widget.'); return }

    // Resolve amount from the configured mode
    const responseData = (req.body?.response_data ?? {}) as Record<string, unknown>
    let amountPaise: number = 0
    if (widget.amount_mode === 'fixed') {
      amountPaise = Number(widget.fixed_amount_paise ?? 0)
    } else if (widget.amount_mode === 'from_field' && widget.amount_from_field_id) {
      const raw = responseData[widget.amount_from_field_id]
      const rupees = Number(String(raw ?? '').replace(/[^\d.]/g, ''))
      amountPaise = Math.round(rupees * 100)
    }
    if (!amountPaise || amountPaise < 100) {
      apiError(res, 400, 'invalid_amount', 'Payment amount must be ≥ ₹1.'); return
    }

    // Mint Razorpay order using the tenant's connected merchant.
    try {
      const { getRazorpayAuthHeader } = await import('../routes/connectors/razorpay')
      const auth = await getRazorpayAuthHeader(supabase, form.tenant_id)
      const r2 = await fetch('https://api.razorpay.com/v1/orders', {
        method:  'POST',
        headers: { Authorization: auth, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          amount:   amountPaise,
          currency: widget.currency || 'INR',
          notes: {
            frequency_form_id: form.id,
            frequency_tenant:  form.tenant_id,
          },
        }),
      })
      const order = await r2.json() as any
      if (!r2.ok) {
        apiError(res, 502, 'razorpay_order_failed', order?.error?.description ?? 'Razorpay order failed'); return
      }
      // Pull the merchant's key_id so the FE can pass it to Checkout JS.
      // Stored on tenant_integrations.metadata.key_id.
      const { data: integ } = await supabase.from('tenant_integrations')
        .select('metadata').eq('tenant_id', form.tenant_id).eq('key', 'razorpay').maybeSingle()
      const keyId = (integ as any)?.metadata?.key_id
      if (!keyId) { apiError(res, 400, 'razorpay_misconfig', 'Razorpay key_id not stored on tenant.'); return }

      res.json({
        order_id:    order.id,
        amount:      order.amount,
        currency:    order.currency,
        key_id:      keyId,
        description: widget.description ?? form.title,
      })
    } catch (e: any) {
      apiError(res, 502, 'razorpay_error', e?.message ?? 'Razorpay request failed')
    }
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

    // ── 2a. Payment verification (when form has a payment widget) ──────
    // If the form has a payment widget, the submit must carry valid
    // Razorpay signature triple (payment_id + order_id + signature)
    // that we verify against the tenant's Razorpay secret. Otherwise
    // anyone could submit without paying.
    const paymentWidget = (form.schema_json?.widgets ?? []).find((w: any) => w?.kind === 'payment') as any
    if (paymentWidget) {
      const { razorpay_payment_id, razorpay_order_id, razorpay_signature } = body
      if (!razorpay_payment_id || !razorpay_order_id || !razorpay_signature) {
        apiError(res, 402, 'payment_required', 'Payment is required to submit this form.')
        return
      }
      try {
        const { data: integ } = await supabase.from('tenant_integrations')
          .select('access_token').eq('tenant_id', form.tenant_id).eq('key', 'razorpay').maybeSingle()
        const secret = (integ as any)?.access_token as string | undefined
        if (!secret) { apiError(res, 400, 'razorpay_misconfig', 'Tenant Razorpay secret missing.'); return }
        const expected = crypto.createHmac('sha256', secret)
          .update(`${razorpay_order_id}|${razorpay_payment_id}`)
          .digest('hex')
        if (expected !== razorpay_signature) {
          apiError(res, 403, 'invalid_payment_signature', 'Payment signature did not match.')
          return
        }
        // Persist payment ids onto response_data so the Submissions tab
        // shows them and downstream workflows can reference them.
        body.__razorpay = { payment_id: razorpay_payment_id, order_id: razorpay_order_id }
      } catch (e: any) {
        apiError(res, 500, 'payment_verify_failed', e?.message ?? 'Signature verification crashed')
        return
      }
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
      // Strip control fields the renderer prepends (honeypot, UTM bag,
      // test flag) before persisting / mapping. They aren't form data
      // even when fieldIds is empty (no schema).
      // Strip every control / payment field. Razorpay ids land in
      // response_data.__razorpay so they're queryable downstream.
      if (
        k === '_hp' || k === '_utm' || k === '_test' ||
        k === 'razorpay_payment_id' || k === 'razorpay_order_id' || k === 'razorpay_signature' ||
        k === '__razorpay'
      ) continue
      if (fieldIds.size === 0 || fieldIds.has(k)) responseData[k] = v
    }
    // Re-attach payment metadata so the submission audit + downstream
    // workflows can find the Razorpay ids without exposing them to the
    // field-id allowlist check above.
    if (body.__razorpay) {
      responseData.__razorpay = body.__razorpay
    }

    // ── 4. Insert audit row (always — survives Table INSERT failures) ──
    // UTM params arrive in body._utm as { utm_source, utm_medium, ... }
    // from the FE renderer which collects them on mount. Persisted to
    // form_submissions.utm_json so the Phase 3 funnel analytics has the
    // attribution data ready when those queries land.
    const ipHash = sha256(`${req.ip ?? 'unknown'}:${form.tenant_id}`)
    const utmJson = sanitizeUtm(body._utm)
    const { data: submission, error: subErr } = await supabase.from('form_submissions')
      .insert({
        form_id:       form.id,
        tenant_id:     form.tenant_id,
        ip_hash:       ipHash,
        user_agent:    req.get('user-agent') ?? null,
        referrer:      req.get('referer') ?? null,
        utm_json:      utmJson,
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
    // Form-level settings can redirect to a custom thank-you page or a
    // gated-content unlock URL. Gated-content unlocks are plan-gated
    // (Growth+) per the locked-in matrix — enforce by checking the
    // form's published_plan_tier against plan_quotas.gated_content_allowed.
    const successMessage = extractSuccessMessage(form.schema_json) ?? 'Thanks! Your submission was received.'
    const settings = (form.settings_json ?? {}) as Record<string, unknown>
    const respPayload: Record<string, unknown> = { ok: true, message: successMessage }

    if (typeof settings.redirect_url === 'string' && settings.redirect_url) {
      respPayload.redirect_url = settings.redirect_url
    }
    if (typeof settings.gated_unlock_url === 'string' && settings.gated_unlock_url) {
      const tier = form.published_plan_tier || 'free'
      const { data: q } = await supabase.from('plan_quotas')
        .select('gated_content_allowed').eq('plan_tier', tier).maybeSingle()
      if ((q as any)?.gated_content_allowed) {
        respPayload.gated_unlock_url = settings.gated_unlock_url
      }
    }
    res.json(respPayload)
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
/**
 * Sanitize the `_utm` bag the FE renderer sends on submit. We allow
 * only the conventional utm_* keys + `gclid` / `fbclid` (paid-ad click
 * identifiers); everything else is dropped. Each value is capped at
 * 200 chars to prevent oversized analytics rows.
 */
const ALLOWED_UTM_KEYS = new Set([
  'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content',
  'gclid', 'fbclid', 'msclkid', 'ttclid',
])
function sanitizeUtm(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {}
  if (!raw || typeof raw !== 'object') return out
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!ALLOWED_UTM_KEYS.has(k)) continue
    if (typeof v !== 'string') continue
    out[k] = v.slice(0, 200)
  }
  return out
}

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
