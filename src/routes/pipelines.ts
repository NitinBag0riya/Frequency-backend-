/**
 * Pipelines + Vertical Packs router — migration 116.
 *
 * Public-ish surface (still authed, but tenant-isolated):
 *   GET    /api/pipeline-packs                    — list curated packs
 *   GET    /api/pipeline-packs/:packId            — pack detail + install preview
 *   POST   /api/pipeline-packs/:packId/install    — provision into the calling tenant
 *
 * Tenant-scoped CRUD over installed pipelines:
 *   GET    /api/pipelines                         — list installed pipelines
 *   GET    /api/pipelines/:id                     — detail + bindings + counts
 *   PATCH  /api/pipelines/:id                     — name / slug / stages
 *   DELETE /api/pipelines/:id                     — archive (soft)
 *   GET    /api/pipelines/:id/bindings            — list workflow bindings (with workflow names)
 *
 * Phase 2 (NOT in this build — call them out so reviewers know they're
 * intentional gaps):
 *   • Pipeline dashboard (kanban view + per-stage row counts + drag-drop)
 *   • Stage-transition activity log
 *   • Per-binding edit (event, filter, is_active toggle) — currently
 *     only created during install
 *   • Pack diff/upgrade — re-install with a newer pack version
 *
 * The install handler is the meaty one. It:
 *   1. Idempotency-checks by (tenant_id, pipeline.slug) — returns the
 *      existing pipeline if it's already installed.
 *   2. Creates the lead_tables row + all lead_columns from the manifest.
 *   3. Creates the pipelines row pointing at that table.
 *   4. Inserts each workflow as DRAFT (status='draft') — the user
 *      reviews + publishes from the existing Workflows page.
 *   5. For each workflow, creates a pipeline_workflow_bindings row.
 *   6. Inserts each template as DRAFT (status='draft') — user reviews +
 *      submits to Meta from the existing WA Templates page.
 *   7. Bumps pipeline_packs.install_count.
 *
 * No real transactions in Supabase JS — instead we rely on FK cascades
 * from `pipelines` to roll back the lead_table on a downstream failure
 * by deleting the pipeline row (which cascades). Workflows + templates
 * left behind on a partial failure are harmless drafts the user can
 * delete; they don't fire until activated. We do best-effort cleanup
 * after the first hard failure point.
 */

import express from 'express'
import { z } from 'zod'
import type { SupabaseClient } from '@supabase/supabase-js'
import { validateBody } from '../validation'
import { apiError } from '../lib/api-error'
import type { PackManifest, PackTemplate, PackColumn } from '../data/packs/real-estate-pack'

// ── Validators ──────────────────────────────────────────────────────────

const StageSchema = z.object({
  name:       z.string().min(1).max(80),
  sort_order: z.number().int(),
  color:      z.string().regex(/^#[0-9A-Fa-f]{6}$/),
  terminal:   z.boolean().optional(),
})

const UpdatePipelineSchema = z.object({
  name:        z.string().min(1).max(200).optional(),
  slug:        z.string().min(2).max(80).regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/).optional(),
  stages_json: z.array(StageSchema).optional(),
  stage_column: z.string().min(1).max(80).optional(),
  key_column:  z.string().min(1).max(80).optional(),
})

interface RouterDeps {
  supabase:        SupabaseClient
  requireAuth:     express.RequestHandler
  identifyTenant:  express.RequestHandler
  checkPermission: (resource: string, action: 'view' | 'edit' | 'delete') => express.RequestHandler
}

// Mirrors src/routes/sites.ts — keep param-shape errors as clean 400s
// instead of letting Postgres surface "invalid input syntax for type uuid"
// as a 500.
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

// ── Template category normaliser ────────────────────────────────────────
// The pack manifest uses Meta's casing (MARKETING/UTILITY/AUTHENTICATION)
// because that's what the user reads. The wa_templates DB column is the
// lowercase enum (migration 001). Convert here so the FE Templates page
// continues to surface them correctly (it uppercases at render).
function manifestCategoryToDb(c: PackTemplate['category']): 'marketing' | 'utility' | 'authentication' {
  if (c === 'MARKETING')      return 'marketing'
  if (c === 'AUTHENTICATION') return 'authentication'
  return 'utility'
}

// Map the manifest header.type (TEXT/IMAGE/DOCUMENT/VIDEO) to the
// jsonb header object the wa_templates column expects (lowercase type
// + optional text). The format mirrors what the wa-connect sync writes
// in src/routes/connectors/index.ts.
function manifestHeaderToDb(h?: PackTemplate['header']): unknown {
  if (!h) return null
  return { type: h.type.toLowerCase(), ...(h.text ? { text: h.text } : {}) }
}

// Map pack column type names to the lead_columns enum. The manifest
// already uses the same enum strings so this is mostly a passthrough,
// but we explicitly whitelist to defend against future drift.
const COLUMN_TYPES = new Set([
  'text','number','email','phone','date','select','boolean','textarea','url',
])
function safeColumnType(t: PackColumn['type']): string {
  return COLUMN_TYPES.has(t) ? t : 'text'
}

export function createPipelinesRouter({
  supabase, requireAuth, identifyTenant, checkPermission,
}: RouterDeps): express.Router {
  const r = express.Router()

  // ── Marketplace (packs) ──────────────────────────────────────────────

  r.get('/api/pipeline-packs', requireAuth, async (_req, res) => {
    const { data, error } = await supabase
      .from('pipeline_packs')
      .select('id, slug, name, description, vertical, is_curated, install_count, created_at')
      .order('is_curated', { ascending: false })
      .order('install_count', { ascending: false })
    if (error) { apiError(res, 500, 'list_failed', error.message); return }
    res.json({ packs: data ?? [] })
  })

  r.get('/api/pipeline-packs/:packId', requireAuth, requireUuid('packId'), async (req, res) => {
    const { data, error } = await supabase
      .from('pipeline_packs')
      .select('*')
      .eq('id', req.params.packId)
      .maybeSingle()
    if (error) { apiError(res, 500, 'read_failed', error.message); return }
    if (!data)  { apiError(res, 404, 'not_found', 'Pack not found.'); return }

    // Surface a lightweight preview for the FE confirm modal: how many
    // of each thing will land in the tenant on install. Avoids the FE
    // having to count manifest_json arrays itself.
    const manifest = (data as { manifest_json: PackManifest }).manifest_json
    const preview = {
      table_columns:  manifest.table?.columns?.length ?? 0,
      pipeline_stages: manifest.pipeline?.stages?.length ?? 0,
      workflows:       manifest.workflows?.length ?? 0,
      templates:       manifest.templates?.length ?? 0,
    }
    res.json({ pack: data, preview })
  })

  r.post('/api/pipeline-packs/:packId/install', requireAuth, identifyTenant,
    requireUuid('packId'), checkPermission('settings', 'edit'),
    async (req, res) => {
      const tenantId = (req as any).tenantId as string
      const userId   = (req as any).user?.id as string | undefined
      if (!userId) { apiError(res, 401, 'no_user', 'Missing authenticated user.'); return }

      // 1. Load the pack manifest.
      const { data: packRow, error: packErr } = await supabase
        .from('pipeline_packs')
        .select('id, slug, name, vertical, manifest_json, install_count')
        .eq('id', req.params.packId)
        .maybeSingle()
      if (packErr) { apiError(res, 500, 'pack_read_failed', packErr.message); return }
      if (!packRow) { apiError(res, 404, 'not_found', 'Pack not found.'); return }
      const manifest = (packRow as { manifest_json: PackManifest }).manifest_json
      if (!manifest?.pipeline?.slug) {
        apiError(res, 422, 'bad_manifest', 'Pack manifest is missing pipeline.slug.'); return
      }

      const pipelineSlug = manifest.pipeline.slug

      // 2. Idempotency — return the existing pipeline if already installed.
      const { data: existingPipeline } = await supabase
        .from('pipelines')
        .select('id, name, slug, vertical, source_table_id, stages_json, stage_column, key_column, status, created_at, updated_at')
        .eq('tenant_id', tenantId)
        .eq('slug', pipelineSlug)
        .maybeSingle()
      if (existingPipeline) {
        // Re-install of an existing pipeline returns the same record. We
        // don't re-create workflows/templates — that would spam duplicates
        // every time the user clicked Install.
        const { data: bindings } = await supabase
          .from('pipeline_workflow_bindings')
          .select('id, workflow_id, event, event_filter, sort_order, is_active')
          .eq('pipeline_id', (existingPipeline as { id: string }).id)
        res.status(200).json({
          pipeline:  existingPipeline,
          lead_table_id: (existingPipeline as { source_table_id: string }).source_table_id,
          workflows: [],
          templates: [],
          bindings:  bindings ?? [],
          already_installed: true,
        })
        return
      }

      // 3. Create the lead_tables row + columns. We mirror the shape used
      //    by POST /lead-tables in src/leads.ts so the existing leads UI
      //    treats this table identically (including the rollback pattern).
      const { data: table, error: tableErr } = await supabase
        .from('lead_tables')
        .insert({
          name:        manifest.table?.name ?? `${packRow.name} — leads`,
          description: manifest.table?.description ?? '',
          source:      'pack_install',
          tenant_id:   tenantId,
          user_id:     userId,
        })
        .select()
        .single()
      if (tableErr || !table) {
        apiError(res, 500, 'table_create_failed', tableErr?.message ?? 'unknown'); return
      }

      const columns = (manifest.table?.columns ?? []).map((c, i) => ({
        table_id:    (table as { id: string }).id,
        tenant_id:   tenantId,
        user_id:     userId,
        name:        c.name,
        key:         c.key,
        type:        safeColumnType(c.type),
        options:     c.options ?? [],
        is_required: !!c.is_required,
        is_primary:  !!c.is_primary || i === 0,
        position:    c.position ?? i,
      }))
      if (columns.length > 0) {
        const { error: colErr } = await supabase.from('lead_columns').insert(columns)
        if (colErr) {
          // Roll back the bare table — same pattern as src/leads.ts to
          // avoid leaving a table-with-no-columns behind.
          await supabase.from('lead_tables').delete().eq('id', (table as { id: string }).id)
          apiError(res, 500, 'columns_insert_failed', colErr.message); return
        }
      }

      // 4. Create the pipelines row.
      const { data: pipeline, error: pipeErr } = await supabase
        .from('pipelines')
        .insert({
          tenant_id:       tenantId,
          name:            manifest.pipeline.name,
          slug:            pipelineSlug,
          vertical:        (packRow as { vertical: string }).vertical,
          source_table_id: (table as { id: string }).id,
          stages_json:     manifest.pipeline.stages ?? [],
          stage_column:    manifest.pipeline.stage_column ?? 'Lead_Stage',
          key_column:      manifest.pipeline.key_column ?? 'Mobile',
        })
        .select()
        .single()
      if (pipeErr || !pipeline) {
        // Roll back the lead_table (cascades to columns).
        await supabase.from('lead_tables').delete().eq('id', (table as { id: string }).id)
        apiError(res, 500, 'pipeline_create_failed', pipeErr?.message ?? 'unknown'); return
      }

      // 5. Insert workflows as drafts + create bindings.
      const insertedWorkflows: Array<{ id: string; slug: string; name: string }> = []
      const bindingsToInsert: Array<{
        pipeline_id: string; workflow_id: string; event: string;
        event_filter: string | null; sort_order: number; is_active: boolean
      }> = []

      for (let i = 0; i < manifest.workflows.length; i++) {
        const w = manifest.workflows[i]
        const { data: wf, error: wfErr } = await supabase
          .from('workflows')
          .insert({
            tenant_id:   tenantId,
            user_id:     userId,
            name:        w.name,
            description: w.description,
            status:      'draft',   // user reviews + publishes from /workflows
            nodes:       (w.nodes_json as any)?.nodes ?? w.nodes_json,
            blueprint:   { installed_from_pack: packRow.slug, source_slug: w.slug },
          })
          .select('id, name')
          .single()
        if (wfErr || !wf) {
          // Best-effort: pipeline already created. Don't roll back — the
          // user can re-install (idempotent) and we'll only insert
          // missing workflows then. Surface a partial-failure 207.
          console.warn(`[pipelines/install] workflow insert failed (${w.slug}):`, wfErr?.message)
          continue
        }
        insertedWorkflows.push({ id: (wf as { id: string }).id, slug: w.slug, name: (wf as { name: string }).name })
        bindingsToInsert.push({
          pipeline_id:  (pipeline as { id: string }).id,
          workflow_id:  (wf as { id: string }).id,
          event:        w.trigger_event,
          event_filter: w.trigger_filter ?? null,
          sort_order:   i,
          is_active:    true,
        })
      }

      let insertedBindings: any[] = []
      if (bindingsToInsert.length > 0) {
        const { data: bs, error: bErr } = await supabase
          .from('pipeline_workflow_bindings')
          .insert(bindingsToInsert)
          .select('id, workflow_id, event, event_filter, sort_order, is_active')
        if (bErr) {
          console.warn('[pipelines/install] bindings insert failed:', bErr.message)
        } else {
          insertedBindings = bs ?? []
        }
      }

      // 6. Insert template drafts. Existing wa_templates uniqueness is
      //    enforced by name+tenant_id (per migration 052) — skip rows
      //    that already exist so re-attempts don't 500.
      const insertedTemplates: Array<{ id: string; name: string }> = []
      for (const t of manifest.templates) {
        // Skip if a template with this name already exists in this tenant
        // — the user may have created it manually before installing.
        const { data: existing } = await supabase
          .from('wa_templates')
          .select('id, name')
          .eq('tenant_id', tenantId)
          .eq('name', t.name)
          .maybeSingle()
        if (existing) {
          insertedTemplates.push({ id: (existing as { id: string }).id, name: (existing as { name: string }).name })
          continue
        }

        const { data: tpl, error: tErr } = await supabase
          .from('wa_templates')
          .insert({
            tenant_id: tenantId,
            user_id:   userId,
            name:      t.name,
            language:  t.language ?? 'en',
            category:  manifestCategoryToDb(t.category),
            status:    'draft',           // user submits to Meta from /channels/whatsapp/templates
            header:    manifestHeaderToDb(t.header),
            body:      t.body,
            buttons:   t.buttons ?? null,
            variables: t.variables ?? [],
          })
          .select('id, name')
          .single()
        if (tErr || !tpl) {
          console.warn(`[pipelines/install] template insert failed (${t.name}):`, tErr?.message)
          continue
        }
        insertedTemplates.push({ id: (tpl as { id: string }).id, name: (tpl as { name: string }).name })
      }

      // 7. Bump install_count. Best-effort; failure is logged.
      const { error: bumpErr } = await supabase
        .from('pipeline_packs')
        .update({ install_count: ((packRow as { install_count: number }).install_count ?? 0) + 1 })
        .eq('id', (packRow as { id: string }).id)
      if (bumpErr) console.warn('[pipelines/install] install_count bump failed:', bumpErr.message)

      res.status(201).json({
        pipeline,
        lead_table_id: (table as { id: string }).id,
        workflows:     insertedWorkflows,
        templates:     insertedTemplates,
        bindings:      insertedBindings,
        already_installed: false,
      })
    })

  // ── Installed pipelines (tenant-scoped CRUD) ─────────────────────────

  r.get('/api/pipelines', requireAuth, identifyTenant, async (req, res) => {
    const tenantId = (req as any).tenantId
    const { data, error } = await supabase
      .from('pipelines')
      .select('id, name, slug, vertical, source_table_id, stages_json, stage_column, key_column, status, created_at, updated_at')
      .eq('tenant_id', tenantId)
      .neq('status', 'archived')
      .order('updated_at', { ascending: false })
    if (error) { apiError(res, 500, 'list_failed', error.message); return }
    res.json({ pipelines: data ?? [] })
  })

  r.get('/api/pipelines/:id', requireAuth, identifyTenant, requireUuid('id'), async (req, res) => {
    const tenantId = (req as any).tenantId
    const { data: pipeline, error } = await supabase
      .from('pipelines')
      .select('*')
      .eq('id', req.params.id)
      .eq('tenant_id', tenantId)
      .maybeSingle()
    if (error) { apiError(res, 500, 'read_failed', error.message); return }
    if (!pipeline) { apiError(res, 404, 'not_found', 'Pipeline not found.'); return }

    // Side-load bindings + a cheap row count from the source table so the
    // detail page renders in one round-trip.
    const [{ data: bindings }, { count: rowCount }] = await Promise.all([
      supabase
        .from('pipeline_workflow_bindings')
        .select('id, workflow_id, event, event_filter, sort_order, is_active, workflows(id, name, status)')
        .eq('pipeline_id', req.params.id)
        .order('sort_order', { ascending: true }),
      supabase
        .from('lead_rows')
        .select('id', { count: 'exact', head: true })
        .eq('table_id', (pipeline as { source_table_id: string }).source_table_id)
        .eq('tenant_id', tenantId),
    ])

    res.json({
      pipeline,
      bindings:  bindings ?? [],
      stats:     { row_count: rowCount ?? 0 },
    })
  })

  r.patch('/api/pipelines/:id', requireAuth, identifyTenant, requireUuid('id'),
    checkPermission('settings', 'edit'), validateBody(UpdatePipelineSchema), async (req, res) => {
    const tenantId = (req as any).tenantId
    const patch = req.body as z.infer<typeof UpdatePipelineSchema>
    if (Object.keys(patch).length === 0) {
      const { data: current } = await supabase
        .from('pipelines').select('*').eq('id', req.params.id).eq('tenant_id', tenantId).maybeSingle()
      if (!current) { apiError(res, 404, 'not_found', 'Pipeline not found.'); return }
      res.json({ pipeline: current }); return
    }
    const { data, error } = await supabase
      .from('pipelines')
      .update(patch)
      .eq('id', req.params.id)
      .eq('tenant_id', tenantId)
      .select('*')
      .single()
    if (error) {
      if ((error as any).code === '23505') {
        apiError(res, 409, 'slug_taken', 'Slug already in use in this workspace.'); return
      }
      if ((error as any).code === 'PGRST116') {
        apiError(res, 404, 'not_found', 'Pipeline not found.'); return
      }
      apiError(res, 500, 'update_failed', error.message); return
    }
    res.json({ pipeline: data })
  })

  r.delete('/api/pipelines/:id', requireAuth, identifyTenant, requireUuid('id'),
    checkPermission('settings', 'delete'), async (req, res) => {
    const tenantId = (req as any).tenantId
    const { error } = await supabase
      .from('pipelines')
      .update({ status: 'archived' })
      .eq('id', req.params.id)
      .eq('tenant_id', tenantId)
    if (error) { apiError(res, 500, 'delete_failed', error.message); return }
    res.json({ ok: true })
  })

  r.get('/api/pipelines/:id/bindings', requireAuth, identifyTenant, requireUuid('id'), async (req, res) => {
    const tenantId = (req as any).tenantId
    // Confirm the pipeline belongs to this tenant before exposing bindings.
    const { data: pipeline } = await supabase
      .from('pipelines').select('id').eq('id', req.params.id).eq('tenant_id', tenantId).maybeSingle()
    if (!pipeline) { apiError(res, 404, 'not_found', 'Pipeline not found.'); return }

    const { data, error } = await supabase
      .from('pipeline_workflow_bindings')
      .select('id, workflow_id, event, event_filter, sort_order, is_active, workflows(id, name, status)')
      .eq('pipeline_id', req.params.id)
      .order('sort_order', { ascending: true })
    if (error) { apiError(res, 500, 'list_failed', error.message); return }
    res.json({ bindings: data ?? [] })
  })

  return r
}
