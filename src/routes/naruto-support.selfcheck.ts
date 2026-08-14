/**
 * Runnable self-check for the Support console diagnostics + fix registry.
 * Run:  npx tsx src/routes/naruto-support.selfcheck.ts
 * No framework — plain asserts. Exits non-zero on failure.
 *
 * Proves the deterministic core against a stub Supabase (no live DB):
 *   • runDiagnostics emits every expected check key,
 *   • verdict tri-state (green / red / unknown) is correct per scenario,
 *   • payment_gateway + plan_limits are honestly `unknown` (never fabricated green),
 *   • every `fix` a check references exists in FIX_REGISTRY,
 *   • FIX_REGISTRY is coherent (unwired specs name the required endpoint).
 *
 * NOT proven here (needs a live Supabase): the resend-invite send + the audit
 * inserts — thin wrappers over buildInviteEmail/sendEmail/recordPlatformAudit.
 */
import assert from 'node:assert/strict'
import { runDiagnostics, FIX_REGISTRY, type DiagnosticCheck } from './naruto-support'

// ── Stub Supabase: a thenable chain returning canned rows per table ──────────
function stub(rows: Record<string, any>) {
  const make = (table: string) => {
    const result = { data: rows[table] ?? null, error: null }
    const chain: any = {
      select: () => chain, eq: () => chain, is: () => chain, gte: () => chain,
      order: () => chain, limit: () => chain,
      maybeSingle: async () => (Array.isArray(result.data) ? { data: result.data[0] ?? null, error: null } : result),
      then: (res: any) => res(result),           // makes the builder awaitable
    }
    return chain
  }
  return { from: (t: string) => make(t), auth: { admin: {} } } as any
}

function byKey(checks: DiagnosticCheck[], key: string): DiagnosticCheck {
  const c = checks.find(x => x.key === key)
  assert.ok(c, `missing check: ${key}`)
  return c!
}

const DAY = 86_400_000
const now = Date.now()
const iso = (dAgo: number) => new Date(now - dAgo * DAY).toISOString()

async function main() {
// ── Scenario A: healthy tenant ───────────────────────────────────────────────
{
  const checks = await runDiagnostics(stub({
    tenants: { id: 't1', slug: 'cafe-aroma', status: 'active', last_active_at: iso(1) },
    tenant_domains: [],                                   // slug-only storefront
    wa_templates: [{ status: 'approved' }, { status: 'approved' }],
    webhook_dead_letter: [],                              // none failing
    aggregator_orders: [{ created_at: iso(0.5), placed_at: iso(0.5) }],
  }), 't1')

  assert.equal(byKey(checks, 'storefront').ok, true)
  assert.equal(byKey(checks, 'whatsapp_templates').ok, true)
  assert.equal(byKey(checks, 'webhooks').ok, true)
  assert.equal(byKey(checks, 'aggregator_sync').ok, true)
  assert.equal(byKey(checks, 'owner_last_login').ok, true)
  // Sources not in this DB stay honestly unknown — never green.
  assert.equal(byKey(checks, 'payment_gateway').ok, null)
  assert.equal(byKey(checks, 'plan_limits').ok, null)
}

// ── Scenario B: unhealthy tenant ─────────────────────────────────────────────
{
  const checks = await runDiagnostics(stub({
    tenants: { id: 't2', slug: 'shop2', status: 'active', last_active_at: iso(90) },
    tenant_domains: [{ hostname: 'shop2.in', kind: 'custom', verified: false, ssl_status: 'pending' }],
    wa_templates: [{ status: 'rejected' }, { status: 'pending' }],
    webhook_dead_letter: [{ id: 'd1', source: 'razorpay', direction: 'inbound' }],
    aggregator_orders: [{ created_at: iso(10), placed_at: iso(10) }],
  }), 't2')

  assert.equal(byKey(checks, 'storefront').ok, false)         // custom domain unverified
  assert.equal(byKey(checks, 'whatsapp_templates').ok, false) // a template rejected
  assert.equal(byKey(checks, 'webhooks').ok, false)           // recent dead-letter
  assert.equal(byKey(checks, 'webhooks').fix, 'replay-webhook')
  assert.equal(byKey(checks, 'aggregator_sync').ok, false)    // 10d stale
  assert.equal(byKey(checks, 'owner_last_login').ok, false)   // 90d idle
}

// ── Scenario C: brand-new tenant (unknowns, not reds) ────────────────────────
{
  const checks = await runDiagnostics(stub({
    tenants: { id: 't3', slug: 'new3', status: 'active', last_active_at: null },
    tenant_domains: [],
    wa_templates: [],                 // no WA templates → unknown, not red
    webhook_dead_letter: [],
    aggregator_orders: null,          // never sold → unknown, not red
  }), 't3')

  assert.equal(byKey(checks, 'whatsapp_templates').ok, null)
  assert.equal(byKey(checks, 'aggregator_sync').ok, null)
  assert.equal(byKey(checks, 'owner_last_login').ok, null)
  assert.equal(byKey(checks, 'owner_last_login').fix, 'resend-invite')
}

// ── Fix-registry integrity: every referenced fix exists + specs are coherent ──
{
  const all = await runDiagnostics(stub({
    tenants: { id: 't', slug: 's', status: 'active', last_active_at: iso(90) },
    tenant_domains: [], wa_templates: [], webhook_dead_letter: [{ id: 'x', source: 'a', direction: 'inbound' }],
    aggregator_orders: null,
  }), 't')
  for (const c of all) {
    if (c.fix) assert.ok(FIX_REGISTRY[c.fix], `check ${c.key} references unknown fix ${c.fix}`)
  }
  for (const [action, spec] of Object.entries(FIX_REGISTRY)) {
    assert.ok(spec.cap && spec.label, `fix ${action} missing cap/label`)
    if (!spec.wired) assert.ok(spec.endpoint, `unwired fix ${action} must name the required endpoint`)
  }
  assert.equal(FIX_REGISTRY['resend-invite'].wired, true)
}

console.log('naruto-support.selfcheck: OK')
}

main().catch(e => { console.error(e); process.exit(1) })
