/**
 * Lean self-check for the pure entitlements helpers (no DB). Run with:
 *   npx tsx src/lib/entitlements.selfcheck.ts
 * Asserts the vertical grouping + limit resolution edge cases the resolver
 * depends on. Not a framework — just runnable asserts.
 */
import assert from 'node:assert'
import { businessGroup, resolveLimit, decideFeature } from './entitlements'

// businessGroup canonicalization (mirror of FE storefront.businessGroup)
assert.equal(businessGroup('restaurant'), 'horeca')
assert.equal(businessGroup('cafe'), 'horeca')
assert.equal(businessGroup('spa'), 'salon')
assert.equal(businessGroup('services'), 'salon')
assert.equal(businessGroup('retail'), 'd2c')
assert.equal(businessGroup('ecommerce'), 'd2c')
assert.equal(businessGroup('real_estate'), 'real_estate')
assert.equal(businessGroup(null), 'other')
assert.equal(businessGroup('who_knows'), 'other')

// resolveLimit: override beats plan; plan used otherwise; missing → -1 (∞)
assert.equal(resolveLimit({ contacts_max: 5000 }, { contacts_max: 999999 }, 'contacts_max'), 999999)
assert.equal(resolveLimit({ contacts_max: 5000 }, null, 'contacts_max'), 5000)
assert.equal(resolveLimit({ contacts_max: 5000 }, {}, 'contacts_max'), 5000)
assert.equal(resolveLimit({}, null, 'contacts_max'), -1)
// override of 0 (block) must win over a permissive plan
assert.equal(resolveLimit({ messages_per_month: 10000 }, { messages_per_month: 0 }, 'messages_per_month'), 0)

// decideFeature: layer precedence for the cockpit matrix source labels.
// Hard vertical gate wins over everything — even a force-on override.
assert.deepEqual(
  decideFeature({ vertical_locked: true, override_enabled: true, plan_granted: true, default_enabled: true }),
  { resolved: false, source: 'vertical' })
// Active override (force-off) beats a plan grant.
assert.deepEqual(
  decideFeature({ vertical_locked: false, override_enabled: false, plan_granted: true, default_enabled: true }),
  { resolved: false, source: 'override' })
// Force-on override beats a false default with no plan grant.
assert.deepEqual(
  decideFeature({ vertical_locked: false, override_enabled: true, plan_granted: false, default_enabled: false }),
  { resolved: true, source: 'override' })
// No override → plan grant wins.
assert.deepEqual(
  decideFeature({ vertical_locked: false, override_enabled: null, plan_granted: true, default_enabled: false }),
  { resolved: true, source: 'plan' })
// No override, no plan grant → global default decides.
assert.deepEqual(
  decideFeature({ vertical_locked: false, override_enabled: null, plan_granted: false, default_enabled: true }),
  { resolved: true, source: 'default' })

console.log('entitlements self-check: OK')
