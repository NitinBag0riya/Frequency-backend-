/**
 * Self-check for the bulk-entitlements pure core — the noop rule + the
 * create/delete inversion that /reverse depends on. No DB, no framework.
 *
 *   npx tsx src/routes/naruto-bulk-entitlements.selfcheck.ts
 */
import assert from 'node:assert'
import { featureOverrideImages, type OverrideImage } from './naruto-bulk-entitlements'

const ON: OverrideImage = { is_enabled: true, override_reason: 'x', expires_at: null, quota_override: null }
const OFF: OverrideImage = { is_enabled: false, override_reason: null, expires_at: null, quota_override: null }

// 1 — force ON with no existing row → writes a row, not a no-op.
let r = featureOverrideImages('on', false, null)
assert.equal(r.noop, false)
assert.equal(r.before_json, null)          // reverse of a create = delete
assert.equal(r.after_json?.is_enabled, true)

// 2 — force ON when already ON → no-op, nothing to write.
r = featureOverrideImages('on', false, ON)
assert.equal(r.noop, true)
assert.equal(r.after_json, null)

// 3 — force OFF when currently ON → writes, before-image preserves prior row.
r = featureOverrideImages('off', false, ON)
assert.equal(r.noop, false)
assert.equal(r.after_json?.is_enabled, false)
assert.equal(r.before_json?.is_enabled, true)   // reverse restores ON

// 4 — inherit with an existing row → deletes it (after=null), before restores.
r = featureOverrideImages('inherit', false, OFF)
assert.equal(r.noop, false)
assert.equal(r.after_json, null)
assert.equal(r.before_json?.is_enabled, false)

// 5 — inherit with no row → no-op.
r = featureOverrideImages('inherit', false, null)
assert.equal(r.noop, true)

// 6 — vertical-locked is always a no-op, whatever the target.
for (const t of ['on', 'off', 'inherit'] as const) {
  assert.equal(featureOverrideImages(t, true, null).noop, true, `locked ${t}`)
  assert.equal(featureOverrideImages(t, true, ON).noop, true, `locked ${t} w/ row`)
}

// 7 — reverse inversion: after applying `after_json`, reversing with `before_json`
//     lands back on the original storage state (null row → row → null row).
{
  const start: OverrideImage | null = null
  const fwd = featureOverrideImages('on', false, start)       // null → ON
  assert.deepEqual(fwd.after_json?.is_enabled, true)
  // now storage holds fwd.after_json; reverse restores fwd.before_json (=null = delete)
  assert.equal(fwd.before_json, null)
}

console.log('✓ naruto-bulk-entitlements selfcheck passed')
