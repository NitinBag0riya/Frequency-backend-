/**
 * Runnable self-check for the pure, security-load-bearing bits of the phone /
 * WhatsApp team-invite accept path. No framework — plain asserts. Exits non-zero
 * on failure.
 *   Run:  npx tsx src/routes/team-invite.selfcheck.ts
 *
 * Covers:
 *   - teammateEmailFromPhone — the deterministic internal identity that lets us
 *     avoid the Supabase phone provider. It MUST be stable, digits-only, always
 *     the control domain, and null for junk (so a bad phone never becomes a real
 *     deliverable address).
 *   - inviteAcceptState — single-use (status), server-expiry, and channel gating,
 *     the sole authorization for account creation + session issuance.
 *   - isValidE164 — the trust-boundary phone validator both rely on.
 */
import assert from 'node:assert/strict'
import { isValidE164, inviteAcceptState, teammateEmailFromPhone } from './teams.js'
import { findAuthUserByEmail, scanAuthUsers, authUsersByIds, inviteStubClaimable } from '../lib/auth-users.js'

// ── Internal-email derivation ────────────────────────────────────────────────
assert.equal(teammateEmailFromPhone('+919876543210'), 'wa-919876543210@teammate.getfrequency.app')
assert.equal(teammateEmailFromPhone('+14155552671'), 'wa-14155552671@teammate.getfrequency.app')
// Deterministic: same number → same identity every time.
assert.equal(teammateEmailFromPhone('+919876543210'), teammateEmailFromPhone('+919876543210'))
// Always the control domain we own (never receives mail) — never a real one.
assert.ok(teammateEmailFromPhone('+919876543210')!.endsWith('@teammate.getfrequency.app'))
// Junk / non-E.164 → null (never fabricate an address).
assert.equal(teammateEmailFromPhone('9876543210'), null)     // no leading '+'
assert.equal(teammateEmailFromPhone('+91 98765 43210'), null) // spaces = not E.164
assert.equal(teammateEmailFromPhone('+0123456789'), null)     // country code can't start 0
assert.equal(teammateEmailFromPhone(''), null)
assert.equal(teammateEmailFromPhone(null), null)
assert.equal(teammateEmailFromPhone(undefined), null)

// ── E.164 trust-boundary validator ───────────────────────────────────────────
assert.equal(isValidE164('+919876543210'), true)
assert.equal(isValidE164('919876543210'), false) // missing '+'
assert.equal(isValidE164('+1'), false)           // too short
assert.equal(isValidE164('+0123456789'), false)  // leading 0 country code

// ── Invite gating (single-use + expiry + channel) ────────────────────────────
const future = new Date(Date.now() + 60_000).toISOString()
const past = new Date(Date.now() - 60_000).toISOString()
const PHONE = '+919876543210'

// Happy path: pending, unexpired, phone present, accepted via phone channel.
assert.equal(inviteAcceptState({ status: 'pending', expires_at: future, phone: PHONE }, 'phone'), 'ok')
// Single-use: anything already consumed/cancelled is refused.
assert.equal(inviteAcceptState({ status: 'accepted', expires_at: future, phone: PHONE }, 'phone'), 'not-pending')
assert.equal(inviteAcceptState({ status: 'cancelled', expires_at: future, phone: PHONE }, 'phone'), 'not-pending')
// Server-side expiry is enforced regardless of client clock.
assert.equal(inviteAcceptState({ status: 'pending', expires_at: past, phone: PHONE }, 'phone'), 'expired')
// Channel gating: a phone accept must land on a phone invite, an email accept on
// an email invite — the token can't be replayed across channels.
assert.equal(inviteAcceptState({ status: 'pending', expires_at: future, phone: null, email: null }, 'phone'), 'wrong-channel')
assert.equal(inviteAcceptState({ status: 'pending', expires_at: future, email: 'a@b.com' }, 'phone'), 'wrong-channel')
assert.equal(inviteAcceptState({ status: 'pending', expires_at: future, email: 'a@b.com' }, 'email'), 'ok')
assert.equal(inviteAcceptState({ status: 'pending', expires_at: future, phone: PHONE }, 'email'), 'wrong-channel')

// ── Email-invite password claim: never on a used account (no takeover) ───────
const T = '2026-09-24T00:00:00Z'
assert.equal(inviteStubClaimable({ invited_at: T, last_sign_in_at: null }), true)  // fresh invite stub
assert.equal(inviteStubClaimable({ invited_at: T, last_sign_in_at: T }), false)    // someone signed in
assert.equal(inviteStubClaimable({ invited_at: null, last_sign_in_at: null }), false) // plain signup, not an invite
assert.equal(inviteStubClaimable({ last_sign_in_at: T }), false)                   // OAuth / real user
assert.equal(inviteStubClaimable(null), false)

// ── auth.users lookups page past 200 (prod had ~349; page-1-only = "not found") ─
function fakeSb(n: number) {
  const users = Array.from({ length: n }, (_, i) => ({ id: `u${i}`, email: `user${i}@x.com` }))
  const calls = { list: 0, byId: 0 }
  const sb = { auth: { admin: {
    async listUsers({ page, perPage }: { page: number; perPage: number }) {
      calls.list++
      return { data: { users: users.slice((page - 1) * perPage, page * perPage) }, error: null }
    },
    async getUserById(id: string) {
      calls.byId++
      return { data: { user: users.find(u => u.id === id) ?? null }, error: null }
    },
  } } }
  return { sb, calls }
}

;(async () => {
  // 2,349 users → target on page 3 of 1000 is still found, case-insensitively.
  const big = fakeSb(2349)
  assert.equal((await findAuthUserByEmail(big.sb, 'USER2300@X.com'))?.id, 'u2300')
  assert.equal(big.calls.list, 3)
  // Missing email → null after the short last page (no infinite loop).
  big.calls.list = 0
  assert.equal(await findAuthUserByEmail(big.sb, 'nobody@x.com'), null)
  assert.equal(big.calls.list, 3)
  assert.equal(await findAuthUserByEmail(big.sb, ''), null)
  // Prod-sized (349): user #300 was invisible to perPage:200 — now found in one call.
  const prod = fakeSb(349)
  assert.equal((await findAuthUserByEmail(prod.sb, 'user300@x.com'))?.id, 'u300')
  assert.equal(prod.calls.list, 1)
  // Substring scan spans all pages.
  assert.equal((await scanAuthUsers(big.sb, u => u.email.startsWith('user234'))).length, 10) // 234 + 2340..2348
  // By-id: one getUserById per UNIQUE id; unknown ids skipped.
  const m = await authUsersByIds(prod.sb, ['u1', 'u300', 'u1', 'ghost'])
  assert.equal(prod.calls.byId, 3)
  assert.deepEqual([...m.keys()].sort(), ['u1', 'u300'])

  console.log('team-invite.selfcheck: OK')
})().catch(e => { console.error(e); process.exit(1) })
