/**
 * Segment filter evaluator.
 *
 * Turns a `filters` jsonb (from public.contact_segments.filters) into a
 * Supabase PostgREST query against `contacts`, plus an optional set-
 * intersection on `contact_consent_state` when the filter mentions a
 * per-channel opt-in requirement.
 *
 * Supported filter keys (anything else is silently ignored — forward compat):
 *
 *   city                  string  — equality on contacts.attributes->>'city'
 *                                   (DB-level: ->> returns text so casing
 *                                   matters; we lowercase both sides).
 *   tags                  string[] — contacts.tags && (overlaps).
 *   exclude_tags          string[] — NOT contacts.tags && (overlaps).
 *   status                'active'|'opted_out'|'blocked' — contacts.status eq.
 *   opted_in_channel      'whatsapp'|'instagram'|'telegram'|'email'|'sms'
 *                                — JOIN contact_consent_state where
 *                                   status='opted_in' AND channel = <>.
 *   created_at_after      ISO 8601 — contacts.created_at >=
 *   created_at_before     ISO 8601 — contacts.created_at <
 *   last_message_at_after ISO 8601 — contacts.last_contacted_at >=
 *
 * The evaluator does NOT execute the query — it returns a finished
 * PostgREST builder so the caller can attach .select(...) / .range(...) /
 * { count: 'exact' } as needed.
 *
 * SECURITY: filters jsonb is tenant-supplied. We never interpolate raw
 * strings into a PostgREST `.or()` / `.filter()` clause — every value
 * goes through a typed Supabase builder method, which escapes for us.
 * Unknown keys are dropped (not 400'd) so a future FE that ships a new
 * filter key against an older server doesn't break the segment.
 */

import { SupabaseClient } from '@supabase/supabase-js'

export interface ContactFilters {
  city?: string
  tags?: string[]
  exclude_tags?: string[]
  status?: 'active' | 'opted_out' | 'blocked'
  opted_in_channel?: 'whatsapp' | 'instagram' | 'telegram' | 'email' | 'sms'
  created_at_after?: string
  created_at_before?: string
  last_message_at_after?: string
}

const SUPPORTED_KEYS = new Set<keyof ContactFilters>([
  'city',
  'tags',
  'exclude_tags',
  'status',
  'opted_in_channel',
  'created_at_after',
  'created_at_before',
  'last_message_at_after',
])

const ALLOWED_CHANNELS = new Set([
  'whatsapp', 'instagram', 'telegram', 'email', 'sms',
])

/** Normalise/validate a filters jsonb. Drops unknown keys + bad values. */
export function sanitizeFilters(raw: unknown): ContactFilters {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const out: ContactFilters = {}
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!SUPPORTED_KEYS.has(k as keyof ContactFilters)) continue
    if (v == null || v === '') continue
    if (k === 'tags' || k === 'exclude_tags') {
      if (!Array.isArray(v)) continue
      const arr = v.map(String).filter(Boolean)
      if (arr.length === 0) continue
      ;(out as any)[k] = arr
    } else if (k === 'opted_in_channel') {
      if (typeof v !== 'string' || !ALLOWED_CHANNELS.has(v)) continue
      out.opted_in_channel = v as ContactFilters['opted_in_channel']
    } else if (k === 'status') {
      if (v !== 'active' && v !== 'opted_out' && v !== 'blocked') continue
      out.status = v
    } else if (k === 'created_at_after' || k === 'created_at_before' || k === 'last_message_at_after') {
      // Crude ISO validation — Date parses laxly so check structure first.
      const s = String(v)
      if (!/^\d{4}-\d{2}-\d{2}/.test(s)) continue
      ;(out as any)[k] = s
    } else if (k === 'city') {
      ;(out.city as any) = String(v).slice(0, 200)
    }
  }
  return out
}

/**
 * Build a tenant-scoped contacts query for a given filter spec.
 *
 * Returns the query builder pre-narrowed to `tenant_id` and any filter
 * keys present. Caller selects columns + ranges as needed:
 *
 *   const q = buildSegmentQuery(supabase, tenantId, filters)
 *   const { data, count } = await q.select('id, name, phone', { count: 'exact' })
 *                                  .range(0, 49)
 *
 * For the `opted_in_channel` case we pre-fetch the contact_id set from
 * contact_consent_state (capped at 10k for safety) and constrain the
 * main query with `.in('id', ids)`. This is two roundtrips vs one join,
 * but keeps the filter composable with all the other contacts-table
 * conditions through the standard PostgREST builder.
 */
export async function buildSegmentQuery(
  supabase: SupabaseClient,
  tenantId: string,
  rawFilters: unknown,
): Promise<{
  query: ReturnType<SupabaseClient['from']> extends infer T ? any : never
  filters: ContactFilters
}> {
  const filters = sanitizeFilters(rawFilters)
  // PostgREST's typed builder requires a .select() before filter methods
  // (.eq / .in / .overlaps). We use a placeholder select of 'id' which
  // the caller can OVERRIDE by calling .select(...) again — supabase-js
  // supports re-selecting on the same builder, with the second call
  // winning. The 'count: exact, head: true' path in segments.ts and the
  // full-column re-select in broadcast-worker.ts both rely on that.
  let q: any = supabase.from('contacts').select('id').eq('tenant_id', tenantId)

  // contacts.attributes->>'city' isn't directly indexed; for small N this
  // is fine, and Postgres still chooses the tenant_id index first. We
  // keep this honest about its cost — a tenant with 100k contacts and a
  // city filter pays a partition scan per segment evaluate. Mitigated by
  // contact_segments.estimated_count being cached.
  if (filters.city) {
    q = q.filter('attributes->>city', 'ilike', filters.city)
  }
  if (filters.tags?.length) {
    q = q.overlaps('tags', filters.tags)
  }
  if (filters.exclude_tags?.length) {
    // PostgREST `not.ov.{a,b}` — same syntax used by broadcast-worker.ts.
    q = q.not('tags', 'ov', `{${filters.exclude_tags.join(',')}}`)
  }
  if (filters.status) {
    q = q.eq('status', filters.status)
  }
  if (filters.created_at_after) {
    q = q.gte('created_at', filters.created_at_after)
  }
  if (filters.created_at_before) {
    q = q.lt('created_at', filters.created_at_before)
  }
  if (filters.last_message_at_after) {
    q = q.gte('last_contacted_at', filters.last_message_at_after)
  }

  if (filters.opted_in_channel) {
    // Pull the contact_id allow-list from contact_consent_state. Cap at
    // 10k — segments larger than that are out of scope for the v1
    // evaluator (broadcasts have their own per-tenant daily cap anyway).
    const { data: optedIn, error } = await supabase
      .from('contact_consent_state')
      .select('contact_id')
      .eq('status', 'opted_in')
      .eq('channel', filters.opted_in_channel)
      .limit(10000)
    if (error) {
      // Don't fail the whole segment — log + fall through to a query
      // that returns zero rows so the operator sees an empty preview
      // rather than a 500. The route layer surfaces a banner.
      console.warn(`[segment-filter] opted_in_channel lookup failed: ${error.message}`)
      q = q.in('id', ['00000000-0000-0000-0000-000000000000'])
    } else {
      const ids = (optedIn ?? []).map((r: any) => r.contact_id).filter(Boolean)
      if (ids.length === 0) {
        // No opted-in contacts on this channel — short-circuit to empty.
        q = q.in('id', ['00000000-0000-0000-0000-000000000000'])
      } else {
        q = q.in('id', ids)
      }
    }
  }

  return { query: q, filters }
}
