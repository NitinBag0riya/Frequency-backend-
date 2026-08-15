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
import { sendTeamInviteWa } from '../lib/team-invite-wa'
import { sendTeamInviteSms } from '../lib/storefront-sms.js'

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

    // The FOUNDING owner is resolved by identifyTenant via tenants.user_id and
    // tagged userRole='owner'. Onboarding never creates an owner
    // user_role_assignments row, so without this fallback the owner 403s on every
    // team route (measured: 112/116 active tenants' owners had no assignment row).
    if ((req as any).userRole === 'owner') { next(); return }

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
      if (role_key === 'owner' && (req as any).userRole !== 'owner') {
        res.status(403).json({ error: 'Only the owner can grant the owner role' }); return
      }

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

  // ─── Invite by phone (WhatsApp) ───────────────────────────────────────────
  // Mirrors the email invite's authz/plan/role guards exactly, but delivers an
  // opaque join link over WhatsApp (reusing resolveWaCreds) instead of email.
  // The invitee has no auth account yet — they create one at /accept-invite via
  // POST /api/team/accept-invite-phone (see below).
  r.post('/api/team/invite-phone',
    requireAuth, identifyTenant, requireTenantPerm(supabase, 'team', 'edit'),
    async (req, res) => {
      const tenantId = (req as any).tenantId
      const inviterId = (req as any).user.id
      const { phone, role_key, department_id, message } = req.body
      if (!role_key) { res.status(400).json({ error: 'phone + role_key required' }); return }
      if (!isValidE164(phone)) { res.status(400).json({ error: 'phone must be E.164, e.g. +919876543210' }); return }
      const e164 = String(phone).trim()
      // Same owner-role clamp as the email path — no privilege escalation.
      if (role_key === 'owner' && (req as any).userRole !== 'owner') {
        res.status(403).json({ error: 'Only the owner can grant the owner role' }); return
      }

      // Plan gate: seats
      const plan = await getTenantPlan(supabase, tenantId)
      const teamMax = Number(plan?.limits?.team_size_max ?? -1)
      if (teamMax > 0) {
        const { count } = await supabase.from('user_role_assignments')
          .select('id', { count: 'exact', head: true }).eq('tenant_id', tenantId)
        if ((count ?? 0) >= teamMax) {
          res.status(402).json({ error: `Plan limit: ${teamMax} seats. Upgrade to add more.` }); return
        }
      }

      // Resolve + plan-gate the role (identical to email path)
      const { data: role } = await supabase.from('role_definitions')
        .select('id, scope, plan_min').eq('key', role_key).eq('scope', 'tenant').maybeSingle()
      if (!role) { res.status(400).json({ error: 'Unknown role' }); return }
      if (role.plan_min && plan && planRank(plan.plan_id) < planRank(role.plan_min)) {
        res.status(402).json({ error: `Role "${role_key}" requires plan ${role.plan_min}` }); return
      }

      const token = crypto.randomBytes(24).toString('base64url')
      const ttl = await getFlag(supabase, 'invite_link_ttl_days', 7)
      const expiresAt = new Date(Date.now() + Number(ttl) * 24 * 60 * 60 * 1000)

      const { data: invite, error: invErr } = await supabase.from('pending_invites').insert({
        tenant_id: tenantId, phone: e164, email: null, role_id: role.id,
        department_id: department_id ?? null, invited_by: inviterId,
        expires_at: expiresAt.toISOString(), message: message ?? null,
        token, status: 'pending',
      }).select().single()
      if (invErr) {
        if ((invErr as any).code === '23505') { res.status(409).json({ error: 'A pending invite already exists for this number' }); return }
        res.status(500).json({ error: invErr.message }); return
      }

      const acceptUrl = `${process.env.FRONTEND_URL ?? 'http://localhost:5173'}/accept-invite?token=${token}`

      // Resolve org name for the template body.
      const { data: t } = await supabase.from('tenants').select('business_name').eq('id', tenantId).maybeSingle()
      const orgName = (t as any)?.business_name ?? 'a team'

      // Delivery mirrors /api/storefront/send-otp: MSG91 SMS is the PRIMARY gateway
      // (the same DLT rail as the login OTP), WhatsApp is the fallback. Best-effort:
      // if both fail we STILL return the accept link so the admin can share it.
      let sent_via: 'sms' | 'whatsapp' | null = null
      let deliver_error: string | undefined
      try {
        await sendTeamInviteSms(supabase, { phone: e164, orgName, acceptUrl })
        sent_via = 'sms'
      } catch (smsErr: any) {
        try {
          await sendTeamInviteWa(supabase, { tenantId, phone: e164, token, orgName })
          sent_via = 'whatsapp'
        } catch (waErr: any) {
          deliver_error = `sms="${smsErr?.message}" wa="${waErr?.message}"`
          console.warn('[invite-phone] SMS + WhatsApp both failed:', deliver_error)
        }
      }
      // wa_sent kept for back-compat with the existing FE toast.
      res.json({ success: true, invite, accept_url: acceptUrl, sent_via, wa_sent: sent_via != null, deliver_error })
    })

  // ─── Add an existing platform user to this tenant ─────────────────────────
  r.post('/api/team/add-existing',
    requireAuth, identifyTenant, requireTenantPerm(supabase, 'team', 'edit'),
    async (req, res) => {
      const tenantId = (req as any).tenantId
      const inviterId = (req as any).user.id
      const { user_id, email, role_key, department_id } = req.body
      if (!role_key || (!user_id && !email)) { res.status(400).json({ error: 'role_key + (user_id or email) required' }); return }
      if (role_key === 'owner' && (req as any).userRole !== 'owner') {
        res.status(403).json({ error: 'Only the owner can grant the owner role' }); return
      }

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
        .select(`id, email, phone, status, message, invited_at, expires_at, accepted_at,
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
      .select(`email, phone, status, expires_at, invited_by,
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
      // `channel` drives which join form AcceptInvitePage shows. Returning the
      // invitee's own phone/email to the token holder is symmetric with the
      // email flow — the opaque token IS the secret gating this preview.
      channel: inv.phone ? 'phone' : 'email',
      email: inv.email,
      phone: inv.phone,
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

  // ─── Accept a PHONE invite (public — invitee has no account yet) ──────────
  // Authorization is the opaque WhatsApp-delivered token: only someone who
  // received the message on that number holds it. We create the invitee's auth
  // account (phone-native; email optional) and materialize the SAME
  // user_role_assignments linkage the email accept path writes. The session is
  // established client-side by Supabase's own signInWithPassword afterwards —
  // we never mint or fabricate a session here.
  r.post('/api/team/accept-invite-phone', async (req, res) => {
    const { token, password, full_name, email } = req.body ?? {}
    if (!token) { res.status(400).json({ error: 'token required' }); return }
    if (typeof password !== 'string' || password.length < 8) {
      res.status(400).json({ error: 'Password must be at least 8 characters' }); return
    }
    if (email != null && typeof email !== 'string') { res.status(400).json({ error: 'email must be a string' }); return }

    const { data: inv, error } = await supabase.from('pending_invites')
      .select('*').eq('token', token).maybeSingle()
    if (error || !inv) { res.status(404).json({ error: 'Invalid invite' }); return }

    const state = inviteAcceptState(inv as any, 'phone')
    if (state === 'not-pending') { res.status(400).json({ error: `Invite is ${inv.status}` }); return }
    if (state === 'expired') {
      await supabase.from('pending_invites').update({ status: 'expired' }).eq('id', inv.id)
      res.status(410).json({ error: 'Invite expired' }); return
    }
    if (state === 'wrong-channel') { res.status(400).json({ error: 'Not a phone invite — use the email flow' }); return }

    // Create the invitee's auth account. phone_confirm/email_confirm are set
    // because the invite token already proved control of the number — the same
    // trust the email path places in magic-link possession. FAIL CLOSED: if the
    // account can't be created we do NOT consume the invite.
    const { data: created, error: cErr } = await (supabase as any).auth.admin.createUser({
      phone: inv.phone,
      phone_confirm: true,
      password,
      ...(email ? { email: email.toLowerCase().trim(), email_confirm: true } : {}),
      user_metadata: { full_name: full_name ?? null, source: 'team_invite_phone' },
    })
    const userId = created?.user?.id
    if (cErr || !userId) {
      // Existing account on this number/email — don't silently reassign; ask
      // them to sign in and use the in-app accept instead.
      const dup = /already|registered|exists/i.test(cErr?.message ?? '')
      res.status(dup ? 409 : 500).json({
        error: dup
          ? 'An account already exists for this number. Sign in, then open the invite link again to accept.'
          : (cErr?.message ?? 'Could not create account'),
      }); return
    }

    // Same linkage row the email accept path writes.
    const { error: ae } = await supabase.from('user_role_assignments').insert({
      user_id: userId, tenant_id: inv.tenant_id, role_id: inv.role_id,
      department_id: inv.department_id, invited_by: inv.invited_by,
      invited_at: inv.invited_at, accepted_at: new Date().toISOString(),
    })
    if (ae && (ae as any).code !== '23505') { res.status(500).json({ error: ae.message }); return }
    await supabase.from('pending_invites').update({ status: 'accepted', accepted_at: new Date().toISOString() }).eq('id', inv.id)

    try {
      const { data: role } = await supabase.from('role_definitions').select('label').eq('id', inv.role_id).maybeSingle()
      await emitNotification(supabase, {
        tenant_id: inv.tenant_id,
        event_key: 'team.invite_accepted',
        recipient_user_ids: [inv.invited_by],
        data: { name: full_name ?? inv.phone, role: role?.label ?? 'Member' },
        link: '/settings/team',
      })
    } catch (e) { console.warn('[invite-phone accepted notif]', (e as any)?.message) }

    // FE signs in with these (phone+password, or email+password if provided).
    res.json({ success: true, tenant_id: inv.tenant_id, phone: inv.phone, has_email: !!email })
  })

  // ─── Update / disable / remove team member ────────────────────────────────
  r.patch('/api/team/members/:assignmentId',
    requireAuth, identifyTenant, requireTenantPerm(supabase, 'team', 'edit'),
    async (req, res) => {
      const tenantId = (req as any).tenantId
      const callerIsOwner = (req as any).userRole === 'owner'
      const { role_key, department_id, disabled } = req.body
      const patch: Record<string, any> = {}
      if (role_key) {
        // Privilege-escalation guards (confirmed exploit: a workspace_admin PATCHed
        // its own row to role_key:'owner' and took over the tenant — reproduced live
        // on prod before this fix). Only an owner may grant the owner role, and no
        // non-owner may change their OWN role.
        if (role_key === 'owner' && !callerIsOwner) {
          res.status(403).json({ error: 'Only the owner can grant the owner role' }); return
        }
        if (!callerIsOwner) {
          const { data: target } = await supabase.from('user_role_assignments')
            .select('user_id').eq('id', String(req.params.assignmentId)).eq('tenant_id', tenantId).maybeSingle()
          if (target && target.user_id === (req as any).user.id) {
            res.status(403).json({ error: 'You cannot change your own role' }); return
          }
        }
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
      if (error) { res.status((error as any).code === 'PGRST116' ? 404 : 500).json({ error: (error as any).code === 'PGRST116' ? 'not found' : error.message }); return }
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
        .select('id, key, label, description, plan_min, is_built_in, allowed_apps')
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

      // Privilege-clamp: a non-owner cannot mint a role with permissions, data
      // scope, or app access broader than their OWN — else a workspace_admin could
      // create (then assign) a role holding billing.edit / tenant.delete they were
      // explicitly denied. Owners may grant anything.
      const DATA_SCOPES = ['own', 'team', 'department', 'all']
      const SCOPE_RANK: Record<string, number> = { own: 0, team: 1, department: 2, all: 3 }
      let finalPerms: Record<string, any> = permissions && typeof permissions === 'object' ? permissions : {}
      let finalScope: string = DATA_SCOPES.includes(data_scope) ? data_scope : 'own'
      let finalApps: string[] = Array.isArray(allowed_apps) ? allowed_apps : ['*']
      if ((req as any).userRole !== 'owner') {
        const { data: myAssign } = await supabase.from('user_role_assignments')
          .select('role_id').eq('user_id', (req as any).user.id).eq('tenant_id', tenantId).maybeSingle()
        const { data: myRole } = myAssign
          ? await supabase.from('role_definitions').select('permissions, data_scope, allowed_apps').eq('id', myAssign.role_id).maybeSingle()
          : { data: null as any }
        const myPerms = ((myRole?.permissions as any) || {}) as Record<string, any>
        const clamped: Record<string, any> = {}
        for (const feat of Object.keys(finalPerms)) {
          for (const act of Object.keys(finalPerms[feat] || {})) {
            if (finalPerms[feat][act] === true && myPerms?.[feat]?.[act] === true) {
              clamped[feat] = clamped[feat] || {}
              clamped[feat][act] = true
            }
          }
        }
        finalPerms = clamped
        const myScope = (myRole?.data_scope as string) || 'own'
        if ((SCOPE_RANK[finalScope] ?? 0) > (SCOPE_RANK[myScope] ?? 0)) finalScope = myScope
        const myApps: string[] = (myRole?.allowed_apps as string[]) || []
        if (!myApps.includes('*')) finalApps = finalApps.filter(a => a !== '*' && myApps.includes(a))
      }
      const { data, error } = await supabase.from('role_definitions').insert({
        scope: 'tenant', key, label, description: description ?? null,
        is_built_in: false, tenant_id: tenantId,
        permissions: finalPerms,
        allowed_apps: finalApps,
        data_scope: finalScope,
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
      if (error) { res.status((error as any).code === 'PGRST116' ? 404 : 500).json({ error: (error as any).code === 'PGRST116' ? 'not found' : error.message }); return }
      res.json(data)
    })

  return r
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function planRank(planId: string): number {
  return ({ free: 0, starter: 1, growth: 2, scale: 3 } as Record<string, number>)[planId] ?? 0
}

/**
 * Strict-ish E.164: leading '+', country digit 1–9, 7–14 more digits.
 * Pure + exported so the selfcheck can pin the trust-boundary validation.
 */
export function isValidE164(phone: unknown): phone is string {
  return typeof phone === 'string' && /^\+[1-9]\d{7,14}$/.test(phone.trim())
}

export type InviteAcceptState = 'ok' | 'not-pending' | 'expired' | 'wrong-channel'

/**
 * Single source of truth for "can this invite row be consumed right now" —
 * used by both accept paths. `channel` asserts the row matches the accept flow
 * (a phone-accept must land on a phone invite, never an email one), which is
 * what keeps the token single-purpose. Pure + exported for the selfcheck.
 */
export function inviteAcceptState(
  invite: { status: string; expires_at: string; phone?: string | null; email?: string | null },
  channel: 'phone' | 'email',
  now: number = Date.now(),
): InviteAcceptState {
  if (invite.status !== 'pending') return 'not-pending'
  if (new Date(invite.expires_at).getTime() < now) return 'expired'
  if (channel === 'phone' && !invite.phone) return 'wrong-channel'
  if (channel === 'email' && !invite.email) return 'wrong-channel'
  return 'ok'
}

async function getFlag(supabase: SupabaseClient, key: string, fallback: any): Promise<any> {
  const { data } = await supabase.from('feature_flags').select('value_json').eq('key', key).maybeSingle()
  return (data?.value_json as any)?.value ?? fallback
}
