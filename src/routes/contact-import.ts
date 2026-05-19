/**
 * Bulk contact import API (P1 #18).
 *
 *   POST   /api/contacts/import           — create a job (status='pending')
 *   GET    /api/contacts/import           — list this tenant's recent jobs
 *   GET    /api/contacts/import/:id       — single job status + counts
 *   GET    /api/contacts/import/:id/dry-run — preview cache (first ~100 rows + per-row issues)
 *   POST   /api/contacts/import/:id/commit — promote a dry_run → executing
 *   POST   /api/contacts/import/:id/cancel — set cancelled_at (only for pending / dry_run)
 *
 * Lifecycle:
 *   POST /import → row inserted with status='pending', BullMQ job enqueued.
 *   Worker picks it up: parsing → dry_run (writes preview_jsonb + row counts).
 *   Operator calls POST /commit: status→'executing'; worker re-enqueued.
 *   Worker on second pass: UPSERTs contacts + inserts consent_events per row.
 *   On success: status='completed' (or 'partial' if any row errored).
 *
 * Per-contact consent provenance — every inserted contact gets a consent_events
 * row with source='bulk_import' and source_detail containing the job_id +
 * consent_basis + filename + tenant-supplied source_label. The proof_text is
 * the job's consent_proof_text verbatim. DPDPA evidentiary trail.
 *
 * No git push, no deploy. Migration via supabase db push (084_contact_import.sql).
 */

import express from 'express'
import { z } from 'zod'
import { SupabaseClient } from '@supabase/supabase-js'
import { validateBody } from '../validation'

type Middleware = (req: express.Request, res: express.Response, next: express.NextFunction) => void | Promise<void>

interface Deps {
  supabase: SupabaseClient
  requireAuth: Middleware
  identifyTenant: Middleware
  checkPermission: (feature: string, action: 'view' | 'edit' | 'delete') => Middleware
  /** Hook into BullMQ — decouples the router from the queue module so tests
   *  can stub it. The route layer enqueues with the job id so the worker
   *  can pick it up; we don't wait for the worker. */
  enqueueImport?: (jobId: string) => Promise<void>
}

// ── Schemas ──────────────────────────────────────────────────────────────────
//
// The inline_payload cap is 5MB at the route layer — beyond that, callers
// must upload via Supabase Storage and pass storage_path (P2 polish — for
// the v1 ship we accept inline only). 5MB ≈ 50k rows of phone+name csv,
// which is comfortably above any single tenant's first import.

const INLINE_PAYLOAD_MAX_BYTES = 5 * 1024 * 1024
const CONSENT_BASIS_VALUES = [
  'opt_in_form', 'existing_customer', 'migration', 'referral', 'manual_entry',
] as const

const ImportCreateSchema = z.object({
  filename: z.string().min(1).max(200),
  source_label: z.string().min(1).max(120),
  consent_basis: z.enum(CONSENT_BASIS_VALUES),
  consent_proof_text: z.string().min(10).max(2000),
  /** CSV text. For v1 we accept inline only — XLSX parsing happens
   *  client-side and is converted to CSV before POST. */
  csv_text: z.string().min(1).refine(
    (s) => Buffer.byteLength(s, 'utf8') <= INLINE_PAYLOAD_MAX_BYTES,
    { message: `csv_text exceeds ${INLINE_PAYLOAD_MAX_BYTES} bytes — split into smaller files` },
  ),
}).strict()

// ── Router factory ──────────────────────────────────────────────────────────
export function createContactImportRouter(deps: Deps): express.Router {
  const r = express.Router()
  const { supabase, requireAuth, identifyTenant, checkPermission, enqueueImport } = deps

  // ── Create job ─────────────────────────────────────────────────────────────
  r.post('/api/contacts/import',
    requireAuth, identifyTenant, checkPermission('leads', 'edit'),
    validateBody(ImportCreateSchema),
    async (req, res) => {
      const tenantId = (req as any).tenantId
      const userId   = (req as any).user?.id ?? null
      const body = req.body as z.infer<typeof ImportCreateSchema>

      const { data: job, error } = await supabase.from('contact_import_jobs').insert({
        tenant_id:          tenantId,
        uploaded_by:        userId,
        filename:           body.filename,
        source_label:       body.source_label,
        consent_basis:      body.consent_basis,
        consent_proof_text: body.consent_proof_text,
        inline_payload:     body.csv_text,
        status:             'pending',
      }).select().single()

      if (error || !job) {
        res.status(500).json({ error: error?.message ?? 'Failed to create import job' })
        return
      }

      // Enqueue — swallow if Redis is down so the row still exists and
      // a manual /commit (or a worker re-poll on boot) can pick it up.
      try { await enqueueImport?.(job.id) } catch (e: any) {
        console.warn(`[contact-import] enqueue failed for job ${job.id}: ${e?.message ?? e}`)
      }

      res.status(201).json({ job_id: job.id, status: job.status })
    },
  )

  // ── List recent jobs ───────────────────────────────────────────────────────
  r.get('/api/contacts/import',
    requireAuth, identifyTenant, checkPermission('leads', 'view'),
    async (req, res) => {
      const tenantId = (req as any).tenantId
      const { data, error } = await supabase
        .from('contact_import_jobs')
        .select('id, filename, source_label, consent_basis, status, rows_total, rows_imported, rows_updated, rows_skipped, rows_error, created_at, started_at, completed_at, cancelled_at')
        .eq('tenant_id', tenantId)
        .order('created_at', { ascending: false })
        .limit(50)
      if (error) { res.status(500).json({ error: error.message }); return }
      res.json(data ?? [])
    },
  )

  // ── Get one job (full row, including errors_jsonb + preview_jsonb) ────────
  r.get('/api/contacts/import/:id',
    requireAuth, identifyTenant, checkPermission('leads', 'view'),
    async (req, res) => {
      const tenantId = (req as any).tenantId
      const { data, error } = await supabase
        .from('contact_import_jobs')
        .select('*')
        .eq('id', req.params.id)
        .eq('tenant_id', tenantId)
        .maybeSingle()
      if (error) { res.status(500).json({ error: error.message }); return }
      if (!data)  { res.status(404).json({ error: 'import job not found' }); return }
      res.json(data)
    },
  )

  // ── Dry-run preview ───────────────────────────────────────────────────────
  // Returns the cached first-pass output. If the worker hasn't run yet the
  // preview is empty — caller polls /import/:id until status='dry_run'.
  r.get('/api/contacts/import/:id/dry-run',
    requireAuth, identifyTenant, checkPermission('leads', 'view'),
    async (req, res) => {
      const tenantId = (req as any).tenantId
      const { data, error } = await supabase
        .from('contact_import_jobs')
        .select('id, status, rows_total, rows_imported, rows_updated, rows_skipped, rows_error, preview_jsonb, errors_jsonb')
        .eq('id', req.params.id)
        .eq('tenant_id', tenantId)
        .maybeSingle()
      if (error) { res.status(500).json({ error: error.message }); return }
      if (!data)  { res.status(404).json({ error: 'import job not found' }); return }
      res.json({
        status: data.status,
        rows: {
          total:    data.rows_total ?? 0,
          imported: data.rows_imported ?? 0,
          updated:  data.rows_updated ?? 0,
          skipped:  data.rows_skipped ?? 0,
          error:    data.rows_error ?? 0,
        },
        preview: data.preview_jsonb ?? [],
        errors:  data.errors_jsonb ?? [],
      })
    },
  )

  // ── Commit (dry_run → executing) ──────────────────────────────────────────
  r.post('/api/contacts/import/:id/commit',
    requireAuth, identifyTenant, checkPermission('leads', 'edit'),
    async (req, res) => {
      const tenantId = (req as any).tenantId
      const { data: job, error: loadErr } = await supabase
        .from('contact_import_jobs')
        .select('id, status, cancelled_at')
        .eq('id', req.params.id)
        .eq('tenant_id', tenantId)
        .maybeSingle()
      if (loadErr) { res.status(500).json({ error: loadErr.message }); return }
      if (!job)    { res.status(404).json({ error: 'import job not found' }); return }
      if (job.cancelled_at) {
        res.status(409).json({ error: 'job is cancelled' }); return
      }
      if (job.status !== 'dry_run') {
        res.status(409).json({ error: `commit only valid from status=dry_run (current: ${job.status})` })
        return
      }

      // Flip status server-side (service role bypasses RLS).
      const { error: updErr } = await supabase
        .from('contact_import_jobs')
        .update({ status: 'executing', started_at: new Date().toISOString() })
        .eq('id', job.id)
        .eq('tenant_id', tenantId)
      if (updErr) { res.status(500).json({ error: updErr.message }); return }

      try { await enqueueImport?.(job.id) } catch (e: any) {
        console.warn(`[contact-import] commit enqueue failed for job ${job.id}: ${e?.message ?? e}`)
      }
      res.json({ success: true, job_id: job.id, status: 'executing' })
    },
  )

  // ── Cancel (pending or dry_run only) ──────────────────────────────────────
  r.post('/api/contacts/import/:id/cancel',
    requireAuth, identifyTenant, checkPermission('leads', 'edit'),
    async (req, res) => {
      const tenantId = (req as any).tenantId
      const { data: job, error: loadErr } = await supabase
        .from('contact_import_jobs')
        .select('id, status, cancelled_at')
        .eq('id', req.params.id)
        .eq('tenant_id', tenantId)
        .maybeSingle()
      if (loadErr) { res.status(500).json({ error: loadErr.message }); return }
      if (!job)    { res.status(404).json({ error: 'import job not found' }); return }
      if (job.cancelled_at) {
        res.json({ success: true, job_id: job.id, already_cancelled: true })
        return
      }
      if (job.status !== 'pending' && job.status !== 'dry_run') {
        res.status(409).json({ error: `cancel only valid from status=pending|dry_run (current: ${job.status})` })
        return
      }
      const nowIso = new Date().toISOString()
      const { error: updErr } = await supabase
        .from('contact_import_jobs')
        .update({ status: 'cancelled', cancelled_at: nowIso })
        .eq('id', job.id)
        .eq('tenant_id', tenantId)
      if (updErr) { res.status(500).json({ error: updErr.message }); return }
      res.json({ success: true, job_id: job.id, cancelled_at: nowIso })
    },
  )

  return r
}
