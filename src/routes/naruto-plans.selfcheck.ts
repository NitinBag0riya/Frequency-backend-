/**
 * Self-check for the §3 plan-limits pure logic (no DB, no network).
 * Run with:  npx tsx src/routes/naruto-plans.selfcheck.ts
 * Locks the cap-resolution, cap-state, downgrade-violation and feature-removal
 * invariants the two-axis editor + downgrade guard depend on.
 */
import assert from 'node:assert'
import {
  resolveCap, capState, limitViolations, removedFeatures, UNLIMITED,
} from '../lib/plan-limits'

// ── resolveCap: override beats plan; null = inherit; absent hard = unlimited ──
{
  assert.deepEqual(resolveCap(10, 8, null, null), { hard: 10, soft: 8 }, 'plan caps pass through')
  assert.deepEqual(resolveCap(10, 8, 25, 20), { hard: 25, soft: 20 }, 'override beats plan')
  assert.deepEqual(resolveCap(10, 8, 25, null), { hard: 25, soft: 8 }, 'hard override, soft inherits')
  assert.deepEqual(resolveCap(undefined, undefined, null, null), { hard: UNLIMITED, soft: null }, 'absent = unlimited')
  assert.deepEqual(resolveCap(0, null, null, null), { hard: 0, soft: null }, '0 = blocked, preserved')
  assert.deepEqual(resolveCap(10, 8, -1, null), { hard: -1, soft: 8 }, 'override to unlimited')
}

// ── capState ──────────────────────────────────────────────────────────────────
{
  assert.equal(capState(3, { soft: 8, hard: 10 }), 'ok', 'below soft = ok')
  assert.equal(capState(8, { soft: 8, hard: 10 }), 'warn', 'at soft = warn')
  assert.equal(capState(10, { soft: 8, hard: 10 }), 'warn', 'at hard but not over = warn')
  assert.equal(capState(11, { soft: 8, hard: 10 }), 'over', 'above hard = over')
  assert.equal(capState(null, { soft: 8, hard: 10 }), 'unmetered', 'no usage = unmetered')
  assert.equal(capState(999, { soft: null, hard: -1 }), 'unlimited', 'unlimited stays unlimited')
  assert.equal(capState(5, { soft: 3, hard: -1 }), 'warn', 'soft warn even when hard unlimited')
}

// ── limitViolations: metered usage above a finite target hard cap blocks ─────
{
  const target = { outlets_max: 1, team_size_max: 5, messages_per_month: -1 }
  const usage  = { outlets_max: 3, team_size_max: 4, messages_per_month: 900_000, sms_per_month: null }
  const v = limitViolations(target, usage)
  assert.equal(v.length, 1, 'only outlets violates')
  assert.deepEqual(v[0], { key: 'outlets_max', usage: 3, targetHard: 1 })
  // unlimited target (-1) never violates; unmetered (null) never violates;
  // metric absent from target = unlimited = never violates.
  assert.equal(limitViolations({}, { outlets_max: 99 }).length, 0, 'absent target = unlimited')
}

// ── removedFeatures ─────────────────────────────────────────────────────────
{
  assert.deepEqual(removedFeatures(['pos', 'kds', 'workflows'], ['pos']), ['kds', 'workflows'], 'downgrade removals')
  assert.deepEqual(removedFeatures(['pos', 'kds'], ['*']), [], 'target grants all → nothing removed')
  assert.deepEqual(removedFeatures(['pos'], ['pos', 'kds']), [], 'upgrade removes nothing')
}

console.log('naruto-plans self-check: all assertions passed ✓')
