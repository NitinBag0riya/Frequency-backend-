/**
 * Nav config + per-feature config — tenant-facing control-plane endpoints.
 *
 *   GET   /api/nav-config          overrides + the caller's role allowed_apps
 *   PATCH /api/nav-config          upsert per-tenant nav overrides (owner/admin)
 *   PATCH /api/team/roles/:id/apps set a tenant role's allowed_apps (owner/admin)
 *   GET   /api/tenant-config       resolved per-feature options (3-layer merge)
 *   PATCH /api/tenant-config       upsert per-tenant option overrides (owner/admin)
 *
 * All tenant-scoped (after identifyTenant). Reads are open to any member; writes
 * gated to owner / workspace admin (settings.edit). The Sidebar consumes
 * /api/nav-config to render a data-driven, role-scoped nav.
 */

import express from 'express'
import type { SupabaseClient } from '@supabase/supabase-js'
import { resolveTenantConfig } from '../lib/config-resolver'

type Middleware = (req: express.Request, res: express.Response, next: express.NextFunction) => void | Promise<void>

interface Deps {
  supabase: SupabaseClient
  requireAuth: Middleware
  identifyTenant: Middleware
}

/** Resolve the caller's tenant role (key + allowed_apps). Owner/super → ['*']. */
async function callerRole(sb: SupabaseClient, req: express.Request): Promise<{ key: string; allowed_apps: string[] }> {
  if ((req as any).isSuperAdmin) return { key: 'super_admin', allowed_apps: ['*'] }
  if ((req as any).userRole === 'owner') return { key: 'owner', allowed_apps: ['*'] }
  const userId = (req as any).user?.id
  const tenantId = (req as any).tenantId
  const { data: assignment } = await sb.from('user_role_assignments')
    .select('role_id, disabled_at').eq('user_id', userId).eq('tenant_id', tenantId).maybeSingle()
  if (!assignment || assignment.disabled_at) return { key: 'none', allowed_apps: [] }
  const { data: role } = await sb.from('role_definitions')
    .select('key, allowed_apps').eq('id', assignment.role_id).maybeSingle()
  return { key: (role as any)?.key ?? 'none', allowed_apps: ((role as any)?.allowed_apps as string[]) ?? ['*'] }
}

/** Gate writes to owner / workspace admin. */
async function isTenantAdmin(sb: SupabaseClient, req: express.Request): Promise<boolean> {
  if ((req as any).isSuperAdmin || (req as any).userRole === 'owner') return true
  const { key } = await callerRole(sb, req)
  return key === 'owner' || key === 'admin' || key === 'workspace_admin'
}

export function createNavConfigRouter(deps: Deps): express.Router {
  const r = express.Router()
  const { supabase, requireAuth, identifyTenant } = deps

  // ─── GET /api/nav-config ────────────────────────────────────────────────
  r.get('/api/nav-config', requireAuth, identifyTenant, async (req, res) => {
    const tenantId = (req as any).tenantId
    if (!tenantId) { res.json({ overrides: [], allowed_apps: ['*'], role: null }); return }
    const [{ data: overrides }, role] = await Promise.all([
      supabase.from('nav_overrides').select('item_key, hidden, sort_order, label, pinned').eq('tenant_id', tenantId),
      callerRole(supabase, req),
    ])
    res.json({ overrides: overrides ?? [], allowed_apps: role.allowed_apps, role: role.key })
  })

  // ─── PATCH /api/nav-config ──────────────────────────────────────────────
  // Body: { overrides: [{ item_key, hidden?, sort_order?, label?, pinned? }] }
  r.patch('/api/nav-config', requireAuth, identifyTenant, async (req, res) => {
    const tenantId = (req as any).tenantId
    if (!tenantId) { res.status(400).json({ error: 'tenant required' }); return }
    if (!(await isTenantAdmin(supabase, req))) { res.status(403).json({ error: 'Owner or admin required' }); return }
    const overrides = Array.isArray(req.body?.overrides) ? req.body.overrides : []
    const rows = overrides
      .filter((o: any) => typeof o?.item_key === 'string' && o.item_key.length <= 64)
      .map((o: any) => ({
        tenant_id: tenantId,
        item_key: String(o.item_key),
        hidden: !!o.hidden,
        sort_order: o.sort_order == null ? null : Number(o.sort_order),
        label: o.label == null ? null : String(o.label).slice(0, 60),
        pinned: !!o.pinned,
        updated_at: new Date().toISOString(),
      }))
    if (!rows.length) { res.json({ ok: true, overrides: [] }); return }
    const { error } = await supabase.from('nav_overrides').upsert(rows, { onConflict: 'tenant_id,item_key' })
    if (error) { res.status(500).json({ error: error.message }); return }
    const { data } = await supabase.from('nav_overrides').select('item_key, hidden, sort_order, label, pinned').eq('tenant_id', tenantId)
    res.json({ ok: true, overrides: data ?? [] })
  })

  // ─── PATCH /api/team/roles/:id/apps ─────────────────────────────────────
  // Set a tenant-owned role's allowed_apps from the role→menu matrix editor.
  // Built-in roles are immutable; owners bypass the app-scope clamp, others are
  // clamped to their own allowed_apps (no privilege escalation).
  r.patch('/api/team/roles/:id/apps', requireAuth, identifyTenant, async (req, res) => {
    const tenantId = (req as any).tenantId
    if (!(await isTenantAdmin(supabase, req))) { res.status(403).json({ error: 'Owner or admin required' }); return }
    const roleId = String(req.params.id)
    let apps: string[] = Array.isArray(req.body?.allowed_apps) ? req.body.allowed_apps.map(String) : []

    const { data: role } = await supabase.from('role_definitions')
      .select('id, scope, is_built_in, tenant_id').eq('id', roleId).maybeSingle()
    if (!role) { res.status(404).json({ error: 'Role not found' }); return }
    if ((role as any).is_built_in) { res.status(400).json({ error: 'Built-in roles cannot be customized. Duplicate it as a custom role first.' }); return }
    if ((role as any).scope !== 'tenant' || (role as any).tenant_id !== tenantId) {
      res.status(403).json({ error: 'Role does not belong to this tenant' }); return
    }

    // Clamp to the caller's own app scope unless they are owner/super.
    if (!((req as any).isSuperAdmin || (req as any).userRole === 'owner')) {
      const mine = (await callerRole(supabase, req)).allowed_apps
      if (!mine.includes('*')) apps = apps.filter(a => a !== '*' && mine.includes(a))
    }
    const { data, error } = await supabase.from('role_definitions')
      .update({ allowed_apps: apps }).eq('id', roleId).select('id, key, allowed_apps').single()
    if (error) { res.status(500).json({ error: error.message }); return }
    res.json(data)
  })

  // ─── GET /api/tenant-config ─────────────────────────────────────────────
  r.get('/api/tenant-config', requireAuth, identifyTenant, async (req, res) => {
    const tenantId = (req as any).tenantId
    if (!tenantId) { res.json({ features: [] }); return }
    try {
      const features = await resolveTenantConfig(supabase, tenantId)
      res.json({ features })
    } catch (e: any) {
      res.status(500).json({ error: e?.message ?? 'config resolve failed' })
    }
  })

  // ─── PATCH /api/tenant-config ───────────────────────────────────────────
  // Body: { updates: [{ config_key, value }] }. value === null clears the override.
  r.patch('/api/tenant-config', requireAuth, identifyTenant, async (req, res) => {
    const tenantId = (req as any).tenantId
    if (!tenantId) { res.status(400).json({ error: 'tenant required' }); return }
    if (!(await isTenantAdmin(supabase, req))) { res.status(403).json({ error: 'Owner or admin required' }); return }
    const updates = Array.isArray(req.body?.updates) ? req.body.updates : []
    const userId = (req as any).user?.id ?? null
    const toUpsert: any[] = []
    const toClear: string[] = []
    for (const u of updates) {
      if (typeof u?.config_key !== 'string' || u.config_key.indexOf('.') <= 0) continue
      if (u.value === null || u.value === undefined) toClear.push(u.config_key)
      else toUpsert.push({ tenant_id: tenantId, config_key: u.config_key, value: u.value, updated_at: new Date().toISOString(), updated_by: userId })
    }
    if (toClear.length) await supabase.from('tenant_config').delete().eq('tenant_id', tenantId).in('config_key', toClear)
    if (toUpsert.length) {
      const { error } = await supabase.from('tenant_config').upsert(toUpsert, { onConflict: 'tenant_id,config_key' })
      if (error) { res.status(500).json({ error: error.message }); return }
    }
    const features = await resolveTenantConfig(supabase, tenantId)
    res.json({ ok: true, features })
  })

  return r
}
