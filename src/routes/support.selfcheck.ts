/**
 * Self-check for support ticket routing — `npx tsx src/routes/support.selfcheck.ts`.
 *
 * Routing is the one piece of this feature with real logic, and getting it
 * wrong is quietly expensive: a mis-routed ticket sits in a channel nobody
 * owns while the merchant waits. The cases below are the ones that actually
 * arrive — Hinglish, Devanagari, and the two pairs that are easy to confuse
 * (merchant payments vs our own billing; a bug vs an ops question).
 */
import assert from 'node:assert/strict'
import { inferCategory, channelMap } from './support'

const cases: Array<[string, string]> = [
  // Merchant money — theirs, not ours.
  ['Zomato ka payment settle nahi ho raha, 3 din se pending', 'payments'],
  ['refund customer ko nahi gaya', 'payments'],
  ['भुगतान नहीं आया', 'payments'],
  ['razorpay gateway KYC pending', 'payments'],
  // Our money — must NOT land in #support-payments.
  ['I want to upgrade my plan, need more seats', 'billing-plans'],
  ['invoice for last month subscription', 'billing-plans'],
  // Daily ops.
  ['KOT printer se print nahi ho raha', 'orders'],
  ['बिल बनाते समय दिक्कत', 'orders'],
  ['swiggy orders are not coming to the board', 'orders'],
  ['day close ka number match nahi kar raha', 'orders'],
  // Catalogue + stock.
  ['paneer ka price change karna hai menu me', 'catalog-stock'],
  ['stock count galat dikha raha hai', 'catalog-stock'],
  ['सामग्री कम दिख रही है', 'catalog-stock'],
  // Setup.
  ['we are new, need help to go live this week', 'onboarding'],
  // Defects.
  ['the page is blank and I get an error', 'bugs'],
  // Genuinely unclear → triage, never a guess.
  ['hello', 'triage'],
  ['can you call me', 'triage'],
  ['', 'triage'],
]

for (const [text, want] of cases) {
  const got = inferCategory(text)
  assert.equal(got, want, `"${text}" → expected ${want}, got ${got}`)
}

// Every category the router can produce must resolve to a real channel id,
// otherwise a ticket silently posts nowhere.
const map = channelMap()
for (const [, want] of cases) {
  assert.ok(map[want], `category "${want}" has no channel configured`)
  assert.match(map[want], /^C[A-Z0-9]{6,}$/, `channel id for "${want}" looks wrong: ${map[want]}`)
}
assert.ok(map.triage, 'triage is the fallback and must always exist')

// A partial env override must MERGE, not replace — otherwise overriding one
// channel silently drops the other six to undefined.
process.env.SLACK_SUPPORT_CHANNELS = JSON.stringify({ payments: 'C0TESTOVERRIDE' })
const merged = channelMap()
assert.equal(merged.payments, 'C0TESTOVERRIDE', 'override should win')
assert.ok(merged.triage && merged.orders, 'unmentioned categories must survive an override')
delete process.env.SLACK_SUPPORT_CHANNELS

// Malformed env must fall back to defaults rather than throwing at request time.
process.env.SLACK_SUPPORT_CHANNELS = '{not json'
assert.ok(channelMap().triage, 'bad JSON must fall back, not crash')
delete process.env.SLACK_SUPPORT_CHANNELS

console.log(`support.selfcheck: OK (${cases.length} routing cases, ${Object.keys(map).length} channels)`)
