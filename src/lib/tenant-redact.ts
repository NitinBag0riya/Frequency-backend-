/**
 * Shared allowlist for any `tenants` row that leaves the server toward a
 * platform-console browser (super-admin.ts, admin.ts, naruto-tenants.ts).
 *
 * Root cause: those routes `select('*')` (or `.select()` on insert) and then
 * `res.json()` the raw row, shipping WhatsApp/Google/GBP tokens and the WA
 * webhook auth token to the browser. An ALLOWLIST (not a denylist) is used on
 * purpose: the migrations folder has drifted from prod, so a denylist would
 * silently leak any column added later. A column missing here is a cosmetic
 * gap (reported, then added); a secret column missing from SECRET_KEYS can't
 * leak by construction because nothing outside the allowlist is ever kept.
 *
 * See docs/state/super-admin-tenant-secret-redaction.md for the full audit.
 */
import { pickAllowed } from '../security'

// Secret-bearing columns on `tenants`. Never let these reach res.json().
export const SECRET_KEYS = [
  'access_token',          // WhatsApp platform/BYO token
  'google_access_token',
  'google_refresh_token',
  'google_token_expiry',   // not itself a secret, but token metadata — drop it too
  'gbp_refresh_token',     // encrypted at rest, still never shipped to the browser
  'wa_app_secret_enc',
  'wa_webhook_token',      // IS the auth for /webhook/wa/<token> — leaking it lets anyone forge webhooks
] as const

// Non-secret columns the platform console (AdminPage.tsx, NarutoTenantDetailPage.tsx,
// lifecycleColumn.tsx) reads off a tenant row, plus the baseline list-endpoint
// select (super-admin.ts:207-210) and onboarding/billing identity columns.
export const ADMIN_TENANT_FIELDS = [
  'id', 'slug', 'business_name', 'business_type', 'status',
  'lifecycle_state', 'state_entered_at',
  'display_phone', 'waba_id', 'user_id',
  'created_at', 'deleted_at', 'last_active_at',
  'timezone', 'currency', 'gstin', 'billing_email', 'billing_address',
  'google_email',
  // embedded relations, passed through as-is (arrays of non-secret rows)
  'tenant_subscriptions', 'tenant_entitlements',
] as const

type TenantRow = Record<string, any>
export type AdminTenant = Partial<Record<(typeof ADMIN_TENANT_FIELDS)[number], any>> & {
  has_wa_token: boolean
  has_google_token: boolean
  has_gbp_token: boolean
  wa_byo_configured: boolean
}

/**
 * Redact a raw `tenants` row (or null) down to the console-safe shape.
 * Presence booleans replace the raw secret so support keeps the
 * connected/not-connected signal without ever seeing the token value.
 */
export function toAdminTenant(row: TenantRow | null | undefined): AdminTenant | null {
  if (!row) return null
  const picked = pickAllowed<TenantRow>(row, ADMIN_TENANT_FIELDS as unknown as (keyof TenantRow)[])
  return {
    ...picked,
    has_wa_token: !!row.access_token,
    has_google_token: !!(row.google_access_token || row.google_refresh_token),
    has_gbp_token: !!row.gbp_refresh_token,
    wa_byo_configured: !!(row.wa_app_secret_enc && row.wa_webhook_token),
  } as AdminTenant
}
