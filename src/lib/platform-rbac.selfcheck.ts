/**
 * Lean self-check for the platform RBAC capability model + audit diff (no DB).
 * Run with:  npx tsx src/lib/platform-rbac.selfcheck.ts
 * Just runnable asserts — the invariants the /naruto access model depends on.
 */
import assert from 'node:assert'
import { can, normalizeRole, capabilitiesFor, PLATFORM_CAPABILITIES } from './platform-rbac'
import { diffJson } from './platform-audit'

// ── Back-compat: super_admin MUST behave as platform_owner (god-mode) ────────
assert.equal(normalizeRole('super_admin'), 'platform_owner')
for (const cap of PLATFORM_CAPABILITIES) assert.equal(can(cap, 'super_admin'), true, `owner missing ${cap}`)
// Owner via the {role} scope form too.
assert.equal(can('tenant.delete', { role: 'super_admin' }), true)

// ── Legacy platform seeds normalize onto the six canonical roles ─────────────
assert.equal(normalizeRole('customer_success'), 'platform_support')
assert.equal(normalizeRole('billing_ops'), 'platform_finance')
assert.equal(normalizeRole('platform_sales'), 'platform_readonly')
assert.equal(normalizeRole('nonsense'), null)
assert.equal(normalizeRole(null), null)

// ── Role boundaries from spec §1.1 ───────────────────────────────────────────
// finance: payments + plan pricing, but NO impersonation, NO feature config.
assert.equal(can('payments.route_account.write', 'platform_finance'), true)
assert.equal(can('plan.pricing.write', 'platform_finance'), true)
assert.equal(can('tenant.impersonate', 'platform_finance'), false)
assert.equal(can('feature.registry.write', 'platform_finance'), false)

// support: impersonate + fixes, but NO plan/entitlement/payment writes.
assert.equal(can('tenant.impersonate', 'platform_support'), true)
assert.equal(can('support.fix.run', 'platform_support'), true)
assert.equal(can('tenant.entitlement.write', 'platform_support'), false)
assert.equal(can('payments.refund.write', 'platform_support'), false)

// onboarding: create/import, but NO plan pricing / payments / deletion.
assert.equal(can('onboarding.import.run', 'platform_onboarding'), true)
assert.equal(can('tenant.write', 'platform_onboarding'), true)
assert.equal(can('plan.pricing.write', 'platform_onboarding'), false)
assert.equal(can('tenant.delete', 'platform_onboarding'), false)

// admin: broad, but NO tenant deletion / NO payout account changes / NO team mgmt.
assert.equal(can('tenant.entitlement.write', 'platform_admin'), true)
assert.equal(can('tenant.delete', 'platform_admin'), false)
assert.equal(can('payments.route_account.write', 'platform_admin'), false)
assert.equal(can('platform_team.write', 'platform_admin'), false)

// readonly: never writes; still no credential reveal.
assert.equal(can('tenant.read', 'platform_readonly'), true)
assert.equal(can('secret.reveal', 'platform_readonly'), false)
for (const cap of PLATFORM_CAPABILITIES) {
  if (cap.endsWith('.write') || cap.endsWith('.run') || cap === 'tenant.suspend' || cap === 'tenant.delete' || cap === 'tenant.impersonate' || cap === 'support.session.revoke') {
    assert.equal(can(cap, 'platform_readonly'), false, `readonly should not have ${cap}`)
  }
}

// only owner + finance may reveal secrets.
assert.equal(can('secret.reveal', 'platform_owner'), true)
assert.equal(can('secret.reveal', 'platform_finance'), true)
assert.equal(can('secret.reveal', 'platform_admin'), false)

// unknown role → zero capabilities.
assert.equal(capabilitiesFor('nobody').size, 0)

// ── Audit diff: only changed keys, both sides carried ────────────────────────
assert.deepEqual(
  diffJson({ is_enabled: true, quota: 5 }, { is_enabled: false, quota: 5 }),
  { before: { is_enabled: true }, after: { is_enabled: false } })
// nested value change detected via JSON compare
assert.deepEqual(
  diffJson({ q: { a: 1 } }, { q: { a: 2 } }),
  { before: { q: { a: 1 } }, after: { q: { a: 2 } } })
// added + removed keys both surface
assert.deepEqual(
  diffJson({ a: 1 }, { b: 2 }),
  { before: { a: 1, b: undefined }, after: { a: undefined, b: 2 } })
// null-safe
assert.deepEqual(diffJson(null, { a: 1 }), { before: { a: undefined }, after: { a: 1 } })

console.log('platform-rbac self-check: OK')
