import express from 'express'
import { SupabaseClient } from '@supabase/supabase-js'

export function createAdminRouter(supabase: SupabaseClient, requireAuth: any) {
  const router = express.Router()

  // Middleware to ensure user is a Super Admin
  const requireSuperAdmin = async (req: express.Request, res: express.Response, next: express.NextFunction) => {
    const user = (req as any).user
    if (!user) return res.status(401).json({ error: 'Auth required' })
    
    const { data: isSuper } = await supabase
      .from('super_admins')
      .select('id')
      .eq('user_id', user.id)
      .maybeSingle()
      
    if (!isSuper) return res.status(403).json({ error: 'Super Admin access required' })
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

  // Toggle tenant features (Entitlements)
  router.post('/tenants/:id/features', requireAuth, requireSuperAdmin, async (req, res) => {
    const { features } = req.body // array of { feature: string, is_enabled: boolean }
    const tenantId = req.params.id
    
    const updates = features.map((f: any) => ({
      tenant_id: tenantId,
      feature: f.feature,
      is_enabled: f.is_enabled,
      updated_at: new Date().toISOString()
    }))

    const { error } = await supabase.from('tenant_entitlements').upsert(updates, { onConflict: 'tenant_id,feature' })
    if (error) return res.status(500).json({ error: error.message })
    res.json({ success: true })
  })

  return router
}
