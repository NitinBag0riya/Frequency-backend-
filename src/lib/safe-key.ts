/**
 * Shared key-validation regex + per-route allowlists for dynamic-column
 * filters and sort params.
 *
 * Why this exists:
 *   Several list endpoints (contacts, workflows, broadcasts, campaigns) accept
 *   `?filters={"<col>":"<val>"}` and `?sortBy=<col>` query params and pass the
 *   key DIRECTLY into PostgREST column expressions:
 *     q.ilike(key, `%${val}%`)
 *     q.order(sortBy, ...)
 *   Without validation, a hostile client can:
 *     - inject PostgREST operators (e.g. "name,email.eq.x") that change the
 *       query semantics, leaking other tenants' rows
 *     - probe arbitrary columns (e.g. `password_hash`) to confirm existence
 *     - DoS by sorting on unindexed columns
 *
 * Defense:
 *   1. SAFE_KEY regex — strips anything that could break PostgREST parsing
 *      (commas, dots, brackets, spaces, quotes).
 *   2. Per-route ALLOWLIST — even if a key passes SAFE_KEY, only the
 *      explicitly-listed columns are permitted. Reject 400 on anything else.
 *
 * Both layers required: SAFE_KEY alone is too permissive (any column name
 * the DB has, including internal flags); allowlists alone are easy to
 * accidentally widen with a future column rename.
 */

/**
 * Permits a–z, 0–9, underscore. 1–64 chars. Case-insensitive.
 *
 * Deliberately excludes:
 *   - dot/comma/bracket → PostgREST operator characters
 *   - colons/semicolons → injection sentinels
 *   - whitespace → never legitimate in a Postgres identifier
 *   - hyphens → ambiguous in PostgREST quoting
 */
export const SAFE_KEY = /^[a-z0-9_]{1,64}$/i

/**
 * Per-route filter+sort column allowlists.
 *
 * IMPORTANT: ALL columns listed here MUST be tenant-safe to expose for
 * filtering. Never include columns like `tenant_id`, `user_id`, encrypted
 * tokens, or internal billing flags.
 */
export const FILTER_ALLOWLISTS = {
  contacts:   ['name', 'phone', 'email', 'channel', 'status', 'tags', 'created_at'],
  workflows:  ['name', 'status', 'updated_at'],
  broadcasts: ['name', 'status', 'channel', 'created_at'],
  campaigns:  ['name', 'status', 'created_at'],
} as const

export type FilterAllowlistName = keyof typeof FILTER_ALLOWLISTS

/**
 * Validate a single filter/sort key against (a) the SAFE_KEY regex AND
 * (b) the per-route allowlist. Returns true iff both pass.
 */
export function isAllowedColumn(name: FilterAllowlistName, key: string): boolean {
  if (!SAFE_KEY.test(key)) return false
  return (FILTER_ALLOWLISTS[name] as readonly string[]).includes(key)
}

/**
 * F6 — sanitize a `?search=` value before string-interpolating it into a
 * PostgREST `.or()` filter expression like
 *   q.or(`name.ilike.%${search}%,email.ilike.%${search}%`)
 *
 * Without sanitization, a malicious `search` value containing `,` or `.`
 * can append additional PostgREST operators that change query semantics
 * (e.g. `foo,bar.eq.123` becomes a separate equality predicate).
 *
 * Strips: commas, dots, percent, parens, asterisks, backslashes — all the
 * PostgREST tree-building characters. Also caps length at 100 to keep a
 * giant search string from blowing up the URL or the LIKE planner.
 *
 * Returns an empty string if the input is empty / whitespace-only — callers
 * should check `if (safeSearch) q = q.or(...)` to avoid running an all-null
 * .or() expression that matches everything.
 *
 * NOTE: this is a "best fit for ILIKE" sanitizer — it's deliberately
 * conservative. For full-text search use `q.textSearch(col, query)` against
 * a tsvector column; that takes the value as a parameter and isn't
 * vulnerable to this class of injection.
 */
export function sanitizeSearch(raw: unknown): string {
  if (typeof raw !== 'string') return ''
  return raw.replace(/[,.%()*\\]/g, '').trim().slice(0, 100)
}
