/**
 * Naruto Platform OS §3 — plans, tiers & limits API.
 *
 * Mounted at root; each route declares its own /api/naruto/* path (mirrors
 * naruto-tenants.ts). Guarded by `requirePlatformCapability` + audited via
 * `recordPlatformAudit` (Part I §1). EXTENDS the existing plan rails — the
 * legacy /api/super-admin/plans editor stays; this adds the two-axis matrix,
 * first-class limits, versioning, the downgrade guard and trial controls.
 *
 *   GET   /api/naruto/plans/matrix                 two-axis matrix + limit defs   (plan.read)
 *   PATCH /api/naruto/plans/:id                    versioned pricing/limits edit  (plan.pricing.write)
 *   GET   /api/naruto/tenants/:id/limits           effective caps + usage         (tenant.read)
 *   PUT   /api/naruto/tenants/:id/limits           per-tenant soft/hard overrides (plan.pricing.write)
 *   GET   /api/naruto/tenants/:id/plan/preview     downgrade impact               (plan.read)
 *   POST  /api/naruto/tenants/:id/plan             change plan / migrate version  (plan.assign.write)
 *   POST  /api/naruto/tenants/:id/trial            set / extend trial             (plan.assign.write)
 */

import express from 'express'
import { z } from 'zod'
import type { SupabaseClient } from '@supabase/supabase-js'
import { requirePlatformCapability } from '../lib/platform-guard'
import { recordPlatformAudit } from '../lib/platform-audit'
import {
  loadLimitDefs, resolveTenantLimits, computeDowngradeImpact,
  loadLivePlanDef, resolvePinnedPlanDef,
} from '../lib/plan-limits'

type Middleware = (req: express.Request, res: express.Response, next: express.NextFunction) => void | Promise<void>
interface Deps { supabase: SupabaseClient; requireAuth: Middleware }

const TIER_ORDER = ['free', 'starter', 'growth', 'scale', 'enterprise'] as const
const VERTICALS = ['*', 'horeca', 'salon', 'real_estate', 'd2c', 'other'] as const

// ─── Schemas ──────────────────────────────────────────────────────────────────
const capMap = z.record(z.string(), z.number().int()) // { metric: n } · -1 unlimited · 0 blocked

const PricingSchema = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  monthly_price_inr: z.number().optional(),
  trial_days: z.number().int().min(0).max(365).optional(),
  trial_expiry_behavior: z.enum(['downgrade', 'suspend']).optional(),
  limits: capMap.optional(),        // HARD caps (enforced)
  soft_limits: capMap.optional(),   // WARN caps
  features: z.array(z.string()).optional(),
  reason: z.string().trim().max(400).optional(),
}).refine(o => Object.keys(o).some(k => k !== 'reason'), { message: 'no changes' })

const OverridesSchema = z.object({
  overrides: z.array(z.object({
    key: z.string().trim().min(1).max(64),
    soft_cap: z.number().int().nullable().optional(),
    hard_cap: z.number().int().nullable().optional(),
  })).max(50),
  reason: z.string().trim().max(400).optional(),
})

const PlanChangeSchema = z.object({
  planId: z.string().trim().min(1).max(64),
  version: z.number().int().optional(),
  force: z.boolean().optional(),
  reason: z.string().trim().max(400).optional(),
})

const TrialSchema = z.object({
  extendDays: z.number().int().min(1).max(365).optional(),
  trialDays: z.number().int().min(0).max(365).optional(),
  reason: z.string().trim().max(400).optional(),
}).refine(o => o.extendDays != null || o.trialDays != null, { message: 'extendDays or trialDays required' })

export function createNarutoPlansRouter(deps: Deps): express.Router {
  const r = express.Router()
  const { supabase, requireAuth } = deps

  // ─── Two-axis matrix (rows = vertical × cols = tier) + the limit catalogue ────
  r.get('/api/naruto/plans/matrix',
    requireAuth, requirePlatformCapability(supabase, 'plan.read'),
    async (_req, res) => {
      const [{ data: plans }, defs] = await Promise.all([
        supabase.from('plans').select('*').eq('scope', 'tenant').order('sort_order'),
        loadLimitDefs(supabase),
      ])
      // cells[vertical][tier] = compact plan summary (or absent = not offered).
      const cells: Record<string, Record<string, any>> = {}
      for (const p of (plans ?? []) as any[]) {
        const vert = p.vertical ?? '*'
        const tier = p.tier ?? p.id
        ;(cells[vert] ??= {})[tier] = {
          id: p.id, name: p.name, vertical: vert, tier, version: p.version ?? 1,
          monthly_price_inr: Number(p.monthly_price_inr ?? 0),
          trial_days: p.trial_days ?? 0,
          trial_expiry_behavior: p.trial_expiry_behavior ?? 'downgrade',
          features: p.features ?? [], limits: p.limits ?? {}, soft_limits: p.soft_limits ?? {},
          is_active: p.is_active !== false,
        }
      }
      res.json({ tiers: TIER_ORDER, verticals: VERTICALS, cells, limitDefs: defs })
    })

  // ─── Versioned pricing/limits edit. NEVER silently mutates a live def: it
  //     snapshots the current version into plan_versions, THEN bumps + applies. ─
  r.patch('/api/naruto/plans/:id',
    requireAuth, requirePlatformCapability(supabase, 'plan.pricing.write'),
    async (req, res) => {
      const parsed = PricingSchema.safeParse(req.body ?? {})
      if (!parsed.success) { res.status(400).json({ error: 'Invalid input', details: parsed.error.flatten() }); return }
      const id = String(req.params.id)
      const before = await loadLivePlanDef(supabase, id)
      if (!before) { res.status(404).json({ error: 'Plan not found' }); return }

      // 1. Archive the current (soon-to-be-superseded) version — idempotent.
      const { error: snapErr } = await supabase.from('plan_versions').upsert({
        plan_id: id, version: before.version, name: before.name,
        monthly_price_inr: before.monthly_price_inr, features: before.features,
        limits: before.limits, soft_limits: before.soft_limits, trial_days: before.trial_days,
        snapshot_by: (req as any).user?.id ?? null,
      }, { onConflict: 'plan_id,version' })
      if (snapErr) { res.status(500).json({ error: `snapshot failed: ${snapErr.message}` }); return }

      // 2. Bump + apply.
      const patch: Record<string, unknown> = { version: before.version + 1, updated_at: new Date().toISOString() }
      const b = parsed.data
      if (b.name !== undefined) patch.name = b.name
      if (b.monthly_price_inr !== undefined) patch.monthly_price_inr = b.monthly_price_inr
      if (b.trial_days !== undefined) patch.trial_days = b.trial_days
      if (b.trial_expiry_behavior !== undefined) patch.trial_expiry_behavior = b.trial_expiry_behavior
      if (b.limits !== undefined) patch.limits = b.limits
      if (b.soft_limits !== undefined) patch.soft_limits = b.soft_limits
      if (b.features !== undefined) patch.features = b.features

      const { data: after, error } = await supabase.from('plans').update(patch).eq('id', id).select().single()
      if (error) { res.status(500).json({ error: error.message }); return }

      await recordPlatformAudit(supabase, req, {
        capability: 'plan.pricing.write', action: 'plan.version.bump', tenant_id: null,
        before: { version: before.version, price: before.monthly_price_inr, limits: before.limits, soft_limits: before.soft_limits },
        after: { version: (after as any).version, price: (after as any).monthly_price_inr, limits: (after as any).limits, soft_limits: (after as any).soft_limits },
        reason: b.reason ?? null,
      })
      res.json({ plan: after, previous_version: before.version })
    })

  // ─── Effective caps + live usage for a tenant ─────────────────────────────────
  r.get('/api/naruto/tenants/:id/limits',
    requireAuth, requirePlatformCapability(supabase, 'tenant.read'),
    async (req, res) => {
      res.json(await resolveTenantLimits(supabase, String(req.params.id)))
    })

  // ─── Per-tenant soft/hard overrides. Hard caps are mirrored into the existing
  //     tenant_entitlements.quota_override so live enforcement honours them. ─────
  r.put('/api/naruto/tenants/:id/limits',
    requireAuth, requirePlatformCapability(supabase, 'plan.pricing.write'),
    async (req, res) => {
      const parsed = OverridesSchema.safeParse(req.body ?? {})
      if (!parsed.success) { res.status(400).json({ error: 'Invalid input', details: parsed.error.flatten() }); return }
      const tenantId = String(req.params.id)
      const before = await resolveTenantLimits(supabase, tenantId)

      for (const o of parsed.data.overrides) {
        // null soft AND null hard = clear the override row.
        if (o.soft_cap == null && o.hard_cap == null) {
          await supabase.from('tenant_limit_overrides').delete().eq('tenant_id', tenantId).eq('limit_key', o.key)
          continue
        }
        const { error } = await supabase.from('tenant_limit_overrides').upsert({
          tenant_id: tenantId, limit_key: o.key,
          soft_cap: o.soft_cap ?? null, hard_cap: o.hard_cap ?? null,
          reason: parsed.data.reason ?? null, set_by: (req as any).user?.id ?? null,
          updated_at: new Date().toISOString(),
        }, { onConflict: 'tenant_id,limit_key' })
        if (error) { res.status(500).json({ error: error.message }); return }
      }

      // Mirror all HARD overrides into a sentinel tenant_entitlements row so
      // lib/limits.resolveLimit (the enforced path) picks them up with no fork.
      await mirrorHardOverrides(supabase, tenantId)

      const after = await resolveTenantLimits(supabase, tenantId)
      await recordPlatformAudit(supabase, req, {
        capability: 'plan.pricing.write', action: 'tenant.limit.override', tenant_id: tenantId,
        before: Object.fromEntries(before.limits.filter(l => l.overridden).map(l => [l.key, { soft: l.soft, hard: l.hard }])),
        after: Object.fromEntries(after.limits.filter(l => l.overridden).map(l => [l.key, { soft: l.soft, hard: l.hard }])),
        reason: parsed.data.reason ?? null,
      })
      res.json(after)
    })

  // ─── Downgrade preview — what a plan change breaks (feeds the DiffConfirm) ─────
  r.get('/api/naruto/tenants/:id/plan/preview',
    requireAuth, requirePlatformCapability(supabase, 'plan.read'),
    async (req, res) => {
      const planId = String(req.query.planId ?? '')
      if (!planId) { res.status(400).json({ error: 'planId required' }); return }
      const version = req.query.version ? Number(req.query.version) : undefined
      const impact = await computeDowngradeImpact(supabase, String(req.params.id), planId, version)
      if (!impact) { res.status(404).json({ error: 'Target plan not found' }); return }
      res.json(impact)
    })

  // ─── Change plan / migrate version. Blocks a downgrade that violates a HARD
  //     limit unless the operator force-resolves with a reason. ────────────────
  r.post('/api/naruto/tenants/:id/plan',
    requireAuth, requirePlatformCapability(supabase, 'plan.assign.write'),
    async (req, res) => {
      const parsed = PlanChangeSchema.safeParse(req.body ?? {})
      if (!parsed.success) { res.status(400).json({ error: 'Invalid input', details: parsed.error.flatten() }); return }
      const tenantId = String(req.params.id)
      const { planId, version, force, reason } = parsed.data

      const target = await resolvePinnedPlanDef(supabase, planId, version ?? null)
      if (!target) { res.status(404).json({ error: 'Target plan not found' }); return }

      const impact = await computeDowngradeImpact(supabase, tenantId, planId, version)
      if (impact?.blocking && !force) {
        res.status(409).json({
          error: 'Downgrade blocked — active usage exceeds the target plan limits',
          code: 'downgrade_blocked', ...impact,
        }); return
      }
      if (impact?.blocking && force && !reason) {
        res.status(400).json({ error: 'A reason is required to force-resolve a blocked downgrade' }); return
      }

      const { data: before } = await supabase.from('tenant_subscriptions')
        .select('plan_id, plan_version, status').eq('tenant_id', tenantId).maybeSingle()

      const { data: after, error } = await supabase.from('tenant_subscriptions').upsert({
        tenant_id: tenantId, plan_id: planId, plan_version: target.version,
        status: 'active', updated_at: new Date().toISOString(),
      }, { onConflict: 'tenant_id' }).select().single()
      if (error) { res.status(500).json({ error: error.message }); return }

      // Overrides mirror + plan-cache bust so enforcement reflects the new plan.
      await mirrorHardOverrides(supabase, tenantId)
      try { (await import('../lib/quota')).invalidatePlanCache(tenantId) } catch { /* worker-only */ }

      await recordPlatformAudit(supabase, req, {
        capability: 'plan.assign.write', action: force ? 'tenant.plan.change.forced' : 'tenant.plan.change',
        tenant_id: tenantId,
        before: { plan_id: (before as any)?.plan_id ?? null, version: (before as any)?.plan_version ?? null },
        after: { plan_id: planId, version: target.version, removed_features: impact?.removedFeatures ?? [], forced_violations: force ? impact?.violations ?? [] : [] },
        reason: reason ?? null, break_glass: !!(impact?.blocking && force),
      })
      res.json({ subscription: after, impact })
    })

  // ─── Trials: set or extend. length = trial_days on the plan; here we set the
  //     tenant's trial window + status. Expiry BEHAVIOUR is per-plan (applied by
  //     applyTrialExpiries, wired into the daily scheduler). ────────────────────
  r.post('/api/naruto/tenants/:id/trial',
    requireAuth, requirePlatformCapability(supabase, 'plan.assign.write'),
    async (req, res) => {
      const parsed = TrialSchema.safeParse(req.body ?? {})
      if (!parsed.success) { res.status(400).json({ error: 'Invalid input', details: parsed.error.flatten() }); return }
      const tenantId = String(req.params.id)
      const { data: cur } = await supabase.from('tenant_subscriptions')
        .select('trial_ends_at, status').eq('tenant_id', tenantId).maybeSingle()

      const base = parsed.data.extendDays != null && cur?.trial_ends_at
        ? new Date(cur.trial_ends_at) : new Date()
      const addDays = parsed.data.extendDays ?? parsed.data.trialDays ?? 0
      base.setDate(base.getDate() + addDays)
      const newEnds = base.toISOString()

      const { data: after, error } = await supabase.from('tenant_subscriptions').update({
        status: 'trial', trial_ends_at: newEnds, updated_at: new Date().toISOString(),
      }).eq('tenant_id', tenantId).select().single()
      if (error) { res.status(500).json({ error: error.message }); return }

      await recordPlatformAudit(supabase, req, {
        capability: 'plan.assign.write', action: parsed.data.extendDays != null ? 'tenant.trial.extend' : 'tenant.trial.set',
        tenant_id: tenantId,
        before: { status: cur?.status ?? null, trial_ends_at: cur?.trial_ends_at ?? null },
        after: { status: 'trial', trial_ends_at: newEnds },
        reason: parsed.data.reason ?? null,
      })
      res.json({ subscription: after })
    })

  return r
}

/**
 * Mirror a tenant's HARD limit overrides into a sentinel tenant_entitlements row
 * so the enforced path (lib/limits.resolveLimit via loadQuotaOverride) honours
 * them without editing the enforcement code. Soft caps stay warn-only.
 */
async function mirrorHardOverrides(supabase: SupabaseClient, tenantId: string): Promise<void> {
  const { data: rows } = await supabase.from('tenant_limit_overrides')
    .select('limit_key, hard_cap').eq('tenant_id', tenantId).not('hard_cap', 'is', null)
  const quota: Record<string, number> = {}
  for (const r of (rows ?? []) as any[]) quota[r.limit_key] = Number(r.hard_cap)
  // Sentinel feature row — is_enabled true so it never gates a feature; only the
  // quota_override jsonb matters to loadQuotaOverride.
  await supabase.from('tenant_entitlements').upsert({
    tenant_id: tenantId, feature: '__limit_override__', is_enabled: true,
    quota_override: quota, granted_at: new Date().toISOString(),
  }, { onConflict: 'tenant_id,feature' })
}

/**
 * Apply trial expiries per each plan's trial_expiry_behavior. Called by the
 * daily scheduler (see WIRE note) — NOT a new worker. Downgrade → move to the
 * free plan (active); suspend → status 'suspended'. Idempotent: only touches
 * trials whose trial_ends_at has passed.
 */
export async function applyTrialExpiries(supabase: SupabaseClient): Promise<{ downgraded: number; suspended: number }> {
  const nowIso = new Date().toISOString()
  const { data: expired } = await supabase.from('tenant_subscriptions')
    .select('tenant_id, plan_id, plans ( trial_expiry_behavior )')
    .eq('status', 'trial').lte('trial_ends_at', nowIso)
  let downgraded = 0, suspended = 0
  const freeDef = await loadLivePlanDef(supabase, 'free')
  for (const s of (expired ?? []) as any[]) {
    const joined = Array.isArray(s.plans) ? s.plans[0] : s.plans
    const behavior = joined?.trial_expiry_behavior ?? 'downgrade'
    if (behavior === 'suspend') {
      await supabase.from('tenant_subscriptions').update({ status: 'suspended', updated_at: nowIso }).eq('tenant_id', s.tenant_id)
      suspended++
    } else {
      await supabase.from('tenant_subscriptions').update({
        plan_id: 'free', plan_version: freeDef?.version ?? 1, status: 'active', updated_at: nowIso,
      }).eq('tenant_id', s.tenant_id)
      downgraded++
    }
    try { (await import('../lib/quota')).invalidatePlanCache(s.tenant_id) } catch { /* worker-only */ }
  }
  return { downgraded, suspended }
}

// ─── WIRE(naruto) — mounting + trial-expiry scheduling ────────────────────────
// 1. Mount (flowgpt-server/src/index.ts, next to createNarutoTenantsRouter):
//        app.use(createNarutoPlansRouter({ supabase, requireAuth }))
//    (Router declares full /api/naruto/* paths → mount at root, no prefix.)
// 2. Trial expiry: call applyTrialExpiries(supabase) from the existing daily
//    scheduler that already runs trial-ending (src/workers/trial-ending.ts) —
//    e.g. schedule a sibling daily tick, or append the call at the end of that
//    worker's runTick. Do NOT add a new worker/queue (no idle-worker cost).
// 3. On plan.limits enforcement of grandfathered versions: lib/limits.ts +
//    lib/quota.ts still read the LIVE plans.limits (not the pinned snapshot).
//    Per-tenant hard overrides ARE honoured (mirrored into quota_override).
//    ponytail: version-pinned caps are honoured by the naruto reader + guard;
//    to also pin the hot enforcement path, resolvePinnedPlanDef would move into
//    checkLimit/resolvePlan. Deferred — edit is in a shared pre-wave file and
//    the common operator knob (per-tenant override) already enforces.
