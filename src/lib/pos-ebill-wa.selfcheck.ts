/**
 * Runnable self-check for the e-bill WhatsApp API dispatch (Phase 6, 6.5:
 * POST /api/internal/pos-ebill-event). Run:  npx tsx src/lib/pos-ebill-wa.selfcheck.ts
 * No framework — plain asserts, no network/Redis (enqueue is an injected
 * fake). Exits non-zero on failure.
 *
 * Covers:
 *   1. Template NOT configured (the real state today — Meta gate unmet) →
 *      `sent: false`, ZERO enqueue calls, never throws. This is the
 *      fail-on-old proof: before this file existed there was no e-bill
 *      WA-API path at all — always sent:false/0 calls. Today's code is the
 *      same until an operator sets WA_EBILL_TEMPLATE_NAME.
 *   2. Template configured + consented + valid phone → exactly one enqueue
 *      call, template body carries the bill link.
 *   3. Opted-out guest → skipped even with a template configured.
 *   4. Invalid/missing phone → skipped, not thrown.
 *   5. Missing bill link → skipped, not thrown.
 */
import assert from 'node:assert/strict'
import { dispatchEBill, normalizePhone, type MessageSendJobLike, type EBillEventBody } from './pos-ebill-wa'

assert.equal(normalizePhone('+919876543210'), '919876543210')
assert.equal(normalizePhone('98765'), null)
assert.equal(normalizePhone(null), null)

async function main() {
  const baseBody: EBillEventBody = {
    tenantId: 'tenant-1', orderId: 'order-1', phone: '+919876543210',
    whatsappOptin: true, billUrl: 'https://order.example.com/track/order-1?t=abc123', amountLabel: '₹640',
  }

  // ── 1. template NOT configured → no-op, never throws, wa.me stays the only path ──
  {
    const calls: MessageSendJobLike[] = []
    const enqueue = async (job: MessageSendJobLike) => { calls.push(job) }
    const out = await dispatchEBill(baseBody, enqueue, { templateName: '' })
    assert.equal(out.sent, false)
    assert.match(out.skippedReason ?? '', /not configured/)
    assert.equal(calls.length, 0, 'MANDATORY: no template → zero sends, ever')
  }

  // ── 2. template configured + consented + valid phone → exactly one send ──
  {
    const calls: MessageSendJobLike[] = []
    const enqueue = async (job: MessageSendJobLike) => { calls.push(job) }
    const out = await dispatchEBill(baseBody, enqueue, { templateName: 'ebill_receipt', templateLang: 'en' })
    assert.equal(out.sent, true)
    assert.equal(calls.length, 1)
    assert.equal(calls[0].to, '919876543210')
    assert.equal(calls[0].channel, 'whatsapp')
    assert.equal(calls[0].template.name, 'ebill_receipt')
    assert.ok(calls[0].template.parameters.includes(baseBody.billUrl), 'bill link is in the template parameters')
  }

  // ── 3. opted-out guest skips even WITH a template configured ─────────────
  {
    const calls: MessageSendJobLike[] = []
    const enqueue = async (job: MessageSendJobLike) => { calls.push(job) }
    const out = await dispatchEBill({ ...baseBody, whatsappOptin: false }, enqueue, { templateName: 'ebill_receipt' })
    assert.equal(out.sent, false)
    assert.match(out.skippedReason ?? '', /opted out/)
    assert.equal(calls.length, 0)
  }

  // ── 4. invalid/missing phone → skipped, not thrown ────────────────────────
  {
    const calls: MessageSendJobLike[] = []
    const enqueue = async (job: MessageSendJobLike) => { calls.push(job) }
    const out = await dispatchEBill({ ...baseBody, phone: '123' }, enqueue, { templateName: 'ebill_receipt' })
    assert.equal(out.sent, false)
    assert.match(out.skippedReason ?? '', /phone/)
    assert.equal(calls.length, 0)

    const outNoPhone = await dispatchEBill({ ...baseBody, phone: null }, enqueue, { templateName: 'ebill_receipt' })
    assert.equal(outNoPhone.sent, false, 'missing phone never throws')
  }

  // ── 5. missing bill link → skipped, not thrown ─────────────────────────────
  {
    const calls: MessageSendJobLike[] = []
    const enqueue = async (job: MessageSendJobLike) => { calls.push(job) }
    const out = await dispatchEBill({ ...baseBody, billUrl: '' }, enqueue, { templateName: 'ebill_receipt' })
    assert.equal(out.sent, false)
    assert.match(out.skippedReason ?? '', /bill link/)
    assert.equal(calls.length, 0)
  }

  console.log('pos-ebill-wa.selfcheck: OK')
  console.log('  MANDATORY: no template configured → zero sends (inert until Meta-approved template is set) · ' +
    'template configured + consented + valid phone → exactly one send carrying the bill link · ' +
    'opted-out/invalid-phone/missing-link all skip without ever throwing')
}

main().catch((e) => { console.error('pos-ebill-wa self-check FAILED:', e); process.exit(1) })
