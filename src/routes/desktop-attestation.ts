/**
 * Frequency Desktop — per-install attestation (Wave 3, replaces the baked shared
 * secret as the primary trust gate for /api/desktop/provision).
 *
 * The pilot gate is a single `DESKTOP_PROVISION_SECRET` shipped inside the Electron
 * binary — extractable, spoofable, and un-revocable per install. This adds a
 * per-install enrolment so each install proves ITSELF, without a full PKI:
 *
 *   1. ENROL (once, first launch): the install generates an Ed25519 keypair in its
 *      userData, keeps the private key, and POSTs { installId, publicKey } to
 *      /api/desktop/enroll. The server records installId → publicKey (first-write-
 *      wins: a known installId can never be re-bound to a new key, so an attacker
 *      who learns an installId can't hijack it).
 *   2. SIGN: every /api/desktop/provision request carries headers
 *        x-desktop-install-id, x-desktop-timestamp (ms epoch),
 *        x-desktop-signature (base64 Ed25519 over `installId.timestamp.rawBody`).
 *      The server verifies the signature against the enrolled public key and that
 *      the timestamp is within ATTEST_WINDOW_MS (anti-replay).
 *
 * Back-compat: /api/desktop/provision still accepts the legacy shared secret
 * (bootstrap + already-shipped pilot builds). A request is authorised if EITHER the
 * shared secret matches OR the per-install signature verifies. New builds sign;
 * old builds keep working until they update.
 *
 * Fail-closed: missing/oversized/badly-typed inputs are rejected; the private key
 * never leaves the install; no signature ⇒ no attestation pass. Signature checks use
 * Ed25519 verify (constant-time in the primitive); the shared-secret compare is
 * length-checked + timing-safe.
 *
 * The verify + enrol LOGIC is injectable (getInstall / recordInstall) so a
 * framework-free self-check drives the whole thing through an in-memory store and
 * asserts: a valid signature passes, a tampered/expired one fails, an unknown/
 * revoked install fails, and the legacy secret still works
 * (desktop-attestation.selfcheck.ts).
 */

import crypto from 'crypto'
import { z } from 'zod'

// Anti-replay: a signed request's timestamp must be within this window of the
// server clock (covers modest clock skew + in-flight latency; short enough that a
// captured request can't be replayed later).
export const ATTEST_WINDOW_MS = 5 * 60_000

// installId: opaque, URL-safe, bounded. publicKey: an Ed25519 SPKI PEM.
const INSTALL_ID_RE = /^[A-Za-z0-9_-]{8,128}$/

export const EnrollSchema = z.object({
  installId: z.string().regex(INSTALL_ID_RE),
  publicKey: z.string().min(1).max(4000),
})
export type EnrollInput = z.infer<typeof EnrollSchema>

export interface InstallRecord {
  installId: string
  publicKey: string // Ed25519 SPKI PEM
  revoked?: boolean
}

export interface AttestHeaders {
  installId?: string | string[]
  timestamp?: string | string[]
  signature?: string | string[]
}

/** The exact string the install signs — binds the install, the moment, and the
 *  full request body so none can be swapped independently. */
export function attestationMessage(installId: string, timestamp: string, rawBody: string): string {
  return `${installId}.${timestamp}.${rawBody}`
}

/** Length-checked, timing-safe string compare. Returns false on any mismatch. */
export function timingSafeEqualStr(a: string, b: string): boolean {
  const ba = Buffer.from(a, 'utf8')
  const bb = Buffer.from(b, 'utf8')
  if (ba.length !== bb.length) return false
  return crypto.timingSafeEqual(ba, bb)
}

/** Validate that a PEM string is genuinely an Ed25519 public key we can verify
 *  against — reject anything else at enrol time (fail-closed input validation). */
export function isValidEd25519PublicKey(pem: string): boolean {
  try {
    const key = crypto.createPublicKey(pem)
    return key.asymmetricKeyType === 'ed25519' && key.type === 'public'
  } catch {
    return false
  }
}

const first = (v?: string | string[]): string | undefined => (Array.isArray(v) ? v[0] : v)

export type AttestResult =
  | { ok: true; installId: string }
  | { ok: false; status: number; error: string }

/**
 * Verify a per-install attestation. Pure over its deps (getInstall / now) so it's
 * self-checkable. Rejects missing headers, malformed installId, non-numeric or
 * stale/future timestamps, unknown/revoked installs, and bad signatures — every
 * failure is fail-closed. On success returns the authenticated installId.
 */
export async function verifyAttestation(
  headers: AttestHeaders,
  rawBody: string,
  deps: { getInstall: (id: string) => Promise<InstallRecord | null>; now?: () => number },
): Promise<AttestResult> {
  const now = deps.now?.() ?? Date.now()
  const installId = first(headers.installId)
  const timestamp = first(headers.timestamp)
  const signature = first(headers.signature)

  if (!installId || !timestamp || !signature) {
    return { ok: false, status: 401, error: 'missing attestation headers' }
  }
  if (!INSTALL_ID_RE.test(installId)) return { ok: false, status: 400, error: 'invalid install id' }
  if (signature.length > 512) return { ok: false, status: 400, error: 'signature too long' }

  const ts = Number(timestamp)
  if (!Number.isFinite(ts)) return { ok: false, status: 400, error: 'invalid timestamp' }
  if (Math.abs(now - ts) > ATTEST_WINDOW_MS) {
    return { ok: false, status: 401, error: 'stale or future timestamp' }
  }

  let sig: Buffer
  try {
    sig = Buffer.from(signature, 'base64')
  } catch {
    return { ok: false, status: 400, error: 'invalid signature encoding' }
  }
  if (!sig.length) return { ok: false, status: 400, error: 'empty signature' }

  const rec = await deps.getInstall(installId)
  if (!rec || rec.revoked) return { ok: false, status: 401, error: 'unknown or revoked install' }

  let verified = false
  try {
    verified = crypto.verify(
      null,
      Buffer.from(attestationMessage(installId, timestamp, rawBody), 'utf8'),
      rec.publicKey,
      sig,
    )
  } catch {
    verified = false
  }
  if (!verified) return { ok: false, status: 401, error: 'signature verification failed' }
  return { ok: true, installId }
}

/**
 * Enrol an install. First-write-wins: a brand-new installId is recorded; a re-enrol
 * with the SAME key is idempotent (touch last_seen); a re-enrol of a known installId
 * with a DIFFERENT key is refused (409) so a leaked installId can't be re-bound to an
 * attacker's key. Returns the outcome for the route to shape into a response.
 */
export async function enrollInstall(
  input: EnrollInput,
  deps: {
    getInstall: (id: string) => Promise<InstallRecord | null>
    recordInstall: (rec: InstallRecord) => Promise<void>
    touchInstall?: (id: string) => Promise<void>
  },
): Promise<{ ok: true; created: boolean; installId: string } | { ok: false; status: number; error: string }> {
  if (!isValidEd25519PublicKey(input.publicKey)) {
    return { ok: false, status: 400, error: 'publicKey must be an Ed25519 SPKI PEM' }
  }
  const existing = await deps.getInstall(input.installId)
  if (existing) {
    if (existing.revoked) return { ok: false, status: 403, error: 'install revoked' }
    // Compare on the normalised (parsed) key so PEM whitespace/line-ending diffs
    // don't read as a different key.
    const same = normalizePublicKey(existing.publicKey) === normalizePublicKey(input.publicKey)
    if (!same) return { ok: false, status: 409, error: 'installId already enrolled with a different key' }
    await deps.touchInstall?.(input.installId)
    return { ok: true, created: false, installId: input.installId }
  }
  await deps.recordInstall({ installId: input.installId, publicKey: input.publicKey })
  return { ok: true, created: true, installId: input.installId }
}

/** Canonical DER-base64 of a public key, so semantically identical PEMs compare
 *  equal regardless of formatting. Returns the raw input if it can't be parsed
 *  (caller has already validated it at enrol time). */
function normalizePublicKey(pem: string): string {
  try {
    return crypto.createPublicKey(pem).export({ type: 'spki', format: 'der' }).toString('base64')
  } catch {
    return pem
  }
}

/**
 * Tiny in-memory fixed-window rate limiter for the enrol endpoint (no Redis — enrol
 * is low-volume and pre-tenant). Keyed by client ip. Not distributed; that's fine —
 * it caps a single instance's exposure to enrol spam, and enrol is idempotent +
 * first-write-wins anyway.
 */
export function makeInMemoryRateLimiter(max: number, windowMs: number) {
  const hits = new Map<string, number[]>()
  return function limited(key: string, now: number = Date.now()): boolean {
    const arr = (hits.get(key) ?? []).filter(t => now - t < windowMs)
    arr.push(now)
    hits.set(key, arr)
    // Opportunistic cleanup so the map can't grow unbounded under many distinct ips.
    if (hits.size > 10_000) {
      for (const [k, v] of hits) if (v.every(t => now - t >= windowMs)) hits.delete(k)
    }
    return arr.length > max
  }
}
