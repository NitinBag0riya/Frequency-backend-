/**
 * AES-256-GCM encryption for store credentials (App Store Connect key, Google
 * Play service-account JSON). Plaintext keys are encrypted at rest and only ever
 * decrypted inside the build job — they never go back to the browser.
 *
 * Key: APP_CRED_KEY env, a 64-char hex string (32 bytes). In production set it.
 * Without it we derive a dev key (logged) so local dev works — never rely on
 * that for real credentials.
 */
import crypto from 'crypto'

function key(): Buffer {
  const hex = process.env.APP_CRED_KEY
  if (hex && /^[0-9a-fA-F]{64}$/.test(hex)) return Buffer.from(hex, 'hex')
  if (process.env.NODE_ENV === 'production') {
    throw new Error('[app-secrets] APP_CRED_KEY (64-hex) must be set in production')
  }
  // Dev fallback — deterministic so restarts can still decrypt local data.
  return crypto.createHash('sha256').update('dev-app-cred-key').digest()
}

export function encryptSecret(plaintext: string): string {
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', key(), iv)
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return `${iv.toString('base64')}:${tag.toString('base64')}:${ct.toString('base64')}`
}

export function decryptSecret(blob: string): string {
  const [ivB, tagB, ctB] = blob.split(':')
  const decipher = crypto.createDecipheriv('aes-256-gcm', key(), Buffer.from(ivB, 'base64'))
  decipher.setAuthTag(Buffer.from(tagB, 'base64'))
  return Buffer.concat([decipher.update(Buffer.from(ctB, 'base64')), decipher.final()]).toString('utf8')
}
