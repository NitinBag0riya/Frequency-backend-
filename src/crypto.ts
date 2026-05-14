/**
 * AES-256-GCM encryption for secrets at rest (OAuth access/refresh tokens,
 * stored API keys, etc).
 *
 * Threat model upgrade (B5):
 *   The legacy AES-256-CBC implementation provided confidentiality but NO
 *   integrity. An attacker with write access to the encrypted column could
 *   tamper ciphertext (bit-flipping the last block to swap the user_id in the
 *   plaintext token, etc) and the decrypt path would happily return the
 *   modified value. GCM adds an authentication tag that detects ANY
 *   ciphertext modification — `decipher.final()` throws on tag mismatch.
 *
 * Wire format:
 *   v1 (current):  "v1:" + hex(iv) + ":" + hex(authTag) + ":" + hex(ciphertext)
 *                  IV is 12 bytes (GCM standard), authTag is 16 bytes.
 *   legacy (CBC):  hex(iv) + ":" + hex(ciphertext)
 *                  IV is 16 bytes (CBC standard).
 *
 *   The version prefix lets us detect format unambiguously: any string
 *   starting with `v1:` is GCM, anything else with a single colon is the
 *   legacy CBC format. This enables rolling migration — new writes go out
 *   as v1, legacy reads keep working until rewrap-tokens.ts has been run.
 *
 * Key derivation:
 *   We derive a 32-byte key via scrypt(ENCRYPTION_KEY, salt, 32) instead of
 *   the prior `padEnd(32).slice(0,32)` truncation. scrypt:
 *     - normalises any-length env-var input to a uniform 32-byte key
 *     - is memory-hard so brute-forcing the env-var from a leaked ciphertext
 *       costs an attacker meaningfully more than a single SHA call
 *     - using a fixed salt (`flowgpt-token-salt-v1`) is ACCEPTABLE here
 *       because we're not protecting against a precomputed-rainbow-table
 *       attack — the env-var IS the secret, scrypt is just a KDF that maps
 *       it to a stable 32-byte AES key.
 *
 *   The legacy CBC decrypt path keeps using the old `padEnd().slice()` key
 *   so existing ciphertexts still decrypt. The rewrap script reads via
 *   legacy and writes via v1 to migrate the column over time.
 *
 * Production hardening — refuse to start if NODE_ENV=production and the env
 * var is missing or set to the dev fallback. Same guard that's in google.ts.
 */
import crypto from 'crypto'

const FALLBACK_DEV_KEY = 'fallback-secret-for-dev-only-32chars-long'
export const ENCRYPTION_KEY = process.env.GOOGLE_TOKEN_SECRET || FALLBACK_DEV_KEY

if (process.env.NODE_ENV === 'production'
  && (!process.env.GOOGLE_TOKEN_SECRET || ENCRYPTION_KEY === FALLBACK_DEV_KEY)) {
  throw new Error('GOOGLE_TOKEN_SECRET must be set in production. Generate with: openssl rand -hex 32')
}

// ── Key derivation ────────────────────────────────────────────────────────
// scrypt is intentionally CPU + memory hard. We compute it ONCE at module
// load (not per-encrypt) — N=16384 is fine for a one-shot at boot but would
// be unacceptable per-request.
const KEY_SALT_V1 = 'flowgpt-token-salt-v1'
const GCM_KEY = crypto.scryptSync(ENCRYPTION_KEY, KEY_SALT_V1, 32)

// Legacy CBC key derivation — DO NOT use for new ciphertexts. Kept so the
// fallback decrypt path can still read tokens written before B5 landed.
const LEGACY_CBC_KEY = Buffer.from(ENCRYPTION_KEY.padEnd(32).slice(0, 32))

const GCM_IV_LENGTH    = 12   // GCM standard
const LEGACY_IV_LENGTH = 16   // CBC standard
const VERSION_V1       = 'v1'

/**
 * Encrypt with AES-256-GCM. Output format described in the file header.
 * Returns null for null/undefined/empty input so callers can pass through
 * "no value" without special-casing.
 */
export function encrypt(text: string | null | undefined): string | null {
  if (text == null || text === '') return null
  const iv = crypto.randomBytes(GCM_IV_LENGTH)
  const cipher = crypto.createCipheriv('aes-256-gcm', GCM_KEY, iv)
  const encrypted = Buffer.concat([cipher.update(String(text), 'utf8'), cipher.final()])
  const authTag = cipher.getAuthTag()
  return `${VERSION_V1}:${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted.toString('hex')}`
}

/**
 * Decrypt — auto-detects v1 (GCM) vs legacy (CBC). Returns the decrypted
 * UTF-8 string, or the input as-is if it doesn't look like ciphertext (so
 * legacy plaintext rows still flow through callers without crashing).
 */
export function decrypt(text: string | null | undefined): string {
  if (!text) return text ?? ''
  // v1 (GCM) path
  if (text.startsWith(`${VERSION_V1}:`)) {
    try {
      const parts = text.split(':')
      // Expect exactly 4 parts: ['v1', ivHex, tagHex, ctHex]
      if (parts.length !== 4) return text
      const [, ivHex, tagHex, ctHex] = parts
      const iv = Buffer.from(ivHex, 'hex')
      const authTag = Buffer.from(tagHex, 'hex')
      const ct = Buffer.from(ctHex, 'hex')
      const decipher = crypto.createDecipheriv('aes-256-gcm', GCM_KEY, iv)
      decipher.setAuthTag(authTag)
      return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8')
    } catch {
      // Auth tag mismatch / wrong key / corrupted — fall through to "return as-is"
      // rather than throw so a single bad row doesn't 500 the request.
      return text
    }
  }
  // Legacy CBC fallback (no version prefix)
  if (!text.includes(':')) return text
  try {
    const parts = text.split(':')
    const iv = Buffer.from(parts.shift()!, 'hex')
    if (iv.length !== LEGACY_IV_LENGTH) return text
    const data = Buffer.from(parts.join(':'), 'hex')
    const decipher = crypto.createDecipheriv('aes-256-cbc', LEGACY_CBC_KEY, iv)
    return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8')
  } catch {
    return text
  }
}

/** Generate a URL-safe random token for CSRF state, PKCE verifier, etc. */
export function randomToken(bytes = 32): string {
  return crypto.randomBytes(bytes).toString('base64url')
}

/** SHA-256 → base64url. Used for PKCE code_challenge. */
export function sha256base64url(input: string): string {
  return crypto.createHash('sha256').update(input).digest('base64url')
}
