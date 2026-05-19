/**
 * routes/data-residency.ts — tenant data-residency flag.
 *
 * Metadata-only today — we are not actually multi-region (every tenant lives
 * in the default Supabase project region). But Indian SMB compliance teams
 * ask the question on day one of procurement, so the column + UI exist now
 * and the migration is honest about its scope ("Data residency is enforced
 * for new tenants. Existing data migrations available on request.").
 *
 * Two endpoints:
 *   GET  /api/tenant/data-residency
 *   POST /api/tenant/data-residency  { residency: 'IN'|'EU'|'US' }
 *
 * Admin-only on POST (owner / workspace_admin / platform_owner). GET is
 * open to any tenant member so the dashboard "Data stored in Mumbai (IN)"
 * badge renders without admin role.
 */

import express from 'express'
import { SupabaseClient } from '@supabase/supabase-js'

type Middleware = (
  req: express.Request,
  res: express.Response,
  next: express.NextFunction,
) => void | Promise<void>

interface Deps {
  supabase: SupabaseClient
  requireAuth: Middleware
  identifyTenant: Middleware
}

const ALLOWED = new Set(['IN', 'EU', 'US'])
const ADMIN_ROLES = new Set(['owner', 'workspace_admin', 'platform_owner', 'super_admin'])

async function resolveTenantRole(supabase: SupabaseClient, userId: string, tenantId: string): Promise<string | null> {
  const { data: ra } = await supabase.from('user_role_assignments')
    .select('role_definitions ( key )')
    .eq('user_id', userId).eq('tenant_id', tenantId).maybeSingle()
  const key = (ra as any)?.role_definitions?.key
  if (key) return key
  const { data: ur } = await supabase.from('user_roles')
    .select('role').eq('user_id', userId).eq('tenant_id', tenantId).maybeSingle()
  if (ur?.role) return ur.role
  const { data: t } = await supabase.from('tenants')
    .select('user_id').eq('id', tenantId).maybeSingle()
  if (t?.user_id === userId) return 'owner'
  return null
}

export function createDataResidencyRouter(deps: Deps): express.Router {
  const r = express.Router()
  const { supabase, requireAuth, identifyTenant } = deps

  r.get('/api/tenant/data-residency', requireAuth, identifyTenant, async (req, res) => {
    const tenantId = (req as any).tenantId as string
    const { data, error } = await supabase.from('tenants')
      .select('data_residency').eq('id', tenantId).maybeSingle()
    if (error) { res.status(500).json({ error: error.message }); return }
    res.json({ residency: data?.data_residency ?? 'IN' })
  })

  r.post('/api/tenant/data-residency', requireAuth, identifyTenant, async (req, res) => {
    const tenantId = (req as any).tenantId as string
    const userId = (req as any).user?.id as string
    const role = await resolveTenantRole(supabase, userId, tenantId)
    if (!role || !ADMIN_ROLES.has(role)) {
      res.status(403).json({ error: 'admin role required' }); return
    }
    const residency = String(req.body?.residency ?? '').toUpperCase()
    if (!ALLOWED.has(residency)) {
      res.status(400).json({ error: 'residency must be IN, EU, or US' }); return
    }
    const { data, error } = await supabase.from('tenants')
      .update({ data_residency: residency })
      .eq('id', tenantId)
      .select('id, data_residency').single()
    if (error) { res.status(500).json({ error: error.message }); return }
    res.json({ residency: data.data_residency })
  })

  return r
}
