/**
 * Signed OAuth `state` blobs (B4).
 *
 * Threat model:
 *   The previous implementation used base64(JSON({userId, tenantId})) as the
 *   `state` query param sent to Google / Instagram / Facebook on the OAuth
 *   handoff. That carried two distinct flaws:
 *     (1) Unauthenticated payload — an attacker could craft a state that
 *         pinned the callback to ANOTHER user's id and trick the server
 *         into writing the attacker's tokens against that user's tenant.
 *     (2) No expiry — a stolen state value (e.g. from a referer header to
 *         an attacker-controlled redirect_uri) could be replayed weeks
 *         later to graft a new connector onto a stale session.
 *
 * Mitigation:
 *   - Sign the JSON blob with HMAC-SHA-256 using OAUTH_STATE_SECRET.
 *   - Embed `n` (nonce) so two concurrent flows from the same user don't
 *     collide and so reuse can be detected (if you add a nonce store later).
 *   - Embed `e` (expiry) at +10 minutes; verifier rejects past-expiry tokens.
 *   - Wire format: `<base64url(payload)>.<base64url(hmac)>`. Verifier splits
 *     on the dot, recomputes HMAC over the LEFT half, compares with
 *     timingSafeEqual, then JSON.parses + checks expiry.
 *
 *   The secret is read from OAUTH_STATE_SECRET (preferred) or falls back to
 *   IMPERSONATION_HMAC_SECRET so single-secret deployments keep working.
 *   The boot check in src/index.ts refuses to start in production if neither
 *   is set / long enough.
 */

import crypto from 'crypto'

const STATE_TTL_MS = 10 * 60 * 1_000 // 10 minutes — enough for the slowest
                                     // 3rd-party consent screen, short enough
                                     // that a stolen state expires before
                                     // most exfil pipelines complete.

function getSecret(): string {
  const s = process.env.OAUTH_STATE_SECRET ?? process.env.IMPERSONATION_HMAC_SECRET ?? process.env.GOOGLE_TOKEN_SECRET
  if (!s || s.length < 32) {
    // Throwing here would let a single misconfigured request exit the
    // process. The boot guard already ensures prod has the secret; in dev,
    // returning a deterministic-but-noisy fallback lets local OAuth flows
    // work end-to-end while screaming in the logs.
    if (process.env.NODE_ENV === 'production') {
      throw new Error('OAUTH_STATE_SECRET unavailable in production')
    }
    return 'dev-fallback-oauth-state-secret-do-not-use-in-prod-32chars'
  }
  return s
}

export interface OauthStatePayload {
  /** Authenticated user id (auth.users.id) initiating the OAuth flow. */
  u: string
  /** Tenant id the resulting tokens should be written against. May be undefined for flows that auto-resolve. */
  t?: string | null
  /** Nonce — opaque random per-flow value. Lets you reject reuse if you add a server-side store. */
  n: string
  /** Absolute expiry in ms epoch. Enforced on verify. */
  e: number
  /** Optional connector key (e.g. 'google_drive', 'google_sheets') so a shared
   *  callback can route the result to the right connector row. */
  k?: string
}

function hmac(secret: string, data: string): string {
  return crypto.createHmac('sha256', secret).update(data).digest('base64url')
}

/** Sign a fresh OAuth state. TTL is 10 min from now. */
export function signOauthState(payload: { userId: string; tenantId?: string | null; connectorKey?: string }): string {
  const body: OauthStatePayload = {
    u: payload.userId,
    t: payload.tenantId ?? null,
    n: crypto.randomBytes(16).toString('base64url'),
    e: Date.now() + STATE_TTL_MS,
    ...(payload.connectorKey ? { k: payload.connectorKey } : {}),
  }
  const blob = Buffer.from(JSON.stringify(body), 'utf8').toString('base64url')
  const sig = hmac(getSecret(), blob)
  return `${blob}.${sig}`
}

/**
 * Verify + decode an OAuth state blob produced by signOauthState. Returns
 * the payload on success, or `null` if signature/format/expiry rejects it.
 *
 * NEVER throw — callers handle null by sending a 400 to the OAuth callback,
 * NOT by leaking the failure reason. (An attacker crafting forged states
 * shouldn't be able to distinguish "wrong sig" from "expired" from
 * "malformed JSON" — all paths look identical.)
 */
export function verifyOauthState(state: string | undefined | null): OauthStatePayload | null {
  if (!state || typeof state !== 'string') return null
  const dot = state.indexOf('.')
  if (dot <= 0 || dot === state.length - 1) return null
  const blob = state.slice(0, dot)
  const sig = state.slice(dot + 1)
  let secret: string
  try { secret = getSecret() } catch { return null }
  const expected = hmac(secret, blob)
  if (sig.length !== expected.length) return null
  let ok = false
  try {
    ok = crypto.timingSafeEqual(Buffer.from(sig, 'utf8'), Buffer.from(expected, 'utf8'))
  } catch { return null }
  if (!ok) return null
  let payload: OauthStatePayload
  try {
    payload = JSON.parse(Buffer.from(blob, 'base64url').toString('utf8'))
  } catch { return null }
  if (typeof payload?.u !== 'string' || typeof payload?.e !== 'number') return null
  if (payload.e < Date.now()) return null
  return payload
}
