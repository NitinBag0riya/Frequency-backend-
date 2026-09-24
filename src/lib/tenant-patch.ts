/**
 * Pure sanitizer for the admin workspace-edit route (PATCH /api/tenants/:id).
 *
 * Whitelists the handful of editable workspace fields, strips control chars,
 * bounds length, and NEVER lets `business_type` (the vertical) through —
 * changing the vertical re-gates the whole workspace (storefront pack, loyalty,
 * catalog copy) and is destructive, so it stays locked to onboarding.
 *
 * Kept separate from the route handler so the security-relevant field
 * whitelisting is unit-testable without booting Express/Supabase.
 */

// Matches ASCII control chars (C0 range + DEL). Constructor form avoids
// embedding literal control bytes in source (same pattern as index.ts).
const CTRL = new RegExp('[\\u0000-\\u001F\\u007F]', 'g')

const clean = (v: unknown, max: number): string | null => {
  if (typeof v !== 'string') return null
  const s = v.replace(CTRL, '').trim().slice(0, max)
  return s.length ? s : null
}

export interface TenantPatchResult {
  /** Column→value map safe to pass to `supabase.from('tenants').update()`. */
  patch: Record<string, string | null>
  /** Set when the request is invalid; the route should 400 with this. */
  error?: string
}

export function sanitizeTenantPatch(body: Record<string, unknown>): TenantPatchResult {
  const patch: Record<string, string | null> = {}

  // business_name is required-if-present: an admin can rename the workspace but
  // can't blank it (the name backs the header, slug, invoices).
  if ('business_name' in body) {
    const bn = clean(body.business_name, 120)
    if (!bn) return { patch: {}, error: 'business_name cannot be empty' }
    patch.business_name = bn
  }
  // Optional basic details — null clears them.
  if ('legal_name' in body)      patch.legal_name      = clean(body.legal_name, 120)
  if ('display_phone' in body)   patch.display_phone   = clean(body.display_phone, 20)
  if ('billing_address' in body) patch.billing_address = clean(body.billing_address, 400)

  // NOTE: business_type is intentionally NOT read here. It's locked.

  if (Object.keys(patch).length === 0) return { patch: {}, error: 'No editable fields supplied' }
  return { patch }
}
