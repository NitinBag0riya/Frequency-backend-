import express from 'express'
import { SupabaseClient } from '@supabase/supabase-js'

/**
 * Mounts the legacy /api/admin/* router (tenants list, stats, feature
 * toggles). Newer Platform Console endpoints live under /api/super-admin
 * (see routes/super-admin.ts) with proper requirePlatformPerm gating.
 *
 * The platform-user check is injected from index.ts so we have a single
 * source of truth (`isPlatformUser`) — both the new RBAC role
 * assignments and the legacy `user_roles.super_admin` row are honoured
 * there. The deprecated `super_admins` table is no longer consulted.
 */
export function createAdminRouter(
  supabase: SupabaseClient,
  requireAuth: any,
  isPlatformUser: (userId: string) => Promise<boolean>,
) {
  const router = express.Router()

  // Gate every /api/admin/* route on platform membership.
  const requireSuperAdmin = async (req: express.Request, res: express.Response, next: express.NextFunction) => {
    const user = (req as any).user
    if (!user) return res.status(401).json({ error: 'Auth required' })
    if (!(await isPlatformUser(user.id))) {
      return res.status(403).json({ error: 'Platform Console access required.' })
    }
    next()
  }

  // List all tenants
  router.get('/tenants', requireAuth, requireSuperAdmin, async (req, res) => {
    const { data, error } = await supabase
      .from('tenants')
      .select('*, tenant_entitlements(feature, is_enabled)')
      .order('created_at', { ascending: false })
      
    if (error) return res.status(500).json({ error: error.message })
    res.json(data || [])
  })

  // Get platform-wide stats
  router.get('/stats', requireAuth, requireSuperAdmin, async (req, res) => {
    try {
      const [tenants, contacts, messages] = await Promise.all([
        supabase.from('tenants').select('*', { count: 'exact', head: true }),
        supabase.from('contacts').select('*', { count: 'exact', head: true }),
        supabase.from('messages').select('*', { count: 'exact', head: true }),
      ])
      res.json({
        tenants: tenants.count || 0,
        contacts: contacts.count || 0,
        messages: messages.count || 0
      })
    } catch (err: any) {
      res.status(500).json({ error: err.message })
    }
  })

  // Toggle tenant features (Entitlements). Super-admin gated, but still
  // validates input to avoid TypeError on missing/wrong-shape body and to
  // reject obviously-bogus feature keys before they hit the DB.
  router.post('/tenants/:id/features', requireAuth, requireSuperAdmin, async (req, res) => {
    const { features } = req.body
    if (!Array.isArray(features) || features.length === 0) {
      return res.status(400).json({ error: 'features must be a non-empty array of { feature, is_enabled }' })
    }
    if (features.length > 200) {
      return res.status(413).json({ error: 'too many features in one request (max 200)' })
    }
    // Same charset as plan-catalogue feature keys: lowercase + digits + underscore.
    const FEATURE_KEY = /^[a-z0-9_]{1,64}$/
    const tenantId = String(req.params.id ?? '')

    const updates: Array<{ tenant_id: string; feature: string; is_enabled: boolean; updated_at: string }> = []
    for (const f of features) {
      if (!f || typeof f !== 'object') {
        return res.status(400).json({ error: 'each feature entry must be { feature, is_enabled }' })
      }
      if (typeof f.feature !== 'string' || !FEATURE_KEY.test(f.feature)) {
        return res.status(400).json({ error: `invalid feature key: ${String(f.feature)}` })
      }
      if (typeof f.is_enabled !== 'boolean') {
        return res.status(400).json({ error: `is_enabled must be boolean for feature ${f.feature}` })
      }
      updates.push({
        tenant_id: tenantId,
        feature: f.feature,
        is_enabled: f.is_enabled,
        updated_at: new Date().toISOString(),
      })
    }

    const { error } = await supabase.from('tenant_entitlements').upsert(updates, { onConflict: 'tenant_id,feature' })
    if (error) return res.status(500).json({ error: error.message })
    res.json({ success: true, updated: updates.length })
  })

  return router
}
