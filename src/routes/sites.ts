/**
 * Sites router — multi-page microsite product (migration 113).
 *
 * Authed (tenant-scoped):
 *   GET    /api/sites                                    — list sites
 *   POST   /api/sites                                    — create site (name + slug)
 *   GET    /api/sites/:siteId                            — site + pages summary
 *   PATCH  /api/sites/:siteId                            — name / slug / nav / theme / domain
 *   DELETE /api/sites/:siteId                            — archive
 *
 *   GET    /api/sites/:siteId/pages                      — list pages
 *   POST   /api/sites/:siteId/pages                      — create page
 *   GET    /api/sites/:siteId/pages/:pageId              — page detail
 *   PATCH  /api/sites/:siteId/pages/:pageId              — autosave schema / settings
 *   POST   /api/sites/:siteId/pages/:pageId/publish      — flip to published
 *   POST   /api/sites/:siteId/pages/:pageId/unpublish    — back to draft
 *   POST   /api/sites/:siteId/pages/:pageId/duplicate    — clone within site
 *   DELETE /api/sites/:siteId/pages/:pageId              — soft archive
 *   POST   /api/sites/:siteId/import-form/:formId        — promote a standalone
 *                                                          form_pages row into
 *                                                          a page of this site
 *
 * Public (no auth):
 *   GET    /api/public/sites/:tenantSlug/:siteSlug/:pageSlug?
 *       — page schema for the renderer. pageSlug optional → home_page_id.
 *
 * Submissions on Site pages reuse form_submissions / form_partial_submissions /
 * form_field_events — same table, with site_page_id populated instead of
 * form_id. The submit endpoint stays on the existing /api/public/forms/...
 * path for now; a follow-up will add the /api/public/sites/.../submit
 * sibling. (MVP: build, navigate, publish. Submission collection on
 * Site pages = next deploy.)
 *
 * No plan-gate enforcement at MVP (per product call) — migration 114 added
 * the columns so we can wire `if max_sites_per_tenant && existing >= cap
 * then 402` in a future patch.
 */

import express from 'express'
import crypto from 'crypto'
import { z } from 'zod'
import { SupabaseClient } from '@supabase/supabase-js'
import { validateBody } from '../validation'
import { apiError } from '../lib/api-error'

// ── Validators ──────────────────────────────────────────────────────────

const SlugSchema = z.string()
  .min(2).max(80)
  .regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/, 'lowercase letters, digits, hyphens; no leading/trailing hyphen')

const CreateSiteSchema = z.object({
  name: z.string().min(1).max(200),
  slug: SlugSchema,
})

const UpdateSiteSchema = z.object({
  name:          z.string().min(1).max(200).optional(),
  slug:          SlugSchema.optional(),
  custom_domain: z.string().min(3).max(253).nullable().optional(),
  nav_json:      z.any().optional(),
  theme_json:    z.any().optional(),
  home_page_id:  z.string().uuid().nullable().optional(),
})

const CreatePageSchema = z.object({
  title:    z.string().min(1).max(200),
  slug:     SlugSchema,
  is_home:  z.boolean().optional(),
})

const UpdatePageSchema = z.object({
  title:                    z.string().min(1).max(200).optional(),
  slug:                     SlugSchema.optional(),
  schema_json:              z.any().optional(),
  seo_json:                 z.any().optional(),
  post_save_action_json:    z.any().optional(),
  post_submit_action_json:  z.any().optional(),
  response_table_id:        z.string().uuid().nullable().optional(),
  is_home:                  z.boolean().optional(),
  sort_order:               z.number().int().optional(),
})

interface RouterDeps {
  supabase:       SupabaseClient
  requireAuth:    express.RequestHandler
  identifyTenant: express.RequestHandler
  checkPermission: (resource: string, action: 'view' | 'edit' | 'delete') => express.RequestHandler
}

// Guard handlers from receiving non-UUID URL params. Coverage probes and
// curl typos used to hit `.eq('id', ':siteId')` directly which Postgres
// rejects with "invalid input syntax for type uuid" — the BE then
// returned 500. With this middleware we 400 cleanly instead.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
function requireUuid(...keys: string[]): express.RequestHandler {
  return (req, res, next) => {
    for (const k of keys) {
      const v = (req.params as Record<string, string | undefined>)[k]
      if (!v || !UUID_RE.test(v)) {
        apiError(res, 400, 'invalid_id', `${k} must be a UUID.`)
        return
      }
    }
    next()
  }
}

export function createSitesRouter({
  supabase, requireAuth, identifyTenant, checkPermission,
}: RouterDeps): express.Router {
  const r = express.Router()

  // ── Sites CRUD ───────────────────────────────────────────────────────

  r.get('/api/sites', requireAuth, identifyTenant, async (req, res) => {
    const tenantId = (req as any).tenantId
    const { data, error } = await supabase
      .from('sites')
      .select('id, name, slug, status, custom_domain, home_page_id, published_at, created_at, updated_at')
      .eq('tenant_id', tenantId)
      .neq('status', 'archived')
      .order('updated_at', { ascending: false })
    if (error) { apiError(res, 500, 'list_failed', error.message); return }
    res.json({ sites: data ?? [] })
  })

  r.post('/api/sites', requireAuth, identifyTenant, checkPermission('settings', 'edit'),
    validateBody(CreateSiteSchema), async (req, res) => {
    const tenantId = (req as any).tenantId
    const { name, slug } = req.body as z.infer<typeof CreateSiteSchema>
    const { data, error } = await supabase
      .from('sites')
      .insert({ tenant_id: tenantId, name, slug })
      .select('*').single()
    if (error) {
      if ((error as any).code === '23505') {
        apiError(res, 409, 'slug_taken', `A site with slug "${slug}" already exists in this workspace.`)
        return
      }
      apiError(res, 500, 'create_failed', error.message); return
    }
    res.status(201).json({ site: data })
  })

  r.get('/api/sites/:siteId', requireAuth, identifyTenant, requireUuid('siteId'), async (req, res) => {
    const tenantId = (req as any).tenantId
    const [{ data: site, error: siteErr }, { data: pages, error: pagesErr }] = await Promise.all([
      supabase.from('sites').select('*').eq('id', req.params.siteId).eq('tenant_id', tenantId).maybeSingle(),
      supabase.from('site_pages')
        .select('id, slug, title, status, sort_order, is_home, published_at, created_at, updated_at')
        .eq('site_id', req.params.siteId)
        .eq('tenant_id', tenantId)
        .neq('status', 'archived')
        .order('sort_order', { ascending: true }),
    ])
    if (siteErr) { apiError(res, 500, 'read_failed', siteErr.message); return }
    if (!site)   { apiError(res, 404, 'not_found',  'Site not found.'); return }
    if (pagesErr) { apiError(res, 500, 'read_failed', pagesErr.message); return }
    res.json({ site, pages: pages ?? [] })
  })

  r.patch('/api/sites/:siteId', requireAuth, identifyTenant, requireUuid('siteId'), checkPermission('settings', 'edit'),
    validateBody(UpdateSiteSchema), async (req, res) => {
    const tenantId = (req as any).tenantId
    const patch = req.body as z.infer<typeof UpdateSiteSchema>
    // Empty patch = no-op. Supabase rejects .update({}) with "no columns
    // to update" which our handler used to bubble as 500. Treat as a
    // successful no-change instead — return the current row.
    if (Object.keys(patch).length === 0) {
      const { data: current, error: readErr } = await supabase
        .from('sites').select('*').eq('id', req.params.siteId).eq('tenant_id', tenantId).maybeSingle()
      if (readErr) { apiError(res, 500, 'read_failed', readErr.message); return }
      if (!current) { apiError(res, 404, 'not_found', 'Site not found.'); return }
      res.json({ site: current }); return
    }
    const { data, error } = await supabase
      .from('sites')
      .update(patch)
      .eq('id', req.params.siteId)
      .eq('tenant_id', tenantId)
      .select('*').single()
    if (error) {
      if ((error as any).code === '23505') {
        apiError(res, 409, 'slug_taken', 'Slug already in use in this workspace.'); return
      }
      if ((error as any).code === 'PGRST116') {
        apiError(res, 404, 'not_found', 'Site not found.'); return
      }
      apiError(res, 500, 'update_failed', error.message); return
    }
    res.json({ site: data })
  })

  r.delete('/api/sites/:siteId', requireAuth, identifyTenant, requireUuid('siteId'), checkPermission('settings', 'delete'), async (req, res) => {
    const tenantId = (req as any).tenantId
    const { error } = await supabase
      .from('sites')
      .update({ status: 'archived' })
      .eq('id', req.params.siteId)
      .eq('tenant_id', tenantId)
    if (error) { apiError(res, 500, 'delete_failed', error.message); return }
    res.json({ ok: true })
  })

  // ── Pages CRUD ───────────────────────────────────────────────────────

  r.get('/api/sites/:siteId/pages', requireAuth, identifyTenant, requireUuid('siteId'), async (req, res) => {
    const tenantId = (req as any).tenantId
    const { data, error } = await supabase
      .from('site_pages')
      .select('id, slug, title, status, sort_order, is_home, published_at, created_at, updated_at')
      .eq('site_id', req.params.siteId)
      .eq('tenant_id', tenantId)
      .neq('status', 'archived')
      .order('sort_order', { ascending: true })
    if (error) { apiError(res, 500, 'list_failed', error.message); return }
    res.json({ pages: data ?? [] })
  })

  r.post('/api/sites/:siteId/pages', requireAuth, identifyTenant, requireUuid('siteId'), checkPermission('settings', 'edit'),
    validateBody(CreatePageSchema), async (req, res) => {
    const tenantId = (req as any).tenantId
    const { title, slug, is_home } = req.body as z.infer<typeof CreatePageSchema>

    // Confirm the site exists + belongs to this tenant.
    const { data: site, error: siteErr } = await supabase
      .from('sites').select('id, home_page_id')
      .eq('id', req.params.siteId).eq('tenant_id', tenantId).maybeSingle()
    if (siteErr) { apiError(res, 500, 'read_failed', siteErr.message); return }
    if (!site)   { apiError(res, 404, 'not_found',  'Site not found.'); return }

    // First page in a site auto-promotes to home. After that, the user
    // has to flip is_home explicitly.
    const { count } = await supabase
      .from('site_pages').select('id', { count: 'exact', head: true })
      .eq('site_id', req.params.siteId).neq('status', 'archived')
    const isFirstPage = (count ?? 0) === 0
    const forceHome = isFirstPage || !!is_home

    const { data: page, error } = await supabase
      .from('site_pages')
      .insert({
        site_id:    req.params.siteId,
        tenant_id:  tenantId,
        title,
        slug,
        is_home:    forceHome,
        sort_order: (count ?? 0),
      })
      .select('*').single()
    if (error) {
      if ((error as any).code === '23505') {
        apiError(res, 409, 'slug_taken', `A page with slug "${slug}" already exists in this site.`); return
      }
      apiError(res, 500, 'create_failed', error.message); return
    }

    // If this page is home, demote any other home page + update sites.home_page_id.
    if (forceHome) {
      await supabase.from('site_pages')
        .update({ is_home: false })
        .eq('site_id', req.params.siteId)
        .neq('id', page.id)
        .eq('is_home', true)
      await supabase.from('sites')
        .update({ home_page_id: page.id })
        .eq('id', req.params.siteId)
    }
    res.status(201).json({ page })
  })

  r.get('/api/sites/:siteId/pages/:pageId', requireAuth, identifyTenant, requireUuid('siteId', 'pageId'), async (req, res) => {
    const tenantId = (req as any).tenantId
    const { data, error } = await supabase
      .from('site_pages')
      .select('*')
      .eq('id', req.params.pageId)
      .eq('site_id', req.params.siteId)
      .eq('tenant_id', tenantId)
      .maybeSingle()
    if (error) { apiError(res, 500, 'read_failed', error.message); return }
    if (!data)  { apiError(res, 404, 'not_found', 'Page not found.'); return }
    res.json({ page: data })
  })

  r.patch('/api/sites/:siteId/pages/:pageId', requireAuth, identifyTenant, requireUuid('siteId', 'pageId'), checkPermission('settings', 'edit'),
    validateBody(UpdatePageSchema), async (req, res) => {
    const tenantId = (req as any).tenantId
    const patch = { ...(req.body as z.infer<typeof UpdatePageSchema>) }
    // Strip the is_home toggle from the main patch — handled separately
    // so we can demote the previous home in the same transaction.
    const newIsHome = patch.is_home
    delete patch.is_home

    // Empty patch (after is_home strip) = no-op. Avoid the Supabase
    // "no columns to update" 500 — return the current row instead.
    if (Object.keys(patch).length === 0 && newIsHome === undefined) {
      const { data: current, error: readErr } = await supabase
        .from('site_pages').select('*')
        .eq('id', req.params.pageId).eq('site_id', req.params.siteId).eq('tenant_id', tenantId)
        .maybeSingle()
      if (readErr)   { apiError(res, 500, 'read_failed', readErr.message); return }
      if (!current)  { apiError(res, 404, 'not_found', 'Page not found.'); return }
      res.json({ page: current }); return
    }

    const { data: page, error } = await supabase
      .from('site_pages')
      .update(patch)
      .eq('id', req.params.pageId)
      .eq('site_id', req.params.siteId)
      .eq('tenant_id', tenantId)
      .select('*').single()
    if (error) {
      if ((error as any).code === '23505') {
        apiError(res, 409, 'slug_taken', 'Slug already in use in this site.'); return
      }
      if ((error as any).code === 'PGRST116') {
        apiError(res, 404, 'not_found', 'Page not found.'); return
      }
      apiError(res, 500, 'update_failed', error.message); return
    }

    if (newIsHome === true) {
      await supabase.from('site_pages')
        .update({ is_home: false })
        .eq('site_id', req.params.siteId)
        .neq('id', req.params.pageId)
        .eq('is_home', true)
      await supabase.from('site_pages')
        .update({ is_home: true })
        .eq('id', req.params.pageId)
      await supabase.from('sites')
        .update({ home_page_id: req.params.pageId })
        .eq('id', req.params.siteId)
    }

    res.json({ page })
  })

  r.post('/api/sites/:siteId/pages/:pageId/publish', requireAuth, identifyTenant, requireUuid('siteId', 'pageId'), checkPermission('settings', 'edit'),
    async (req, res) => {
    const tenantId = (req as any).tenantId
    const { data, error } = await supabase
      .from('site_pages')
      .update({ status: 'published', published_at: new Date().toISOString() })
      .eq('id', req.params.pageId)
      .eq('site_id', req.params.siteId)
      .eq('tenant_id', tenantId)
      .select('*').single()
    if (error) {
      // PGRST116 = no rows returned for .single(). Map to 404 instead of 500
      // — without this, hitting publish on a phantom page id used to crash
      // the coverage probe with "publish_failed: query returned 0 rows".
      if ((error as any).code === 'PGRST116') { apiError(res, 404, 'not_found', 'Page not found.'); return }
      apiError(res, 500, 'publish_failed', error.message); return
    }
    res.json({ page: data })
  })

  r.post('/api/sites/:siteId/pages/:pageId/unpublish', requireAuth, identifyTenant, requireUuid('siteId', 'pageId'), checkPermission('settings', 'edit'),
    async (req, res) => {
    const tenantId = (req as any).tenantId
    const { data, error } = await supabase
      .from('site_pages')
      .update({ status: 'draft' })
      .eq('id', req.params.pageId)
      .eq('site_id', req.params.siteId)
      .eq('tenant_id', tenantId)
      .select('*').single()
    if (error) {
      if ((error as any).code === 'PGRST116') { apiError(res, 404, 'not_found', 'Page not found.'); return }
      apiError(res, 500, 'unpublish_failed', error.message); return
    }
    res.json({ page: data })
  })

  r.post('/api/sites/:siteId/pages/:pageId/duplicate', requireAuth, identifyTenant, requireUuid('siteId', 'pageId'), checkPermission('settings', 'edit'),
    async (req, res) => {
    const tenantId = (req as any).tenantId
    const { data: src, error: srcErr } = await supabase
      .from('site_pages').select('*')
      .eq('id', req.params.pageId)
      .eq('site_id', req.params.siteId)
      .eq('tenant_id', tenantId)
      .maybeSingle()
    if (srcErr) { apiError(res, 500, 'read_failed', srcErr.message); return }
    if (!src)   { apiError(res, 404, 'not_found',  'Page not found.'); return }

    // Slug: append -copy, then -copy-2, etc. until we find a free one.
    const baseSlug = `${(src as any).slug}-copy`
    let slug = baseSlug
    let attempt = 1
    while (true) {
      const { data: collision } = await supabase.from('site_pages')
        .select('id').eq('site_id', req.params.siteId).eq('slug', slug).maybeSingle()
      if (!collision) break
      attempt++
      slug = `${baseSlug}-${attempt}`
      if (attempt > 99) { apiError(res, 500, 'slug_unavailable', 'Could not find a free slug.'); return }
    }

    const { count } = await supabase
      .from('site_pages').select('id', { count: 'exact', head: true })
      .eq('site_id', req.params.siteId).neq('status', 'archived')

    const { data: dup, error: dupErr } = await supabase.from('site_pages')
      .insert({
        site_id:                 req.params.siteId,
        tenant_id:               tenantId,
        title:                   `${(src as any).title} (copy)`,
        slug,
        schema_json:             (src as any).schema_json,
        seo_json:                (src as any).seo_json,
        post_save_action_json:   (src as any).post_save_action_json,
        post_submit_action_json: (src as any).post_submit_action_json,
        response_table_id:       (src as any).response_table_id,
        sort_order:              (count ?? 0),
        status:                  'draft',
        is_home:                 false,
      })
      .select('*').single()
    if (dupErr) { apiError(res, 500, 'duplicate_failed', dupErr.message); return }
    res.status(201).json({ page: dup })
  })

  r.delete('/api/sites/:siteId/pages/:pageId', requireAuth, identifyTenant, requireUuid('siteId', 'pageId'), checkPermission('settings', 'delete'),
    async (req, res) => {
    const tenantId = (req as any).tenantId
    const { error } = await supabase
      .from('site_pages')
      .update({ status: 'archived' })
      .eq('id', req.params.pageId)
      .eq('site_id', req.params.siteId)
      .eq('tenant_id', tenantId)
    if (error) { apiError(res, 500, 'delete_failed', error.message); return }
    res.json({ ok: true })
  })

  // ── Builder asset library ────────────────────────────────────────────
  // Used by the in-builder image picker. Lists tenant assets under
  // form-uploads/assets/<tenant_id>/ and mints signed upload URLs into
  // the same prefix. This is separate from the form-submission file
  // upload path (which scopes per-form + per-submission); these are
  // long-lived workspace assets reusable across pages.
  r.get('/api/builder/assets', requireAuth, identifyTenant, async (req, res) => {
    const tenantId = (req as any).tenantId
    const prefix = `assets/${tenantId}`
    // Storage.list returns the immediate children of the prefix. We sort
    // by created_at desc so the newest uploads land first in the picker.
    const { data, error } = await supabase.storage
      .from('form-uploads')
      .list(prefix, { limit: 200, sortBy: { column: 'created_at', order: 'desc' } })
    if (error) { apiError(res, 500, 'list_failed', error.message); return }
    const assets = (data ?? [])
      .filter(it => it.name && !it.name.startsWith('.'))
      .map(it => {
        const path = `${prefix}/${it.name}`
        const { data: pub } = supabase.storage.from('form-uploads').getPublicUrl(path)
        return {
          path,
          name:         it.name,
          public_url:   pub?.publicUrl ?? '',
          created_at:   (it as any).created_at ?? null,
          size:         (it.metadata as any)?.size ?? null,
          content_type: (it.metadata as any)?.mimetype ?? null,
        }
      })
    res.json({ assets })
  })

  // Mint a signed upload URL for a workspace-level image asset. The FE
  // generates a uuid client-side and PUTs the file bytes to the signed
  // URL; the resulting public URL is reusable across pages.
  r.post('/api/builder/asset-upload-url', requireAuth, identifyTenant,
    checkPermission('settings', 'edit'), async (req, res) => {
    const tenantId = (req as any).tenantId
    const { filename, content_type } = (req.body ?? {}) as { filename?: string; content_type?: string }
    if (!filename || filename.length > 200) {
      apiError(res, 400, 'invalid_filename', 'Filename required (≤200 chars).'); return
    }
    // Sanitize + prefix with a uuid so two uploads with the same filename
    // don't collide. Lives under assets/<tenant>/<uuid>-<name>.
    const safe = filename.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120)
    const uid  = crypto.randomUUID()
    const path = `assets/${tenantId}/${uid}-${safe}`
    const { data, error } = await supabase.storage
      .from('form-uploads')
      .createSignedUploadUrl(path)
    if (error || !data) {
      apiError(res, 500, 'upload_url_failed', error?.message ?? 'Could not mint upload URL'); return
    }
    const { data: pub } = supabase.storage.from('form-uploads').getPublicUrl(path)
    res.json({
      signed_url:   data.signedUrl,
      token:        data.token,
      path,
      public_url:   pub?.publicUrl ?? '',
      content_type,
    })
  })

  // ── Reorder pages within a site ──────────────────────────────────────
  // Accepts the full ordered list of page IDs and writes contiguous
  // sort_order values 0..N-1. The FE optimistically updates its local
  // state before calling so the drag handle feels instantaneous; this
  // endpoint just durably persists the order so a refresh restores it.
  // Idempotent — calling with the same order is a no-op.
  r.post('/api/sites/:siteId/pages/reorder', requireAuth, identifyTenant, requireUuid('siteId'),
    checkPermission('settings', 'edit'), async (req, res) => {
    const tenantId = (req as any).tenantId
    const { siteId } = req.params as { siteId: string }
    const ids = Array.isArray((req.body ?? {}).page_ids) ? ((req.body as any).page_ids as unknown[]) : null
    if (!ids || ids.some(x => typeof x !== 'string')) {
      apiError(res, 400, 'invalid_body', 'Expected { page_ids: string[] }'); return
    }
    // Guard: every supplied id must belong to this site + tenant.
    const { data: rows, error: readErr } = await supabase
      .from('site_pages')
      .select('id')
      .eq('site_id', siteId)
      .eq('tenant_id', tenantId)
      .neq('status', 'archived')
    if (readErr) { apiError(res, 500, 'read_failed', readErr.message); return }
    const validIds = new Set((rows ?? []).map(r => (r as any).id as string))
    for (const id of ids as string[]) {
      if (!validIds.has(id)) { apiError(res, 400, 'unknown_page', `Page "${id}" not in site.`); return }
    }
    // Write sort_order in one pass. Postgres doesn't have a batched
    // update API in Supabase JS so we issue parallel single-row updates.
    const results = await Promise.all((ids as string[]).map((id, idx) =>
      supabase.from('site_pages')
        .update({ sort_order: idx })
        .eq('id', id)
        .eq('site_id', siteId)
        .eq('tenant_id', tenantId)
    ))
    const firstErr = results.find(r => r.error)
    if (firstErr?.error) { apiError(res, 500, 'reorder_failed', firstErr.error.message); return }
    res.json({ ok: true, count: ids.length })
  })

  // ── Site page templates marketplace ──────────────────────────────────
  // Curated (+ tenant-published, future) templates that fork into a
  // Site as a new site_pages row.
  //
  //   GET  /api/site-page-templates                       — list / filter
  //   POST /api/sites/:siteId/pages/from-template/:tplId  — fork into site
  //
  // Mirror of the form_templates pattern from migration 110.

  r.get('/api/site-page-templates', requireAuth, async (req, res) => {
    let q = supabase.from('site_page_templates')
      .select('id, slug, title, description, category, is_curated, screenshot_url, fork_count, author_tenant_id, created_at')
      .order('is_curated', { ascending: false })
      .order('fork_count', { ascending: false })
      .order('created_at', { ascending: false })
      .limit(200)
    if (req.query.category && typeof req.query.category === 'string') {
      q = q.eq('category', req.query.category)
    }
    const { data, error } = await q
    if (error) { apiError(res, 500, 'list_failed', error.message); return }
    res.json({ templates: data ?? [] })
  })

  // Fork a template into a Site as a new page. Accepts optional title +
  // slug overrides so the user can name their fork at create time.
  r.post('/api/sites/:siteId/pages/from-template/:templateId',
    requireAuth, identifyTenant, requireUuid('siteId', 'templateId'), checkPermission('settings', 'edit'), async (req, res) => {
    const tenantId = (req as any).tenantId
    const { siteId, templateId } = req.params as { siteId: string; templateId: string }

    const [siteRes, tplRes] = await Promise.all([
      supabase.from('sites').select('id, tenant_id').eq('id', siteId).eq('tenant_id', tenantId).maybeSingle(),
      supabase.from('site_page_templates').select('*').eq('id', templateId).maybeSingle(),
    ])
    if (siteRes.error)  { apiError(res, 500, 'read_failed', siteRes.error.message); return }
    if (!siteRes.data)  { apiError(res, 404, 'not_found',  'Site not found.'); return }
    if (tplRes.error)   { apiError(res, 500, 'read_failed', tplRes.error.message); return }
    if (!tplRes.data)   { apiError(res, 404, 'not_found',  'Template not found.'); return }

    const tpl = tplRes.data as any
    const overrides = (req.body ?? {}) as { title?: string; slug?: string }
    const overrideTitle = typeof overrides.title === 'string' && overrides.title.trim()
      ? overrides.title.trim().slice(0, 200)
      : tpl.title
    const overrideSlug  = typeof overrides.slug === 'string' && overrides.slug.trim()
      ? overrides.slug.trim().toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 80)
      : `${tpl.slug}-${Date.now().toString(36).slice(-5)}`

    // First page in a fresh site auto-becomes home.
    const { count } = await supabase
      .from('site_pages').select('id', { count: 'exact', head: true })
      .eq('site_id', siteId).neq('status', 'archived')
    const isFirstPage = (count ?? 0) === 0

    const { data: page, error: insErr } = await supabase.from('site_pages').insert({
      site_id:     siteId,
      tenant_id:   tenantId,
      title:       overrideTitle,
      slug:        overrideSlug,
      schema_json: tpl.schema_json,
      sort_order:  (count ?? 0),
      is_home:     isFirstPage,
    }).select('*').single()
    if (insErr) {
      if ((insErr as any).code === '23505') {
        apiError(res, 409, 'slug_taken', `A page with slug "${overrideSlug}" already exists in this site.`)
        return
      }
      apiError(res, 500, 'fork_failed', insErr.message); return
    }

    if (isFirstPage) {
      await supabase.from('sites').update({ home_page_id: page.id }).eq('id', siteId)
    }

    // Bump fork_count for popularity ranking. Best-effort.
    try {
      await supabase.rpc('increment_site_page_template_fork_count', { p_template_id: templateId })
    } catch {
      await supabase.from('site_page_templates')
        .update({ fork_count: (tpl.fork_count ?? 0) + 1 })
        .eq('id', templateId)
    }

    res.status(201).json({ page })
  })

  // ── Import a standalone form into this Site as a page ────────────────
  // Lets a tenant keep their existing /forms list working AND optionally
  // promote a form into a Site without losing the schema. Sets is_home
  // false unless this is the first page in the site.
  r.post('/api/sites/:siteId/import-form/:formId', requireAuth, identifyTenant, requireUuid('siteId', 'formId'), checkPermission('settings', 'edit'),
    async (req, res) => {
    const tenantId = (req as any).tenantId

    const [siteRes, formRes] = await Promise.all([
      supabase.from('sites').select('id').eq('id', req.params.siteId).eq('tenant_id', tenantId).maybeSingle(),
      supabase.from('form_pages').select('*').eq('id', req.params.formId).eq('tenant_id', tenantId).maybeSingle(),
    ])
    if (siteRes.error)  { apiError(res, 500, 'read_failed', siteRes.error.message); return }
    if (!siteRes.data)  { apiError(res, 404, 'not_found',  'Site not found.'); return }
    if (formRes.error)  { apiError(res, 500, 'read_failed', formRes.error.message); return }
    if (!formRes.data)  { apiError(res, 404, 'not_found',  'Form not found.'); return }

    const form = formRes.data as any
    // Suffix the slug to avoid collisions with other pages in the site.
    let slug = form.slug
    const { data: clash } = await supabase.from('site_pages')
      .select('id').eq('site_id', req.params.siteId).eq('slug', slug).maybeSingle()
    if (clash) slug = `${form.slug}-${Date.now().toString(36).slice(-5)}`

    const { count } = await supabase
      .from('site_pages').select('id', { count: 'exact', head: true })
      .eq('site_id', req.params.siteId).neq('status', 'archived')
    const isFirstPage = (count ?? 0) === 0

    const { data: page, error } = await supabase.from('site_pages').insert({
      site_id:                 req.params.siteId,
      tenant_id:               tenantId,
      title:                   form.title,
      slug,
      schema_json:             form.schema_json,
      post_save_action_json:   form.post_save_action_json,
      post_submit_action_json: form.post_submit_action_json,
      response_table_id:       form.response_table_id,
      sort_order:              (count ?? 0),
      is_home:                 isFirstPage,
    }).select('*').single()
    if (error) { apiError(res, 500, 'import_failed', error.message); return }

    if (isFirstPage) {
      await supabase.from('sites').update({ home_page_id: page.id }).eq('id', req.params.siteId)
    }
    res.status(201).json({ page })
  })

  // ── Public renderer endpoint ─────────────────────────────────────────
  // pageSlug optional → resolves to sites.home_page_id, then falls back
  // to the lowest sort_order published page. Two explicit routes instead
  // of `:pageSlug?` because Express 5 / path-to-regexp v8 dropped the
  // legacy optional-suffix syntax — `?` now throws "Unexpected ? at index".
  const publicSiteHandler: express.RequestHandler = async (req, res) => {
    const { tenantSlug, siteSlug, pageSlug } = req.params as { tenantSlug: string; siteSlug: string; pageSlug?: string }

    // 1. Resolve tenant by slug.
    const { data: tenant, error: tErr } = await supabase
      .from('tenants').select('id').eq('slug', tenantSlug).maybeSingle()
    if (tErr || !tenant) { apiError(res, 404, 'not_found', 'Site not found.'); return }

    // 2. Resolve site within tenant.
    const { data: site, error: sErr } = await supabase
      .from('sites')
      .select('id, name, slug, status, home_page_id, nav_json, theme_json, custom_domain')
      .eq('tenant_id', (tenant as any).id)
      .eq('slug', siteSlug)
      .maybeSingle()
    if (sErr || !site) { apiError(res, 404, 'not_found', 'Site not found.'); return }
    // Site-level publish gate: only ARCHIVED sites block public reads.
    // Pages still need to be individually published (filtered below).
    // The original `status !== 'published'` check meant a brand-new site
    // returned 404 for every page until the tenant manually flipped the
    // site row to published — but the UI only exposes per-page publish,
    // not per-site. Net effect: every site rendered 404. Now we honour
    // page-level publishing as the source of truth, and the only thing
    // that hides a whole site publicly is explicit archival.
    if ((site as any).status === 'archived') { apiError(res, 404, 'not_found', 'Site not available.'); return }

    // 3. Resolve the page. Explicit slug wins; otherwise home_page_id;
    //    otherwise the lowest sort_order published page.
    let pageQuery = supabase.from('site_pages')
      .select('id, slug, title, schema_json, seo_json, status')
      .eq('site_id', (site as any).id)
      .eq('status', 'published')
    let pageRes
    if (pageSlug) {
      pageRes = await pageQuery.eq('slug', pageSlug).maybeSingle()
    } else if ((site as any).home_page_id) {
      pageRes = await pageQuery.eq('id', (site as any).home_page_id).maybeSingle()
    } else {
      pageRes = await pageQuery.order('sort_order', { ascending: true }).limit(1).maybeSingle()
    }
    if (pageRes.error) { apiError(res, 500, 'read_failed', pageRes.error.message); return }
    if (!pageRes.data) { apiError(res, 404, 'not_found',  'Page not found.'); return }

    // 4. Build a nav payload that's safe to ship to anon: just the labels
    //    + slugs of published sibling pages, never schema_json or status.
    const { data: navPages } = await supabase.from('site_pages')
      .select('id, slug, title, is_home, sort_order')
      .eq('site_id', (site as any).id)
      .eq('status', 'published')
      .order('sort_order', { ascending: true })

    // 5. Resolve any `form:<id>` cross-link tokens embedded in this page's
    //    schema so the public renderer can emit /f/:tenant/:formSlug
    //    hrefs without a second round-trip. Only forms that actually
    //    appear in the schema are returned; nothing else leaks.
    const formTokenIds = new Set<string>()
    const walk = (node: any): void => {
      if (!node) return
      if (typeof node === 'string' && node.startsWith('form:')) {
        formTokenIds.add(node.slice(5))
      } else if (Array.isArray(node)) {
        for (const v of node) walk(v)
      } else if (typeof node === 'object') {
        for (const v of Object.values(node)) walk(v)
      }
    }
    walk((pageRes.data as any)?.schema_json)
    let linkedForms: Array<{ id: string; slug: string; title: string }> = []
    if (formTokenIds.size > 0) {
      const { data: formRows } = await supabase.from('form_pages')
        .select('id, slug, title, status')
        .in('id', Array.from(formTokenIds))
        .eq('tenant_id', (tenant as any).id)
        .eq('status', 'published')
      linkedForms = (formRows ?? []).map((f: any) => ({ id: f.id, slug: f.slug, title: f.title }))
    }

    res.json({
      site: {
        name:          (site as any).name,
        slug:          (site as any).slug,
        nav_json:      (site as any).nav_json,
        theme_json:    (site as any).theme_json,
        custom_domain: (site as any).custom_domain,
      },
      page:         pageRes.data,
      siblings:     navPages ?? [],
      linked_forms: linkedForms,
    })
  }
  // Bind both URL shapes to the same handler — Express 5 requires the
  // explicit split because path-to-regexp v8 dropped `?`-suffix syntax.
  r.get('/api/public/sites/:tenantSlug/:siteSlug',           publicSiteHandler)
  r.get('/api/public/sites/:tenantSlug/:siteSlug/:pageSlug', publicSiteHandler)

  // ── Public submit endpoint for Site pages ────────────────────────────
  // Mirrors the essential bits of POST /api/public/forms/.../submit but
  // writes form_submissions with site_page_id populated (form_id null).
  // MVP scope — skips advanced features the legacy form endpoint has:
  //   • Razorpay payment verification (Site pages can't host a payment
  //     widget yet from a publish-quota standpoint; revisit when we wire
  //     plan gating to site_pages)
  //   • Signed-form PDF render enqueue (no published_plan_tier on
  //     site_pages yet to drive the signed_forms_allowed check)
  //   • Per-page monthly submission quota (no snapshot yet)
  // Honeypot + show_if pruning + table-row insert still happen — that's
  // the minimum bar for a form widget on a Site page to "work".
  r.post('/api/public/sites/:tenantSlug/:siteSlug/:pageSlug/submit', async (req, res) => {
    const { tenantSlug, siteSlug, pageSlug } = req.params as { tenantSlug: string; siteSlug: string; pageSlug: string }

    // 1. Resolve tenant → site → page.
    const { data: tenant } = await supabase.from('tenants').select('id').eq('slug', tenantSlug).maybeSingle()
    if (!tenant) { apiError(res, 404, 'not_found', 'Page not found.'); return }
    const { data: site } = await supabase.from('sites')
      .select('id, status, tenant_id').eq('tenant_id', (tenant as any).id).eq('slug', siteSlug).maybeSingle()
    if (!site)               { apiError(res, 404, 'not_found',     'Page not found.'); return }
    if ((site as any).status === 'archived') {
      apiError(res, 404, 'not_found', 'Site not available.'); return
    }
    const { data: page } = await supabase.from('site_pages')
      .select('id, status, schema_json, response_table_id, post_save_action_json, tenant_id')
      .eq('site_id', (site as any).id).eq('slug', pageSlug).maybeSingle()
    if (!page)                { apiError(res, 404, 'not_found',     'Page not found.'); return }
    if ((page as any).status !== 'published') {
      apiError(res, 404, 'not_found', 'Page not published.'); return
    }

    const body = (req.body ?? {}) as Record<string, unknown>

    // 2. Honeypot — same convention as /api/public/forms/.../submit.
    if (body._hp && String(body._hp).length > 0) {
      res.json({ ok: true, message: 'Thanks!' }); return
    }

    // 3. Strip control fields + filter by known field ids in the schema.
    const fieldIds = new Set<string>()
    const fieldById = new Map<string, any>()
    for (const w of ((page as any).schema_json?.widgets ?? []) as any[]) {
      if (w?.kind === 'form' && Array.isArray(w.fields)) {
        for (const f of w.fields) if (f?.id) { fieldIds.add(f.id); fieldById.set(f.id, f) }
      }
    }
    const responseData: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(body)) {
      if (k === '_hp' || k === '_utm' || k === '_test' || k === '_partial_token') continue
      if (fieldIds.size === 0 || fieldIds.has(k)) responseData[k] = v
    }

    // 4. show_if pruning — strip values for fields that should be hidden.
    for (const f of fieldById.values()) {
      if (!f?.show_if) continue
      const rule = f.show_if
      const left = String(responseData[rule.field_id] ?? '')
      let shown = true
      switch (rule.op) {
        case 'equals':       shown = left === String(rule.value ?? ''); break
        case 'not_equals':   shown = left !== String(rule.value ?? ''); break
        case 'in':           shown = Array.isArray(rule.value) && rule.value.includes(left); break
        case 'not_in':       shown = Array.isArray(rule.value) && !rule.value.includes(left); break
        case 'is_empty':     shown = left === ''; break
        case 'is_not_empty': shown = left !== ''; break
      }
      if (!shown) delete responseData[f.id]
    }

    // 5. Required + length / pattern checks (mirror of forms.ts §3a).
    const errors: Array<{ field_id: string; field_label: string; reason: string }> = []
    for (const f of fieldById.values()) {
      if (f?.show_if && !(f.id in responseData)) continue
      const val = responseData[f.id] == null ? '' : String(responseData[f.id])
      if (f.required && val.trim() === '') {
        errors.push({ field_id: f.id, field_label: f.label, reason: 'required' }); continue
      }
      if (val === '') continue
      if (['short_text','long_text','email','phone'].includes(f.kind)) {
        if (typeof f.min_length === 'number' && val.length < f.min_length) errors.push({ field_id: f.id, field_label: f.label, reason: `min_length:${f.min_length}` })
        if (typeof f.max_length === 'number' && val.length > f.max_length) errors.push({ field_id: f.id, field_label: f.label, reason: `max_length:${f.max_length}` })
        if (typeof f.pattern === 'string' && f.pattern.length > 0) {
          try { if (!new RegExp(f.pattern).test(val)) errors.push({ field_id: f.id, field_label: f.label, reason: f.pattern_error || 'pattern_mismatch' }) }
          catch { /* invalid regex in schema — skip */ }
        }
      }
    }
    if (errors.length > 0) {
      apiError(res, 422, 'validation_failed', `${errors.length} field${errors.length === 1 ? '' : 's'} failed validation.`, { errors })
      return
    }

    // 6. Insert submission row. site_page_id populated; form_id stays null.
    const ipHash = req.ip ? crypto.createHash('sha256').update(String(req.ip)).digest('hex') : null
    const { data: submission, error: subErr } = await supabase.from('form_submissions').insert({
      site_page_id:  (page as any).id,
      tenant_id:     (page as any).tenant_id,
      response_data: responseData,
      ip_hash:       ipHash,
      user_agent:    req.headers['user-agent']?.toString().slice(0, 500) ?? null,
      submitted_at:  new Date().toISOString(),
    }).select('id').single()
    if (subErr) { apiError(res, 500, 'submit_failed', subErr.message); return }

    // 7. Mirror into the destination lead_table (Step 2) if set. Best-effort.
    if ((page as any).response_table_id) {
      try {
        await supabase.from('lead_table_rows').insert({
          table_id: (page as any).response_table_id,
          tenant_id: (page as any).tenant_id,
          data: responseData,
        })
      } catch (e: any) {
        console.warn(`[sites] table mirror failed for submission ${submission?.id}: ${e?.message ?? e}`)
      }
    }

    res.json({ ok: true, submission_id: submission?.id ?? null })
  })

  return r
}
