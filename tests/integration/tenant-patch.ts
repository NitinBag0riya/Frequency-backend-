/**
 * Self-check for sanitizeTenantPatch — the security-relevant field whitelist
 * behind PATCH /api/tenants/:id. Run: `npx tsx tests/integration/tenant-patch.ts`
 * (or add to package.json as test:tenant-patch). Assert-based, no framework.
 */
import assert from 'node:assert/strict'
import { sanitizeTenantPatch } from '../../src/lib/tenant-patch'

const CTRL = new RegExp('[\\u0000-\\u001F\\u007F]')

// 1. business_type (vertical) is LOCKED — never makes it into the patch.
{
  const { patch, error } = sanitizeTenantPatch({ business_name: 'Cafe X', business_type: 'd2c' })
  assert.equal(error, undefined)
  assert.deepEqual(patch.business_name, 'Cafe X')
  assert.ok(!('business_type' in patch), 'business_type must be stripped')
}

// 2. Control chars stripped, length bounded.
{
  const dirty = 'Ac' + String.fromCharCode(0, 9, 127) + 'me' + 'x'.repeat(200)
  const { patch } = sanitizeTenantPatch({ business_name: dirty })
  assert.ok(!CTRL.test(patch.business_name as string), 'control chars stripped')
  assert.equal((patch.business_name as string).length, 120, 'bounded to 120 chars')
}

// 3. Empty / whitespace-only business_name is rejected (can't blank the name).
{
  const { error } = sanitizeTenantPatch({ business_name: '   ' })
  assert.equal(error, 'business_name cannot be empty')
}

// 4. No editable fields → rejected (prevents no-op writes / junk bodies).
{
  const { error } = sanitizeTenantPatch({ business_type: 'salon', id: 'x', status: 'suspended' })
  assert.equal(error, 'No editable fields supplied')
}

// 5. Optional details pass through; non-strings become null (clears field).
{
  const { patch, error } = sanitizeTenantPatch({
    business_name: 'Acme', legal_name: 'Acme Pvt Ltd', display_phone: '+91 98765 43210',
    billing_address: 42,
  })
  assert.equal(error, undefined)
  assert.equal(patch.legal_name, 'Acme Pvt Ltd')
  assert.equal(patch.display_phone, '+91 98765 43210')
  assert.equal(patch.billing_address, null)
}

console.log('✓ tenant-patch selfcheck passed (5 cases)')
