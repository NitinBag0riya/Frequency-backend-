/**
 * Lean self-check for the activation score (spec §6). No DB.
 * Run with:  npx tsx src/lib/activation-score.selfcheck.ts
 */
import assert from 'node:assert'
import {
  computeActivationScore, stepsDone, ONBOARDING_STEP_KEYS, type Checklist,
} from './activation-score'

const allDone: Checklist = Object.fromEntries(
  ONBOARDING_STEP_KEYS.map(k => [k, { status: 'done' as const }]),
)

// Empty checklist + no orders → floor.
assert.deepEqual(computeActivationScore({}).breakdown, { setup: 0, first: 0, repeat: 0 })
assert.equal(computeActivationScore({}).score, 0)

// Fully set up, no orders yet → 50 (setup only). Proves it does NOT collapse to
// 0 like a literal product would — the whole reason we weight instead.
assert.equal(computeActivationScore(allDone).score, 50)
assert.equal(stepsDone(allDone), 8)

// Set up + first order + saturated week-1 volume → 100.
assert.equal(computeActivationScore(allDone, { firstOrderAt: '2026-08-14', ordersWeek1: 5 }).score, 100)

// First order alone (no repeat) → 50 setup + 25 first = 75.
assert.equal(computeActivationScore(allDone, { firstOrderAt: '2026-08-14', ordersWeek1: 0 }).score, 75)

// Half the steps, first order, 2 of 5 week-1 orders → 25 + 25 + 10 = 60.
const half: Checklist = Object.fromEntries(
  ONBOARDING_STEP_KEYS.slice(0, 4).map(k => [k, { status: 'done' as const }]),
)
assert.equal(computeActivationScore(half, { firstOrderAt: '2026-08-14', ordersWeek1: 2 }).score, 60)

// Repeat component saturates (never exceeds its 25-pt cap).
assert.equal(computeActivationScore(allDone, { firstOrderAt: '2026-08-14', ordersWeek1: 999 }).breakdown.repeat, 25)

// blocked / in_progress are NOT done.
assert.equal(stepsDone({ create: { status: 'blocked' }, outlets: { status: 'in_progress' } }), 0)

console.log('activation-score.selfcheck: OK')
