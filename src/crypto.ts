/**
 * AES-256-CBC encryption for secrets at rest (OAuth access/refresh tokens,
 * stored API keys, etc).
 *
 * Used by every connector — the same `GOOGLE_TOKEN_SECRET` env var is reused
 * as the master key (renamed conceptually to TOKEN_SECRET; keeping the var
 * name for backwards-compat with deployed instances).
 *
 * Production hardening — refuse to start if NODE_ENV=production and the env
 * var is missing or set to the dev fallback. Same guard that's in google.ts.
 */
import crypto from 'crypto'

const FALLBACK_DEV_KEY = 'fallback-secret-for-dev-only-32chars-long'
export const ENCRYPTION_KEY = process.env.GOOGLE_TOKEN_SECRET || FALLBACK_DEV_KEY
const IV_LENGTH = 16

if (process.env.NODE_ENV === 'production'
  && (!process.env.GOOGLE_TOKEN_SECRET || ENCRYPTION_KEY === FALLBACK_DEV_KEY)) {
  throw new Error('GOOGLE_TOKEN_SECRET must be set in production. Generate with: openssl rand -hex 16')
}

export function encrypt(text: string | null | undefined): string | null {
  if (text == null || text === '') return null
  const iv = crypto.randomBytes(IV_LENGTH)
  const cipher = crypto.createCipheriv('aes-256-cbc', Buffer.from(ENCRYPTION_KEY.padEnd(32).slice(0, 32)), iv)
  const encrypted = Buffer.concat([cipher.update(String(text)), cipher.final()])
  return iv.toString('hex') + ':' + encrypted.toString('hex')
}

export function decrypt(text: string | null | undefined): string {
  if (!text || !text.includes(':')) return text ?? ''
  try {
    const parts = text.split(':')
    const iv = Buffer.from(parts.shift()!, 'hex')
    const data = Buffer.from(parts.join(':'), 'hex')
    const decipher = crypto.createDecipheriv('aes-256-cbc', Buffer.from(ENCRYPTION_KEY.padEnd(32).slice(0, 32)), iv)
    return Buffer.concat([decipher.update(data), decipher.final()]).toString()
  } catch {
    // Not a real ciphertext (e.g. legacy plaintext). Return as-is so callers
    // can still use legacy values.
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
