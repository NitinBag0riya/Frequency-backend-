/**
 * Runnable self-check for the Brevo email/SMS provider swap.
 * Run:  npx tsx src/lib/brevo.selfcheck.ts
 * No framework — plain asserts. Exits non-zero on failure.
 */
import assert from 'node:assert/strict'
import { parseSender, brevoApiKey } from './email.js'
import { normRecipient } from './storefront-sms.js'

// API-key normalization: raw xkeysib passes through; base64 {"api_key":"xkeysib-…"}
// wrapper is unwrapped. (Synthetic key — not a real secret.)
const RAW = 'xkeysib-0000synthetic0000-selfcheck'
process.env.BREVO_API_KEY = RAW
assert.equal(brevoApiKey(), RAW)
process.env.BREVO_API_KEY = Buffer.from(JSON.stringify({ api_key: RAW })).toString('base64')
assert.equal(brevoApiKey(), RAW)
delete process.env.BREVO_API_KEY
assert.equal(brevoApiKey(), undefined)

// Sender parsing: "Name <email>" and bare "email"
assert.deepEqual(parseSender('Frequency <hello@frequency.in>'), { email: 'hello@frequency.in', name: 'Frequency' })
assert.deepEqual(parseSender('  hello@frequency.in  '), { email: 'hello@frequency.in' })
assert.equal(parseSender('<hello@frequency.in>').email, 'hello@frequency.in') // empty name → undefined, omitted in JSON

// Recipient normalization: bare 10-digit → default country code; already-CC untouched; strips +/spaces
process.env.BREVO_SMS_COUNTRY_CODE = '91'
assert.equal(normRecipient('9876543210'), '919876543210')
assert.equal(normRecipient('+91 98765 43210'), '919876543210')
assert.equal(normRecipient('919876543210'), '919876543210')

console.log('brevo.selfcheck: OK')
