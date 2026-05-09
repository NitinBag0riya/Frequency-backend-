/**
 * Team management — endpoints for tenant Workspace Admin / Owner to manage
 * their team using the new RBAC model (role_definitions + user_role_assignments).
 *
 * Key flows:
 *   - Invite by email (Supabase auth.admin.invite sends a magic link)
 *   - Add an existing platform user to this tenant (search by email)
 *   - Change roles, disable users, remove users
 *   - Departments CRUD
 *   - Custom role builder (Growth+ plans only)
 *   - Per-tenant role label overrides
 *   - Accept invite (consumes pending_invites token)
 *
 * The `requireTenantPerm(feature, action)` helper does role-based permission
 * checks the same way `requirePlatformPerm` does for super-admin routes.
 */

import express from 'express'
import crypto from 'crypto'
import { SupabaseClient } from '@supabase/supabase-js'
import { emitNotification } from './notifications'

type Middleware = (req: express.Request, res: express.Response, next: express.NextFunction) => void | Promise<void>

interface Deps {
  supabase: SupabaseClient
  requireAuth: Middleware
  identifyTenant: Middleware
}

/**
 * Walks user's role permission matrix in the current tenant and gates the action.
 * Use after `identifyTenant` so `req.tenantId` is set.
 */
function requireTenantPerm(supabase: SupabaseClient, feature: string, action: 'view' | 'edit' | 'delete'): Middleware {
  return async (req, res, next) => {
    const userId = (req as any).user?.id
    const tenantId = (req as any).tenantId
    if (!userId || !tenantId) { res.status(401).json({ error: 'Auth + tenant required' }); return }

    // Tenant Owner is always permitted (legacy super_admin user_roles entry would
    // also bypass this via identifyTenant marking isSuperAdmin)
    if ((req as any).isSuperAdmin) { next(); return }

    const { data: assignment } = await supabase.from('user_role_assignments')
      .select('role_id, disabled_at')
      .eq('user_id', userId).eq('tenant_id', tenantId)
      .maybeSingle()
    if (!assignment || assignment.disabled_at) {
      res.status(403).json({ error: 'You do not have access to this tenant' }); return
    }
    const { data: role } = await supabase.from('role_definitions')
      .select('key, permissions').eq('id', assignment.role_id).maybeSingle()
    if (!role) { res.status(403).json({ error: 'Role not found' }); return }
    const fp = (role.permissions as any)?.[feature]
    if (!fp || !fp[action]) {
      res.status(403).json({ error: `Your role (${role.key}) lacks ${action} on ${feature}` }); return
    }
    next()
  }
}

/** Look up the active subscription's plan to enforce gating (e.g. custom roles only on Growth+). */
async function getTenantPlan(supabase: SupabaseClient, tenantId: string): Promise<{ plan_id: string; limits: any } | null> {
  const { data: sub } = await supabase.from('tenant_subscriptions')
    .select('plan_id, plans(limits)').eq('tenant_id', tenantId).maybeSingle()
  if (!sub) return null
  return { plan_id: sub.plan_id, limits: (sub as any).plans?.limits ?? {} }
}

export function createTeamsRouter(deps: Deps): express.Router {
  const r = express.Router()
  const { supabase, requireAuth, identifyTenant } = deps

  // ─── Roster ───────────────────────────────────────────────────────────────
  r.get('/api/team/members',
    requireAuth, identifyTenant, requireTenantPerm(supabase, 'team', 'view'),
    async (req, res) => {
      const tenantId = (req as any).tenantId
      const { data, error } = await supabase.from('user_role_assignments')
        .select(`
          id, user_id, role_id, department_id, disabled_at, accepted_at, invited_at, created_at,
          role_definitions!inner ( key, label, scope )
        `)
        .eq('tenant_id', tenantId)
        .order('created_at')
      if (error) { res.status(500).json({ error: error.message }); return }

      // Hydrate user emails from auth.users via service role
      const ids = (data ?? []).map(r => r.user_id)
      const userMap: Record<string, { email: string; name?: string }> = {}
      if (ids.length > 0) {
        const { data: { users = [] } = {} as any } = await (supabase as any).auth.admin.listUsers({ perPage: 200 })
        for (const u of users as any[]) if (ids.includes(u.id)) {
          userMap[u.id] = { email: u.email ?? '', name: u.user_metadata?.full_name }
        }
      }

      const out = (data ?? []).map((row: any) => ({
        id: row.id,
        user_id: row.user_id,
        email: userMap[row.user_id]?.email ?? '',
        name: userMap[row.user_id]?.name ?? null,
        role_key: row.role_definitions.key,
        role_label: row.role_definitions.label,
        department_id: row.department_id,
        disabled: !!row.disabled_at,
        accepted_at: row.accepted_at,
        joined_at: row.created_at,
      }))
      res.json(out)
    })

  // ─── Invite by email ──────────────────────────────────────────────────────
  // Uses Supabase Auth admin invite — Supabase sends the magic-link email.
  // We persist a pending_invites row so the AcceptInvitePage can resolve the
  // user → tenant + role context after the magic-link click.
  r.post('/api/team/invite',
    requireAuth, identifyTenant, requireTenantPerm(supabase, 'team', 'edit'),
    async (req, res) => {
      const tenantId = (req as any).tenantId
      const inviterId = (req as any).user.id
      const { email, role_key, department_id, message } = req.body
      if (!email || !role_key) { res.status(400).json({ error: 'email + role_key required' }); return }

      // Plan gate: enforce team_size_max
      const plan = await getTenantPlan(supabase, tenantId)
      const teamMax = Number(plan?.limits?.team_size_max ?? -1)
      if (teamMax > 0) {
        const { count } = await supabase.from('user_role_assignments')
          .select('id', { count: 'exact', head: true }).eq('tenant_id', tenantId)
        if ((count ?? 0) >= teamMax) {
          res.status(402).json({ error: `Plan limit: ${teamMax} seats. Upgrade to add more.` }); return
        }
      }

      // Resolve role
      const { data: role } = await supabase.from('role_definitions')
        .select('id, scope, plan_min').eq('key', role_key).eq('scope', 'tenant').maybeSingle()
      if (!role) { res.status(400).json({ error: 'Unknown role' }); return }
      // Role plan-gate check
      if (role.plan_min && plan && planRank(plan.plan_id) < planRank(role.plan_min)) {
        res.status(402).json({ error: `Role "${role_key}" requires plan ${role.plan_min}` }); return
      }

      // Build pending invite token
      const token = crypto.randomBytes(24).toString('base64url')
      const ttl = await getFlag(supabase, 'invite_link_ttl_days', 7)
      const expiresAt = new Date(Date.now() + Number(ttl) * 24 * 60 * 60 * 1000)

      const { data: invite, error: invErr } = await supabase.from('pending_invites').insert({
        tenant_id: tenantId, email, role_id: role.id, department_id: department_id ?? null,
        invited_by: inviterId, expires_at: expiresAt.toISOString(),
        message: message ?? null, token, status: 'pending',
      }).select().single()
      if (invErr) {
        if ((invErr as any).code === '23505') { res.status(409).json({ error: 'A pending invite already exists for this email' }); return }
        res.status(500).json({ error: invErr.message }); return
      }

      // Send the email via Supabase Auth admin
      const acceptUrl = `${process.env.FRONTEND_URL ?? 'http://localhost:5173'}/accept-invite?token=${token}`
      try {
        await (supabase as any).auth.admin.inviteUserByEmail(email, { redirectTo: acceptUrl })
      } catch (e: any) {
        // If the user already exists, Supabase returns an error — that's OK,
        // we still have a pending_invites row; the existing user can click the
        // link from the in-app banner or we can send a magic link separately.
        if (!/already/i.test(e?.message ?? '')) {
          console.warn('[invite] Supabase auth email failed:', e?.message)
        }
      }
      res.json({ success: true, invite, accept_url: acceptUrl })
    })

  // ─── Add an existing platform user to this tenant ─────────────────────────
  r.post('/api/team/add-existing',
    requireAuth, identifyTenant, requireTenantPerm(supabase, 'team', 'edit'),
    async (req, res) => {
      const tenantId = (req as any).tenantId
      const inviterId = (req as any).user.id
      const { user_id, email, role_key, department_id } = req.body
      if (!role_key || (!user_id && !email)) { res.status(400).json({ error: 'role_key + (user_id or email) required' }); return }

      // Resolve user
      let resolvedUserId = user_id
      if (!resolvedUserId && email) {
        const { data: { users = [] } = {} as any } = await (supabase as any).auth.admin.listUsers({ perPage: 200 })
        const u = (users as any[]).find(u => u.email === email)
        if (!u) { res.status(404).json({ error: 'No platform user with that email. Use /api/team/invite instead.' }); return }
        resolvedUserId = u.id
      }

      const plan = await getTenantPlan(supabase, tenantId)
      const teamMax = Number(plan?.limits?.team_size_max ?? -1)
      if (teamMax > 0) {
        const { count } = await supabase.from('user_role_assignments')
          .select('id', { count: 'exact', head: true }).eq('tenant_id', tenantId)
        if ((count ?? 0) >= teamMax) {
          res.status(402).json({ error: `Plan limit: ${teamMax} seats. Upgrade.` }); return
        }
      }

      const { data: role } = await supabase.from('role_definitions')
        .select('id').eq('key', role_key).eq('scope', 'tenant').maybeSingle()
      if (!role) { res.status(400).json({ error: 'Unknown role' }); return }

      const { data, error } = await supabase.from('user_role_assignments').insert({
        user_id: resolvedUserId, tenant_id: tenantId, role_id: role.id,
        department_id: department_id ?? null,
        invited_by: inviterId,
        invited_at: new Date().toISOString(),
        accepted_at: new Date().toISOString(),    // existing user is auto-accepted
      }).select().single()
      if (error) {
        if ((error as any).code === '23505') { res.status(409).json({ error: 'User already in this tenant' }); return }
        res.status(500).json({ error: error.message }); return
      }
      res.json(data)
    })

  // ─── Pending invites: list, resend, cancel ────────────────────────────────
  r.get('/api/team/invites',
    requireAuth, identifyTenant, requireTenantPerm(supabase, 'team', 'view'),
    async (req, res) => {
      const tenantId = (req as any).tenantId
      const { data, error } = await supabase.from('pending_invites')
        .select(`id, email, status, message, invited_at, expires_at, accepted_at,
                 role_definitions ( key, label )`)
        .eq('tenant_id', tenantId)
        .order('invited_at', { ascending: false })
      if (error) { res.status(500).json({ error: error.message }); return }
      res.json(data ?? [])
    })

  r.post('/api/team/invites/:id/resend',
    requireAuth, identifyTenant, requireTenantPerm(supabase, 'team', 'edit'),
    async (req, res) => {
      const tenantId = (req as any).tenantId
      const { data: inv } = await supabase.from('pending_invites')
        .select('*').eq('id', String(req.params.id)).eq('tenant_id', tenantId).maybeSingle()
      if (!inv) { res.status(404).json({ error: 'Invite not found' }); return }
      if (inv.status !== 'pending') { res.status(400).json({ error: `Invite is ${inv.status}` }); return }

      const acceptUrl = `${process.env.FRONTEND_URL ?? 'http://localhost:5173'}/accept-invite?token=${inv.token}`
      try {
        await (supabase as any).auth.admin.inviteUserByEmail(inv.email, { redirectTo: acceptUrl })
      } catch (e: any) {
        console.warn('[invite resend] Supabase auth:', e?.message)
      }
      res.json({ success: true, accept_url: acceptUrl })
    })

  r.delete('/api/team/invites/:id',
    requireAuth, identifyTenant, requireTenantPerm(supabase, 'team', 'edit'),
    async (req, res) => {
      const tenantId = (req as any).tenantId
      const { error } = await supabase.from('pending_invites').update({ status: 'cancelled' })
        .eq('id', String(req.params.id)).eq('tenant_id', tenantId)
      if (error) { res.status(500).json({ error: error.message }); return }
      res.json({ success: true })
    })

  // ─── Public invite preview (no auth) — drives AcceptInvitePage header ────
  r.get('/api/team/invite-info', async (req, res) => {
    const token = String(req.query.token ?? '')
    if (!token) { res.status(400).json({ error: 'token required' }); return }
    const { data: inv } = await supabase.from('pending_invites')
      .select(`email, status, expires_at, invited_by,
               role_definitions ( label ),
               tenants!inner ( business_name )`)
      .eq('token', token).maybeSingle()
    if (!inv) { res.status(404).json({ error: 'Invalid invite token' }); return }
    if (inv.status !== 'pending') { res.status(410).json({ error: `Invite is ${inv.status}` }); return }
    if (new Date(inv.expires_at).getTime() < Date.now()) {
      res.status(410).json({ error: 'Invite expired' }); return
    }
    // Resolve inviter name (best-effort)
    let inviter_name: string | undefined
    try {
      const { data: { user } = {} as any } = await (supabase as any).auth.admin.getUserById(inv.invited_by)
      inviter_name = user?.user_metadata?.full_name ?? user?.email
    } catch {}
    res.json({
      email: inv.email,
      status: inv.status,
      expires_at: inv.expires_at,
      org_name: (inv as any).tenants?.business_name ?? 'an organization',
      role_label: (inv as any).role_definitions?.label ?? 'Member',
      inviter_name,
    })
  })

  // ─── Accept invite (called from AcceptInvitePage with auth'd user) ────────
  r.post('/api/team/accept-invite', requireAuth, async (req, res) => {
    const userId = (req as any).user.id
    const userEmail = (req as any).user.email
    const { token } = req.body
    if (!token) { res.status(400).json({ error: 'token required' }); return }

    const { data: inv, error } = await supabase.from('pending_invites')
      .select('*').eq('token', token).maybeSingle()
    if (error || !inv) { res.status(404).json({ error: 'Invalid invite' }); return }
    if (inv.status !== 'pending') { res.status(400).json({ error: `Invite is ${inv.status}` }); return }
    if (new Date(inv.expires_at).getTime() < Date.now()) {
      await supabase.from('pending_invites').update({ status: 'expired' }).eq('id', inv.id)
      res.status(410).json({ error: 'Invite expired' }); return
    }
    // Email match check (if available)
    if (userEmail && userEmail.toLowerCase() !== inv.email.toLowerCase()) {
      res.status(403).json({ error: `Invite is for ${inv.email} but you are signed in as ${userEmail}` }); return
    }

    // Create the assignment + mark accepted
    const { error: ae } = await supabase.from('user_role_assignments').insert({
      user_id: userId, tenant_id: inv.tenant_id, role_id: inv.role_id,
      department_id: inv.department_id, invited_by: inv.invited_by,
      invited_at: inv.invited_at, accepted_at: new Date().toISOString(),
    })
    if (ae && (ae as any).code !== '23505') {
      res.status(500).json({ error: ae.message }); return
    }
    await supabase.from('pending_invites').update({ status: 'accepted', accepted_at: new Date().toISOString() }).eq('id', inv.id)

    // Notify the inviter (and tenant Workspace Admins) that a member joined
    try {
      // Get role label + acceptor name
      const [{ data: role }, { data: { user: acceptor } = {} as any }] = await Promise.all([
        supabase.from('role_definitions').select('label').eq('id', inv.role_id).maybeSingle(),
        (supabase as any).auth.admin.getUserById(userId),
      ])
      const acceptorName = acceptor?.user_metadata?.full_name ?? acceptor?.email ?? 'A teammate'
      await emitNotification(supabase, {
        tenant_id: inv.tenant_id,
        event_key: 'team.invite_accepted',
        recipient_user_ids: [inv.invited_by],
        data: { name: acceptorName, role: role?.label ?? 'Member' },
        link: '/settings/team',
      })
    } catch (e) { console.warn('[invite accepted notif]', (e as any)?.message) }

    res.json({ success: true, tenant_id: inv.tenant_id })
  })

  // ─── Update / disable / remove team member ────────────────────────────────
  r.patch('/api/team/members/:assignmentId',
    requireAuth, identifyTenant, requireTenantPerm(supabase, 'team', 'edit'),
    async (req, res) => {
      const tenantId = (req as any).tenantId
      const { role_key, department_id, disabled } = req.body
      const patch: Record<string, any> = {}
      if (role_key) {
        const { data: role } = await supabase.from('role_definitions')
          .select('id').eq('key', role_key).eq('scope', 'tenant').maybeSingle()
        if (!role) { res.status(400).json({ error: 'Unknown role' }); return }
        patch.role_id = role.id
      }
      if ('department_id' in req.body) patch.department_id = department_id
      if ('disabled' in req.body) {
        patch.disabled_at = disabled ? new Date().toISOString() : null
        patch.disabled_by = disabled ? (req as any).user.id : null
      }
      const { data, error } = await supabase.from('user_role_assignments')
        .update(patch).eq('id', String(req.params.assignmentId)).eq('tenant_id', tenantId)
        .select().single()
      if (error) { res.status(500).json({ error: error.message }); return }
      res.json(data)
    })

  r.delete('/api/team/members/:assignmentId',
    requireAuth, identifyTenant, requireTenantPerm(supabase, 'team', 'delete'),
    async (req, res) => {
      const tenantId = (req as any).tenantId
      const { error } = await supabase.from('user_role_assignments')
        .delete().eq('id', String(req.params.assignmentId)).eq('tenant_id', tenantId)
      if (error) { res.status(500).json({ error: error.message }); return }
      res.json({ success: true })
    })

  // ─── Departments CRUD ─────────────────────────────────────────────────────
  r.get('/api/team/departments',
    requireAuth, identifyTenant, requireTenantPerm(supabase, 'team', 'view'),
    async (req, res) => {
      const tenantId = (req as any).tenantId
      const { data, error } = await supabase.from('departments')
        .select('*').eq('tenant_id', tenantId).order('name')
      if (error) { res.status(500).json({ error: error.message }); return }
      res.json(data ?? [])
    })

  r.post('/api/team/departments',
    requireAuth, identifyTenant, requireTenantPerm(supabase, 'team', 'edit'),
    async (req, res) => {
      const tenantId = (req as any).tenantId
      const { name, color } = req.body
      if (!name) { res.status(400).json({ error: 'name required' }); return }
      const { data, error } = await supabase.from('departments').insert({
        tenant_id: tenantId, name, color: color ?? '#6b7280',
      }).select().single()
      if (error) {
        if ((error as any).code === '23505') { res.status(409).json({ error: 'Department name already exists' }); return }
        res.status(500).json({ error: error.message }); return
      }
      res.json(data)
    })

  r.delete('/api/team/departments/:id',
    requireAuth, identifyTenant, requireTenantPerm(supabase, 'team', 'delete'),
    async (req, res) => {
      const tenantId = (req as any).tenantId
      const { error } = await supabase.from('departments').delete()
        .eq('id', String(req.params.id)).eq('tenant_id', tenantId)
      if (error) { res.status(500).json({ error: error.message }); return }
      res.json({ success: true })
    })

  // ─── Roles available to this tenant (for the role dropdown) ───────────────
  r.get('/api/team/roles',
    requireAuth, identifyTenant, requireTenantPerm(supabase, 'team', 'view'),
    async (req, res) => {
      const tenantId = (req as any).tenantId
      // Built-in roles + this tenant's custom roles (if any)
      const { data, error } = await supabase.from('role_definitions')
        .select('id, key, label, description, plan_min, is_built_in')
        .eq('scope', 'tenant')
        .or(`tenant_id.eq.${tenantId},is_built_in.eq.true`)
        .order('label')
      if (error) { res.status(500).json({ error: error.message }); return }
      // Apply tenant-specific label overrides
      const { data: overrides } = await supabase.from('role_label_overrides')
        .select('role_id, custom_label').eq('tenant_id', tenantId)
      const omap = new Map((overrides ?? []).map(o => [o.role_id, o.custom_label]))
      const out = (data ?? []).map(r => ({ ...r, label: omap.get(r.id) ?? r.label }))
      res.json(out)
    })

  // ─── Custom role builder (Growth+ only) ───────────────────────────────────
  r.post('/api/team/custom-roles',
    requireAuth, identifyTenant, requireTenantPerm(supabase, 'team', 'edit'),
    async (req, res) => {
      const tenantId = (req as any).tenantId
      const plan = await getTenantPlan(supabase, tenantId)
      if (!plan?.limits?.custom_roles_allowed) {
        res.status(402).json({ error: 'Custom roles require Growth+ plan. Upgrade to enable.' }); return
      }
      const { key, label, description, permissions, allowed_apps, data_scope } = req.body
      if (!key || !label) { res.status(400).json({ error: 'key + label required' }); return }
      const { data, error } = await supabase.from('role_definitions').insert({
        scope: 'tenant', key, label, description: description ?? null,
        is_built_in: false, tenant_id: tenantId,
        permissions: permissions ?? {},
        allowed_apps: allowed_apps ?? ['*'],
        data_scope: data_scope ?? 'own',
      }).select().single()
      if (error) {
        if ((error as any).code === '23505') { res.status(409).json({ error: 'Role with this key already exists in your tenant' }); return }
        res.status(500).json({ error: error.message }); return
      }
      res.json(data)
    })

  // ─── Per-tenant role label overrides ──────────────────────────────────────
  r.post('/api/team/role-labels',
    requireAuth, identifyTenant, requireTenantPerm(supabase, 'team', 'edit'),
    async (req, res) => {
      const tenantId = (req as any).tenantId
      const { role_id, custom_label } = req.body
      if (!role_id || !custom_label) { res.status(400).json({ error: 'role_id + custom_label required' }); return }
      const { data, error } = await supabase.from('role_label_overrides').upsert({
        tenant_id: tenantId, role_id, custom_label,
      }).select().single()
      if (error) { res.status(500).json({ error: error.message }); return }
      res.json(data)
    })

  return r
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function planRank(planId: string): number {
  return ({ free: 0, starter: 1, growth: 2, scale: 3 } as Record<string, number>)[planId] ?? 0
}

async function getFlag(supabase: SupabaseClient, key: string, fallback: any): Promise<any> {
  const { data } = await supabase.from('feature_flags').select('value_json').eq('key', key).maybeSingle()
  return (data?.value_json as any)?.value ?? fallback
}
