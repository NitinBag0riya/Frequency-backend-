/**
 * Check-before-create guard — "look at what we already have in hand before
 * making another one." Before a create endpoint inserts a new template / WA Flow
 * / broadcast (WhatsApp, Telegram, …), it asks this guard whether a same-named
 * resource already exists for the tenant. If one does and the caller hasn't
 * explicitly confirmed, the endpoint returns 409 with the existing row so the UI
 * can keep a human in the loop: "Reuse this, or create another?" Resending with
 * ?confirm=true (or { confirm: true }) overrides.
 *
 * Read-only. The match is a case-insensitive name compare scoped to the tenant
 * (plus any extra equality filters — channel, language, …) so it never crosses
 * tenants and never blocks a genuinely different resource.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Request } from 'express'

export interface DuplicateMatch {
  id: string
  name: string
  status?: string | null
  created_at?: string | null
  [k: string]: any
}

/**
 * Return an existing same-named row for this tenant, or null. `extra` adds
 * equality filters (e.g. { channel: 'telegram' } or { language: 'en_US' }) so
 * the dedup key matches how the resource is actually uniquely identified.
 */
export async function findDuplicateByName(
  supabase: SupabaseClient,
  table: string,
  tenantId: string,
  name: string,
  extra: Record<string, string> = {},
): Promise<DuplicateMatch | null> {
  const trimmed = String(name ?? '').trim()
  if (!trimmed) return null
  let q: any = supabase.from(table)
    .select('id, name, status, created_at')
    .eq('tenant_id', tenantId)
    .ilike('name', trimmed)            // case-insensitive exact (no wildcards in `trimmed`)
  for (const [k, v] of Object.entries(extra)) q = q.eq(k, v)
  const { data, error } = await q.limit(1)
  if (error) {
    // Never let a guard hiccup block a create — fail open, log, let the insert
    // (and its DB constraints) be the backstop.
    console.warn(`[dedupe-guard] lookup failed on ${table}: ${error.message}`)
    return null
  }
  return (Array.isArray(data) && data[0]) ? (data[0] as DuplicateMatch) : null
}

/** The 409 body every create endpoint returns on an unconfirmed duplicate. */
export function duplicateResponse(kind: string, existing: DuplicateMatch) {
  const status = existing.status ? ` (status: ${existing.status})` : ''
  return {
    duplicate: true,
    kind,
    existing,
    message: `A ${kind} named "${existing.name}" already exists${status}. Reuse it, or resend with confirm to create another.`,
  }
}

/**
 * Did the caller explicitly confirm "create anyway"? Checked from the query
 * string (?confirm=true) AND the body ({ confirm: true }) so it works whether or
 * not the create's validation schema strips unknown body keys. We keep the
 * override OUT of the body that gets inserted by reading it here, not by adding
 * it to the resource schema.
 */
export function isConfirmedCreate(req: Request): boolean {
  const q = (req.query?.confirm as string | undefined)
  const b = (req.body as any)?.confirm
  return q === 'true' || q === '1' || b === true || b === 'true'
}
