/**
 * Runnable self-check for phone-invite token/expiry/tenant-link logic.
 * Run:  npx tsx src/routes/teams.selfcheck.ts
 * Plain asserts, no framework. Exits non-zero on failure.
 *
 * Covers the security-load-bearing pure logic behind the phone-invite flow:
 *   - E.164 validation at the trust boundary
 *   - single-use / expiry / channel gating (inviteAcceptState)
 */
import assert from 'node:assert/strict'
import { isValidE164, inviteAcceptState } from './teams.js'

const now = Date.parse('2026-08-15T12:00:00Z')
const future = new Date(now + 86_400_000).toISOString()
const past = new Date(now - 86_400_000).toISOString()

// ── E.164 validation ────────────────────────────────────────────────────────
assert.equal(isValidE164('+919876543210'), true)
assert.equal(isValidE164('+14155552671'), true)
assert.equal(isValidE164('919876543210'), false, 'missing leading +')
assert.equal(isValidE164('+0123456789'), false, 'country code cannot start with 0')
assert.equal(isValidE164('+123'), false, 'too short')
assert.equal(isValidE164('+91 98765 43210'), false, 'no spaces')
assert.equal(isValidE164(''), false)
assert.equal(isValidE164(undefined), false)
assert.equal(isValidE164(1234567890 as any), false, 'non-string rejected')

// ── Accept-state gating ───────────────────────────────────────────────────────
const phoneInvite = { status: 'pending', expires_at: future, phone: '+919876543210', email: null }

// Happy path: pending + unexpired + right channel.
assert.equal(inviteAcceptState(phoneInvite, 'phone', now), 'ok')

// Single-use: once accepted (or cancelled/expired), it can't be re-consumed.
assert.equal(inviteAcceptState({ ...phoneInvite, status: 'accepted' }, 'phone', now), 'not-pending')
assert.equal(inviteAcceptState({ ...phoneInvite, status: 'cancelled' }, 'phone', now), 'not-pending')

// Expiry is enforced against the row, not the client clock.
assert.equal(inviteAcceptState({ ...phoneInvite, expires_at: past }, 'phone', now), 'expired')

// Channel isolation: a phone-accept must not consume an email invite (and v.v.),
// which is what keeps the WhatsApp-delivered token single-purpose.
const emailInvite = { status: 'pending', expires_at: future, phone: null, email: 'a@b.com' }
assert.equal(inviteAcceptState(emailInvite, 'phone', now), 'wrong-channel')
assert.equal(inviteAcceptState(phoneInvite, 'email', now), 'wrong-channel')
assert.equal(inviteAcceptState(emailInvite, 'email', now), 'ok')

// Ordering: not-pending is reported before expiry (a cancelled+expired invite
// reads as not-pending, so a stale link never leaks an "expired" hint that a
// still-live one wouldn't).
assert.equal(inviteAcceptState({ ...phoneInvite, status: 'cancelled', expires_at: past }, 'phone', now), 'not-pending')

console.log('teams.selfcheck: OK')
