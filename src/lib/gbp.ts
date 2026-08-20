/**
 * Google Business Profile (GBP) API client.
 *
 * OAuth runs under the SAME client as the SEO/Search Console connector (the
 * "Frequency Search Console" app — GOOGLE_OAUTH_CLIENT_ID/SECRET, mirroring
 * src/routes/seo-gsc.ts), NOT the Gmail/Sheets Google app. The refresh token is
 * kept in the tenant's SEPARATE `gbp_refresh_token` column, encrypted with
 * app-secrets encryptSecret/decryptSecret (the same at-rest scheme seo-gsc uses)
 * — separate from the GSC token so the two connects never clobber each other.
 *
 * The GBP APIs are split across three hosts (Google's own doing):
 *   - accounts:  mybusinessaccountmanagement.googleapis.com/v1
 *   - locations: mybusinessbusinessinformation.googleapis.com/v1
 *   - reviews + reply: mybusiness.googleapis.com/v4  (v4 still serves reviews;
 *                      there is no v1 replacement for reviews as of 2026).
 *
 * 403 PERMISSION_DENIED is handled EXPLICITLY, not as a 500. The GBP API
 * requires a one-time per-project access grant (the "Business Profile API"
 * allow-list) that a fresh GCP project does NOT have. Until Google approves it,
 * every call 403s with PERMISSION_DENIED — that's a provisioning state, not a
 * crash. We surface { apiAccess: 'denied' } so the FE can show "request GBP API
 * access" instead of an error toast. NEVER fabricate reviews — real data, or an
 * honest empty/denied state.
 */

import { createClient } from '@supabase/supabase-js'
import { encryptSecret, decryptSecret } from './app-secrets'

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://yiicpndeggaedxobyopu.supabase.co'
const supabase = createClient(SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY!)

// GBP shares the SEO/Search Console OAuth client (the "Frequency Search Console"
// app), NOT the Gmail/Sheets Google app — so it reads the same GOOGLE_OAUTH_*
// creds seo-gsc.ts uses. Its token stays in its OWN column (gbp_refresh_token),
// separate from the GSC token, so the two connects never clobber each other.
const GOOGLE_CLIENT_ID     = () => process.env.GOOGLE_OAUTH_CLIENT_ID || ''
const GOOGLE_CLIENT_SECRET = () => process.env.GOOGLE_OAUTH_CLIENT_SECRET || ''

const ACCOUNTS_BASE  = 'https://mybusinessaccountmanagement.googleapis.com/v1'
const LOCATIONS_BASE = 'https://mybusinessbusinessinformation.googleapis.com/v1'
const REVIEWS_BASE   = 'https://mybusiness.googleapis.com/v4'

// GBP access-token refresh caches in-memory per process for the token's life so
// a burst of status/reviews calls doesn't hammer Google's token endpoint. Keyed
// by tenant id; short-lived, best-effort (a restart just refetches).
const tokenCache = new Map<string, { token: string; exp: number }>()

export type ApiAccess = 'ok' | 'denied' | 'unknown'

/** Raised so callers can branch on the GBP allow-list not being granted yet. */
export class GbpPermissionDenied extends Error {
  constructor(msg = 'GBP API access not granted for this project') {
    super(msg)
    this.name = 'GbpPermissionDenied'
  }
}

export interface GbpLocation {
  name: string       // 'locations/456'
  title: string
  address: string
}

export interface GbpReview {
  id: string
  reviewer: string
  rating: number     // 1..5 (0 if unspecified)
  comment: string
  createTime: string
  reply: { comment: string; updateTime: string } | null
}

export interface GbpReviewsResult {
  reviews: GbpReview[]
  averageRating: number
  totalReviewCount: number
}

// ── Token refresh ────────────────────────────────────────────────────────────
/**
 * Returns a non-expired GBP access token for the given tenant row. Refreshes
 * from gbp_refresh_token when the cached token is within 60s of expiry. Throws
 * if the tenant has no gbp_refresh_token (not connected).
 */
export async function getValidGbpToken(tenant: { id: string; gbp_refresh_token?: string | null }): Promise<string> {
  const cached = tokenCache.get(tenant.id)
  if (cached && cached.exp > Date.now() + 60_000) return cached.token

  if (!tenant.gbp_refresh_token) throw new Error('GBP is not connected for this workspace.')
  const refreshToken = decryptSecret(tenant.gbp_refresh_token)

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: GOOGLE_CLIENT_ID(),
      client_secret: GOOGLE_CLIENT_SECRET(),
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    }),
  })
  const data = await res.json() as any
  if (data.error) throw new Error(`GBP token refresh failed: ${data.error_description ?? data.error}`)

  tokenCache.set(tenant.id, {
    token: data.access_token,
    exp: Date.now() + (data.expires_in ?? 3600) * 1000,
  })
  return data.access_token
}

// ── Shared GET with explicit 403 → GbpPermissionDenied ───────────────────────
async function gbpGet(url: string, token: string): Promise<any> {
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } })
  const data = await res.json().catch(() => ({})) as any
  if (res.status === 403) throw new GbpPermissionDenied(data?.error?.message)
  if (!res.ok || data.error) {
    throw new Error(`GBP ${res.status}: ${data?.error?.message ?? 'request failed'}`)
  }
  return data
}

// ── Accounts ─────────────────────────────────────────────────────────────────
/** First GBP account name, e.g. 'accounts/123'. Null if the user has none. */
export async function getFirstAccount(token: string): Promise<string | null> {
  const data = await gbpGet(`${ACCOUNTS_BASE}/accounts`, token)
  return data.accounts?.[0]?.name ?? null
}

// ── Locations ────────────────────────────────────────────────────────────────
export async function listLocations(token: string, account: string): Promise<GbpLocation[]> {
  const readMask = 'name,title,storefrontAddress'
  const data = await gbpGet(
    `${LOCATIONS_BASE}/${account}/locations?readMask=${encodeURIComponent(readMask)}&pageSize=100`,
    token,
  )
  return (data.locations ?? []).map((l: any) => ({
    name: l.name,                      // 'locations/456'
    title: l.title ?? '',
    address: formatAddress(l.storefrontAddress),
  }))
}

function formatAddress(a: any): string {
  if (!a) return ''
  const parts = [
    ...(Array.isArray(a.addressLines) ? a.addressLines : []),
    a.locality,
    a.administrativeArea,
    a.postalCode,
  ].filter(Boolean)
  return parts.join(', ')
}

// ── Reviews ──────────────────────────────────────────────────────────────────
const STAR_TO_INT: Record<string, number> = { ONE: 1, TWO: 2, THREE: 3, FOUR: 4, FIVE: 5 }

/** Map a v4 review payload row to our normalised shape. Exported for self-check. */
export function normalizeReview(r: any): GbpReview {
  return {
    id: r.reviewId ?? r.name ?? '',
    reviewer: r.reviewer?.displayName ?? 'Anonymous',
    rating: STAR_TO_INT[r.starRating] ?? 0,
    comment: r.comment ?? '',
    createTime: r.createTime ?? '',
    reply: r.reviewReply
      ? { comment: r.reviewReply.comment ?? '', updateTime: r.reviewReply.updateTime ?? '' }
      : null,
  }
}

/**
 * Reviews for a location. `location` is the bare 'locations/456' name; the v4
 * reviews endpoint nests it under the account: /{account}/{location}/reviews.
 */
export async function listReviews(token: string, account: string, location: string): Promise<GbpReviewsResult> {
  const data = await gbpGet(`${REVIEWS_BASE}/${account}/${location}/reviews`, token)
  return {
    reviews: (data.reviews ?? []).map(normalizeReview),
    averageRating: data.averageRating ?? 0,
    totalReviewCount: data.totalReviewCount ?? 0,
  }
}

// ── Reply ────────────────────────────────────────────────────────────────────
/**
 * Upsert the business reply to a review. `reviewName` is the full v4 resource
 * name: 'accounts/123/locations/456/reviews/abc'. PUT is upsert per the API.
 */
export async function replyToReview(token: string, reviewName: string, comment: string): Promise<void> {
  const res = await fetch(`${REVIEWS_BASE}/${reviewName}/reply`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ comment }),
  })
  const data = await res.json().catch(() => ({})) as any
  if (res.status === 403) throw new GbpPermissionDenied(data?.error?.message)
  if (!res.ok || data.error) {
    throw new Error(`GBP reply ${res.status}: ${data?.error?.message ?? 'request failed'}`)
  }
}

// ── OAuth (under the GOOGLE_OAUTH / "Frequency Search Console" client) ────────

/** True when the shared Google OAuth app is configured (same switch seo-gsc uses). */
export function gbpOauthConfigured(): boolean {
  return !!(GOOGLE_CLIENT_ID() && GOOGLE_CLIENT_SECRET())
}

const GBP_REDIRECT_URI = () =>
  process.env.GBP_OAUTH_REDIRECT_URI
  || 'https://api.getfrequency.app/api/connectors/gbp/callback'

/** GBP's own consent URL — same client as GSC, but scope=business.manage. */
export function gbpConnectUrl(state: string): string {
  return 'https://accounts.google.com/o/oauth2/v2/auth?' + new URLSearchParams({
    client_id: GOOGLE_CLIENT_ID(), redirect_uri: GBP_REDIRECT_URI(), response_type: 'code',
    scope: 'https://www.googleapis.com/auth/business.manage email profile',
    access_type: 'offline', prompt: 'consent', include_granted_scopes: 'true', state,
  })
}

interface GoogleTokens { access_token: string; refresh_token?: string; id_token?: string }

/** code → tokens, under the GOOGLE_OAUTH client (mirrors seo-gsc exchangeCode). */
export async function exchangeCodeForGbp(code: string): Promise<GoogleTokens> {
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code, client_id: GOOGLE_CLIENT_ID(), client_secret: GOOGLE_CLIENT_SECRET(),
      redirect_uri: GBP_REDIRECT_URI(), grant_type: 'authorization_code',
    }),
  })
  if (!r.ok) throw new Error(`GBP token exchange ${r.status}`)
  return r.json() as Promise<GoogleTokens>
}

/** Decode the email out of the id_token (no extra call); fall back to userinfo. */
export async function gbpEmailFromTokens(tokens: GoogleTokens): Promise<string | null> {
  try {
    if (tokens.id_token) {
      const payload = JSON.parse(Buffer.from(tokens.id_token.split('.')[1], 'base64').toString('utf8'))
      if (payload?.email) return String(payload.email)
    }
  } catch { /* fall through */ }
  try {
    const r = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    })
    if (r.ok) { const j: any = await r.json(); return j?.email ?? null }
  } catch { /* best-effort */ }
  return null
}

// ── Callback helper — persist the GBP refresh token onto the tenant ──────────
/** Store the encrypted GBP refresh token + email on the tenant row. */
export async function saveGbpToken(tenantId: string, refreshToken: string, email: string | null): Promise<void> {
  const { error } = await supabase.from('tenants').update({
    gbp_refresh_token: encryptSecret(refreshToken),
    gbp_email: email,
    updated_at: new Date().toISOString(),
  }).eq('id', tenantId)
  if (error) throw new Error(`saveGbpToken: ${error.message}`)
  tokenCache.delete(tenantId)   // drop any stale cached access token
}
