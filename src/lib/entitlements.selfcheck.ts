/**
 * Lean self-check for the pure entitlements helpers (no DB). Run with:
 *   npx tsx src/lib/entitlements.selfcheck.ts
 * Asserts the vertical grouping + limit resolution edge cases the resolver
 * depends on. Not a framework — just runnable asserts.
 */
import assert from 'node:assert'
import { businessGroup, resolveLimit } from './entitlements'

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

console.log('entitlements self-check: OK')
