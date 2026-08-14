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
