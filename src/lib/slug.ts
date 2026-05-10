/**
 * Workspace slug utilities — keeps the FE's `/{orgSlug}/*` URL shape clean.
 *
 * The DB column `tenants.slug` is the source of truth (unique + CHECK-
 * constrained shape). This module is the application-level wrapper that:
 *
 *   1. Generates a candidate slug from a business name (slugify).
 *   2. Refuses reserved slugs that collide with FE top-level routes
 *      (api, naruto, admin, etc.) — mirrors migration 034's CHECK.
 *   3. Resolves collisions by suffixing -2, -3, …, retrying until unique.
 *
 * Use at:
 *   - POST /api/onboarding   — when a fresh user creates their first tenant
 *   - POST /api/auth/facebook/connect-waba — when a tenant is created from
 *     the WhatsApp OAuth flow
 *   - Any future "create another workspace" flow
 *
 * NOT used by:
 *   - The slug resolver in the FE (FE just reads slug off the tenant API).
 *     If a user types a wrong slug, the FE shows WorkspaceNotFound; no
 *     server-side regeneration is needed.
 */

import type { SupabaseClient } from '@supabase/supabase-js'

/** Slugs that collide with FE top-level routes — refused at create time
 *  AND at the DB CHECK level (migration 034). Keep in lockstep. */
export const RESERVED_SLUGS = new Set([
  'api', 'naruto', 'admin', 'auth', 'home', 'accept-invite',
  'app', 'console', 'login', 'signup', 'settings', 'help',
  'blog', 'docs', 'www', 'mail', 'ftp', 'public', 'root',
  'support', 'status', 'onboarding-new', 'webhook', 'webhooks',
  'static', 'assets', 'cdn', '_next', 'pricing', 'features',
  'tenant', 'tenants', 'workspace', 'workspaces',
])

/**
 * Convert a free-text name to a URL-safe candidate slug. Does NOT check
 * uniqueness or reserved-word collisions — that's `ensureUniqueSlug`.
 *
 *   slugify("Acme Realty Pvt Ltd")   → "acme-realty-pvt-ltd"
 *   slugify("नितिन की दुकान")          → "" (caller falls back)
 *   slugify("  Hi-Tech  Bakery  !! ") → "hi-tech-bakery"
 */
export function slugify(input: string): string {
  return String(input ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32)
}

/** Fallback used when slugify() returns an empty string (e.g. all-non-Latin
 *  org name). Tenant id's first 8 hex chars are stable + unique enough. */
export function fallbackSlug(tenantId: string): string {
  return `workspace-${(tenantId || '').replace(/-/g, '').slice(0, 8) || 'new'}`
}

/**
 * Return a slug that is (a) non-reserved and (b) not already taken by
 * another tenant. Tries the base candidate first, then `${base}-2`,
 * `${base}-3`, etc. up to 99.
 *
 * Worst-case race: two concurrent calls return the same slug before
 * insert. Caller MUST rely on the DB UNIQUE constraint as the ultimate
 * safety net and retry on 23505 conflict.
 */
export async function ensureUniqueSlug(
  supabase: SupabaseClient,
  baseCandidate: string,
  fallbackId: string,
): Promise<string> {
  let base = slugify(baseCandidate)
  if (!base || base.length < 3) base = fallbackSlug(fallbackId)
  // Reserve names short-circuit to the fallback path with a -2 if needed.
  if (RESERVED_SLUGS.has(base)) base = fallbackSlug(fallbackId)

  // First try the bare candidate.
  if (!(await isSlugTaken(supabase, base))) return base

  // Then -2, -3, … up to -99. Leaves -28 chars for the base.
  const trimmedBase = base.slice(0, 28)
  for (let i = 2; i <= 99; i++) {
    const candidate = `${trimmedBase}-${i}`
    if (!(await isSlugTaken(supabase, candidate))) return candidate
  }
  // Astronomically unlikely path — fall back to a uuid-derived slug.
  return fallbackSlug(fallbackId)
}

async function isSlugTaken(supabase: SupabaseClient, slug: string): Promise<boolean> {
  const { data } = await supabase.from('tenants').select('id').eq('slug', slug).maybeSingle()
  return !!data
}

/**
 * Validate user-supplied slug input (for a future "rename workspace URL"
 * Settings action). Returns null if valid, else a human-readable reason.
 *
 * Not used yet — exported now so the validation rules live in one place
 * when the rename flow ships.
 */
export function validateSlug(input: string): string | null {
  if (!input) return 'Slug is required'
  if (input.length < 3) return 'Slug must be at least 3 characters'
  if (input.length > 32) return 'Slug must be 32 characters or fewer'
  if (!/^[a-z0-9]([a-z0-9-]{1,30}[a-z0-9])?$/.test(input)) {
    return 'Slug can only contain lowercase letters, numbers and hyphens; can\'t start or end with a hyphen'
  }
  if (RESERVED_SLUGS.has(input)) return `'${input}' is reserved — try another`
  return null
}
