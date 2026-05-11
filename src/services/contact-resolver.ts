/**
 * Lead → Contact upsert service.
 *
 * Calling a contact is universal across the contacts table, but Leads live
 * in their own bag (lead_tables / leads) and don't carry an FK into
 * contacts. Before any outbound call from a Lead row, we promote the lead
 * into contacts by phone — idempotent so workflows / FE / explicit endpoint
 * can all call this on the same lead without duplicating rows.
 *
 * Design ref: `.calling-feature/think/01-backend-design.md` §9.
 *
 * Guardrail: this service runs AFTER existing lead inserts and never
 * mutates lead rows. It only writes to `contacts`. Failures are non-fatal —
 * the calling path logs and continues, so a transient DB hiccup doesn't
 * break lead creation for users who don't have calling enabled.
 *
 * Lead/contact linkage: the original lead row is referenced in
 * `contacts.attributes.source_lead_id` (JSONB). We chose to nest it rather
 * than add a column because the contacts table is shared with many
 * non-calling features and we don't want to fan migration risk to them.
 * Migration 035 adds a generated `is_callable` column but leaves identity
 * columns alone.
 */

import type { SupabaseClient } from '@supabase/supabase-js'

/** Shape of a lead row as it appears in `leads` (raw `data` JSONB). */
export interface LeadLike {
  id:         string
  name?:      string
  phone?:     string | null
  email?:     string | null
  tags?:      string[]
  source?:    string
  /** Raw lead_data blob — we look here for phone/name when top-level fields
   *  are not set (mirrors how `leads.data` is populated by the CSV / form
   *  ingest paths). */
  data?:      Record<string, any>
}

export interface ContactResolveResult {
  contact_id: string | null
  created:    boolean
  reason?:    string
}

/**
 * Normalise an Indian-ish phone number to the `+E164` shape we store in
 * contacts. Strips spaces, dashes, parens. Falls back to the input if we
 * can't parse — better to insert something the user can correct than to
 * silently drop a lead.
 */
function normalisePhone(raw: unknown): string | null {
  if (raw == null) return null
  const s = String(raw).trim()
  if (!s) return null
  const digits = s.replace(/[^\d+]/g, '')
  if (!digits) return null
  if (digits.startsWith('+')) return digits
  // India default: 10-digit local numbers get +91 prefix.
  if (/^\d{10}$/.test(digits)) return `+91${digits}`
  if (/^91\d{10}$/.test(digits)) return `+${digits}`
  // Anything else: assume already international, prefix with '+' to be safe.
  return digits.startsWith('+') ? digits : `+${digits}`
}

/**
 * Pull phone from the lead row, checking top-level first then the JSONB
 * `data` blob (handles both /api/leads manual creates and form/CSV ingest).
 */
function extractPhone(lead: LeadLike): string | null {
  const cand = lead.phone
            ?? lead.data?.phone
            ?? lead.data?.Phone
            ?? lead.data?.PHONE
            ?? lead.data?.mobile
            ?? lead.data?.Mobile
            ?? lead.data?.contact
  return normalisePhone(cand)
}

function extractName(lead: LeadLike): string {
  return (lead.name
       ?? lead.data?.name
       ?? lead.data?.Name
       ?? lead.data?.full_name
       ?? lead.data?.fullName
       ?? '').toString().trim()
      || 'Unknown'
}

function extractEmail(lead: LeadLike): string | null {
  const e = lead.email
         ?? lead.data?.email
         ?? lead.data?.Email
         ?? null
  if (!e) return null
  const s = String(e).trim()
  return s.length > 0 ? s : null
}

/**
 * Upsert a contact from a lead row. Safe to call repeatedly with the same
 * lead. Returns `{ contact_id: null }` (no-throw) when the lead carries no
 * phone — calling requires phone, so dropping silently is the correct UX:
 * the FE will gray out the Call button.
 *
 * Concurrency note: two simultaneous calls for the same lead can race on
 * the SELECT-then-INSERT. We mitigate by relying on the existing
 * `(tenant_id, phone)` unique index on contacts — the second INSERT trips
 * 23505 and we re-SELECT to return the surviving row. No advisory lock
 * needed; Postgres handles it.
 */
export async function upsertContactFromLead(
  supabase: SupabaseClient,
  tenantId: string,
  lead: LeadLike,
): Promise<ContactResolveResult> {
  if (!tenantId) return { contact_id: null, created: false, reason: 'missing_tenant_id' }
  if (!lead || !lead.id) return { contact_id: null, created: false, reason: 'missing_lead_id' }

  const phone = extractPhone(lead)
  if (!phone) return { contact_id: null, created: false, reason: 'missing_phone' }

  const name  = extractName(lead)
  const email = extractEmail(lead)
  const baseTags = Array.isArray(lead.tags) ? lead.tags : []
  const tags = Array.from(new Set([...baseTags, 'from_lead']))

  // 1) Look up by tenant_id + phone (matches the unique index).
  const { data: existing, error: selErr } = await supabase
    .from('contacts')
    .select('id, attributes, tags')
    .eq('tenant_id', tenantId)
    .eq('phone', phone)
    .maybeSingle()

  if (selErr) {
    console.warn(`[contact-resolver] select failed tenant=${tenantId} lead=${lead.id}: ${selErr.message}`)
    return { contact_id: null, created: false, reason: `select_failed:${selErr.message}` }
  }

  if (existing) {
    // 2) Existing contact — merge link metadata + tags. Silent (no realtime
    //    publish): callers that already track the contact don't need a
    //    "contact.created" ping on an unrelated lead promote.
    const attrs = (existing.attributes ?? {}) as Record<string, any>
    const existingTags = Array.isArray(existing.tags) ? existing.tags as string[] : []
    const needsAttrPatch = attrs.source_lead_id == null
    const mergedTags = Array.from(new Set([...existingTags, 'from_lead']))
    const needsTagPatch = mergedTags.length > existingTags.length

    if (needsAttrPatch || needsTagPatch) {
      const patch: Record<string, any> = {}
      if (needsAttrPatch) patch.attributes = { ...attrs, source_lead_id: lead.id, source: 'lead_promote' }
      if (needsTagPatch)  patch.tags = mergedTags
      const { error: updErr } = await supabase
        .from('contacts')
        .update(patch)
        .eq('id', existing.id)
        .eq('tenant_id', tenantId)
      if (updErr) {
        console.warn(`[contact-resolver] update failed contact=${existing.id}: ${updErr.message}`)
      }
    }
    return { contact_id: existing.id as string, created: false }
  }

  // 3) Net-new insert. The contacts.user_id column is NOT NULL on legacy
  //    RLS — read it back from the tenant's owner so we don't fail on
  //    tenants whose schemas predate the tenant_id migration. `tenants.user_id`
  //    is the owner across both legacy + current code paths.
  const { data: tenantOwner } = await supabase
    .from('tenants')
    .select('user_id')
    .eq('id', tenantId)
    .maybeSingle()

  const insertRow: Record<string, any> = {
    tenant_id: tenantId,
    name,
    phone,
    email,
    tags,
    status: 'active',
    attributes: { source_lead_id: lead.id, source: 'lead_promote' },
  }
  if (tenantOwner?.user_id) insertRow.user_id = tenantOwner.user_id

  const { data: inserted, error: insErr } = await supabase
    .from('contacts')
    .insert(insertRow)
    .select('id')
    .maybeSingle()

  if (insErr) {
    // Unique-violation: another caller raced us. Re-SELECT for the winner.
    if ((insErr as any).code === '23505') {
      const { data: again } = await supabase
        .from('contacts')
        .select('id')
        .eq('tenant_id', tenantId)
        .eq('phone', phone)
        .maybeSingle()
      if (again?.id) return { contact_id: again.id as string, created: false }
    }
    console.warn(`[contact-resolver] insert failed tenant=${tenantId} lead=${lead.id}: ${insErr.message}`)
    return { contact_id: null, created: false, reason: `insert_failed:${insErr.message}` }
  }

  return { contact_id: (inserted?.id as string) ?? null, created: true }
}
