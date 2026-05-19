/**
 * lib/link-shortener.ts — Broadcast URL → short-link rewriter (P2 #19).
 *
 * Pre-send, the broadcast worker calls `shortenBody(...)` with the raw body
 * text (or the resolved value of a WA template variable that's been mapped
 * to a URL). For every URL found in the body, this:
 *
 *   1. Generates a base62 token (10 chars by default; ~60 bits entropy).
 *   2. Inserts a `broadcast_links` row mapping the token to the original
 *      URL + the (broadcast_id, contact_id, position) tuple.
 *   3. Replaces the URL in the body with  ${publicBaseUrl}/r/${token}  .
 *
 * The redirect handler at GET /r/:token does the inverse: token → original
 * URL, log a click, 302.
 *
 * Token entropy is deliberately base62 (no `-`/`_`/`.`) so the short link
 * is double-tap-selectable in WhatsApp on Android (the WA tokeniser breaks
 * on hyphens; we found this out the hard way during the CTWA work).
 *
 * URL detection: we use a tight pattern that matches  http(s)://...  up to
 * whitespace or a clear terminator. We deliberately do NOT try to be a full
 * URL parser — the body comes from the tenant's own template and the
 * expectation is "if it looks like a URL with a scheme, we shorten it; if
 * it doesn't, we leave it alone". Tenants who want to track  example.com
 * without a scheme can prefix  https://  .
 *
 * Trailing punctuation (`.`, `,`, `)`, `]`, `!`, `?`, `;`, `:`) is trimmed
 * off the captured URL because users frequently end sentences with a URL:
 *   "Check out https://shop.com/sale!"  → trailing  !  should not be part
 * of the URL.
 *
 * Idempotency: shortenBody is NOT idempotent on its own — calling it twice
 * for the same (broadcast, contact, body) would create two rows. The worker
 * call site already runs once per contact per broadcast, so this is fine.
 */

import crypto from 'crypto'
import { SupabaseClient } from '@supabase/supabase-js'

// Base62 alphabet — digits, upper, lower (62 chars). 62^10 ≈ 8.4e17 ≈ 59.5
// bits of entropy. Birthday-collision rate at 100M tokens is ~4e-7 → fine.
const BASE62 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'

/**
 * Generate a base62 token of the requested length using crypto.randomBytes
 * (CSPRNG). Rejection sampling avoids the modulo bias that would otherwise
 * give the early alphabet chars slightly higher probability.
 */
export function generateToken(length = 10): string {
  if (length < 6 || length > 16) {
    // Match the CHECK constraint on broadcast_links.token so a caller
    // can't accidentally generate a token the DB will reject.
    throw new Error(`generateToken: length must be 6..16 (got ${length})`)
  }
  const out: string[] = []
  // 4× over-sample to keep rejection-sampling rare. 256 mod 62 = 8; any byte
  // >= 248 is rejected to keep the distribution uniform.
  const buf = crypto.randomBytes(length * 4)
  for (let i = 0; out.length < length && i < buf.length; i++) {
    const b = buf[i]
    if (b >= 248) continue                          // reject biased tail
    out.push(BASE62[b % 62])
  }
  if (out.length < length) {
    // Vanishingly unlikely with 4× over-sample, but be safe — recurse.
    return generateToken(length)
  }
  return out.join('')
}

export interface ExtractedUrl {
  url: string
  start: number
  end: number
}

// Greedy match for http(s) URLs. We intentionally avoid the U+200D etc.
// zero-widths and the unicode IRI extensions — WA / TG / IG bodies for our
// SMB audience are ASCII-URL only in 100% of inspected templates.
const URL_RE = /https?:\/\/[^\s<>"']+/gi
// Trailing punctuation we strip off the match. Done as a separate post-pass
// because the regex itself can't reliably distinguish "URL ends in ." vs
// "URL ends in . because it's the end of a sentence".
const TRAILING_PUNCT = /[.,)\]!?;:]+$/

/**
 * Extract every URL from `body`, returning ordered { url, start, end }
 * descriptors. Ordering matches first-appearance in the body — we rely on
 * this so the `position` column in broadcast_links is meaningful.
 *
 * Overlapping matches aren't possible with a non-backtracking regex like
 * this one, so deduping is by exact-URL: the same URL appearing twice in
 * a body produces TWO rows (both will resolve to the same destination but
 * the analytics page can show per-position click breakdowns).
 */
export function extractUrls(body: string): ExtractedUrl[] {
  if (!body) return []
  const out: ExtractedUrl[] = []
  URL_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = URL_RE.exec(body)) != null) {
    let url = m[0]
    let end = m.index + url.length
    // Strip trailing punctuation that's almost-certainly not part of the URL.
    const trailing = url.match(TRAILING_PUNCT)
    if (trailing) {
      url = url.slice(0, url.length - trailing[0].length)
      end = m.index + url.length
    }
    if (url.length < 8) continue                    // "http://" alone — bogus
    out.push({ url, start: m.index, end })
  }
  return out
}

export interface ShortenResult {
  body: string
  links: Array<{ token: string; original_url: string; position: number }>
}

export interface ShortenInput {
  tenantId: string
  broadcastId: string | null
  contactId: string | null
  body: string
  publicBaseUrl: string                              // e.g. https://api.getfrequency.app
}

/**
 * For every URL in `body`, INSERT a broadcast_links row and replace the URL
 * with the short-link form. Returns the rewritten body + the list of links
 * created (caller may want to log them).
 *
 * If body contains no URLs, returns the input body verbatim with an empty
 * `links` array — zero DB writes. This is the hot path for the majority of
 * broadcasts (most templates we see don't contain URLs).
 *
 * Public base URL is trimmed of trailing slashes so the resulting short
 * link is always exactly  ${base}/r/${token}  with one slash.
 */
export async function shortenBody(
  supabase: SupabaseClient,
  input: ShortenInput,
): Promise<ShortenResult> {
  const { tenantId, broadcastId, contactId, body, publicBaseUrl } = input
  const urls = extractUrls(body)
  if (urls.length === 0) return { body, links: [] }

  const base = publicBaseUrl.replace(/\/+$/, '')
  // Build all rows first so we do a single insert round-trip rather than N.
  const rows = urls.map((u, idx) => ({
    tenant_id: tenantId,
    broadcast_id: broadcastId,
    contact_id: contactId,
    token: generateToken(10),
    original_url: u.url,
    position: idx,
  }))

  const { error } = await supabase.from('broadcast_links').insert(rows)
  if (error) {
    // Token uniqueness collision is astronomically unlikely but if it ever
    // happens, fail loudly so the caller can decide whether to retry. We
    // explicitly DO NOT swallow this — silently sending the original URL
    // would defeat the entire feature.
    throw new Error(`shortenBody: insert broadcast_links failed: ${error.message}`)
  }

  // Reconstruct the body by walking the URL descriptors in reverse so each
  // replacement doesn't invalidate the indices of the next one.
  let out = body
  for (let i = urls.length - 1; i >= 0; i--) {
    const { start, end } = urls[i]
    const token = rows[i].token
    out = out.slice(0, start) + `${base}/r/${token}` + out.slice(end)
  }

  return {
    body: out,
    links: rows.map(r => ({
      token: r.token,
      original_url: r.original_url,
      position: r.position,
    })),
  }
}
