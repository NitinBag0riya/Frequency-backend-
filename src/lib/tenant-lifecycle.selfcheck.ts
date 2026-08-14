/**
 * Runnable self-check for the pure lifecycle state machine (§4).
 * Run:  npx tsx src/lib/tenant-lifecycle.selfcheck.ts
 * No framework — plain asserts. Exits non-zero on failure.
 *
 * Pins every transition in `computeLifecycleState` with a fixed injected clock,
 * so the nightly recompute and on-event hooks are proven to agree state-for-state.
 */
import assert from 'node:assert/strict'
import { computeLifecycleState, type LifecycleSignals } from './tenant-lifecycle'

const NOW = new Date('2026-08-14T00:00:00.000Z').getTime()
const daysAgo = (d: number) => new Date(NOW - d * 86_400_000).toISOString()

// A healthy, launched baseline we mutate per case.
const base: LifecycleSignals = {
  suspended: false,
  provisioned: true,
  setupCompleteness: 1,
  goLiveReady: true,
  firstOrderAt: daysAgo(90),
  lastActivityAt: daysAgo(1),
  recentOrders30d: 40,
  gmv30d: 50_000,
  gmvPrev30d: 45_000,
  paymentPastDue: false,
  now: NOW,
}
const S = (over: Partial<LifecycleSignals>): LifecycleSignals => ({ ...base, ...over })

// Suspension overrides everything.
assert.equal(computeLifecycleState(S({ suspended: true })), 'suspended')
assert.equal(computeLifecycleState(S({ suspended: true, provisioned: false })), 'suspended')

// Pre-provision.
assert.equal(computeLifecycleState(S({ provisioned: false, firstOrderAt: null })), 'lead')

// Pre-launch ladder.
assert.equal(
  computeLifecycleState(S({ firstOrderAt: null, setupCompleteness: 0, goLiveReady: false })),
  'provisioned',
)
assert.equal(
  computeLifecycleState(S({ firstOrderAt: null, setupCompleteness: 0.5, goLiveReady: false })),
  'configuring',
)
assert.equal(
  computeLifecycleState(S({ firstOrderAt: null, setupCompleteness: 1, goLiveReady: true })),
  'ready_to_launch',
)

// Just launched → live (within grace); established + active → healthy.
assert.equal(computeLifecycleState(S({ firstOrderAt: daysAgo(2) })), 'live')
assert.equal(computeLifecycleState(S({ firstOrderAt: daysAgo(30) })), 'healthy')

// At-risk triggers: past-due, GMV halved, or no orders in 30d.
assert.equal(computeLifecycleState(S({ paymentPastDue: true })), 'at_risk')
assert.equal(computeLifecycleState(S({ gmv30d: 10_000, gmvPrev30d: 45_000 })), 'at_risk')
assert.equal(computeLifecycleState(S({ recentOrders30d: 0 })), 'at_risk')

// Idle ladder — dormant then churned (measured from lastActivityAt).
assert.equal(computeLifecycleState(S({ lastActivityAt: daysAgo(40) })), 'dormant')
assert.equal(computeLifecycleState(S({ lastActivityAt: daysAgo(70) })), 'churned')

// Idle beats at-risk (churned even with no recent orders).
assert.equal(
  computeLifecycleState(S({ lastActivityAt: daysAgo(70), recentOrders30d: 0 })),
  'churned',
)

console.log('✓ tenant-lifecycle self-check passed')
