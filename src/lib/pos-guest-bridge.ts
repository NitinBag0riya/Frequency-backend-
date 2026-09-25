/**
 * POS guest → contacts/consent bridge (POS Upgrade Phase 6, P6-bridge).
 *
 * storefront-api POSTs a captured POS guest here — server-to-server,
 * x-internal-secret (same seam as /api/internal/pos-reservation-event,
 * /api/internal/pos-approval-request, etc. — see src/index.ts) — whenever a
 * counter bill captures/updates a guest's name/phone/birthday/anniversary/
 * address, plus whatever the WhatsApp-consent checkbox at billing read
 * (6.4 — default UNTICKED, H3/DPDPA).
 *
 * ─── WHY A NEW BRIDGE (not customer-sync) ────────────────────────────────────
 * `/api/storefront/customer-sync` (routes/storefront-domains.ts →
 * lib/catalog.ts syncCustomerRow) mirrors a signed-in storefront guest into
 * the tables-backed `lead_rows` Customers table — a different data model
 * with no consent semantics at all. The 6.2 birthday sweep
 * (workers/birthday-wish-sweep.ts) reads `contacts.attributes` +
 * `contact_consent_state`, which customer-sync never touches. Without this
 * bridge the sweep sees zero POS birthdays — see docs/state/pos-upgrade.md
 * "SHARP EDGE" for the verified gap. This module is the missing write path;
 * customer-sync is untouched (still does its own job for signed-in guests).
 *
 * ─── DPDPA — THE ONE RULE THIS FILE EXISTS TO ENFORCE ───────────────────────
 * consent===true is the ONLY signal that ever writes a `consent_events` row
 * (event_type='opt_in', purpose='marketing', source='pos'). The
 * migration-072 trigger materializes that into
 * contact_consent_state.status='opted_in', which is what the birthday
 * sweep's join reads. Anything else (false / undefined) writes NOTHING to
 * consent_events — the contact is still upserted (so a returning guest's
 * name/birthday carries over bill to bill) but its consent state is
 * whatever it already was. This is a ONE-WAY, GRANT-ONLY gate: a
 * default-unticked checkbox on THIS bill must never silently revoke a real
 * opt-in a guest gave on an earlier visit — inferring an opt-out from an
 * absent tick would be a bridge bug, not consent hygiene. Revocation is a
 * deliberate, separate action (DSR / contacts-page unsubscribe), not this
 * path.
 */
import type { SupabaseClient } from '@supabase/supabase-js'

export interface PosGuestSyncBody {
  tenantId: string
  guest: {
    phone: string
    name?: string | null
    email?: string | null
    /** 'YYYY-MM-DD' preferred (bare 'MM-DD' also accepted downstream by the
     *  sweep's date matcher) — consumed by workers/birthday-wish-sweep.ts. */
    birthday?: string | null
    anniversary?: string | null
    address?: string | null
    /** Exact checkbox state captured AT THIS BILL (6.4). Only `true` ever
     *  grants consent — see file header. */
    consent?: boolean
  }
}

export interface PosGuestSyncResult {
  contactId: string | null
  consentRecorded: boolean
  skippedReason?: string
}

/** Digits-only phone — same shape used everywhere else contacts.phone is
 *  written (contact-import-processor.ts normalizePhone). */
export function normalizeGuestPhone(raw: string | null | undefined): string | null {
  if (!raw) return null
  const trimmed = String(raw).trim().replace(/[\s\-()]/g, '').replace(/^\+/, '')
  if (/^91\d{10}$/.test(trimmed)) return trimmed
  if (/^[6-9]\d{9}$/.test(trimmed)) return `91${trimmed}`
  if (/^\d{8,15}$/.test(trimmed)) return trimmed
  return null
}

/** Only non-empty fields — merged onto the existing row's attributes by the
 *  caller so a field this sync doesn't carry is never wiped. */
export function guestAttributesPatch(guest: PosGuestSyncBody['guest']): Record<string, string> {
  const patch: Record<string, string> = {}
  if (guest.birthday)    patch.birthday    = String(guest.birthday).trim()
  if (guest.anniversary) patch.anniversary = String(guest.anniversary).trim()
  if (guest.address)     patch.address     = String(guest.address).trim()
  return patch
}

export async function syncPosGuestToContacts(
  supabase: SupabaseClient,
  body: PosGuestSyncBody,
): Promise<PosGuestSyncResult> {
  const phone = normalizeGuestPhone(body.guest?.phone)
  if (!body.tenantId || !phone) {
    return { contactId: null, consentRecorded: false, skippedReason: 'tenantId and a valid guest phone are required' }
  }
  const attrsPatch = guestAttributesPatch(body.guest ?? {})

  const { data: existing } = await supabase.from('contacts')
    .select('id, name, attributes, tags')
    .eq('tenant_id', body.tenantId).eq('phone', phone).maybeSingle()

  let contactId: string
  if (existing) {
    const mergedAttrs = { ...((existing as any).attributes ?? {}), ...attrsPatch }
    const tags: string[] = Array.isArray((existing as any).tags) ? (existing as any).tags : []
    const patch: Record<string, any> = { attributes: mergedAttrs }
    // Never overwrite a name/email the operator (or an earlier visit) already curated.
    if (body.guest.name && !(existing as any).name) patch.name = body.guest.name
    if (body.guest.email) patch.email = body.guest.email
    if (!tags.includes('pos-guest')) patch.tags = [...tags, 'pos-guest']
    const { error } = await supabase.from('contacts').update(patch).eq('id', (existing as any).id)
    if (error) return { contactId: null, consentRecorded: false, skippedReason: `contact update failed: ${error.message}` }
    contactId = (existing as any).id
  } else {
    const { data: created, error } = await supabase.from('contacts').insert({
      tenant_id:  body.tenantId,
      name:       body.guest.name || 'POS Guest',
      phone,
      email:      body.guest.email || null,
      tags:       ['pos-guest'],
      attributes: attrsPatch,
      status:     'active',
    }).select('id').single()
    if (error || !created) return { contactId: null, consentRecorded: false, skippedReason: `contact insert failed: ${error?.message ?? 'unknown'}` }
    contactId = (created as any).id
  }

  // ── DPDPA consent — the one-way, grant-only gate (see file header) ────────
  if (body.guest.consent !== true) {
    return {
      contactId, consentRecorded: false,
      skippedReason: body.guest.consent === false
        ? 'checkbox unticked at billing — no consent recorded'
        : 'no consent flag sent — no consent recorded',
    }
  }
  const { error: ceErr } = await supabase.from('consent_events').insert({
    tenant_id:     body.tenantId,
    contact_id:    contactId,
    channel:       'whatsapp',
    event_type:    'opt_in',
    purpose:       'marketing',
    source:        'pos',
    source_detail: { captured_at: 'billing' },
    proof_text:    'Send bill & offers on WhatsApp (checked at POS billing)',
  })
  if (ceErr) return { contactId, consentRecorded: false, skippedReason: `consent_events insert failed: ${ceErr.message}` }
  return { contactId, consentRecorded: true }
}
