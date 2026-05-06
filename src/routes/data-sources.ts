/**
 * Data-source mirroring routes.
 *
 *   POST /api/data-sources/google-sheet/mirror
 *     Imports a Google Sheet into a new (or existing) lead_table and
 *     registers a subscription that the data-source-sync worker re-runs
 *     every `sync_interval_minutes` minutes.
 *
 *   GET    /api/data-sources                  — list this tenant's subs
 *   GET    /api/data-sources/:id              — single subscription + status
 *   PATCH  /api/data-sources/:id              — toggle active/paused
 *   DELETE /api/data-sources/:id              — remove subscription (keeps lead_table)
 *   POST   /api/data-sources/:id/sync         — trigger an immediate re-sync
 *
 * The actual sync logic lives in workers/data-source-sync.ts so this router
 * stays thin and the heavy I/O happens off the request thread.
 */

import express from 'express'
import { z } from 'zod'
import { SupabaseClient } from '@supabase/supabase-js'
import { sheetsGetMetadata, sheetsReadRange } from '../google'
import { validateBody } from '../validation'

type Middleware = (req: express.Request, res: express.Response, next: express.NextFunction) => void | Promise<void>

interface Deps {
  supabase: SupabaseClient
  requireAuth: Middleware
  identifyTenant: Middleware
  checkPermission: (feature: string, action: 'view' | 'edit' | 'delete') => Middleware
  /** Hook to enqueue a sync job — keeps this router decoupled from BullMQ. */
  enqueueSyncNow?: (subscriptionId: string) => Promise<void>
}

const MirrorGoogleSheetSchema = z.object({
  spreadsheet_id: z.string().min(10),
  tab_name: z.string().nullable().optional(),
  /** If set, attach the subscription to an existing lead_table (will not
   *  delete its existing rows; new ones are upserted). Otherwise we create
   *  a fresh lead_table from the sheet's headers. */
  lead_table_id: z.string().uuid().optional(),
  suggested_name: z.string().max(200).optional(),
  sync_interval_minutes: z.number().int().min(1).max(1440).optional(),
})

const PatchSubSchema = z.object({
  status: z.enum(['active', 'paused']).optional(),
  sync_interval_minutes: z.number().int().min(1).max(1440).optional(),
})

export function createDataSourcesRouter(deps: Deps): express.Router {
  const r = express.Router()
  const { supabase, requireAuth, identifyTenant, checkPermission, enqueueSyncNow } = deps

  // ── List ──────────────────────────────────────────────────────────────────
  r.get('/api/data-sources',
    requireAuth, identifyTenant, checkPermission('integrations', 'view'),
    async (req, res) => {
      const tenantId = (req as any).tenantId
      const { data, error } = await supabase.from('data_source_subscriptions').select('*')
        .eq('tenant_id', tenantId).order('created_at', { ascending: false })
      if (error) { res.status(500).json({ error: error.message }); return }
      res.json(data ?? [])
    })

  r.get('/api/data-sources/:id',
    requireAuth, identifyTenant, checkPermission('integrations', 'view'),
    async (req, res) => {
      const tenantId = (req as any).tenantId
      const { data, error } = await supabase.from('data_source_subscriptions').select('*')
        .eq('id', req.params.id).eq('tenant_id', tenantId).maybeSingle()
      if (error)  { res.status(500).json({ error: error.message }); return }
      if (!data)  { res.status(404).json({ error: 'subscription not found' }); return }
      res.json(data)
    })

  r.patch('/api/data-sources/:id',
    requireAuth, identifyTenant, checkPermission('integrations', 'edit'),
    validateBody(PatchSubSchema),
    async (req, res) => {
      const tenantId = (req as any).tenantId
      const { data, error } = await supabase.from('data_source_subscriptions')
        .update({ ...req.body, updated_at: new Date().toISOString() })
        .eq('id', req.params.id).eq('tenant_id', tenantId)
        .select().maybeSingle()
      if (error) { res.status(500).json({ error: error.message }); return }
      if (!data) { res.status(404).json({ error: 'subscription not found' }); return }
      res.json(data)
    })

  r.delete('/api/data-sources/:id',
    requireAuth, identifyTenant, checkPermission('integrations', 'delete'),
    async (req, res) => {
      const tenantId = (req as any).tenantId
      const { error } = await supabase.from('data_source_subscriptions')
        .delete().eq('id', req.params.id).eq('tenant_id', tenantId)
      if (error) { res.status(500).json({ error: error.message }); return }
      res.json({ success: true })
    })

  // ── Trigger immediate re-sync ─────────────────────────────────────────────
  r.post('/api/data-sources/:id/sync',
    requireAuth, identifyTenant, checkPermission('integrations', 'edit'),
    async (req, res) => {
      const tenantId = (req as any).tenantId
      const { data: sub } = await supabase.from('data_source_subscriptions')
        .select('id').eq('id', req.params.id).eq('tenant_id', tenantId).maybeSingle()
      if (!sub) { res.status(404).json({ error: 'subscription not found' }); return }
      // Set next_sync_at to now() so the poller picks it up on the next 5-min tick.
      await supabase.from('data_source_subscriptions').update({
        next_sync_at: new Date().toISOString(),
        status: 'active',
        last_error: null,
      }).eq('id', sub.id)
      try { await enqueueSyncNow?.(sub.id) } catch { /* swallow */ }
      res.json({ queued: true })
    })

  // ── Mirror a Google Sheet (the headline feature) ──────────────────────────
  r.post('/api/data-sources/google-sheet/mirror',
    requireAuth, identifyTenant, checkPermission('integrations', 'edit'),
    validateBody(MirrorGoogleSheetSchema),
    async (req, res) => {
      const tenantId = (req as any).tenantId
      const userId   = (req as any).user.id
      const { spreadsheet_id, tab_name, suggested_name, sync_interval_minutes, lead_table_id } = req.body as z.infer<typeof MirrorGoogleSheetSchema>

      // 1. Load tenant for Google credentials
      const { data: tenant } = await supabase.from('tenants').select('*').eq('id', tenantId).maybeSingle()
      if (!tenant?.google_access_token) {
        res.status(400).json({ error: 'Google account not connected. Connect Google Drive first.' })
        return
      }

      // 2. Read sheet metadata + first row of the chosen tab to infer columns
      let meta: any
      try { meta = await sheetsGetMetadata(tenant, spreadsheet_id) }
      catch (err: any) { res.status(400).json({ error: `Couldn't read spreadsheet: ${err.message}` }); return }

      const sheets = (meta.sheets ?? []) as any[]
      const targetSheetMeta = (tab_name ? sheets.find(s => s?.properties?.title === tab_name) : sheets[0])
        ?? sheets[0]
      if (!targetSheetMeta) {
        res.status(400).json({ error: 'Spreadsheet has no tabs.' }); return
      }
      const tabActual: string = targetSheetMeta.properties?.title ?? 'Sheet1'

      // Read the header row + a sample of data so we can build columns + initial rows.
      let values: string[][] = []
      try { values = await sheetsReadRange(tenant, spreadsheet_id, `${tabActual}!1:5000`) }
      catch (err: any) { res.status(400).json({ error: `Couldn't read sheet rows: ${err.message}` }); return }
      const [headerRow = [], ...dataRows] = values
      if (headerRow.length === 0) {
        res.status(400).json({ error: `Tab "${tabActual}" appears empty.` }); return
      }

      // 3. Resolve the lead_table — either reuse one or create new.
      let table: { id: string; name: string }
      if (lead_table_id) {
        const { data: existing } = await supabase.from('lead_tables').select('id, name')
          .eq('id', lead_table_id).eq('tenant_id', tenantId).maybeSingle()
        if (!existing) { res.status(404).json({ error: 'lead_table not found' }); return }
        table = existing
      } else {
        const tableName = (suggested_name?.trim() || meta.properties?.title || 'Synced Sheet').slice(0, 200)
        const { data: created, error: createErr } = await supabase.from('lead_tables').insert({
          tenant_id: tenantId,
          user_id:   userId,
          name:      tableName,
          description: `Mirrored from Google Sheet "${meta.properties?.title ?? ''}" · tab "${tabActual}"`,
          source:    'google_sheets',
          source_config: { spreadsheet_id, tab_name: tabActual },
        }).select('id, name').single()
        if (createErr || !created) {
          res.status(500).json({ error: createErr?.message ?? 'Failed to create lead_table' })
          return
        }
        table = created

        // Build columns from the header row.
        const cols = headerRow.map((label, i) => ({
          tenant_id:   tenantId,
          user_id:     userId,
          table_id:    table.id,
          name:        String(label || `Column ${i + 1}`).slice(0, 100),
          key:         keyify(String(label || `col_${i + 1}`)),
          type:        'text',
          is_primary:  i === 0,
          is_required: false,
          position:    i,
        }))
        if (cols.length > 0) {
          await supabase.from('lead_columns').insert(cols)
        }
      }

      // 4. Create the subscription row (next_sync_at = now() so poller pulls it on next tick).
      const { data: sub, error: subErr } = await supabase.from('data_source_subscriptions').insert({
        tenant_id: tenantId,
        lead_table_id: table.id,
        source_type:   'google_sheet',
        source_config: { spreadsheet_id, tab_name: tabActual, header_row: headerRow },
        column_mappings: Object.fromEntries(headerRow.map((h: string) => [h, keyify(h)])),
        sync_interval_minutes: sync_interval_minutes ?? 5,
        next_sync_at: new Date().toISOString(),
        status: 'active',
        created_by: userId,
      }).select().single()
      if (subErr || !sub) {
        res.status(500).json({ error: subErr?.message ?? 'Failed to create subscription' })
        return
      }

      // Backlink: lead_tables.synced_from_subscription_id
      await supabase.from('lead_tables')
        .update({ synced_from_subscription_id: sub.id, updated_at: new Date().toISOString() })
        .eq('id', table.id)

      // 5. Run the first import inline — best-effort; if it fails, the worker
      //    will retry within 5 minutes and surface the error in last_error.
      try {
        const result = await runFirstImport({ supabase, sub, headerRow, dataRows, tenantId, userId, tableId: table.id })
        await supabase.from('data_source_subscriptions').update({
          last_synced_at: new Date().toISOString(),
          next_sync_at:   new Date(Date.now() + (sub.sync_interval_minutes * 60_000)).toISOString(),
          rows_imported:  result.imported,
          rows_updated:   result.updated,
        }).eq('id', sub.id)
      } catch (err: any) {
        await supabase.from('data_source_subscriptions').update({
          status: 'error', last_error: err?.message ?? String(err),
        }).eq('id', sub.id)
      }

      res.json({ subscription: sub, lead_table: table })
    })

  return r
}

// ── helpers ──────────────────────────────────────────────────────────────────
function keyify(label: string): string {
  return String(label).toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 60) || 'col'
}

/** First-pass import: turn each data row into a lead_rows.data jsonb keyed by
 *  the column-mappings (header → key). Idempotent on re-run because we look
 *  up by the primary column value (first column) before inserting.
 *
 *  Rows with empty primary cell are skipped. */
async function runFirstImport(opts: {
  supabase: SupabaseClient
  sub: { id: string; column_mappings: Record<string, string> }
  headerRow: string[]
  dataRows: string[][]
  tenantId: string
  userId: string
  tableId: string
}) {
  const { supabase, headerRow, dataRows, tenantId, userId, tableId } = opts
  const keys = headerRow.map(keyify)
  const primaryKey = keys[0]

  let imported = 0
  for (const row of dataRows) {
    const data: Record<string, string> = {}
    for (let i = 0; i < keys.length; i++) {
      data[keys[i]] = String(row[i] ?? '')
    }
    if (!data[primaryKey]?.trim()) continue
    // Skip if a row with the same primary already exists (best-effort dedupe)
    const { data: existing } = await supabase.from('lead_rows')
      .select('id')
      .eq('table_id', tableId)
      .filter(`data->>${primaryKey}`, 'eq', data[primaryKey])
      .limit(1)
      .maybeSingle()
    if (existing) continue
    await supabase.from('lead_rows').insert({
      tenant_id: tenantId, user_id: userId, table_id: tableId,
      data, status: 'new', tags: [],
    })
    imported++
  }
  return { imported, updated: 0 }
}
