/**
 * Self-check: resolvePlatformTenantAccess (R2, platform-tenant-bypass §Option C).
 * Also greps index.ts to prove identifyTenant's platform branch actually calls
 * the helper — a selfcheck that only exercises the pure function in isolation
 * could stay green while the real request path still bypasses it.
 *   Run: npx tsx src/lib/platform-guard.selfcheck.ts
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { resolvePlatformTenantAccess } from './platform-guard.js'

let pass = 0
const fail: string[] = []
const ok = (c: boolean, m: string) => (c ? pass++ : fail.push(m))

// platform_readonly: GET allowed (has tenant.read), POST to an unrelated
// tenant-scoped write denied.
ok(
  resolvePlatformTenantAccess({ role: 'platform_readonly', method: 'GET', path: '/api/contacts', isMember: false }).kind === 'platform',
  'platform_readonly GET /api/contacts on a foreign tenant is allowed (tenant.read)',
)
ok(
  resolvePlatformTenantAccess({ role: 'platform_readonly', method: 'POST', path: '/api/contacts', isMember: false }).kind === 'deny',
  'platform_readonly POST /api/contacts on a foreign tenant is denied',
)

// platform_support: same read/write split.
ok(
  resolvePlatformTenantAccess({ role: 'platform_support', method: 'GET', path: '/api/contacts', isMember: false }).kind === 'platform',
  'platform_support GET /api/contacts on a foreign tenant is allowed (tenant.read)',
)
ok(
  resolvePlatformTenantAccess({ role: 'platform_support', method: 'POST', path: '/api/contacts', isMember: false }).kind === 'deny',
  'platform_support POST /api/contacts on a foreign tenant is denied',
)

// Onboarding-allowlisted write: platform_onboarding has onboarding.wizard.run
// -> PATCH storefront admin config allowed; platform_support lacks it -> denied.
const onboardingConfigWrite = resolvePlatformTenantAccess({
  role: 'platform_onboarding', method: 'PATCH', path: '/api/storefront/admin/config', isMember: false,
})
ok(onboardingConfigWrite.kind === 'platform', 'platform_onboarding PATCH /api/storefront/admin/config is allowed (onboarding.wizard.run)')
ok(
  onboardingConfigWrite.kind === 'platform' && !!onboardingConfigWrite.audit && onboardingConfigWrite.audit.capability === 'onboarding.wizard.run',
  'allowlisted write carries an audit capability for recordPlatformAudit',
)
ok(
  resolvePlatformTenantAccess({ role: 'platform_support', method: 'PATCH', path: '/api/storefront/admin/config', isMember: false }).kind === 'deny',
  'platform_support PATCH /api/storefront/admin/config on a foreign tenant is denied (no onboarding.wizard.run)',
)

// Domains allowlist (POST create, DELETE :id, POST :id/recheck).
ok(resolvePlatformTenantAccess({ role: 'platform_onboarding', method: 'POST', path: '/api/storefront/domains', isMember: false }).kind === 'platform', 'onboarding role can POST /api/storefront/domains')
ok(resolvePlatformTenantAccess({ role: 'platform_onboarding', method: 'DELETE', path: '/api/storefront/domains/abc123', isMember: false }).kind === 'platform', 'onboarding role can DELETE /api/storefront/domains/:id')
ok(resolvePlatformTenantAccess({ role: 'platform_onboarding', method: 'POST', path: '/api/storefront/domains/abc123/recheck', isMember: false }).kind === 'platform', 'onboarding role can POST /api/storefront/domains/:id/recheck')

// Settlement/resolve: allowlisted (off the blanket 403) but its capability
// check is deferred downstream — NOT gated on onboarding.wizard.run here, so
// even a role without it reaches the chokepoint (the real gate is
// payments.route_account.write inside storefront-domains.ts).
const settlement = resolvePlatformTenantAccess({ role: 'platform_finance', method: 'POST', path: '/api/storefront/admin/settlement/resolve', isMember: false })
ok(settlement.kind === 'platform' && !settlement.audit, 'settlement/resolve reaches its own downstream capability check, unaudited here')

// A real member always falls through, regardless of role/method — Option C's
// "member of the tenant -> normal path, never isSuperAdmin".
ok(
  resolvePlatformTenantAccess({ role: 'platform_readonly', method: 'DELETE', path: '/api/workflows/1', isMember: true }).kind === 'member',
  'a real member of the tenant falls through to the normal membership path',
)

// A disabled platform assignment must not resolve to a role key at all —
// this is enforced by resolvePlatformRole (disabled_at check), not by
// resolvePlatformTenantAccess, so exercise the same disabled_at gate here.
ok(
  resolvePlatformTenantAccess({ role: null, method: 'GET', path: '/api/contacts', isMember: false }).kind === 'deny',
  'no role (e.g. a disabled platform assignment resolved to null) denies even a read',
)

// Source check: identifyTenant's platform branch must actually call the
// helper — otherwise this file could pass green while index.ts still runs
// the old ad-hoc bypass.
const indexSrc = readFileSync(join(__dirname, '..', 'index.ts'), 'utf8')
const identifyTenantMatch = indexSrc.match(/async function identifyTenant\([\s\S]*?\n}\n/)
ok(!!identifyTenantMatch, 'index.ts still defines identifyTenant (grep anchor did not drift)')
const identifyTenantSrc = identifyTenantMatch?.[0] ?? ''
ok(/resolvePlatformTenantAccess\(/.test(identifyTenantSrc), 'identifyTenant calls resolvePlatformTenantAccess(')
ok(/resolvePlatformRole\(supabase, user\.id\)/.test(identifyTenantSrc), 'identifyTenant resolves the platform role via resolvePlatformRole (disabled_at-aware), not an ad-hoc query')
ok(!/user_role_assignments'\)\s*\n\s*\.select\('role_definitions \( key, scope \)'\)/.test(identifyTenantSrc), 'the old ad-hoc platform-assignment query is gone from identifyTenant')
ok(/from '\.\/lib\/platform-guard'/.test(indexSrc), 'index.ts imports from ./lib/platform-guard')

console.log(`\n  ${pass} checks passed, ${fail.length} failed`)
if (fail.length) { for (const f of fail) console.error('  ✗ ' + f); process.exit(1) }
console.log('  ✓ platform-guard: resolvePlatformTenantAccess OK')
