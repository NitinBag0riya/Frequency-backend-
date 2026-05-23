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

  r.get('/api/sites/:siteId', requireAuth, identifyTenant, async (req, res) => {
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

  r.patch('/api/sites/:siteId', requireAuth, identifyTenant, checkPermission('settings', 'edit'),
    validateBody(UpdateSiteSchema), async (req, res) => {
    const tenantId = (req as any).tenantId
    const patch = req.body as z.infer<typeof UpdateSiteSchema>
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
      apiError(res, 500, 'update_failed', error.message); return
    }
    res.json({ site: data })
  })

  r.delete('/api/sites/:siteId', requireAuth, identifyTenant, checkPermission('settings', 'delete'), async (req, res) => {
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

  r.get('/api/sites/:siteId/pages', requireAuth, identifyTenant, async (req, res) => {
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

  r.post('/api/sites/:siteId/pages', requireAuth, identifyTenant, checkPermission('settings', 'edit'),
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

  r.get('/api/sites/:siteId/pages/:pageId', requireAuth, identifyTenant, async (req, res) => {
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

  r.patch('/api/sites/:siteId/pages/:pageId', requireAuth, identifyTenant, checkPermission('settings', 'edit'),
    validateBody(UpdatePageSchema), async (req, res) => {
    const tenantId = (req as any).tenantId
    const patch = { ...(req.body as z.infer<typeof UpdatePageSchema>) }
    // Strip the is_home toggle from the main patch — handled separately
    // so we can demote the previous home in the same transaction.
    const newIsHome = patch.is_home
    delete patch.is_home

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

  r.post('/api/sites/:siteId/pages/:pageId/publish', requireAuth, identifyTenant, checkPermission('settings', 'edit'),
    async (req, res) => {
    const tenantId = (req as any).tenantId
    const { data, error } = await supabase
      .from('site_pages')
      .update({ status: 'published', published_at: new Date().toISOString() })
      .eq('id', req.params.pageId)
      .eq('site_id', req.params.siteId)
      .eq('tenant_id', tenantId)
      .select('*').single()
    if (error) { apiError(res, 500, 'publish_failed', error.message); return }
    res.json({ page: data })
  })

  r.post('/api/sites/:siteId/pages/:pageId/unpublish', requireAuth, identifyTenant, checkPermission('settings', 'edit'),
    async (req, res) => {
    const tenantId = (req as any).tenantId
    const { data, error } = await supabase
      .from('site_pages')
      .update({ status: 'draft' })
      .eq('id', req.params.pageId)
      .eq('site_id', req.params.siteId)
      .eq('tenant_id', tenantId)
      .select('*').single()
    if (error) { apiError(res, 500, 'unpublish_failed', error.message); return }
    res.json({ page: data })
  })

  r.post('/api/sites/:siteId/pages/:pageId/duplicate', requireAuth, identifyTenant, checkPermission('settings', 'edit'),
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

  r.delete('/api/sites/:siteId/pages/:pageId', requireAuth, identifyTenant, checkPermission('settings', 'delete'),
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

  // ── Import a standalone form into this Site as a page ────────────────
  // Lets a tenant keep their existing /forms list working AND optionally
  // promote a form into a Site without losing the schema. Sets is_home
  // false unless this is the first page in the site.
  r.post('/api/sites/:siteId/import-form/:formId', requireAuth, identifyTenant, checkPermission('settings', 'edit'),
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
  // to the lowest sort_order published page. Returns 404 if neither
  // exists (= the site is brand new + no published page yet).
  r.get('/api/public/sites/:tenantSlug/:siteSlug/:pageSlug?', async (req, res) => {
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
    if ((site as any).status !== 'published') { apiError(res, 404, 'not_found', 'Site not published.'); return }

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

    res.json({
      site: {
        name:          (site as any).name,
        slug:          (site as any).slug,
        nav_json:      (site as any).nav_json,
        theme_json:    (site as any).theme_json,
        custom_domain: (site as any).custom_domain,
      },
      page: pageRes.data,
      siblings: navPages ?? [],
    })
  })

  return r
}
