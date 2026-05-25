import type { SupabaseClient } from '@supabase/supabase-js'

/**
 * Canonical session.variables seeder.
 *
 * Builds the `{ trigger, contact }` shape that every interpolation site
 * expects when it resolves `{{contact.name}}`, `{{trigger.text}}`, etc.
 *
 * Used by EVERY session-creation site (WA/IG/TG keyword-trigger inbounds
 * via inbound-router.startWorkflow, Shopify webhooks via shopify-triggers,
 * child workflows via executor.start_workflow) AND by the resume path in
 * the workflow worker (to refresh trigger.text from a new inbound reply).
 *
 * Guarantees:
 *   1. **Always** returns at least a populated `contact` bag, even when
 *      the contacts row doesn't exist yet. Missing fields become empty
 *      strings — the interpolator drops empty values cleanly and
 *      `{{contact.name}}` renders as `''` instead of leaking the
 *      literal `{{contact.name}}` to the recipient.
 *   2. **Attribute spread comes FIRST** so canonical name/phone/tags
 *      can never be shadowed by a user attribute keyed 'name'.
 *   3. **Phone lookup tries all variants** (+E.164, bare digits, raw
 *      contactId) via `IN` rather than `OR` with telegram_id/instagram_id
 *      columns that may not exist on older tenants.
 */
export async function seedSessionVars(
  supabase: SupabaseClient,
  tenantId:  string,
  contactId: string,
  triggerPayload?: Record<string, any>,
  existing?: Record<string, any>,
): Promise<Record<string, any>> {
  // Try every phone shape we might've stored — +E.164, bare digits, raw.
  // Dedupe so an already-`+`-prefixed id isn't doubled or double-bared.
  const phoneVariants = Array.from(new Set([
    contactId,
    contactId.startsWith('+') ? contactId : `+${contactId}`,
    contactId.replace(/^\++/, ''),
  ])).filter(Boolean)

  // Single IN lookup. Channel-specific columns (telegram_id, instagram_id)
  // are intentionally skipped — they're set separately for those channels
  // and the keyword trigger path uses contactId-as-phone anyway.
  let contact: any = null
  if (phoneVariants.length > 0) {
    const { data } = await supabase
      .from('contacts')
      .select('name, phone, tags, attributes')
      .eq('tenant_id', tenantId)
      .in('phone', phoneVariants)
      .limit(1)
      .maybeSingle()
    contact = data
  }

  // Attributes spread FIRST so the canonical name/phone/tags fields
  // always win. Without this, a contact with attributes={name:'X'}
  // would shadow the real contact.name = 'Y'.
  const contactBag: Record<string, any> = {
    ...(contact?.attributes ?? {}),
    name:  contact?.name  ?? '',
    phone: contact?.phone ?? contactId,
    tags:  contact?.tags  ?? [],
  }

  return {
    ...(existing ?? {}),
    trigger: { ...(existing?.trigger ?? {}), ...(triggerPayload ?? {}) },
    contact: contactBag,
  }
}
