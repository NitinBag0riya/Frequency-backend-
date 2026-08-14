/**
 * Lean self-check for the platform approval engine (no DB, no express).
 * Run with:  npx tsx src/routes/platform-approvals.selfcheck.ts
 * Covers the §1.2 invariants withApproval must hold.
 */
import assert from 'node:assert'
import {
  withApproval, registerPlatformAction, ACTION_CAPABILITY, BreakGlassDenied,
} from './platform-approvals'

// ── Minimal fake supabase: one flexible chainable/awaitable builder per table ──
function makeFake(rulesByAction: Record<string, any>) {
  const captured: any = { proposals: [], audits: [], notifs: [] }
  function from(table: string) {
    const b: any = {
      select: () => b, eq: () => b, order: () => b, limit: () => b, is: () => b, update: () => b,
      insert: (row: any) => {
        if (table === 'platform_action_proposals') captured.proposals.push(row)
        if (table === 'super_admin_audit') captured.audits.push(row)
        if (table === 'platform_notifications') captured.notifs.push(row)
        return b
      },
      maybeSingle: () => Promise.resolve({ data: table === 'platform_approval_rules' ? (rulesByAction[b._action] ?? null) : null }),
      single: () => Promise.resolve({ data: { id: 'p1' }, error: null }),
    }
    // capture which action a rule lookup asked for
    const origEq = b.eq
    b.eq = (col: string, val: any) => { if (col === 'action') b._action = val; return origEq() }
    return b
  }
  return { fake: { from } as any, captured }
}

const reqOwner: any = { user: { id: 'owner1' }, platformRole: 'platform_owner', ip: '1.1.1.1', get: () => 'ua' }
const reqAdmin: any = { user: { id: 'admin1' }, platformRole: 'platform_admin', ip: '1.1.1.1', get: () => 'ua' }

async function main() {
// ── 1. No rule → applies immediately + audits, does NOT propose ────────────────
{
  const { fake, captured } = makeFake({})
  let ran = false
  const out = await withApproval({
    supabase: fake, req: reqAdmin, action: 'tenant.suspend', tenantId: 't1',
    args: { reason: 'x' }, reason: 'x', before: { status: 'active' },
    apply: async () => { ran = true; return { status: 'suspended' } },
  })
  assert.equal(out.status, 'applied')
  assert.equal(ran, true, 'apply must run when no rule')
  assert.equal(captured.proposals.length, 0, 'no proposal when no rule')
  assert.equal(captured.audits.length, 1, 'immediate apply audits once')
}

// ── 2. Rule requires approval → pending, apply NEVER runs, proposal + notify ──
{
  const { fake, captured } = makeFake({ 'tenant.suspend': { requires_approval: true, label: 'Tenant suspend' } })
  let ran = false
  const out = await withApproval({
    supabase: fake, req: reqAdmin, action: 'tenant.suspend', tenantId: 't1',
    args: { reason: 'x' }, reason: 'x', before: { status: 'active' },
    apply: async () => { ran = true; return {} },
  })
  assert.equal(out.status, 'pending')
  assert.equal((out as any).proposalId, 'p1')
  assert.equal(ran, false, 'apply MUST NOT run on the pending path')
  assert.equal(captured.proposals.length, 1, 'proposal recorded')
  assert.equal(captured.proposals[0].before_json.status, 'active', 'before-image stored')
  assert.equal(captured.notifs.length, 1, 'platform team notified of waiting approval')
  assert.equal(captured.notifs[0].kind, 'approval.waiting')
}

// ── 3. Break-glass by a non-owner is denied (before apply runs) ────────────────
{
  const { fake } = makeFake({ 'tenant.delete': { requires_approval: true } })
  let ran = false
  await assert.rejects(
    () => withApproval({
      supabase: fake, req: reqAdmin, action: 'tenant.delete', tenantId: 't1',
      reason: 'x', breakGlass: true, apply: async () => { ran = true; return {} },
    }),
    (e: any) => e instanceof BreakGlassDenied,
  )
  assert.equal(ran, false, 'non-owner break-glass must not execute')
}

// ── 4. Break-glass by owner → applies + red audit flag + critical notify ──────
{
  const { fake, captured } = makeFake({ 'tenant.delete': { requires_approval: true } })
  const out = await withApproval({
    supabase: fake, req: reqOwner, action: 'tenant.delete', tenantId: 't1',
    reason: 'incident', breakGlass: true, apply: async () => ({ deleted: true }),
  })
  assert.equal(out.status, 'applied')
  assert.equal((out as any).breakGlass, true)
  assert.equal(captured.audits.length, 1)
  assert.equal(captured.audits[0].payload.break_glass, true, 'break_glass flagged in audit')
  assert.equal(captured.notifs[0].kind, 'action.break_glass')
  assert.equal(captured.notifs[0].severity, 'critical')
}

// ── 5. Every dangerous action maps to an acting capability + registers ─────────
for (const a of ['plan.downgrade', 'entitlement.bulk', 'payments.route_account', 'payments.payout', 'tenant.suspend', 'tenant.delete']) {
  assert.ok(ACTION_CAPABILITY[a], `missing capability map for ${a}`)
}
registerPlatformAction('demo.noop', async () => ({ ok: true }))

console.log('platform-approvals.selfcheck: all assertions passed ✓')
}

main().catch(e => { console.error(e); process.exit(1) })
