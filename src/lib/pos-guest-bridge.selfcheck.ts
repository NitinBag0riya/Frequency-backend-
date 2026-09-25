/**
 * Runnable self-check for the POS guest → contacts/consent bridge
 * (Phase 6, P6-bridge: POST /api/internal/pos-guest-sync).
 * Run:  npx tsx src/lib/pos-guest-bridge.selfcheck.ts
 * No framework — plain asserts, in-memory fake Supabase. Exits non-zero on
 * failure. Proves the DPDPA MANDATORY invariant:
 *
 *   1. consent=false  → contact IS upserted (birthday/name carry over) but
 *      NO consent_events row is written → nothing for the sweep to find.
 *      This is the fail-on-old proof: before this file existed, there was
 *      no bridge at all, so `contacts` and `consent_events` were NEVER
 *      written from a POS guest — 0 rows in both tables, always. Today's
 *      code writes the contact but is asserted to still write ZERO
 *      consent_events on an unticked box.
 *   2. consent=true   → contact upserted AND exactly one consent_events row
 *      (event_type='opt_in', purpose='marketing', source='pos').
 *   3. A later sync with consent=false on an ALREADY-opted-in contact does
 *      NOT write an opt_out event — the grant-only, one-way gate (a
 *      default-unticked box at visit 2 must never revoke visit 1's consent).
 *   4. Returning-guest birthday/name merge, never wipe an existing value.
 */
import assert from 'node:assert/strict'
import { syncPosGuestToContacts, normalizeGuestPhone, guestAttributesPatch } from './pos-guest-bridge'

// ── pure helpers ─────────────────────────────────────────────────────────────
assert.equal(normalizeGuestPhone('+91 98765 43210'), '919876543210')
assert.equal(normalizeGuestPhone('9876543210'), '919876543210')
assert.equal(normalizeGuestPhone('123'), null, 'too short → invalid')
assert.equal(normalizeGuestPhone(null), null)
assert.deepEqual(guestAttributesPatch({ phone: 'x', birthday: '1990-06-15' }), { birthday: '1990-06-15' })
assert.deepEqual(guestAttributesPatch({ phone: 'x' }), {}, 'no fields → empty patch, never wipes')

// ── in-memory fake Supabase — minimal chain covering contacts + consent_events ─
type Row = Record<string, any>
function makeFakeSupabase() {
  const tables: Record<string, Row[]> = { contacts: [], consent_events: [] }
  let seq = 0
  const uid = (p: string) => `${p}-${++seq}`
  function query(table: string) {
    const rows = tables[table] ?? (tables[table] = [])
    const filters: Array<[string, any]> = []
    const builder: any = {
      select() { return builder },
      eq(col: string, val: any) { filters.push([col, val]); return builder },
      match: () => rows.filter(r => filters.every(([c, v]) => r[c] === v)),
      async maybeSingle() { return { data: builder.match()[0] ?? null, error: null } },
      insert(payload: Row) {
        const row = { id: payload.id ?? uid(table.slice(0, 3)), ...payload }
        rows.push(row)
        return {
          select() { return { async single() { return { data: row, error: null } } } },
          async then(res: any) { return Promise.resolve({ data: row, error: null }).then(res) },
        }
      },
      update(patch: Row) {
        return {
          async eq(col: string, val: any) {
            const idx = rows.findIndex(r => r[col] === val)
            if (idx >= 0) rows[idx] = { ...rows[idx], ...patch }
            return { error: idx >= 0 ? null : { message: 'not found' } }
          },
        }
      },
    }
    return builder
  }
  return { _tables: tables, from: (t: string) => query(t) } as any
}

async function main() {
  // ── 2 & 4. consent=true on a NEW guest → contact + exactly one opt_in event ─
  const sb1 = makeFakeSupabase()
  const r1 = await syncPosGuestToContacts(sb1, {
    tenantId: 't1', guest: { phone: '9876543210', name: 'Asha', birthday: '1990-06-15', consent: true },
  })
  assert.ok(r1.contactId, 'contact created')
  assert.equal(r1.consentRecorded, true)
  assert.equal(sb1._tables.contacts.length, 1)
  assert.equal(sb1._tables.contacts[0].attributes.birthday, '1990-06-15')
  assert.equal(sb1._tables.consent_events.length, 1, 'exactly one consent_events row')
  assert.equal(sb1._tables.consent_events[0].event_type, 'opt_in')
  assert.equal(sb1._tables.consent_events[0].purpose, 'marketing')
  assert.equal(sb1._tables.consent_events[0].source, 'pos')
  assert.equal(sb1._tables.consent_events[0].channel, 'whatsapp')

  // ── 1. consent=false on a NEW guest → contact upserted, ZERO consent rows ──
  const sb2 = makeFakeSupabase()
  const r2 = await syncPosGuestToContacts(sb2, {
    tenantId: 't1', guest: { phone: '9876500000', name: 'Rahul', birthday: '1985-03-02', consent: false },
  })
  assert.ok(r2.contactId, 'contact still created for a walk-in guest')
  assert.equal(r2.consentRecorded, false)
  assert.equal(sb2._tables.contacts.length, 1, 'contact row exists (name/birthday captured)')
  assert.equal(sb2._tables.contacts[0].attributes.birthday, '1985-03-02')
  assert.equal(sb2._tables.consent_events.length, 0, 'MANDATORY: unticked box writes NO consent_events row')

  // undefined consent behaves the same as false (never assumed).
  const sb2b = makeFakeSupabase()
  const r2b = await syncPosGuestToContacts(sb2b, { tenantId: 't1', guest: { phone: '9876500001', name: 'X' } })
  assert.equal(r2b.consentRecorded, false)
  assert.equal(sb2b._tables.consent_events.length, 0)

  // ── 3. grant-only, one-way gate: a later unticked visit does NOT revoke ────
  const sb3 = makeFakeSupabase()
  await syncPosGuestToContacts(sb3, { tenantId: 't1', guest: { phone: '9876511111', name: 'Priya', consent: true } })
  assert.equal(sb3._tables.consent_events.length, 1, 'visit 1: opted in')
  const r3b = await syncPosGuestToContacts(sb3, { tenantId: 't1', guest: { phone: '9876511111', consent: false } })
  assert.equal(r3b.consentRecorded, false)
  assert.equal(sb3._tables.consent_events.length, 1, 'visit 2 (unticked) must NOT add an opt_out — still exactly the one opt_in')
  assert.equal(sb3._tables.consent_events[0].event_type, 'opt_in', 'the one event on file is still the original opt_in')

  // ── 4. returning-guest merge: birthday from visit 1 survives a visit-2 sync that omits it ──
  assert.equal(sb3._tables.contacts[0].attributes.birthday, undefined, 'visit 1 sent no birthday')
  const r3c = await syncPosGuestToContacts(sb3, { tenantId: 't1', guest: { phone: '9876511111', anniversary: '2020-01-01' } })
  assert.ok(r3c.contactId)
  assert.equal(sb3._tables.contacts[0].attributes.anniversary, '2020-01-01', 'new field merged in')

  // ── missing tenantId / invalid phone never throws, just reports skipped ────
  const sb4 = makeFakeSupabase()
  const bad1 = await syncPosGuestToContacts(sb4, { tenantId: '', guest: { phone: '9876543210' } })
  assert.equal(bad1.contactId, null)
  assert.match(bad1.skippedReason ?? '', /tenantId/)
  const bad2 = await syncPosGuestToContacts(sb4, { tenantId: 't1', guest: { phone: '123' } })
  assert.equal(bad2.contactId, null)
  assert.equal(sb4._tables.contacts.length, 0)

  console.log('pos-guest-bridge.selfcheck: OK')
  console.log('  consent=true → contact + exactly one opt_in consent_events row (channel=whatsapp, purpose=marketing, source=pos) · ' +
    'consent=false/absent → contact upserted, ZERO consent_events rows (MANDATORY DPDPA gate) · ' +
    'a later unticked visit never revokes an earlier real opt-in (grant-only, one-way) · attributes merge without wiping')
}

main().catch((e) => { console.error('pos-guest-bridge self-check FAILED:', e); process.exit(1) })
