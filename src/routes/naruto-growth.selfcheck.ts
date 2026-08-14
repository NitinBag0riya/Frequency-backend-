/**
 * Self-check for naruto-growth pure math (funnel / cohort survival / churn-NRR).
 * No DB, no framework — plain asserts. Run: `npx tsx src/routes/naruto-growth.selfcheck.ts`
 * (or import runNarutoGrowthSelfCheck() from a boot check). Keeps the growth
 * numbers honest: the definitions live here, not scattered in the route.
 */
import assert from 'node:assert'
import { funnelOf, cohortsOf, churnNrr, type TenantRow } from './naruto-growth.js'

const DAY = 86_400_000
const NOW = Date.parse('2026-08-14T00:00:00Z')
const ago = (days: number) => new Date(NOW - days * DAY).toISOString()

function row(p: Partial<TenantRow> & { id: string; state: string }): TenantRow {
  return {
    id: p.id, slug: p.slug ?? p.id, name: p.name ?? p.id, vertical: p.vertical ?? 'horeca',
    status: p.status ?? 'active', state: p.state, stateEnteredAt: p.stateEnteredAt ?? null,
    createdAt: p.createdAt ?? ago(100), lastActiveAt: p.lastActiveAt ?? null,
    planId: p.planId ?? 'growth', subStatus: p.subStatus ?? 'active',
  }
}

export function runNarutoGrowthSelfCheck(): void {
  // ── funnelOf: monotone signup ⊇ activated ⊇ live ⊇ retained; suspended masks ──
  const fRows: TenantRow[] = [
    row({ id: 'a', state: 'lead' }),            // signup only
    row({ id: 'b', state: 'configuring' }),     // activated
    row({ id: 'c', state: 'ready_to_launch' }), // activated
    row({ id: 'd', state: 'live' }),            // activated + live + retained
    row({ id: 'e', state: 'healthy' }),         // activated + live + retained
    row({ id: 'f', state: 'at_risk' }),         // activated + live + retained
    row({ id: 'g', state: 'dormant' }),         // activated + live (not retained)
    row({ id: 'h', state: 'churned' }),         // activated + live (not retained)
    row({ id: 'i', state: 'suspended' }),       // signup only (masked)
  ]
  const f = funnelOf(fRows)
  assert.strictEqual(f.signup, 9, 'signup counts everyone')
  assert.strictEqual(f.activated, 7, 'activated = not lead/provisioned/suspended')
  assert.strictEqual(f.live, 5, 'live = launched states')
  assert.strictEqual(f.retained, 3, 'retained = live/healthy/at_risk')
  assert.ok(f.signup >= f.activated && f.activated >= f.live && f.live >= f.retained, 'funnel is monotone')

  // ── cohortsOf: survivorship by signup month, eligibility gated by age ──
  const cRows: TenantRow[] = [
    row({ id: 'c1', createdAt: ago(95), state: 'healthy' }),  // survived, eligible @30/60/90
    row({ id: 'c2', createdAt: ago(95), state: 'churned' }),  // lost, eligible @30/60/90
    row({ id: 'c3', createdAt: ago(10), state: 'healthy' }),  // too young for 30d window
  ]
  const cohorts = cohortsOf(cRows, NOW)
  const oldCohort = cohorts.find(c => c.elig90 === 2)!
  assert.ok(oldCohort, 'old cohort has 2 members eligible at 90d')
  assert.strictEqual(oldCohort.r90, 0.5, '1 of 2 survived at 90d')
  const youngCohort = cohorts.find(c => c.size === 1 && c.elig30 === 0)!
  assert.ok(youngCohort, 'young cohort not yet eligible at 30d')
  assert.strictEqual(youngCohort.r30, 0, 'no eligible members → 0 rate (not NaN)')

  // ── churnNrr: logo + revenue churn; NRR==GRR until a plan-change log exists ──
  const mrrOf = (t: TenantRow) => (t.planId === 'growth' ? 1000 : 500)
  const chRows: TenantRow[] = [
    row({ id: 'k1', state: 'healthy', planId: 'growth' }),                          // active, 1000
    row({ id: 'k2', state: 'live', planId: 'starter' }),                            // active, 500
    row({ id: 'k3', state: 'churned', planId: 'growth', stateEnteredAt: ago(5) }),  // churned in-window, 1000
    row({ id: 'k4', state: 'churned', planId: 'growth', stateEnteredAt: ago(90) }), // churned BEFORE window → excluded
  ]
  const ch = churnNrr(chRows, mrrOf, NOW, 30)
  assert.strictEqual(ch.churnedLogos, 1, 'only in-window churn counts')
  assert.strictEqual(ch.baseLogos, 3, 'base = churned-in-window + active launched')
  assert.strictEqual(ch.mrrStart, 2500, 'start MRR = 1000+500 active + 1000 churned')
  assert.strictEqual(ch.mrrChurned, 1000, 'churned MRR')
  assert.strictEqual(ch.revenueChurnPct, 40, '1000/2500 = 40%')
  assert.strictEqual(ch.nrrPct, 60, 'GRR: (2500-1000)/2500 = 60%')
  assert.strictEqual(ch.nrrIsGrr, true, 'flagged as GRR until expansion/contraction sourced')
  assert.ok(Math.abs(ch.logoChurnPct - 33.33) < 0.01, '1/3 logos ≈ 33.33%')

  // Empty input must not throw / divide-by-zero.
  const z = churnNrr([], mrrOf, NOW, 30)
  assert.strictEqual(z.nrrPct, 0)
  assert.strictEqual(funnelOf([]).signup, 0)
  assert.deepStrictEqual(cohortsOf([], NOW), [])

  console.log('✓ naruto-growth self-check passed')
}

// Standalone script (never imported by the app) — run on execution, like the
// sibling *.selfcheck.ts files. `npx tsx src/routes/naruto-growth.selfcheck.ts`.
runNarutoGrowthSelfCheck()
