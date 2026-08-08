/**
 * Runnable self-check for the MSG91 storefront SMS path.
 * Run:  npx tsx src/lib/storefront-sms.selfcheck.ts
 * No framework — plain asserts, fetch stubbed. Exits non-zero on failure.
 */
import assert from 'node:assert/strict'
import { sendSmsOtp, sendSmsOrderUpdate, normRecipient, smsAvailable } from './storefront-sms.js'

process.env.MSG91_AUTH_KEY = 'synthetic-authkey-0000'
process.env.MSG91_SENDER_ID = 'FREQNC'
process.env.MSG91_OTP_TEMPLATE_ID = 'otp-flow-id'
process.env.MSG91_ORDER_TEMPLATE_ID = 'order-flow-id'
process.env.MSG91_COUNTRY_CODE = '91'

// Capture the outgoing request instead of hitting MSG91.
let last: { url: string; body: any } | null = null
;(globalThis as any).fetch = async (url: string, init: any) => {
  last = { url, body: JSON.parse(init.body) }
  return { ok: true, json: async () => ({ type: 'success' }) } as any
}

async function main() {
  // Recipient normalization: bare 10-digit → CC prepended; already-CC untouched.
  assert.equal(normRecipient('9876543210'), '919876543210')
  assert.equal(normRecipient('+91 98765 43210'), '919876543210')

  assert.equal(await smsAvailable(), true)

  // OTP v2: var1=code, var2=store display name (falls back to brand), CC prepended.
  await sendSmsOtp({} as any, { slug: 's', phone: '9694993366', code: '1234', storeName: 'Maple Mortar' })
  assert.equal(last!.url, 'https://control.msg91.com/api/v5/flow/')
  assert.equal(last!.body.template_id, 'otp-flow-id')
  assert.equal(last!.body.sender, 'FREQNC')
  assert.deepEqual(last!.body.recipients, [{ mobiles: '919694993366', var1: '1234', var2: 'Maple Mortar' }])

  // OTP without a store name falls back to the brand literal.
  await sendSmsOtp({} as any, { slug: 's', phone: '9694993366', code: '1234' })
  assert.equal(last!.body.recipients[0].var2, 'Frequency')

  // Order v2: pass-through var1=order#, var2=status, var3=name; templateId override wins.
  await sendSmsOrderUpdate({} as any, {
    slug: 's', phone: '09876543210',
    vars: { var1: '1088', var2: 'ready', var3: 'Aura' },
    templateId: 'override-flow',
  })
  assert.equal(last!.body.template_id, 'override-flow')
  assert.deepEqual(last!.body.recipients, [{ mobiles: '919876543210', var1: '1088', var2: 'ready', var3: 'Aura' }])

  // Order var1 is NUMBER-tagged: non-digits are stripped ("#1088" → "1088").
  await sendSmsOrderUpdate({} as any, { slug: 's', phone: '9876543210', vars: { var1: '#1088', var2: 'ready', var3: 'Aura' } })
  assert.equal(last!.body.recipients[0].var1, '1088')

  // Order var3 backfills from storeName when the caller omits it.
  await sendSmsOrderUpdate({} as any, { slug: 's', phone: '9876543210', vars: { var1: '1088', var2: 'ready' }, storeName: 'Aura Salon' })
  assert.equal(last!.body.recipients[0].var3, 'Aura Salon')

  // Order defaults when vars entirely missing (var1='0', status/name fall back).
  await sendSmsOrderUpdate({} as any, { slug: 's', phone: '9876543210', vars: {} })
  assert.deepEqual(last!.body.recipients[0], { mobiles: '919876543210', var1: '0', var2: 'updated', var3: 'Frequency' })

  // Each var stays inside the DLT per-variable budget (30 chars).
  await sendSmsOrderUpdate({} as any, { slug: 's', phone: '9876543210', vars: { var1: '1088', var2: 'out for delivery this evening before 9pm', var3: 'A Very Long Restaurant Name That Exceeds' } })
  assert.ok(last!.body.recipients[0].var2.length <= 30 && last!.body.recipients[0].var3.length <= 30, 'order vars must be <= 30 chars')

  // Missing template id throws (→ caller falls back to WhatsApp / on-screen).
  delete process.env.MSG91_OTP_TEMPLATE_ID
  await assert.rejects(
    sendSmsOtp({} as any, { slug: 's', phone: '9876543210', code: '1234' }),
    /template_id not set/,
  )

  console.log('storefront-sms.selfcheck: OK')
}

main().catch((e) => { console.error(e); process.exit(1) })
