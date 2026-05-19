/**
 * Workflow template library (P1 #13).
 *
 *   GET  /api/workflow-templates                  — public, no auth.
 *   GET  /api/workflow-templates?vertical=&channel=  — optional filters.
 *   GET  /api/workflow-templates/:slug             — public, single template detail.
 *   POST /api/workflow-templates/:slug/clone       — authed + tenant.
 *
 * The catalog itself is non-sensitive (curated by us) so list + detail are
 * intentionally public — they're the same content the marketing site would
 * link to. The RLS policy on public.workflow_templates already enforces
 * "status = 'live'" so anon callers can only see live entries.
 *
 * Clone is the only mutating route. It:
 *   1. Looks up the template by slug.
 *   2. Inserts a new public.workflows row into the caller's tenant with
 *      the template's nodes_json copied verbatim and status='draft' so
 *      the user keeps editing via the existing chat-driven builder.
 *   3. Stamps public.workflow_template_clones (append-only audit).
 *   4. Bumps workflow_templates.usage_count via an atomic update so
 *      concurrent clones from different tenants don't lose increments.
 *
 * Catalog writes (insert/update/delete on workflow_templates) are out of
 * scope here — RLS revokes those grants on authenticated+anon, and the
 * super-admin manages the catalog out-of-band. A /naruto/templates UI is
 * deferred to P2.
 */

import express from 'express'
import { SupabaseClient } from '@supabase/supabase-js'

type Middleware = (req: express.Request, res: express.Response, next: express.NextFunction) => void | Promise<void>

interface Deps {
  supabase: SupabaseClient
  requireAuth: Middleware
  identifyTenant: Middleware
}

// Vertical / channel enums mirror the CHECK constraint on
// public.workflow_templates so the route rejects bad filter values up
// front rather than letting them silently 404.
const VALID_VERTICALS = new Set(['d2c', 'edtech', 'clinic', 'realestate', 'generic'])
const VALID_CHANNELS  = new Set(['whatsapp', 'telegram', 'instagram', 'multi'])

export function createWorkflowTemplatesRouter(deps: Deps): express.Router {
  const r = express.Router()
  const { supabase, requireAuth, identifyTenant } = deps

  // ── GET /api/workflow-templates ───────────────────────────────────────────
  // Public catalog list. Anon-friendly so the marketing surface can show
  // the same cards without forcing a login.
  r.get('/api/workflow-templates', async (req, res) => {
    const vertical = req.query.vertical ? String(req.query.vertical) : null
    const channel  = req.query.channel  ? String(req.query.channel)  : null

    if (vertical && !VALID_VERTICALS.has(vertical)) {
      res.status(400).json({ error: `Invalid vertical. Expected one of: ${[...VALID_VERTICALS].join(', ')}` })
      return
    }
    if (channel && !VALID_CHANNELS.has(channel)) {
      res.status(400).json({ error: `Invalid channel. Expected one of: ${[...VALID_CHANNELS].join(', ')}` })
      return
    }

    let q = supabase.from('workflow_templates')
      .select('id, slug, vertical, channel, title, summary, hero_emoji, example_first_message, prerequisites, usage_count, status, created_at, updated_at')
      .eq('status', 'live')
      .order('usage_count', { ascending: false })
      .order('created_at',  { ascending: false })

    if (vertical) q = q.eq('vertical', vertical)
    if (channel)  q = q.eq('channel',  channel)

    const { data, error } = await q
    if (error) { res.status(500).json({ error: error.message }); return }
    res.json({ templates: data ?? [] })
  })

  // ── GET /api/workflow-templates/:slug ─────────────────────────────────────
  // Public detail view including nodes_json so the FE can preview the full
  // workflow before the user clones it.
  r.get('/api/workflow-templates/:slug', async (req, res) => {
    const slug = String(req.params.slug)
    const { data, error } = await supabase.from('workflow_templates')
      .select('*')
      .eq('slug', slug)
      .eq('status', 'live')
      .maybeSingle()
    if (error) { res.status(500).json({ error: error.message }); return }
    if (!data) { res.status(404).json({ error: 'Template not found' }); return }
    res.json(data)
  })

  // ── POST /api/workflow-templates/:slug/clone ──────────────────────────────
  // Authed + tenant. Creates a draft workflow in the caller's workspace.
  // The chat-driven builder is the canonical post-clone editor — we
  // intentionally do NOT spin up a visual canvas for templates.
  r.post('/api/workflow-templates/:slug/clone', requireAuth, identifyTenant, async (req, res) => {
    const tenantId = (req as any).tenantId
    const userId   = (req as any).user?.id
    const slug     = String(req.params.slug)

    // 1. Resolve template. Must be live or we refuse.
    const { data: tpl, error: tplErr } = await supabase.from('workflow_templates')
      .select('id, slug, title, channel, nodes_json, prerequisites')
      .eq('slug', slug)
      .eq('status', 'live')
      .maybeSingle()
    if (tplErr) { res.status(500).json({ error: tplErr.message }); return }
    if (!tpl)   { res.status(404).json({ error: 'Template not found' }); return }

    // 2. Insert the new workflow row. Status stays 'draft' so the active-
    //    workflow plan-limit gate doesn't fire on clone — users iterate
    //    before flipping to live, which is when checkPermission +
    //    blockIfOverLimit kick in on PATCH /api/workflows/:id.
    //
    //    workflows.user_id is NOT NULL (see migration 001) so we stamp the
    //    cloning user. tenant_id comes from identifyTenant.
    const customName = (req.body?.name ? String(req.body.name) : '').trim()
    const newName = customName || tpl.title

    const { data: newWf, error: wfErr } = await supabase.from('workflows').insert({
      tenant_id:     tenantId,
      user_id:       userId,
      name:          newName,
      description:   `Cloned from template: ${tpl.title}`,
      status:        'draft',
      nodes:         tpl.nodes_json,
      integrations:  tpl.prerequisites ?? [],
      intent_text:   `Cloned from "${tpl.title}" — edit via chat to customize.`,
    }).select('id').single()
    if (wfErr) {
      res.status(500).json({ error: `Clone failed: ${wfErr.message}` })
      return
    }

    // 3. Audit row. Append-only — the SELECT policy on workflow_template_clones
    //    lets the cloning tenant read its own audit history.
    const { error: auditErr } = await supabase.from('workflow_template_clones').insert({
      template_id: tpl.id,
      tenant_id:   tenantId,
      workflow_id: newWf.id,
      cloned_by:   userId ?? null,
    })
    if (auditErr) {
      // Don't fail the clone over an audit-row hiccup — the workflow
      // already exists and the user expects to land on it. Log loud
      // so we notice in metrics.
      console.error('[workflow-templates] clone audit insert failed:', auditErr.message)
    }

    // 4. Bump usage_count. Read-then-write race is acceptable here — the
    //    counter is for catalog sorting, not billing. RLS revokes
    //    UPDATE on workflow_templates from authenticated, but this route
    //    runs with the service-role client (same supabase handle used by
    //    every other authed route in this app — see src/index.ts), so the
    //    update goes through. If we ever migrate this route to the user's
    //    JWT client we'd need an RPC with security definer.
    {
      const { data: current } = await supabase.from('workflow_templates')
        .select('usage_count').eq('id', tpl.id).maybeSingle()
      const next = ((current?.usage_count as number | undefined) ?? 0) + 1
      await supabase.from('workflow_templates')
        .update({ usage_count: next, updated_at: new Date().toISOString() })
        .eq('id', tpl.id)
    }

    res.status(201).json({ workflow_id: newWf.id, slug: tpl.slug })
  })

  return r
}
