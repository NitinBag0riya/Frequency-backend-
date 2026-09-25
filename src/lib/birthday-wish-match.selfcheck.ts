/**
 * Runnable self-check for the birthday/anniversary daily-sweep SELECTION
 * LOGIC (POS Upgrade Phase 6, 6.2 — workers/birthday-wish-sweep.ts).
 * Run:  npx tsx src/lib/birthday-wish-match.selfcheck.ts
 * No framework — plain asserts, zero network/env dependency (this module has
 * no supabase/queue imports by design — see its file header). Exits non-zero
 * on failure.
 *
 * MANDATORY (DPDPA): the fixture below is the exact 3-contact shape named in
 * the task — bday-today opted_in / bday-today opted_out / other-day
 * opted_in — and asserts the sweep selects ONLY the first. Before this file
 * existed there was no worker at all (fail-on-old = trivially 0 selected,
 * always), so this also proves today's code actually does the job, not just
 * that it compiles.
 */
import assert from 'node:assert/strict'
import {
  todayMonthDayIST, extractMonthDay, matchesToday,
  isConsentedMarketingWhatsApp, selectSweepTargets,
} from './birthday-wish-match'

// ── pure date/consent helpers ────────────────────────────────────────────────
{
  const md = todayMonthDayIST(new Date(Date.UTC(2026, 8, 25, 3, 0, 0))) // 2026-09-25 08:30 IST
  assert.equal(md, '09-25', 'IST civil date, not UTC (03:00 UTC = 08:30 IST, same day)')
  // A date near UTC midnight that rolls to the NEXT day in IST.
  const rolled = todayMonthDayIST(new Date(Date.UTC(2026, 8, 24, 20, 0, 0))) // 2026-09-24 20:00 UTC = 2026-09-25 01:30 IST
  assert.equal(rolled, '09-25', 'IST offset correctly rolls the civil date forward')
}
assert.equal(extractMonthDay('1990-06-15'), '06-15')
assert.equal(extractMonthDay('06-15'), '06-15')
assert.equal(extractMonthDay(''), null)
assert.equal(extractMonthDay(null), null)
assert.equal(extractMonthDay('not-a-date'), null)

assert.equal(matchesToday({ birthday: '1990-06-15' }, '06-15'), 'birthday')
assert.equal(matchesToday({ anniversary: '2020-06-15' }, '06-15'), 'anniversary')
assert.equal(matchesToday({ birthday: '06-15' }, '01-01'), null, 'no match on a different day')
assert.equal(matchesToday(null, '06-15'), null)
assert.equal(matchesToday({ birthday: '1990-06-15', anniversary: '1990-06-15' }, '06-15'), 'birthday', 'birthday wins the tie — exactly one wish')

assert.equal(isConsentedMarketingWhatsApp({ channel: 'whatsapp', purpose: 'marketing', status: 'opted_in' }), true)
assert.equal(isConsentedMarketingWhatsApp({ channel: 'whatsapp', purpose: 'marketing', status: 'opted_out' }), false, 'opted_out is rejected')
assert.equal(isConsentedMarketingWhatsApp({ channel: 'whatsapp', purpose: 'marketing', status: 'expired' }), false, 'expired is rejected')
assert.equal(isConsentedMarketingWhatsApp({ channel: 'sms', purpose: 'marketing', status: 'opted_in' }), false, 'wrong channel is rejected')
assert.equal(isConsentedMarketingWhatsApp({ channel: 'whatsapp', purpose: 'transactional', status: 'opted_in' }), false, 'wrong purpose is rejected')
assert.equal(isConsentedMarketingWhatsApp(null), false, 'no consent row at all is rejected')

// ── MANDATORY: the exact 3-contact fixture ───────────────────────────────────
{
  const todayMD = '09-25'
  // "other day" derived as today+3 (never accidentally collides with todayMD,
  // unlike a hardcoded '01-01' which WOULD collide if this ever ran on Jan 1).
  const otherDate = new Date(Date.UTC(2026, 8, 25))
  otherDate.setUTCDate(otherDate.getUTCDate() + 3)
  const otherMD = `${String(otherDate.getUTCMonth() + 1).padStart(2, '0')}-${String(otherDate.getUTCDate()).padStart(2, '0')}`

  const rows = [
    { // 1. bday-today, opted_in → SELECTED
      id: 'a', tenant_id: 't1', phone: '919000000001', name: 'Asha',
      attributes: { birthday: `1990-${todayMD}` },
      contact_consent_state: { channel: 'whatsapp', purpose: 'marketing', status: 'opted_in' },
    },
    { // 2. bday-today, opted_out → NEVER selected (the DPDPA invariant)
      id: 'b', tenant_id: 't1', phone: '919000000002', name: 'Rahul',
      attributes: { birthday: `1985-${todayMD}` },
      contact_consent_state: { channel: 'whatsapp', purpose: 'marketing', status: 'opted_out' },
    },
    { // 3. other-day, opted_in → not selected (wrong day)
      id: 'c', tenant_id: 't1', phone: '919000000003', name: 'Priya',
      attributes: { birthday: `1992-${otherMD}` },
      contact_consent_state: { channel: 'whatsapp', purpose: 'marketing', status: 'opted_in' },
    },
  ]

  const selected = selectSweepTargets(rows as any, todayMD)
  assert.equal(selected.length, 1, 'exactly one contact selected')
  assert.equal(selected[0].id, 'a', 'ONLY the bday-today + opted_in contact fires')
  assert.equal(selected[0].kind, 'birthday')

  // Same fixture but contact_consent_state arrives as a 1-element array (the
  // shape supabase-js actually returns for an embedded !inner join) — selection
  // logic must handle both shapes identically.
  const rowsArrayShape = rows.map(r => ({ ...r, contact_consent_state: [r.contact_consent_state] }))
  const selectedArrayShape = selectSweepTargets(rowsArrayShape as any, todayMD)
  assert.deepEqual(selectedArrayShape.map(s => s.id), ['a'], 'array-shaped embedded consent row selects identically')

  // A contact with NO consent row at all (defensive — the SQL !inner join
  // should never actually produce this, but the JS-side gate must still hold).
  const noConsentRow = [{ id: 'd', tenant_id: 't1', phone: '919000000004', name: 'X', attributes: { birthday: `1990-${todayMD}` }, contact_consent_state: null }]
  assert.deepEqual(selectSweepTargets(noConsentRow as any, todayMD), [], 'no consent row on file → never selected')
}

console.log('birthday-wish-sweep.selfcheck: OK')
console.log('  IST civil-date rollover correct · MM-DD extraction handles YYYY-MM-DD and bare MM-DD · ' +
  'MANDATORY: opted_in+today-birthday selected, opted_out+today-birthday NEVER selected, opted_in+other-day NEVER selected · ' +
  'consent gate holds for both array- and object-shaped embedded joins and for a missing consent row')
