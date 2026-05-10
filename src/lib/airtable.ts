/**
 * Airtable read helpers — kept separate from the connector router so the
 * data-source mirror endpoint + the sync worker can call them without
 * pulling in the full router module.
 *
 * All endpoints follow Airtable's REST API:
 *   GET https://api.airtable.com/v0/meta/bases/:baseId/tables  → schema
 *   GET https://api.airtable.com/v0/:baseId/:tableId           → records (paginated)
 *
 * Records page-size = 100 (Airtable max). Mirror endpoint pulls one page
 * for the inline first import; the sync worker pages through everything
 * on each tick.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { getValidToken } from '../routes/connectors/airtable'

const AIR = 'https://api.airtable.com/v0'

export interface AirtableField {
  id:   string
  name: string
  type: string  // 'singleLineText', 'multilineText', 'number', 'email', 'phoneNumber', 'date', etc.
}

export interface AirtableTableSchema {
  id:     string
  name:   string
  fields: AirtableField[]
}

export interface AirtableRecord {
  id:        string
  createdTime: string
  fields:    Record<string, unknown>
}

/**
 * Fetch the schema (fields list) for a single table within a base. The
 * `meta/bases/:baseId/tables` endpoint returns all tables; we filter by id.
 */
export async function getTableSchema(
  supabase: SupabaseClient,
  tenantId: string,
  baseId: string,
  tableId: string,
): Promise<AirtableTableSchema> {
  const token = await getValidToken(supabase, tenantId)
  const res = await fetch(`${AIR}/meta/bases/${baseId}/tables`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  const body = await res.json() as any
  if (!res.ok) throw new Error(body?.error?.message ?? body?.error ?? `Airtable error (${res.status})`)
  const tables = (body.tables ?? []) as AirtableTableSchema[]
  // tableId can be either the literal Airtable id (tblXXX) or the table name.
  // Match either so callers don't have to know which the user picked.
  const table = tables.find(t => t.id === tableId) ?? tables.find(t => t.name === tableId)
  if (!table) throw new Error(`Table "${tableId}" not found in base ${baseId}`)
  return table
}

/**
 * Fetch ONE page of records (up to 100) from a table. Returns the records
 * + an `offset` token to pass to the next call (or null if final page).
 *
 * The mirror endpoint reads one page inline so the user sees data
 * immediately. The sync worker iterates through pages on its tick.
 */
export async function listRecords(
  supabase: SupabaseClient,
  tenantId: string,
  baseId: string,
  tableId: string,
  opts: { offset?: string; pageSize?: number; view?: string } = {},
): Promise<{ records: AirtableRecord[]; offset: string | null }> {
  const token = await getValidToken(supabase, tenantId)
  const params = new URLSearchParams()
  params.set('pageSize', String(Math.min(100, Math.max(1, opts.pageSize ?? 100))))
  if (opts.offset) params.set('offset', opts.offset)
  if (opts.view)   params.set('view', opts.view)
  const res = await fetch(`${AIR}/${baseId}/${encodeURIComponent(tableId)}?${params}`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  const body = await res.json() as any
  if (!res.ok) throw new Error(body?.error?.message ?? body?.error ?? `Airtable error (${res.status})`)
  return {
    records: (body.records ?? []) as AirtableRecord[],
    offset:  body.offset ?? null,
  }
}

/**
 * Page through ALL records in a table — returns a flat array. Used by the
 * sync worker for full re-pulls. Bounded at maxPages × 100 records to
 * avoid unbounded memory if a tenant points at a 10M-record base.
 */
export async function listAllRecords(
  supabase: SupabaseClient,
  tenantId: string,
  baseId: string,
  tableId: string,
  opts: { view?: string; maxPages?: number } = {},
): Promise<AirtableRecord[]> {
  const out: AirtableRecord[] = []
  let offset: string | null = null
  const maxPages = opts.maxPages ?? 50  // 50 × 100 = 5000-record cap per sync
  for (let page = 0; page < maxPages; page++) {
    const res = await listRecords(supabase, tenantId, baseId, tableId, {
      offset: offset ?? undefined,
      pageSize: 100,
      view: opts.view,
    })
    out.push(...res.records)
    if (!res.offset) break
    offset = res.offset
  }
  return out
}

/** Map Airtable field type → our lead_columns.type enum. Best-effort coerce
 *  on first import; users can change later from the Columns tab. */
export function airtableFieldToLeadType(fieldType: string): string {
  switch (fieldType) {
    case 'number':
    case 'currency':
    case 'percent':
    case 'count':
    case 'rating':              return 'number'
    case 'email':               return 'email'
    case 'phoneNumber':         return 'phone'
    case 'url':                 return 'url'
    case 'date':
    case 'dateTime':            return 'date'
    case 'checkbox':            return 'boolean'
    case 'singleSelect':
    case 'multipleSelects':     return 'select'
    case 'multilineText':
    case 'richText':            return 'textarea'
    default:                    return 'text'
  }
}
