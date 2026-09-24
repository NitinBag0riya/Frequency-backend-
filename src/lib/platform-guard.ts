/**
 * Platform capability guard (spec Part I §1.1 — "Server-enforced on every
 * mutation; client gating is cosmetic").
 *
 * `requirePlatformCapability(supabase, capability)` resolves the caller's
 * platform role key (the platform-scoped user_role_assignments row, falling
 * back to the legacy user_roles super_admin row), normalizes it onto the six
 * canonical roles, and checks the capability via the pure `can()` helper. On
 * success it stamps `req.platformRole` (canonical key) for downstream audit.
 *
 * This is the capability-string counterpart to super-admin.ts's legacy
 * `requirePlatformPerm(feature, action)` matrix check. New platform endpoints
 * should use THIS; legacy endpoints keep the matrix guard until migrated (see
 * the WIRE(naruto) map in super-admin.ts).
 */
import type express from 'express'
import type { SupabaseClient } from '@supabase/supabase-js'
import { can, normalizeRole, type PlatformCapability } from './platform-rbac'

/**
 * The R2 chokepoint (spec docs/state/platform-tenant-bypass.md, Option C).
 *
 * identifyTenant's platform branch used to grant ANY platform role +
 * a raw X-Tenant-ID header full `isSuperAdmin` access to that tenant — no
 * membership, method, or capability check, and `platform_readonly` /
 * `platform_support` could write. `resolvePlatformTenantAccess` is the ONE
 * place identifyTenant asks "what may this platform-role caller do to a
 * tenant they aren't a member of", so the rule lives in one pure, testable
 * function instead of being re-decided ad hoc at each of the ~140
 * identifyTenant call sites.
 *
 * Rules (caller already knows `isMember` — a real member always takes the
 * normal per-tenant path, never this one):
 *   - GET/HEAD/OPTIONS: allowed iff the role has `tenant.read`.
 *   - Any other method: 403 `platform_write_requires_explicit_endpoint`,
 *     UNLESS the path+method is on the explicit allowlist below.
 */
export type PlatformTenantAccess =
  | { kind: 'member' }
  | { kind: 'platform'; audit?: { capability: PlatformCapability; action: string } }
  | { kind: 'deny'; status: 403; code: 'platform_write_requires_explicit_endpoint' | 'platform_tenant_read_denied' }

const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])

/**
 * Explicit-endpoint write allowlist. `capability: null` means the path
 * enforces its OWN (stronger) capability check further downstream — listing
 * it here only keeps it off the blanket write-403 so that downstream check
 * still runs; it must NOT be loosened to `onboarding.wizard.run` here.
 * Case in point: POST /api/storefront/admin/settlement/resolve is already
 * gated on `payments.route_account.write` inside storefront-domains.ts
 * (money-moving; deliberately a different, narrower role than onboarding).
 */
const WRITE_ALLOWLIST: Array<{
  method: string
  test: (path: string) => boolean
  capability: PlatformCapability | null
  action: string
}> = [
  { method: 'PATCH', test: p => p === '/api/storefront/admin/config', capability: 'onboarding.wizard.run', action: 'storefront.admin.config.write' },
  { method: 'POST', test: p => p === '/api/storefront/domains', capability: 'onboarding.wizard.run', action: 'storefront.domains.create' },
  { method: 'DELETE', test: p => /^\/api\/storefront\/domains\/[^/]+$/.test(p), capability: 'onboarding.wizard.run', action: 'storefront.domains.delete' },
  { method: 'POST', test: p => /^\/api\/storefront\/domains\/[^/]+\/recheck$/.test(p), capability: 'onboarding.wizard.run', action: 'storefront.domains.recheck' },
  { method: 'POST', test: p => p === '/api/storefront/admin/settlement/resolve', capability: null, action: 'storefront.admin.settlement.resolve' },
]

export function resolvePlatformTenantAccess(opts: {
  /** Raw role key (canonical or legacy) — normalized inside. */
  role: string | null
  method: string
  path: string
  isMember: boolean
}): PlatformTenantAccess {
  if (opts.isMember) return { kind: 'member' }

  const canonical = normalizeRole(opts.role)
  const method = opts.method.toUpperCase()

  if (READ_METHODS.has(method)) {
    if (canonical && can('tenant.read', canonical)) return { kind: 'platform' }
    return { kind: 'deny', status: 403, code: 'platform_tenant_read_denied' }
  }

  const entry = WRITE_ALLOWLIST.find(e => e.method === method && e.test(opts.path))
  if (entry) {
    if (entry.capability === null) return { kind: 'platform' } // downstream check decides
    if (canonical && can(entry.capability, canonical)) {
      return { kind: 'platform', audit: { capability: entry.capability, action: entry.action } }
    }
  }

  return { kind: 'deny', status: 403, code: 'platform_write_requires_explicit_endpoint' }
}

type Middleware = (req: express.Request, res: express.Response, next: express.NextFunction) => void | Promise<void>

/**
 * Resolve the caller's canonical platform role key, or null if they have none.
 * New RBAC first (user_role_assignments, tenant_id IS NULL), then legacy
 * user_roles super_admin — mirrors resolveRole() on the FE and platformCan()
 * on the server so there is one truth for "is this a platform user".
 */
export async function resolvePlatformRole(supabase: SupabaseClient, userId: string): Promise<string | null> {
  const { data: assignment } = await supabase.from('user_role_assignments')
    .select('disabled_at, role_definitions ( key, scope )')
    .eq('user_id', userId)
    .is('tenant_id', null)
    .maybeSingle()
  const a = assignment as any
  if (a && !a.disabled_at && a.role_definitions?.scope === 'platform' && a.role_definitions?.key) {
    return a.role_definitions.key as string
  }
  const { data: legacy } = await supabase.from('user_roles')
    .select('role').eq('user_id', userId).is('tenant_id', null).limit(1)
  if (legacy?.[0]?.role === 'super_admin') return 'super_admin'
  return null
}

export function requirePlatformCapability(supabase: SupabaseClient, capability: PlatformCapability): Middleware {
  return async (req, res, next) => {
    const user = (req as any).user
    if (!user) { res.status(401).json({ error: 'Auth required' }); return }
    const roleKey = await resolvePlatformRole(supabase, user.id)
    const canonical = normalizeRole(roleKey)
    if (!canonical || !can(capability, canonical)) {
      res.status(403).json({ error: `Platform role lacks capability: ${capability}` })
      return
    }
    ;(req as any).platformRole = canonical
    ;(req as any).isSuperAdmin = true
    next()
  }
}
