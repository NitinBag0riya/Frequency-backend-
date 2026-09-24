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

console.log('team-invite.selfcheck: OK')
