/**
 * Saved contact segments API (P1 #18).
 *
 *   GET    /api/segments               — list non-archived segments
 *   POST   /api/segments               — create
 *   GET    /api/segments/:id           — read one
 *   PATCH  /api/segments/:id           — update name / description / filters
 *   GET    /api/segments/:id/count     — evaluate filters, return { count }
 *   GET    /api/segments/:id/preview   — return up to N matching contacts
 *   DELETE /api/segments/:id           — archive (sets archived_at; soft delete)
 *
 * Filter evaluation lives in lib/segment-filter.ts. The route layer is the
 * thin tenant-scoped façade — every read/write is .eq('tenant_id', tenantId)
 * defensively even though RLS already enforces it.
 *
 * No git push, no deploy.
 */

import express from 'express'
import { z } from 'zod'
import { SupabaseClient } from '@supabase/supabase-js'
import { validateBody } from '../validation'
import { buildSegmentQuery, sanitizeFilters } from '../lib/segment-filter'

type Middleware = (req: express.Request, res: express.Response, next: express.NextFunction) => void | Promise<void>

interface Deps {
  supabase: SupabaseClient
  requireAuth: Middleware
  identifyTenant: Middleware
  checkPermission: (feature: string, action: 'view' | 'edit' | 'delete') => Middleware
}

// ── Schemas ──────────────────────────────────────────────────────────────────
//
// The `filters` jsonb is intentionally lax at the schema layer — segment-
// filter.ts sanitizeFilters() is the authoritative validator. This way a
// new filter key shipping in the FE doesn't get 400'd before the server
// is taught about it (forward compat).

const FiltersBlobSchema = z.record(z.string(), z.any())

const SegmentCreateSchema = z.object({
  name:        z.string().min(2).max(80),
  description: z.string().max(500).optional().nullable(),
  filters:     FiltersBlobSchema.optional(),
}).strict()

const SegmentPatchSchema = z.object({
  name:        z.string().min(2).max(80).optional(),
  description: z.string().max(500).optional().nullable(),
  filters:     FiltersBlobSchema.optional(),
}).strict()

// ── Router factory ──────────────────────────────────────────────────────────
export function createSegmentsRouter(deps: Deps): express.Router {
  const r = express.Router()
  const { supabase, requireAuth, identifyTenant, checkPermission } = deps

  // ── List (non-archived) ────────────────────────────────────────────────────
  r.get('/api/segments',
    requireAuth, identifyTenant, checkPermission('leads', 'view'),
    async (req, res) => {
      const tenantId = (req as any).tenantId
      const { data, error } = await supabase
        .from('contact_segments')
        .select('id, name, description, filters, estimated_count, created_by, created_at, updated_at')
        .eq('tenant_id', tenantId)
        .is('archived_at', null)
        .order('created_at', { ascending: false })
        .limit(200)
      if (error) { res.status(500).json({ error: error.message }); return }
      // Audit punch fix: normalize to `{ data: [...] }` to match the rest
      // of the collection endpoints (workflow-templates: `{templates:[]}`,
      // crm: `{stages:[]}`, breach: `{data:[]}`, agency-revshare: `{data:[]}`).
      // Sibling listing endpoints across the codebase wrap their array — a
      // bare array here was inconsistent and forced FE callers into a type
      // discriminator. Wrapping behind a one-keyed object is also cheap
      // future-proofing for adding `total`, `cursor`, etc.
      res.json({ data: data ?? [] })
    },
  )

  // ── Create ────────────────────────────────────────────────────────────────
  r.post('/api/segments',
    requireAuth, identifyTenant, checkPermission('leads', 'edit'),
    validateBody(SegmentCreateSchema),
    async (req, res) => {
      const tenantId = (req as any).tenantId
      const userId   = (req as any).user?.id ?? null
      const body = req.body as z.infer<typeof SegmentCreateSchema>

      // Sanitize filters at create time so the row never carries garbage.
      // Unknown keys silently dropped; bad values dropped. Empty {} is OK.
      const filters = sanitizeFilters(body.filters ?? {})

      const { data, error } = await supabase.from('contact_segments').insert({
        tenant_id:   tenantId,
        name:        body.name,
        description: body.description ?? null,
        filters,
        created_by:  userId,
      }).select().single()
      if (error) {
        // Surface a friendlier 409 on the (tenant_id, name) unique violation.
        const msg = error.message ?? ''
        if (msg.toLowerCase().includes('duplicate') || msg.toLowerCase().includes('unique')) {
          res.status(409).json({ error: `A segment named "${body.name}" already exists.` })
          return
        }
        res.status(500).json({ error: msg }); return
      }
      res.status(201).json(data)
    },
  )

  // ── Read one ──────────────────────────────────────────────────────────────
  r.get('/api/segments/:id',
    requireAuth, identifyTenant, checkPermission('leads', 'view'),
    async (req, res) => {
      const tenantId = (req as any).tenantId
      const { data, error } = await supabase
        .from('contact_segments')
        .select('*')
        .eq('id', req.params.id)
        .eq('tenant_id', tenantId)
        .maybeSingle()
      if (error) { res.status(500).json({ error: error.message }); return }
      if (!data)  { res.status(404).json({ error: 'segment not found' }); return }
      res.json(data)
    },
  )

  // ── Update ────────────────────────────────────────────────────────────────
  r.patch('/api/segments/:id',
    requireAuth, identifyTenant, checkPermission('leads', 'edit'),
    validateBody(SegmentPatchSchema),
    async (req, res) => {
      const tenantId = (req as any).tenantId
      const patch = req.body as z.infer<typeof SegmentPatchSchema>
      const updates: Record<string, unknown> = {}
      if (patch.name !== undefined)        updates.name = patch.name
      if (patch.description !== undefined) updates.description = patch.description
      if (patch.filters !== undefined)     updates.filters = sanitizeFilters(patch.filters)

      if (Object.keys(updates).length === 0) {
        res.status(400).json({ error: 'no fields to update' }); return
      }
      updates.updated_at = new Date().toISOString()

      const { data, error } = await supabase
        .from('contact_segments')
        .update(updates)
        .eq('id', req.params.id)
        .eq('tenant_id', tenantId)
        .select().maybeSingle()
      if (error) { res.status(500).json({ error: error.message }); return }
      if (!data)  { res.status(404).json({ error: 'segment not found' }); return }
      res.json(data)
    },
  )

  // ── Count matching contacts ───────────────────────────────────────────────
  r.get('/api/segments/:id/count',
    requireAuth, identifyTenant, checkPermission('leads', 'view'),
    async (req, res) => {
      const tenantId = (req as any).tenantId
      const { data: seg, error: segErr } = await supabase
        .from('contact_segments')
        .select('id, filters')
        .eq('id', req.params.id)
        .eq('tenant_id', tenantId)
        .maybeSingle()
      if (segErr) { res.status(500).json({ error: segErr.message }); return }
      if (!seg)    { res.status(404).json({ error: 'segment not found' }); return }

      const { query } = await buildSegmentQuery(supabase, tenantId, seg.filters)
      const { count, error: cntErr } = await query
        .select('id', { count: 'exact', head: true })
      if (cntErr) {
        res.status(500).json({ error: cntErr.message }); return
      }
      const total = count ?? 0

      // Refresh the cached estimate (stale-while-revalidate). Fire-and-
      // forget — failures here are not user-facing.
      supabase.from('contact_segments').update({
        estimated_count: total,
        updated_at: new Date().toISOString(),
      }).eq('id', seg.id).eq('tenant_id', tenantId)
        .then(({ error }) => { if (error) console.warn(`[segments] estimate update: ${error.message}`) })

      res.json({ count: total })
    },
  )

  // ── Preview (first N matching contacts) ───────────────────────────────────
  r.get('/api/segments/:id/preview',
    requireAuth, identifyTenant, checkPermission('leads', 'view'),
    async (req, res) => {
      const tenantId = (req as any).tenantId
      const limit = Math.min(Math.max(parseInt(String(req.query.limit ?? '50'), 10) || 50, 1), 200)

      const { data: seg, error: segErr } = await supabase
        .from('contact_segments')
        .select('id, filters')
        .eq('id', req.params.id)
        .eq('tenant_id', tenantId)
        .maybeSingle()
      if (segErr) { res.status(500).json({ error: segErr.message }); return }
      if (!seg)    { res.status(404).json({ error: 'segment not found' }); return }

      const { query } = await buildSegmentQuery(supabase, tenantId, seg.filters)
      const { data, error: rowsErr } = await query
        .select('id, name, phone, email, tags, status, last_contacted_at, attributes')
        .order('created_at', { ascending: false })
        .limit(limit)
      if (rowsErr) { res.status(500).json({ error: rowsErr.message }); return }
      res.json({ contacts: data ?? [], limit })
    },
  )

  // ── Archive (soft delete) ─────────────────────────────────────────────────
  r.delete('/api/segments/:id',
    requireAuth, identifyTenant, checkPermission('leads', 'delete'),
    async (req, res) => {
      const tenantId = (req as any).tenantId
      const { error } = await supabase
        .from('contact_segments')
        .update({ archived_at: new Date().toISOString(), updated_at: new Date().toISOString() })
        .eq('id', req.params.id)
        .eq('tenant_id', tenantId)
      if (error) { res.status(500).json({ error: error.message }); return }
      res.json({ success: true })
    },
  )

  return r
}
