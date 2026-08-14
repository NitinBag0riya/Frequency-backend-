/**
 * Runnable self-check for nudge-engine — no framework. Run with:
 *   npx tsx src/lib/nudge-engine.selfcheck.ts
 *
 * Exercises the parts with real logic: template rendering, the step_stalled
 * trigger's checklist filter (step-not-done AND prereqs-done), and the
 * cooldown/notify-once dedupe — all against an in-memory Supabase stub so it
 * needs no DB. Asserts and exits non-zero on failure.
 */

import assert from 'node:assert'
import { TEMPLATES, TRIGGERS, cooldownOk, type NudgeRule, type Candidate } from './nudge-engine'

// ── Minimal in-memory Supabase stub (only the query shapes the engine uses) ──
type Row = Record<string, any>
function makeStub(tables: Record<string, Row[]>) {
  const inserts: Record<string, Row[]> = {}
  function from(table: string) {
    let rows = [...(tables[table] ?? [])]
    const api: any = {
      select() { return api },
      eq(col: string, val: any) { rows = rows.filter(r => r[col] === val); return api },
      in(col: string, vals: any[]) { rows = rows.filter(r => vals.includes(r[col])); return api },
      is(col: string, val: any) { rows = rows.filter(r => (r[col] ?? null) === val); return api },
      lt(col: string, val: any) { rows = rows.filter(r => r[col] < val); return api },
      gte(col: string, val: any) { rows = rows.filter(r => r[col] >= val); return api },
      limit() { return api },
      order() { return api },
      maybeSingle() { return Promise.resolve({ data: rows[0] ?? null }) },
      then(res: any) { return Promise.resolve({ data: rows, error: null }).then(res) },
      insert(row: Row) { (inserts[table] ??= []).push(row); return Promise.resolve({ data: null, error: null }) },
    }
    return api
  }
  return { from, auth: { admin: { getUserById: async () => ({ data: { user: { email: null } } }) } }, _inserts: inserts } as any
}

async function run() {
  // 1. Templates render with the tenant name + a dashboard link.
  const cand: Candidate = { tenantId: 't1', tenantName: 'Cafe Zero', ownerEmail: 'o@x.com', ownerUserId: 'u1', context: {} }
  const tpl = TEMPLATES['catalog_done_payments_pending']
  assert(tpl.subject(cand).includes('Cafe Zero'), 'subject should include tenant name')
  assert(/payments/i.test(tpl.text(cand)), 'body should mention payments')

  // 2. step_stalled trigger: only tenants with catalog done + payments NOT done,
  //    stalled past the cutoff, match.
  const old = new Date(Date.now() - 100 * 3600_000).toISOString()   // 100h ago > 72h
  const fresh = new Date().toISOString()
  const stub = makeStub({
    tenants: [
      { id: 't1', business_name: 'Match Co', slug: 'match', user_id: 'u1', billing_email: 'a@x.com', lifecycle_state: 'configuring', state_entered_at: old, deleted_at: null },
      { id: 't2', business_name: 'Too Fresh', slug: 'fresh', user_id: 'u2', billing_email: 'b@x.com', lifecycle_state: 'configuring', state_entered_at: fresh, deleted_at: null },
      { id: 't3', business_name: 'No Catalog', slug: 'nocat', user_id: 'u3', billing_email: 'c@x.com', lifecycle_state: 'configuring', state_entered_at: old, deleted_at: null },
      { id: 't4', business_name: 'Already Paid', slug: 'paid', user_id: 'u4', billing_email: 'd@x.com', lifecycle_state: 'configuring', state_entered_at: old, deleted_at: null },
    ],
    tenant_onboarding_checklists: [
      { tenant_id: 't1', steps: { catalog: { status: 'done' }, payments: { status: 'in_progress' } } },
      { tenant_id: 't3', steps: { catalog: { status: 'not_started' } } },
      { tenant_id: 't4', steps: { catalog: { status: 'done' }, payments: { status: 'done' } } },
    ],
  })
  const rule: NudgeRule = {
    id: 'catalog_done_payments_pending', label: '', trigger: 'step_stalled',
    condition: { step: 'payments', requires_done: ['catalog'], min_hours: 72 },
    channel: 'email', template_key: 'catalog_done_payments_pending', cooldown_hours: 72, enabled: true,
  }
  const cands = await TRIGGERS.step_stalled(stub, rule)
  const ids = cands.map(c => c.tenantId).sort()
  assert.deepEqual(ids, ['t1'], `step_stalled should match only t1, got ${JSON.stringify(ids)}`)

  // 3. Cooldown: a recent 'sent' log inside the window blocks; outside allows.
  const within = makeStub({ platform_nudge_log: [{ tenant_id: 't1', rule_id: 'r', status: 'sent', sent_at: new Date().toISOString() }] })
  assert.equal(await cooldownOk(within, 't1', 'r', 72), false, 'recent send should be on cooldown')
  const stale = makeStub({ platform_nudge_log: [{ tenant_id: 't1', rule_id: 'r', status: 'sent', sent_at: old }] })
  assert.equal(await cooldownOk(stale, 't1', 'r', 72), true, 'stale send should be past cooldown')
  const none = makeStub({ platform_nudge_log: [] })
  assert.equal(await cooldownOk(none, 't1', 'r', 72), true, 'no prior send should be allowed')

  console.log('nudge-engine.selfcheck: OK')
}

run().catch(e => { console.error('nudge-engine.selfcheck FAILED:', e); process.exit(1) })
