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
import { sanitizeSearch } from '../lib/safe-key'

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
      // F6: sanitize search before .or() interpolation. See lib/safe-key.ts
      // for why — without this a hostile platform-user query string could
      // append PostgREST predicates and skew the tenants list.
      const safeSearch = sanitizeSearch(search)
      if (safeSearch) query = query.or(`business_name.ilike.%${safeSearch}%,display_phone.ilike.%${safeSearch}%,waba_id.ilike.%${safeSearch}%`)

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

  // ─── GET /api/super-admin/agencies ─────────────────────────────────────
  // Platform-team-facing listing of every agency on the platform. Differs
  // from /api/agencies/me (which filters to memberships) — super-admins
  // need to see ALL agencies for support / triage / abuse review.
  //
  // Returns one row per agency with:
  //   - identity (id, name, slug, owner_user_id, status)
  //   - sub_account_count (active sub-accounts only — soft-removed
  //     entries don't count toward the agency's footprint)
  //   - mrr_inr (sum of monthly_price_inr from active subs across all
  //     sub-account tenants) — used by the agency-tab MRR column
  //   - has_subscription (boolean — whether the agency itself pays a
  //     platform fee, distinct from sub-account billing)
  //
  // Pagination + search + status filter mirror /api/super-admin/tenants.
  r.get('/api/super-admin/agencies',
    requireAuth, requirePlatformPerm(supabase, 'tenants', 'view'),
    async (req, res) => {
      const page = Math.max(1, parseInt(String(req.query.page ?? '1'), 10) || 1)
      // Security audit P1: cap pageSize at 25 (was 100) so a single
      // request can't fan-out 100 parallel `auth.admin.getUserById`
      // calls — that path was both rate-limit-risky against the Supabase
      // Auth API and a PII-sweep amplifier for a compromised platform
      // token. 25 is the size used by Stripe Dashboard tables; matches
      // pagination UX expectations.
      const pageSize = Math.min(25, Math.max(1, parseInt(String(req.query.pageSize ?? '24'), 10) || 24))
      const offset = (page - 1) * pageSize
      const search = String(req.query.search ?? '').trim()
      const status = String(req.query.status ?? 'all')

      let q = supabase.from('agencies')
        .select('id, name, slug, owner_user_id, status, default_revshare_pct, agency_paid_by_default, created_at, plan_id, current_subscription_id', { count: 'exact' })
        .order('created_at', { ascending: false })
        .range(offset, offset + pageSize - 1)
      if (search)             q = q.ilike('name', `%${search}%`)
      if (status !== 'all')   q = q.eq('status', status)
      const { data: agencies, error, count } = await q
      if (error) { res.status(500).json({ error: error.message }); return }
      if (!agencies || agencies.length === 0) {
        res.json({ data: [], page, pageSize, total: count ?? 0, totalPages: Math.max(1, Math.ceil((count ?? 0) / pageSize)) }); return
      }

      // Sub-account count + MRR aggregation per agency. Two queries in
      // parallel against agency_sub_accounts → tenant_subscriptions →
      // plans. Best-effort: a failure here just leaves these columns at 0.
      const agencyIds = agencies.map(a => a.id)
      const { data: subAccounts } = await supabase.from('agency_sub_accounts')
        .select('agency_id, tenant_id, removed_at')
        .in('agency_id', agencyIds)
        .is('removed_at', null)
      const countByAgency: Record<string, number> = {}
      const tenantIdsByAgency: Record<string, string[]> = {}
      for (const sa of (subAccounts ?? []) as any[]) {
        countByAgency[sa.agency_id] = (countByAgency[sa.agency_id] ?? 0) + 1
        ;(tenantIdsByAgency[sa.agency_id] = tenantIdsByAgency[sa.agency_id] ?? []).push(sa.tenant_id)
      }
      const allTenantIds = Object.values(tenantIdsByAgency).flat()
      const mrrByAgency: Record<string, number> = {}
      if (allTenantIds.length > 0) {
        const { data: subs } = await supabase.from('tenant_subscriptions')
          .select('tenant_id, status, plans!inner(monthly_price_inr)')
          .in('tenant_id', allTenantIds)
          .eq('status', 'active')
        const mrrByTenant: Record<string, number> = {}
        for (const s of (subs ?? []) as any[]) {
          const p = Array.isArray(s.plans) ? s.plans[0] : s.plans
          mrrByTenant[s.tenant_id] = Number(p?.monthly_price_inr ?? 0)
        }
        for (const [agencyId, tIds] of Object.entries(tenantIdsByAgency)) {
          mrrByAgency[agencyId] = tIds.reduce((sum, tid) => sum + (mrrByTenant[tid] ?? 0), 0)
        }
      }

      // Resolve owner email per agency for support contact use. One
      // auth.admin.getUserById call per unique owner.
      const ownerIds = Array.from(new Set(agencies.map(a => a.owner_user_id).filter(Boolean) as string[]))
      const emailByOwner: Record<string, string> = {}
      if (ownerIds.length > 0) {
        const lookups = await Promise.all(ownerIds.map(uid => supabase.auth.admin.getUserById(uid).catch(() => null)))
        for (let i = 0; i < ownerIds.length; i++) {
          const e = lookups[i]?.data?.user?.email
          if (e) emailByOwner[ownerIds[i]] = e
        }
      }

      const enriched = agencies.map(a => ({
        ...a,
        sub_account_count: countByAgency[a.id] ?? 0,
        mrr_inr:           mrrByAgency[a.id] ?? 0,
        has_subscription:  !!a.current_subscription_id,
        owner_email:       a.owner_user_id ? (emailByOwner[a.owner_user_id] ?? null) : null,
      }))
      res.json({
        data: enriched,
        page, pageSize,
        total: count ?? 0,
        totalPages: Math.max(1, Math.ceil((count ?? 0) / pageSize)),
      })
    })

  // ─── GET /api/super-admin/agencies/:id ─────────────────────────────────
  // Single-agency lookup for super-admins. Bypasses the agency_members
  // gate that /api/agencies/:id enforces — used so a super-admin can
  // open an agency console (/agency/:slug) for support purposes even
  // though they aren't a member of the agency.
  r.get('/api/super-admin/agencies/:id',
    requireAuth, requirePlatformPerm(supabase, 'tenants', 'view'),
    async (req, res) => {
      const agencyId = String(req.params.id)
      const { data, error } = await supabase.from('agencies').select('*').eq('id', agencyId).maybeSingle()
      if (error) { res.status(500).json({ error: error.message }); return }
      if (!data) { res.status(404).json({ error: 'not found' }); return }
      res.json({ agency: data })
    })

  // ─── GET /api/super-admin/agencies/by-slug/:slug ────────────────────────
  // Slug-based variant — AgencyShell resolves the URL's :slug to an
  // agency without first calling /api/agencies/me (which would 403
  // a super-admin who isn't a member).
  r.get('/api/super-admin/agencies/by-slug/:slug',
    requireAuth, requirePlatformPerm(supabase, 'tenants', 'view'),
    async (req, res) => {
      // Security audit P2: validate the slug against the same regex used
      // at creation BEFORE hitting the DB. Without this, an over-sized
      // attacker-controlled string is forwarded through PostgREST as a
      // parameter — parameterized so not injectable, but still a
      // probing surface. Reject malformed slugs at the edge.
      const slug = String(req.params.slug)
      if (!/^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/.test(slug)) {
        res.status(400).json({ error: 'invalid slug format' }); return
      }
      const { data, error } = await supabase.from('agencies').select('*').eq('slug', slug).maybeSingle()
      if (error) { res.status(500).json({ error: error.message }); return }
      if (!data) { res.status(404).json({ error: 'not found' }); return }
      res.json({ agency: data })
    })

  // ─── GET /api/super-admin/recent-signups ───────────────────────────────
  // Returns the last N (default 10) tenant + agency signups across the
  // platform, sorted newest-first. Drives the "Recent signups" feed on
  // the platform dashboard so the platform team can spot anomalies (e.g.
  // a sudden burst of fake signups) or celebrate wins.
  //
  // Reuses the 'tenants:view' perm — anyone with visibility into the
  // tenant list also gets the signups feed.
  r.get('/api/super-admin/recent-signups',
    requireAuth, requirePlatformPerm(supabase, 'tenants', 'view'),
    async (req, res) => {
      const limit = Math.min(50, Math.max(1, parseInt(String(req.query.limit ?? '10'), 10) || 10))
      const [t, a] = await Promise.all([
        supabase.from('tenants')
          .select('id, business_name, slug, created_at, status')
          .order('created_at', { ascending: false })
          .limit(limit),
        supabase.from('agencies')
          .select('id, name, slug, created_at, status')
          .order('created_at', { ascending: false })
          .limit(limit),
      ])
      // Merge + sort by created_at; cap to limit. Tag each row with kind
      // so the FE can render a different icon/color per type.
      const tenants = (t.data ?? []).map(r => ({ kind: 'tenant' as const, id: r.id, name: r.business_name, slug: r.slug, created_at: r.created_at, status: r.status }))
      const agencies = (a.data ?? []).map(r => ({ kind: 'agency' as const, id: r.id, name: r.name, slug: r.slug, created_at: r.created_at, status: r.status }))
      const merged = [...tenants, ...agencies]
        .sort((x, y) => new Date(y.created_at).getTime() - new Date(x.created_at).getTime())
        .slice(0, limit)
      res.json({ signups: merged })
    })

  // ─── GET /api/super-admin/mrr-trend ────────────────────────────────────
  // Returns daily MRR snapshots for the last N days (default 30). Approach:
  // for each day, sum monthly_price_inr from tenant_subscriptions that were
  // ACTIVE on that day (i.e. created on/before AND not yet cancelled). This
  // is an approximation — true MRR-on-date would require a snapshot table
  // we don't keep yet — but matches the spirit of "is platform revenue
  // growing?" for the dashboard chart.
  //
  // Single round-trip: pull all tenant_subscriptions with their created_at
  // + cancelled_at + plan price, then compute the daily series in memory.
  // For <50k subs this is fine; beyond that we'd materialize a daily
  // snapshot table (TODO when we hit that scale).
  r.get('/api/super-admin/mrr-trend',
    requireAuth, requirePlatformPerm(supabase, 'tenants', 'view'),
    async (req, res) => {
      const days = Math.min(90, Math.max(7, parseInt(String(req.query.days ?? '30'), 10) || 30))
      // Security audit P1: previously this fetched the FULL
      // tenant_subscriptions table on every request — fine at <5k subs
      // but linearly degrades. Pre-filter to subs that COULD have been
      // active during the window: created on/before the window's end,
      // and not cancelled before the window's start.
      const now = new Date()
      const windowStart = new Date(now.getFullYear(), now.getMonth(), now.getDate() - (days - 1))
      const windowEnd   = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999)
      const windowStartIso = windowStart.toISOString()
      const windowEndIso   = windowEnd.toISOString()
      const { data: subs, error: subErr } = await supabase.from('tenant_subscriptions')
        .select('created_at, cancelled_at, status, plans!inner(monthly_price_inr)')
        .lte('created_at', windowEndIso)
        .or(`cancelled_at.is.null,cancelled_at.gte.${windowStartIso}`)
        .limit(50000) // hard ceiling — defends against runaway tenant-subs growth
      if (subErr) { res.status(500).json({ error: subErr.message }); return }
      if (!subs) { res.json({ trend: [] }); return }
      // Log row count so ops can spot the cliff before users feel it.
      // Once subs > 20k start materializing a daily-snapshot table.
      console.log(`[mrr-trend] window=${days}d subs=${subs.length}`)

      // Walk each day in the window and sum the price of every sub that
      // was active on that day. "Active on day D" = created_at <= D AND
      // (cancelled_at IS NULL OR cancelled_at > D). `now` is already
      // computed above (line 790-ish) for the window boundaries.
      const trend: Array<{ date: string; mrr_inr: number }> = []
      for (let i = days - 1; i >= 0; i--) {
        const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i)
        const dayEnd = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59, 999)
        const dayEndIso = dayEnd.toISOString()
        let sum = 0
        for (const s of subs as any[]) {
          if (s.created_at && s.created_at <= dayEndIso) {
            const cancelled = s.cancelled_at
            if (!cancelled || cancelled > dayEndIso) {
              const p = Array.isArray(s.plans) ? s.plans[0] : s.plans
              sum += Number(p?.monthly_price_inr ?? 0)
            }
          }
        }
        trend.push({
          date: d.toISOString().slice(0, 10), // YYYY-MM-DD
          mrr_inr: sum,
        })
      }
      res.json({ trend })
    })

  // ─── Webhook dead-letter (migration 064) ─────────────────────────────────
  // Permanent failures from webhook.inbound + webhook.outbound queues. The
  // worker writes one row here when a job exhausts all 5 retries
  // (workers/webhook-retry.ts). This endpoint powers the super-admin
  // "Webhook failures" view + the per-row replay button.
  //
  // Reuses the same 'audit' platform feature key — anyone allowed to read
  // the platform audit log can read webhook failures (they're operationally
  // similar: "what went wrong in our infra").
  r.get('/api/super-admin/webhook-failures',
    requireAuth, requirePlatformPerm(supabase, 'audit', 'view'),
    async (req, res) => {
      const { source, direction, tenant_id, replayed, page = '1', pageSize = '50' } = req.query as Record<string, string>
      const p = Math.max(1, parseInt(page, 10) || 1)
      const ps = Math.min(200, Math.max(1, parseInt(pageSize, 10) || 50))
      const offset = (p - 1) * ps

      let q = supabase.from('webhook_dead_letter')
        .select('id, tenant_id, source, direction, attempts, last_error, created_at, replayed_at, replayed_by, replay_count',
                { count: 'exact' })
        .order('created_at', { ascending: false })
        .range(offset, offset + ps - 1)
      if (source)    q = q.eq('source', source)
      if (direction) q = q.eq('direction', direction)
      if (tenant_id) q = q.eq('tenant_id', tenant_id)
      if (replayed === 'true')  q = q.not('replayed_at', 'is', null)
      if (replayed === 'false') q = q.is('replayed_at', null)

      const { data, error, count } = await q
      if (error) { res.status(500).json({ error: error.message }); return }
      res.json({
        data: data ?? [],
        total: count ?? 0,
        page: p, pageSize: ps,
        totalPages: Math.max(1, Math.ceil((count ?? 0) / ps)),
      })
    })

  // Fetch one row including the full payload (only revealed on demand to
  // keep list responses cheap and avoid logging payloads in normal browse).
  r.get('/api/super-admin/webhook-failures/:id',
    requireAuth, requirePlatformPerm(supabase, 'audit', 'view'),
    async (req, res) => {
      const { data, error } = await supabase.from('webhook_dead_letter')
        .select('*').eq('id', String(req.params.id)).maybeSingle()
      if (error) { res.status(500).json({ error: error.message }); return }
      if (!data)  { res.status(404).json({ error: 'not_found' }); return }
      res.json(data)
    })

  // Replay — re-enqueue the original payload onto the matching queue. The
  // worker sees `isReplay=true` so it skips the stale-job guard. We do NOT
  // delete the row on replay; we bump replay_count and stamp replayed_at +
  // replayed_by so the audit trail survives.
  r.post('/api/super-admin/webhook-failures/:id/replay',
    requireAuth, requirePlatformPerm(supabase, 'audit', 'edit'),
    async (req, res) => {
      const id = String(req.params.id)
      const { data: row, error } = await supabase.from('webhook_dead_letter')
        .select('*').eq('id', id).maybeSingle()
      if (error) { res.status(500).json({ error: error.message }); return }
      if (!row)  { res.status(404).json({ error: 'not_found' }); return }

      try {
        const { enqueueWebhookInbound, enqueueWebhookOutbound } = await import('../queue')
        if (row.direction === 'inbound') {
          const payload = { ...(row.payload as any), isReplay: true, receivedAt: new Date().toISOString() }
          await enqueueWebhookInbound(payload)
        } else if (row.direction === 'outbound') {
          const payload = { ...(row.payload as any), isReplay: true }
          await enqueueWebhookOutbound(payload)
        } else {
          res.status(400).json({ error: `unknown direction: ${row.direction}` }); return
        }
      } catch (e: any) {
        res.status(503).json({ error: `enqueue failed: ${e?.message ?? e}` }); return
      }

      const user = (req as any).user
      await supabase.from('webhook_dead_letter').update({
        replayed_at:  new Date().toISOString(),
        replayed_by:  user?.id ?? null,
        replay_count: (row.replay_count ?? 0) + 1,
      }).eq('id', id)

      await audit(supabase, req, {
        action: 'webhook_failures.replay',
        payload: { id, source: row.source, direction: row.direction, tenant_id: row.tenant_id },
        target_tenant_id: row.tenant_id,
      })

      res.json({ ok: true, replayed: id })
    })

  // ── Governance audit (Phase 4 v1.3) ──────────────────────────────────
  //
  // Read-only cross-tenant view of commerce_governance_actions for
  // compliance audit. Filters: status, action_type, tenant_id (optional),
  // date range. Joined with tenants + agency_sub_accounts so the FE can
  // render "which workspace", "linked to which agency", "current
  // approval mode" without round-tripping.
  //
  // We DELIBERATELY don't expose write actions here. Super-admins
  // approving on behalf of a tenant would defeat the two-person rule.
  // If a tenant + their agency are both stuck, the right path is to
  // help them resolve it inside one of their consoles — not to
  // shortcut from the platform.
  r.get('/api/super-admin/governance/actions',
    requireAuth, requirePlatformPerm(supabase, 'audit', 'view'),
    async (req, res) => {
      const status      = req.query.status      ? String(req.query.status)      : null
      const actionType  = req.query.action_type ? String(req.query.action_type) : null
      const tenantId    = req.query.tenant_id   ? String(req.query.tenant_id)   : null
      const limit       = Math.min(parseInt(String(req.query.limit ?? '200'), 10) || 200, 1000)
      let q = supabase.from('commerce_governance_actions')
        .select('*, tenants:tenant_id(id, business_name, slug)')
        .order('created_at', { ascending: false })
        .limit(limit)
      if (status)     q = q.eq('status', status)
      if (actionType) q = q.eq('action_type', actionType)
      if (tenantId)   q = q.eq('tenant_id', tenantId)
      const { data, error } = await q
      if (error) { res.status(500).json({ error: error.message }); return }
      res.json({ data: data ?? [] })
    })

  // Aggregate counts for the audit dashboard hero strip.
  r.get('/api/super-admin/governance/summary',
    requireAuth, requirePlatformPerm(supabase, 'audit', 'view'),
    async (_req, res) => {
      const statuses = ['pending', 'applied', 'rejected', 'expired', 'failed'] as const
      const out: Record<string, number> = {}
      // One head-count query per status. Five small queries is fine here;
      // the result feeds a hero strip on a low-frequency page.
      for (const s of statuses) {
        const { count } = await supabase.from('commerce_governance_actions')
          .select('id', { count: 'exact', head: true })
          .eq('status', s)
        out[s] = count ?? 0
      }
      res.json({ data: out })
    })

  return r
}
