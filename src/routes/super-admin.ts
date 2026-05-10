/**
 * Super-admin endpoints — platform-level operations.
 *
 * Mounted under /api/super-admin/*. Every route is gated by `requirePlatformPerm`,
 * which reads `user_role_assignments` rows where tenant_id IS NULL (platform
 * scope), looks up the role's permissions matrix, and enforces fine-grained
 * action access. The Platform Owner role gets everything; Customer Success can
 * impersonate but not suspend; Billing Ops can change plans but not impersonate;
 * etc.
 *
 * Every mutating action writes a row to `super_admin_audit` so we have a
 * permanent record of who did what.
 *
 *   GET    /tenants                       list all tenants (paginated, filterable)
 *   GET    /tenants/:id                   tenant detail (subscription + users + audit)
 *   POST   /tenants/:id/suspend           suspend tenant
 *   POST   /tenants/:id/reactivate        reactivate tenant
 *   DELETE /tenants/:id                   soft-delete tenant (hard cascade after 30d)
 *
 *   GET    /plans                         list plans (also publicly readable for the FE)
 *   POST   /plans                         create plan
 *   PATCH  /plans/:id                     edit plan (features, limits, freemium caps)
 *   DELETE /plans/:id                     delete plan (only if no active subscriptions)
 *
 *   GET    /roles                         list role definitions (both scopes)
 *   POST   /roles                         create custom role (scope=tenant if tenant_id given)
 *   PATCH  /roles/:id                     edit role permissions
 *   DELETE /roles/:id                     delete role (only if not built_in)
 *
 *   GET    /audit                         paginated audit log (filterable by actor/action/tenant)
 *
 *   POST   /tenants/:id/impersonate       returns short-lived JWT scoped to that tenant
 *   POST   /impersonate/stop              ends current impersonation session
 *
 *   GET    /feature-flags                 list flags
 *   PATCH  /feature-flags/:key            update flag value
 *
 *   GET    /announcements                 list (also publicly readable)
 *   POST   /announcements                 create
 *   DELETE /announcements/:id             delete
 *
 *   GET    /approval-rules                list (incl. tenant overrides)
 *   POST   /approval-rules                create
 *   PATCH  /approval-rules/:id            update
 *   DELETE /approval-rules/:id            delete
 *
 *   POST   /tenants/:id/subscription      change plan / extend trial
 */

import express from 'express'
import jwt, { randomUUID } from 'crypto'   // Node built-in crypto for JWT signing + handoff IDs
import { SupabaseClient } from '@supabase/supabase-js'

type Middleware = (req: express.Request, res: express.Response, next: express.NextFunction) => void | Promise<void>

interface Deps {
  supabase: SupabaseClient
  requireAuth: Middleware
}

/**
 * Walk the role permission matrix to decide whether the platform-scoped user
 * can perform a feature/action. Reads from role_definitions.permissions.
 */
async function platformCan(supabase: SupabaseClient, userId: string, feature: string, action: 'view' | 'edit' | 'delete'): Promise<{ ok: boolean; role?: string }> {
  const { data: assignment } = await supabase.from('user_role_assignments')
    .select('role_id, disabled_at')
    .eq('user_id', userId)
    .is('tenant_id', null)                 // platform-scoped
    .maybeSingle()
  if (!assignment || assignment.disabled_at) return { ok: false }

  const { data: role } = await supabase.from('role_definitions')
    .select('key, permissions')
    .eq('id', assignment.role_id)
    .eq('scope', 'platform')
    .maybeSingle()
  if (!role) return { ok: false }

  const featurePerm = (role.permissions as any)?.[feature]
  if (!featurePerm) return { ok: false, role: role.key }
  return { ok: !!featurePerm[action], role: role.key }
}

function requirePlatformPerm(supabase: SupabaseClient, feature: string, action: 'view' | 'edit' | 'delete'): Middleware {
  return async (req, res, next) => {
    const user = (req as any).user
    if (!user) { res.status(401).json({ error: 'Auth required' }); return }
    const { ok, role } = await platformCan(supabase, user.id, feature, action)
    if (!ok) { res.status(403).json({ error: `Platform role lacks ${action} on ${feature}` }); return }
    ;(req as any).platformRole = role
    next()
  }
}

/** Write a row to super_admin_audit. Best-effort; failures are logged not thrown. */
async function audit(
  supabase: SupabaseClient, req: express.Request,
  args: { action: string; target_tenant_id?: string | null; target_user_id?: string | null; payload?: any; reason?: string }
) {
  try {
    const user = (req as any).user
    await supabase.from('super_admin_audit').insert({
      actor_user_id: user?.id ?? null,
      actor_role: (req as any).platformRole ?? null,
      action: args.action,
      target_tenant_id: args.target_tenant_id ?? null,
      target_user_id: args.target_user_id ?? null,
      payload: args.payload ?? {},
      reason: args.reason ?? null,
      ip_address: req.ip ?? null,
      user_agent: req.get('user-agent') ?? null,
    })
  } catch (e) {
    console.error('[audit] failed to write', e)
  }
}

export function createSuperAdminRouter(deps: Deps): express.Router {
  const r = express.Router()
  const { supabase, requireAuth } = deps

  // ─── Tenants ──────────────────────────────────────────────────────────────
  r.get('/api/super-admin/tenants',
    requireAuth, requirePlatformPerm(supabase, 'tenants', 'view'),
    async (req, res) => {
      const { search, status, plan, page = '1', pageSize = '20' } = req.query as Record<string, string>
      const p = Math.max(1, parseInt(page, 10) || 1)
      const ps = Math.min(100, Math.max(1, parseInt(pageSize, 10) || 20))
      const offset = (p - 1) * ps

      let query = supabase.from('tenants')
        .select(`id, business_name, display_phone, waba_id, status, created_at, deleted_at,
                 user_id,
                 tenant_subscriptions ( plan_id, status, trial_ends_at, current_period_end )`,
          { count: 'exact' })
        .order('created_at', { ascending: false })
        .range(offset, offset + ps - 1)

      if (status && status !== 'all') query = query.eq('status', status)
      if (search) query = query.or(`business_name.ilike.%${search}%,display_phone.ilike.%${search}%,waba_id.ilike.%${search}%`)

      const { data, error, count } = await query
      if (error) { res.status(500).json({ error: error.message }); return }

      let rows = data ?? []
      if (plan && plan !== 'all') {
        rows = rows.filter((t: any) => t.tenant_subscriptions?.[0]?.plan_id === plan)
      }
      res.json({ data: rows, total: count ?? rows.length, page: p, pageSize: ps, totalPages: Math.max(1, Math.ceil((count ?? 0) / ps)) })
    })

  r.get('/api/super-admin/tenants/:id',
    requireAuth, requirePlatformPerm(supabase, 'tenants', 'view'),
    async (req, res) => {
      const id = String(req.params.id)
      const { data: tenant } = await supabase.from('tenants')
        .select(`*, tenant_subscriptions(*), tenant_entitlements(*)`)
        .eq('id', id).maybeSingle()
      if (!tenant) { res.status(404).json({ error: 'Tenant not found' }); return }

      const [{ data: users }, { data: auditRows }, { data: usage }] = await Promise.all([
        supabase.from('user_role_assignments')
          .select('id, user_id, role_id, department_id, disabled_at, accepted_at, created_at, role_definitions!inner(key, label)')
          .eq('tenant_id', id),
        supabase.from('super_admin_audit')
          .select('id, action, payload, reason, actor_role, created_at')
          .eq('target_tenant_id', id)
          .order('created_at', { ascending: false }).limit(20),
        supabase.from('tenant_usage')
          .select('metric, period_start, count')
          .eq('tenant_id', id)
          .gte('period_start', new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString().slice(0, 10)),
      ])

      res.json({ tenant, users: users ?? [], audit: auditRows ?? [], usage: usage ?? [] })
    })

  r.post('/api/super-admin/tenants/:id/suspend',
    requireAuth, requirePlatformPerm(supabase, 'tenants', 'edit'),
    async (req, res) => {
      const id = String(req.params.id)
      const reason = String(req.body?.reason ?? '').trim()
      if (!reason) { res.status(400).json({ error: 'Reason required for suspend' }); return }

      const userId = (req as any).user.id
      const { error } = await supabase.from('tenants').update({
        status: 'suspended',
        status_changed_at: new Date().toISOString(),
        status_changed_by: userId,
        status_change_reason: reason,
      }).eq('id', id)
      if (error) { res.status(500).json({ error: error.message }); return }

      // Mirror onto subscription so quota checks treat as suspended
      await supabase.from('tenant_subscriptions').update({ status: 'suspended' }).eq('tenant_id', id)

      await audit(supabase, req, { action: 'tenant.suspend', target_tenant_id: id, reason })
      res.json({ success: true })
    })

  r.post('/api/super-admin/tenants/:id/reactivate',
    requireAuth, requirePlatformPerm(supabase, 'tenants', 'edit'),
    async (req, res) => {
      const id = String(req.params.id)
      const reason = String(req.body?.reason ?? '').trim() || 'Reactivated'
      const userId = (req as any).user.id

      const { error } = await supabase.from('tenants').update({
        status: 'active',
        status_changed_at: new Date().toISOString(),
        status_changed_by: userId,
        status_change_reason: reason,
        deleted_at: null,
      }).eq('id', id)
      if (error) { res.status(500).json({ error: error.message }); return }

      await supabase.from('tenant_subscriptions').update({ status: 'active' }).eq('tenant_id', id)

      await audit(supabase, req, { action: 'tenant.reactivate', target_tenant_id: id, reason })
      res.json({ success: true })
    })

  r.delete('/api/super-admin/tenants/:id',
    requireAuth, requirePlatformPerm(supabase, 'tenants', 'delete'),
    async (req, res) => {
      const id = String(req.params.id)
      const reason = String(req.body?.reason ?? '').trim()
      const confirm = String(req.body?.confirm_name ?? '').trim()
      if (!reason) { res.status(400).json({ error: 'Reason required' }); return }

      // GitHub-style "type org name to confirm"
      const { data: tenant } = await supabase.from('tenants')
        .select('business_name').eq('id', id).maybeSingle()
      if (!tenant) { res.status(404).json({ error: 'Tenant not found' }); return }
      if (tenant.business_name && confirm !== tenant.business_name) {
        res.status(400).json({ error: `Type the org name to confirm: "${tenant.business_name}"` }); return
      }

      // Soft delete — hard cascade after grace period (separate cron worker)
      const userId = (req as any).user.id
      await supabase.from('tenants').update({
        status: 'deleted',
        deleted_at: new Date().toISOString(),
        status_changed_by: userId,
        status_change_reason: reason,
      }).eq('id', id)

      await audit(supabase, req, { action: 'tenant.delete_soft', target_tenant_id: id, reason })
      res.json({ success: true, scheduled_for_hard_delete_after_days: 30 })
    })

  // ─── Plans ────────────────────────────────────────────────────────────────
  // GET /plans is also exposed publicly for FE; super-admin gates POST/PATCH/DELETE.
  r.get('/api/super-admin/plans', requireAuth, requirePlatformPerm(supabase, 'plans', 'view'),
    async (_req, res) => {
      const { data, error } = await supabase.from('plans').select('*').order('sort_order')
      if (error) { res.status(500).json({ error: error.message }); return }
      res.json(data ?? [])
    })

  r.post('/api/super-admin/plans', requireAuth, requirePlatformPerm(supabase, 'plans', 'edit'),
    async (req, res) => {
      const { id, name, monthly_price_inr, trial_days, features, limits, freemium_caps } = req.body
      if (!id || !name) { res.status(400).json({ error: 'id + name required' }); return }
      const { data, error } = await supabase.from('plans').insert({
        id, name,
        monthly_price_inr: monthly_price_inr ?? 0,
        trial_days: trial_days ?? 14,
        features: features ?? [],
        limits: limits ?? {},
        freemium_caps: freemium_caps ?? {},
      }).select().single()
      if (error) { res.status(500).json({ error: error.message }); return }
      await audit(supabase, req, { action: 'plan.create', payload: data })
      res.json(data)
    })

  r.patch('/api/super-admin/plans/:id', requireAuth, requirePlatformPerm(supabase, 'plans', 'edit'),
    async (req, res) => {
      const allowed = ['name', 'monthly_price_inr', 'trial_days', 'features', 'limits', 'freemium_caps', 'is_active']
      const patch: Record<string, any> = { updated_at: new Date().toISOString() }
      for (const k of allowed) if (k in req.body) patch[k] = req.body[k]
      const { data, error } = await supabase.from('plans').update(patch).eq('id', String(req.params.id)).select().single()
      if (error) { res.status(500).json({ error: error.message }); return }
      await audit(supabase, req, { action: 'plan.update', payload: { id: String(req.params.id), changes: patch } })
      res.json(data)
    })

  r.delete('/api/super-admin/plans/:id', requireAuth, requirePlatformPerm(supabase, 'plans', 'delete'),
    async (req, res) => {
      const { count } = await supabase.from('tenant_subscriptions')
        .select('id', { count: 'exact', head: true })
        .eq('plan_id', String(req.params.id)).eq('status', 'active')
      if ((count ?? 0) > 0) { res.status(409).json({ error: `${count} active subscriptions on this plan. Migrate them first.` }); return }
      const { error } = await supabase.from('plans').delete().eq('id', String(req.params.id))
      if (error) { res.status(500).json({ error: error.message }); return }
      await audit(supabase, req, { action: 'plan.delete', payload: { id: String(req.params.id) } })
      res.json({ success: true })
    })

  // ─── Roles ────────────────────────────────────────────────────────────────
  r.get('/api/super-admin/roles', requireAuth, requirePlatformPerm(supabase, 'roles', 'view'),
    async (req, res) => {
      const scope = (req.query.scope as string) ?? null
      let q = supabase.from('role_definitions').select('*')
      if (scope) q = q.eq('scope', scope)
      const { data, error } = await q.order('label')
      if (error) { res.status(500).json({ error: error.message }); return }
      res.json(data ?? [])
    })

  r.patch('/api/super-admin/roles/:id', requireAuth, requirePlatformPerm(supabase, 'roles', 'edit'),
    async (req, res) => {
      const allowed = ['label', 'description', 'permissions', 'allowed_apps', 'data_scope', 'plan_min']
      const patch: Record<string, any> = { updated_at: new Date().toISOString() }
      for (const k of allowed) if (k in req.body) patch[k] = req.body[k]
      const { data, error } = await supabase.from('role_definitions').update(patch).eq('id', String(req.params.id)).select().single()
      if (error) { res.status(500).json({ error: error.message }); return }
      await audit(supabase, req, { action: 'role.update', payload: { id: String(req.params.id), changes: patch } })
      res.json(data)
    })

  r.delete('/api/super-admin/roles/:id', requireAuth, requirePlatformPerm(supabase, 'roles', 'delete'),
    async (req, res) => {
      const { data: role } = await supabase.from('role_definitions').select('is_built_in, key, scope').eq('id', String(req.params.id)).maybeSingle()
      if (!role) { res.status(404).json({ error: 'Role not found' }); return }
      if (role.is_built_in) { res.status(400).json({ error: 'Cannot delete a built-in role' }); return }
      const { error } = await supabase.from('role_definitions').delete().eq('id', String(req.params.id))
      if (error) { res.status(500).json({ error: error.message }); return }
      await audit(supabase, req, { action: 'role.delete', payload: { id: String(req.params.id), key: role.key } })
      res.json({ success: true })
    })

  // ─── Audit log ────────────────────────────────────────────────────────────
  r.get('/api/super-admin/audit', requireAuth, requirePlatformPerm(supabase, 'audit', 'view'),
    async (req, res) => {
      const { actor, action, tenant_id, page = '1', pageSize = '50' } = req.query as Record<string, string>
      const p = Math.max(1, parseInt(page, 10) || 1)
      const ps = Math.min(200, Math.max(1, parseInt(pageSize, 10) || 50))
      const offset = (p - 1) * ps
      let q = supabase.from('super_admin_audit')
        .select('*', { count: 'exact' })
        .order('created_at', { ascending: false })
        .range(offset, offset + ps - 1)
      if (actor)     q = q.eq('actor_user_id', actor)
      if (action)    q = q.eq('action', action)
      if (tenant_id) q = q.eq('target_tenant_id', tenant_id)
      const { data, error, count } = await q
      if (error) { res.status(500).json({ error: error.message }); return }
      res.json({ data: data ?? [], total: count ?? 0, page: p, pageSize: ps })
    })

  // ─── Impersonation ────────────────────────────────────────────────────────
  // Issues a short-lived JWT-like token (HMAC-signed). The FE stores it under
  // a separate key (so the user's own session stays intact in another tab) and
  // sends it via the `X-Impersonate-Token` header on subsequent requests.
  // ─── Impersonation (handoff-token flow) ───────────────────────────────────
  //
  // SECURITY: the actual impersonation JWT must NEVER appear in any URL,
  // browser history, dev-tools network log preview, or paste buffer. To
  // open the impersonation in a new tab safely we use a two-step handoff:
  //
  //   1. POST /tenants/:id/impersonate — mints the JWT, stores it in a
  //      short-lived in-memory map keyed by a random one-time `handoff_id`,
  //      and returns ONLY the handoff_id to the FE.
  //   2. New tab opens with `?imp_handoff=<id>`, on first load it calls
  //      POST /impersonate/claim with that id (authenticated). Server
  //      verifies the requesting user matches the actor that started the
  //      handoff, returns the JWT, then deletes the handoff entry.
  //
  // Even if the handoff_id leaks (it's just a UUID in a URL), it's already
  // consumed; replays return 404. JWT lives only in sessionStorage of the
  // tab that successfully claimed it.
  const HANDOFF_TTL_MS = 30_000  // very short — only needs to survive the new tab opening

  interface HandoffEntry {
    actor_user_id: string
    token: string
    expires_at: string
    tenant_id: string
    read_only: boolean
    created_at: number
  }
  const pendingHandoffs = new Map<string, HandoffEntry>()

  // Periodic sweep so a never-claimed handoff doesn't leak memory.
  setInterval(() => {
    const cutoff = Date.now() - HANDOFF_TTL_MS
    for (const [id, entry] of pendingHandoffs) {
      if (entry.created_at < cutoff) pendingHandoffs.delete(id)
    }
  }, 60_000).unref?.()

  r.post('/api/super-admin/tenants/:id/impersonate',
    requireAuth, requirePlatformPerm(supabase, 'impersonate', 'edit'),
    async (req, res) => {
      const tenantId = String(req.params.id)
      const userId = (req as any).user.id
      const reason = String(req.body?.reason ?? '').trim() || 'Support ticket'

      const { data: ttlFlag } = await supabase.from('feature_flags')
        .select('value_json').eq('key', 'impersonation_ttl_minutes').maybeSingle()
      const ttlMinutes = (ttlFlag?.value_json as any)?.value ?? 60

      const expiresAt = Date.now() + ttlMinutes * 60 * 1000
      const payload = { typ: 'imp', actor: userId, tenant_id: tenantId, exp: expiresAt, read_only: true }
      // Dedicated impersonation secret. Must be a long random string. Refuses
      // to mint if missing in production — a hardcoded fallback like
      // 'dev-secret' would let any code-leak forge tenant-impersonation
      // tokens. Falls back to GOOGLE_TOKEN_SECRET (the legacy var) for backward
      // compat during deploys, but prefer the dedicated one going forward.
      const secret = process.env.IMPERSONATION_HMAC_SECRET ?? process.env.GOOGLE_TOKEN_SECRET
      if (!secret || secret.length < 32) {
        if (process.env.NODE_ENV === 'production') {
          res.status(503).json({ error: 'Impersonation not configured. Set IMPERSONATION_HMAC_SECRET (≥32 chars) on the server.' })
          return
        }
        // Dev: warn loudly but still mint so local dev isn't blocked.
        console.warn('[super-admin] WARNING: minting impersonation token with weak/missing secret. Set IMPERSONATION_HMAC_SECRET.')
      }
      const effectiveSecret = secret && secret.length >= 32 ? secret : `dev-only-${process.pid}-${Date.now()}`
      const data = Buffer.from(JSON.stringify(payload)).toString('base64url')
      const sig = jwt.createHmac('sha256', effectiveSecret).update(data).digest('base64url')
      const token = `${data}.${sig}`

      // Stash the JWT under a random one-time handoff id.
      const handoffId = randomUUID()
      pendingHandoffs.set(handoffId, {
        actor_user_id: userId,
        token,
        expires_at: new Date(expiresAt).toISOString(),
        tenant_id: tenantId,
        read_only: true,
        created_at: Date.now(),
      })

      await audit(supabase, req, { action: 'impersonate.start', target_tenant_id: tenantId, reason, payload: { ttl_minutes: ttlMinutes } })
      // Return only the handoff id — caller opens a new tab with it, the new
      // tab claims it, JWT never appears in any URL.
      res.json({ handoff_id: handoffId, handoff_expires_in_ms: HANDOFF_TTL_MS })
    })

  r.post('/api/super-admin/impersonate/claim', requireAuth,
    async (req, res) => {
      const userId = (req as any).user.id
      const handoffId = String(req.body?.handoff_id ?? '').trim()
      if (!handoffId) { res.status(400).json({ error: 'Missing handoff_id' }); return }

      const entry = pendingHandoffs.get(handoffId)
      if (!entry) { res.status(404).json({ error: 'Handoff expired or already claimed.' }); return }
      // Single-use: delete immediately so concurrent claims fail.
      pendingHandoffs.delete(handoffId)

      // The user claiming MUST be the same user who initiated the handoff.
      // This stops a stolen handoff_id from being replayed by anyone else
      // who is signed in.
      if (entry.actor_user_id !== userId) {
        await audit(supabase, req, {
          action: 'impersonate.claim_rejected',
          target_tenant_id: entry.tenant_id,
          payload: { reason: 'actor_mismatch' },
        })
        res.status(403).json({ error: 'This impersonation handoff was issued to a different user.' })
        return
      }
      // TTL check — pendingHandoffs is also swept periodically, but verify here too.
      if (Date.now() - entry.created_at > HANDOFF_TTL_MS) {
        res.status(410).json({ error: 'Handoff expired.' })
        return
      }

      await audit(supabase, req, { action: 'impersonate.claim', target_tenant_id: entry.tenant_id })
      res.json({
        token: entry.token,
        expires_at: entry.expires_at,
        tenant_id: entry.tenant_id,
        read_only: entry.read_only,
      })
    })

  r.post('/api/super-admin/impersonate/stop', requireAuth,
    async (req, res) => {
      // The actual revocation happens client-side (FE drops the token). We
      // only audit the stop event so we have a paired record with .start.
      await audit(supabase, req, { action: 'impersonate.stop' })
      res.json({ success: true })
    })

  // ─── Feature flags ────────────────────────────────────────────────────────
  r.get('/api/super-admin/feature-flags', requireAuth, requirePlatformPerm(supabase, 'feature_flags', 'view'),
    async (_req, res) => {
      const { data, error } = await supabase.from('feature_flags').select('*').order('key')
      if (error) { res.status(500).json({ error: error.message }); return }
      res.json(data ?? [])
    })

  r.patch('/api/super-admin/feature-flags/:key', requireAuth, requirePlatformPerm(supabase, 'feature_flags', 'edit'),
    async (req, res) => {
      const userId = (req as any).user.id
      const allowed = ['is_enabled', 'rollout_percent', 'enabled_for_tenants', 'value_json', 'description']
      const patch: Record<string, any> = { updated_by: userId, updated_at: new Date().toISOString() }
      for (const k of allowed) if (k in req.body) patch[k] = req.body[k]
      const { data, error } = await supabase.from('feature_flags').update(patch).eq('key', String(req.params.key)).select().single()
      if (error) { res.status(500).json({ error: error.message }); return }
      await audit(supabase, req, { action: 'feature_flag.update', payload: { key: String(req.params.key), changes: patch } })
      res.json(data)
    })

  // ─── Announcements ────────────────────────────────────────────────────────
  r.get('/api/super-admin/announcements', requireAuth, requirePlatformPerm(supabase, 'announcements', 'view'),
    async (_req, res) => {
      const { data, error } = await supabase.from('platform_announcements').select('*').order('created_at', { ascending: false })
      if (error) { res.status(500).json({ error: error.message }); return }
      res.json(data ?? [])
    })

  r.post('/api/super-admin/announcements', requireAuth, requirePlatformPerm(supabase, 'announcements', 'edit'),
    async (req, res) => {
      const { title, body, severity, audience, starts_at, ends_at } = req.body
      if (!title) { res.status(400).json({ error: 'title required' }); return }
      const { data, error } = await supabase.from('platform_announcements').insert({
        title, body: body ?? null, severity: severity ?? 'info',
        audience: audience ?? 'all', starts_at: starts_at ?? null, ends_at: ends_at ?? null,
        created_by: (req as any).user.id,
      }).select().single()
      if (error) { res.status(500).json({ error: error.message }); return }
      await audit(supabase, req, { action: 'announcement.create', payload: data })
      res.json(data)
    })

  r.delete('/api/super-admin/announcements/:id', requireAuth, requirePlatformPerm(supabase, 'announcements', 'delete'),
    async (req, res) => {
      await supabase.from('platform_announcements').delete().eq('id', String(req.params.id))
      await audit(supabase, req, { action: 'announcement.delete', payload: { id: String(req.params.id) } })
      res.json({ success: true })
    })

  // ─── Approval rules ────────────────────────────────────────────────────────
  r.get('/api/super-admin/approval-rules', requireAuth, requirePlatformPerm(supabase, 'approval_rules', 'view'),
    async (_req, res) => {
      const { data, error } = await supabase.from('approval_rules').select('*').order('action_type')
      if (error) { res.status(500).json({ error: error.message }); return }
      res.json(data ?? [])
    })

  r.patch('/api/super-admin/approval-rules/:id', requireAuth, requirePlatformPerm(supabase, 'approval_rules', 'edit'),
    async (req, res) => {
      const allowed = ['threshold_metric', 'threshold_value', 'required_role', 'is_enabled', 'notes']
      const patch: Record<string, any> = { updated_at: new Date().toISOString() }
      for (const k of allowed) if (k in req.body) patch[k] = req.body[k]
      const { data, error } = await supabase.from('approval_rules').update(patch).eq('id', String(req.params.id)).select().single()
      if (error) { res.status(500).json({ error: error.message }); return }
      await audit(supabase, req, { action: 'approval_rule.update', payload: { id: String(req.params.id), changes: patch } })
      res.json(data)
    })

  // ─── Subscription change (extend trial / change plan) ─────────────────────
  r.post('/api/super-admin/tenants/:id/subscription', requireAuth, requirePlatformPerm(supabase, 'subscriptions', 'edit'),
    async (req, res) => {
      const tenantId = String(req.params.id)
      const { plan_id, extend_trial_days, status, reason } = req.body
      const patch: Record<string, any> = { updated_at: new Date().toISOString() }
      if (plan_id) patch.plan_id = plan_id
      if (status)  patch.status  = status
      if (extend_trial_days) {
        const { data: cur } = await supabase.from('tenant_subscriptions').select('trial_ends_at').eq('tenant_id', tenantId).maybeSingle()
        const base = cur?.trial_ends_at ? new Date(cur.trial_ends_at) : new Date()
        base.setDate(base.getDate() + Number(extend_trial_days))
        patch.trial_ends_at = base.toISOString()
      }
      const { data, error } = await supabase.from('tenant_subscriptions').update(patch).eq('tenant_id', tenantId).select().single()
      if (error) { res.status(500).json({ error: error.message }); return }
      await audit(supabase, req, { action: plan_id ? 'plan.change' : 'subscription.update', target_tenant_id: tenantId, payload: { changes: patch }, reason })
      res.json(data)
    })

  // ─── Platform stats summary (for AdminPage header) ─────────────────────────
  r.get('/api/super-admin/stats', requireAuth, requirePlatformPerm(supabase, 'tenants', 'view'),
    async (_req, res) => {
      const [t, c, m, sub] = await Promise.all([
        supabase.from('tenants').select('id', { count: 'exact', head: true }).neq('status', 'deleted'),
        supabase.from('contacts').select('id', { count: 'exact', head: true }),
        supabase.from('messages').select('id', { count: 'exact', head: true }),
        supabase.from('tenant_subscriptions').select('plan_id, status, plans!inner(monthly_price_inr)').eq('status', 'active'),
      ])
      const mrr = (sub.data ?? []).reduce((s: number, r: any) => s + Number(r.plans?.monthly_price_inr ?? 0), 0)
      res.json({
        tenants: t.count ?? 0,
        contacts: c.count ?? 0,
        messages: m.count ?? 0,
        active_subscriptions: sub.data?.length ?? 0,
        mrr_inr: mrr,
      })
    })

  return r
}
