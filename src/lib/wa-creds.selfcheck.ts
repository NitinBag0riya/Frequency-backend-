/**
 * Self-check for the two pieces of wa-creds that are easy to get subtly wrong
 * and expensive to get wrong in production:
 *
 *   1. readSecretValue must round-trip encrypted values AND pass legacy
 *      plaintext tokens through untouched. If the passthrough breaks, every
 *      existing tenant's WhatsApp stops sending the moment this deploys.
 *   2. verifyMetaSignature must accept a genuine Meta signature and reject
 *      everything else — including a valid signature made with the WRONG app
 *      secret, which is exactly the BYO cross-tenant case.
 *
 * Run: npx tsx src/lib/wa-creds.selfcheck.ts
 */

import assert from 'assert'
import crypto from 'crypto'
import { readSecretValue, writeSecretValue, verifyMetaSignature, newWebhookToken } from './wa-creds'

// ── 1. Secret storage ──────────────────────────────────────────────────────
const plain = 'EAAGm0PX4ZCpsBA1234567890abcdefGHIJKLMNOP'
const blob = writeSecretValue(plain)

assert.notStrictEqual(blob, plain, 'encrypted blob must differ from plaintext')
assert.strictEqual(blob.split(':').length, 3, 'blob must be iv:tag:ciphertext')
assert.strictEqual(readSecretValue(blob), plain, 'encrypted value must round-trip')

// The migration path: rows written before encryption are bare Meta tokens.
assert.strictEqual(readSecretValue(plain), plain, 'legacy plaintext must pass through')
assert.strictEqual(readSecretValue(null), null, 'null stays null')
assert.strictEqual(readSecretValue(''), null, 'empty stays null')

// A real Meta token contains no ':' — that is what makes the discriminator
// safe. Guard the assumption so a future token format change is caught here
// rather than by a silent decrypt attempt in production.
assert.ok(!plain.includes(':'), 'Meta token must not contain a colon')

// Two encryptions of the same input must differ (random IV) but both decrypt.
const blob2 = writeSecretValue(plain)
assert.notStrictEqual(blob, blob2, 'IV must be random per encryption')
assert.strictEqual(readSecretValue(blob2), plain, 'second blob decrypts too')

// ── 2. Webhook signature ───────────────────────────────────────────────────
const ourSecret = 'platform-app-secret'
const theirSecret = 'byo-tenant-app-secret'
const body = Buffer.from(JSON.stringify({ object: 'whatsapp_business_account', entry: [] }))
const sign = (s: string) => 'sha256=' + crypto.createHmac('sha256', s).update(body).digest('hex')

assert.strictEqual(verifyMetaSignature(body, sign(ourSecret), ourSecret), true,
  'genuine signature must verify')

// The BYO isolation property: a payload signed by one tenant's app must not
// verify against another secret. This is what stops a merchant who controls
// their own signing key from posting into someone else's inbox.
assert.strictEqual(verifyMetaSignature(body, sign(theirSecret), ourSecret), false,
  'signature from a different app secret must be rejected')

assert.strictEqual(verifyMetaSignature(body, undefined, ourSecret), false, 'missing header rejected')
assert.strictEqual(verifyMetaSignature(body, sign(ourSecret), ''), false, 'missing secret rejected')
assert.strictEqual(verifyMetaSignature(body, 'sha1=deadbeef', ourSecret), false, 'wrong prefix rejected')
assert.strictEqual(verifyMetaSignature(body, 'sha256=short', ourSecret), false, 'length mismatch rejected')

// Tampered body must fail even with a previously-valid signature.
const goodSig = sign(ourSecret)
const tampered = Buffer.from(JSON.stringify({ object: 'whatsapp_business_account', entry: [{ id: 'evil' }] }))
assert.strictEqual(verifyMetaSignature(tampered, goodSig, ourSecret), false, 'tampered body rejected')

// ── 3. Webhook tokens ──────────────────────────────────────────────────────
const tokens = new Set(Array.from({ length: 500 }, () => newWebhookToken()))
assert.strictEqual(tokens.size, 500, 'webhook tokens must be unique')
assert.ok([...tokens].every(t => /^[A-Za-z0-9_-]{32,}$/.test(t)), 'tokens must be URL-safe and long')

console.log('✅ wa-creds self-check passed')
