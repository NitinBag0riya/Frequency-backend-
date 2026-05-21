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
import { getTableSchema, listRecords, airtableFieldToLeadType } from '../lib/airtable'
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
}).strict()

const MirrorAirtableSchema = z.object({
  base_id:  z.string().min(10),       // 'appXXXXXXXXXXXXXX'
  table_id: z.string().min(1),        // either 'tblXXX' or human name
  view:     z.string().optional(),    // optional Airtable view to filter by
  /** If set, attach to existing lead_table; else create fresh from schema. */
  lead_table_id: z.string().uuid().optional(),
  suggested_name: z.string().max(200).optional(),
  sync_interval_minutes: z.number().int().min(1).max(1440).optional(),
}).strict()

// `.strict()` rejects unknown keys → callers can't sneak `tenant_id`,
// `user_id`, `id`, `lead_table_id`, `created_at` etc. into the UPDATE via
// the spread below. The .eq('tenant_id', ...) only filters the target row,
// so without strict() a PATCH could re-tenant the subscription.
const PatchSubSchema = z.object({
  status: z.enum(['active', 'paused']).optional(),
  sync_interval_minutes: z.number().int().min(1).max(1440).optional(),
  // Pin a saved field mapping to be auto-applied on every sync tick. NULL
  // clears the pin (worker falls back to legacy keyify/column_mappings).
  // Tenant ownership is enforced below before the UPDATE lands.
  default_mapping_id: z.string().uuid().nullable().optional(),
}).strict()

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
      // `validateBody` replaced req.body with the parsed (strict-stripped)
      // result. Bind to a typed local so the spread visibly says "spread
      // the validated patch" — `tenant_id`, `id`, `lead_table_id`,
      // `created_at` etc. were already 400'd by PatchSubSchema's .strict()
      // and can't land in the UPDATE. See SECURITY CONTRACT in src/validation.ts.
      const patch = req.body as z.infer<typeof PatchSubSchema>
      // Tenant-scope the pinned mapping. A caller from tenant A must not be
      // able to pin tenant B's mapping; .strict() prevented spoofing
      // tenant_id, but the FK target value itself still needs validation.
      if (patch.default_mapping_id) {
        const { data: mp, error: mpErr } = await supabase
          .from('lead_field_mappings')
          .select('id').eq('id', patch.default_mapping_id).eq('tenant_id', tenantId).maybeSingle()
        if (mpErr) { res.status(500).json({ error: mpErr.message }); return }
        if (!mp)   { res.status(400).json({ error: 'default_mapping_id does not belong to this tenant' }); return }
      }
      const { data, error } = await supabase.from('data_source_subscriptions')
        .update({ ...patch, updated_at: new Date().toISOString() })
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

        // Bug fix — dedupe keys so headers like ["Name","name","NAME"] don't
        // collide on the (table_id, key) unique constraint. We append a
        // numeric suffix to the second+ occurrence.
        const seen = new Map<string, number>()
        const cols = headerRow.map((label, i) => {
          const baseKey = keyify(String(label || `col_${i + 1}`))
          const count = seen.get(baseKey) ?? 0
          seen.set(baseKey, count + 1)
          const finalKey = count === 0 ? baseKey : `${baseKey}_${count + 1}`
          return {
            tenant_id:   tenantId,
            user_id:     userId,
            table_id:    table.id,
            name:        String(label || `Column ${i + 1}`).slice(0, 100),
            key:         finalKey,
            type:        'text',
            is_primary:  i === 0,
            is_required: false,
            position:    i,
          }
        })
        if (cols.length > 0) {
          // Bug fix — check the insert error explicitly. Previously a
          // failure here (constraint violation, RLS denial, etc.) was
          // silently swallowed, leaving the user with an orphan lead_table
          // and no columns. Now we clean up and 500 with the real cause.
          const { error: colErr } = await supabase.from('lead_columns').insert(cols)
          if (colErr) {
            // Roll back the just-created table so the user can retry cleanly.
            await supabase.from('lead_tables').delete().eq('id', table.id)
            res.status(500).json({ error: `Failed to create columns: ${colErr.message}` })
            return
          }
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

      // 5. Run the first import inline. On failure, surface the actual error
      //    in the response — previously the response returned 200 with the
      //    sub snapshot even when the import had crashed, leaving the user
      //    with an empty table and no idea why. The worker retries every
      //    5 min so this is still recoverable, but the FE should know.
      let importResult: { imported: number; updated: number; error?: string }
      try {
        const result = await runFirstImport({ supabase, sub, headerRow, dataRows, tenantId, userId, tableId: table.id })
        await supabase.from('data_source_subscriptions').update({
          last_synced_at: new Date().toISOString(),
          next_sync_at:   new Date(Date.now() + (sub.sync_interval_minutes * 60_000)).toISOString(),
          rows_imported:  result.imported,
          rows_updated:   result.updated,
        }).eq('id', sub.id)
        importResult = result
      } catch (err: any) {
        const errorMessage = err?.message ?? String(err)
        await supabase.from('data_source_subscriptions').update({
          status: 'error', last_error: errorMessage,
        }).eq('id', sub.id)
        importResult = { imported: 0, updated: 0, error: errorMessage }
      }

      res.json({
        subscription: sub,
        lead_table: table,
        import: importResult,
      })
    })

  // ── Mirror an Airtable table ──────────────────────────────────────────────
  // Same shape as the Google Sheets mirror: read schema → infer columns →
  // create lead_table (or attach to existing) → register subscription →
  // run first import inline → return both. Sync worker handles ongoing pulls.
  r.post('/api/data-sources/airtable/mirror',
    requireAuth, identifyTenant, checkPermission('integrations', 'edit'),
    validateBody(MirrorAirtableSchema),
    async (req, res) => {
      const tenantId = (req as any).tenantId
      const userId   = (req as any).user.id
      const { base_id, table_id, view, suggested_name, sync_interval_minutes, lead_table_id } =
        req.body as z.infer<typeof MirrorAirtableSchema>

      // 1. Fetch table schema (validates Airtable connected + table exists).
      let schema
      try { schema = await getTableSchema(supabase, tenantId, base_id, table_id) }
      catch (err: any) { res.status(400).json({ error: `Couldn't read Airtable table: ${err.message}` }); return }
      if (!schema.fields || schema.fields.length === 0) {
        res.status(400).json({ error: `Table "${schema.name}" has no fields.` }); return
      }

      // 2. Resolve target lead_table — reuse or create.
      let table: { id: string; name: string }
      if (lead_table_id) {
        const { data: existing } = await supabase.from('lead_tables').select('id, name')
          .eq('id', lead_table_id).eq('tenant_id', tenantId).maybeSingle()
        if (!existing) { res.status(404).json({ error: 'lead_table not found' }); return }
        table = existing
      } else {
        const tableName = (suggested_name?.trim() || schema.name).slice(0, 200)
        const { data: created, error: createErr } = await supabase.from('lead_tables').insert({
          tenant_id: tenantId,
          user_id:   userId,
          name:      tableName,
          description: `Mirrored from Airtable base ${base_id} · table "${schema.name}"`,
          source:    'airtable',
          source_config: { base_id, table_id: schema.id, table_name: schema.name, view },
        }).select('id, name').single()
        if (createErr || !created) {
          res.status(500).json({ error: createErr?.message ?? 'Failed to create lead_table' }); return
        }
        table = created

        // Build columns from Airtable schema. Type-coerce best-effort via
        // airtableFieldToLeadType — user can change later from Columns tab.
        const cols = schema.fields.map((f, i) => ({
          tenant_id:   tenantId,
          user_id:     userId,
          table_id:    table.id,
          name:        f.name.slice(0, 100),
          key:         keyify(f.name),
          type:        airtableFieldToLeadType(f.type),
          is_primary:  i === 0,
          is_required: false,
          position:    i,
        }))
        if (cols.length > 0) await supabase.from('lead_columns').insert(cols)
      }

      // 3. Subscription row. column_mappings = airtable field name → our key
      // so the sync worker doesn't have to reconcile per call.
      const fieldNameToKey = Object.fromEntries(schema.fields.map(f => [f.name, keyify(f.name)]))
      const { data: sub, error: subErr } = await supabase.from('data_source_subscriptions').insert({
        tenant_id:     tenantId,
        lead_table_id: table.id,
        source_type:   'airtable',
        source_config: { base_id, table_id: schema.id, table_name: schema.name, view },
        column_mappings: fieldNameToKey,
        sync_interval_minutes: sync_interval_minutes ?? 5,
        next_sync_at: new Date().toISOString(),
        status: 'active',
        created_by: userId,
      }).select().single()
      if (subErr || !sub) {
        res.status(500).json({ error: subErr?.message ?? 'Failed to create subscription' })
        return
      }

      // Backlink so the FE Source tab shows "live mirror" pill on the table
      await supabase.from('lead_tables')
        .update({ synced_from_subscription_id: sub.id, updated_at: new Date().toISOString() })
        .eq('id', table.id)

      // 4. Inline first import — pull one page (100 records) so the user
      // sees data immediately. Worker pages through more on its tick.
      //
      // Idempotency: stash Airtable's stable record.id into data.airtable_record_id
      // and pre-check existing rows before inserting. Without this, a user
      // double-clicking "Mirror" (or a network blip causing the FE to retry)
      // would create 200 duplicate rows in the new lead_table. Same dedup
      // strategy the sync worker uses for ongoing pulls.
      try {
        const { records } = await listRecords(supabase, tenantId, base_id, schema.id, { view, pageSize: 100 })
        if (records.length === 0) {
          await supabase.from('data_source_subscriptions').update({
            last_synced_at: new Date().toISOString(),
            next_sync_at:   new Date(Date.now() + (sub.sync_interval_minutes * 60_000)).toISOString(),
            rows_imported:  0,
          }).eq('id', sub.id)
        } else {
          // Find any rows already imported for this table (handles the
          // double-click + reuse-existing-table cases together).
          const { data: existingRows } = await supabase.from('lead_rows')
            .select('data->>airtable_record_id')
            .eq('table_id', table.id)
            .eq('tenant_id', tenantId)
            .limit(10000)
          const existingIds = new Set((existingRows ?? []).map((r: any) => r.airtable_record_id).filter(Boolean))

          const inserts = records
            .filter(rec => !existingIds.has(rec.id))
            .map(rec => ({
              tenant_id: tenantId,
              user_id:   userId,
              table_id:  table.id,
              data:      {
                airtable_record_id: rec.id,
                ...Object.fromEntries(Object.entries(rec.fields).map(([k, v]) => [
                  fieldNameToKey[k] ?? keyify(k),
                  v == null ? '' : (typeof v === 'object' ? JSON.stringify(v) : String(v)),
                ])),
              },
              status:    'new',
              tags:      [],
              ingest_source: 'sync',
            }))

          if (inserts.length > 0) {
            await supabase.from('lead_rows').insert(inserts)
          }
          await supabase.from('data_source_subscriptions').update({
            last_synced_at: new Date().toISOString(),
            next_sync_at:   new Date(Date.now() + (sub.sync_interval_minutes * 60_000)).toISOString(),
            rows_imported:  inserts.length,
          }).eq('id', sub.id)
        }
      } catch (err: any) {
        // First import failed — keep the subscription so the worker retries.
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
  // Dedupe keys the same way mirror() does, so column→data alignment stays
  // consistent with the columns we just inserted.
  const seen = new Map<string, number>()
  const keys = headerRow.map((label, i) => {
    const base = keyify(String(label || `col_${i + 1}`))
    const count = seen.get(base) ?? 0
    seen.set(base, count + 1)
    return count === 0 ? base : `${base}_${count + 1}`
  })
  const primaryKey = keys[0]
  if (!primaryKey) return { imported: 0, updated: 0 }

  // ── Set-based dedupe ────────────────────────────────────────────────
  // Previously this function ran ONE SELECT per data row (N+1) — a 500-row
  // sheet meant 500 round-trips serialized over the Supabase REST API.
  // That routinely blew past Express's 120s default and made the import
  // appear to "silently fail". We now batch-fetch existing primary
  // values in a single round-trip per table and dedupe in memory.
  const existingPrimaryValues = new Set<string>()
  {
    // Paginate the existing-row fetch in case the table is huge. 1000 at
    // a time keeps the URL filter list under PostgREST's typical 8KB cap.
    const PAGE = 1000
    let offset = 0
    while (true) {
      const { data: page, error } = await supabase.from('lead_rows')
        .select('data')
        .eq('table_id', tableId)
        .range(offset, offset + PAGE - 1)
      if (error) throw new Error(`failed to fetch existing rows: ${error.message}`)
      if (!page || page.length === 0) break
      for (const r of page) {
        const v = (r as any).data?.[primaryKey]
        if (typeof v === 'string' && v.trim()) existingPrimaryValues.add(v.trim())
      }
      if (page.length < PAGE) break
      offset += PAGE
    }
  }

  // Build the new rows in memory, then bulk-insert in batches.
  const toInsert: Array<{ tenant_id: string; user_id: string; table_id: string; data: Record<string,string>; status: string; tags: string[] }> = []
  const seenInThisImport = new Set<string>()
  for (const row of dataRows) {
    const data: Record<string, string> = {}
    for (let i = 0; i < keys.length; i++) {
      data[keys[i]] = String(row[i] ?? '')
    }
    const pv = data[primaryKey]?.trim()
    if (!pv) continue
    if (existingPrimaryValues.has(pv)) continue
    if (seenInThisImport.has(pv)) continue  // dedupe within this single import too
    seenInThisImport.add(pv)
    toInsert.push({
      tenant_id: tenantId, user_id: userId, table_id: tableId,
      data, status: 'new', tags: [],
    })
  }

  // Bulk insert in batches of 500. Past the inflight Postgres connection
  // limit this would otherwise queue arbitrarily — staying under 1MB
  // payload also avoids Supabase's edge limit.
  let imported = 0
  const BATCH = 500
  for (let i = 0; i < toInsert.length; i += BATCH) {
    const batch = toInsert.slice(i, i + BATCH)
    const { error } = await supabase.from('lead_rows').insert(batch)
    if (error) throw new Error(`row insert batch ${i}-${i + batch.length} failed: ${error.message}`)
    imported += batch.length
  }
  return { imported, updated: 0 }
}
