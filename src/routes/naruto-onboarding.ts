/**
 * Naruto onboarding — assisted-wizard checklist + outlets (spec Part II §5/§6).
 *
 * Mounted under /api. Every route is platform-gated by a capability string and
 * every mutation is audited (before→after diff) via recordPlatformAudit — the
 * pattern the wave-1 platform-guard/platform-audit libs establish.
 *
 *   Reads   → 'tenant.read'          (all six platform roles have it)
 *   Writes  → 'onboarding.wizard.run' (owner, admin*, onboarding)
 *      * admin lacks it by the spec matrix; owner + onboarding drive the wizard.
 *
 * Endpoints:
 *   GET    /api/naruto/onboarding/:tenantId/checklist
 *          → { steps, percent, estMinutesRemaining, activation }
 *   PATCH  /api/naruto/onboarding/:tenantId/checklist/:step
 *          body { status, who_completed?, blocking_reason? } → upsert one step
 *   GET    /api/naruto/tenants/:tenantId/outlets
 *   POST   /api/naruto/tenants/:tenantId/outlets
 *   PATCH  /api/naruto/tenants/:tenantId/outlets/:id
 *   DELETE /api/naruto/tenants/:tenantId/outlets/:id
 *
 * WIRE(naruto) — REGISTRATION: this module is not yet mounted. In
 * flowgpt-server/src/index.ts, next to the other capability-gated routers
 * (near `app.use(createSuperAdminRouter({ supabase, requireAuth }))`), add:
 *
 *     import { createNarutoOnboardingRouter } from './routes/naruto-onboarding'
 *     app.use(createNarutoOnboardingRouter({ supabase, requireAuth }))
 *
 * No other wiring needed — the router carries its own capability guards.
 *
 * WIRE(naruto) — TENANT CREATE (Step 1): tenant provisioning is the lifecycle
 * agent's slice, NOT here. The FE wizard Step 1 POSTs to `/api/naruto/tenants`
 * (see src/lib/onboarding-checklist.ts::createTenant). When that endpoint lands,
 * it should — after inserting the tenant — seed this checklist with
 * { create: { status:'done', who_completed:'operator' } }. Until then Step 1
 * surfaces a clear "not wired yet" message instead of dead-ending.
 */

import express from 'express'
import { SupabaseClient } from '@supabase/supabase-js'
import { requirePlatformCapability } from '../lib/platform-guard'
import { recordPlatformAudit } from '../lib/platform-audit'
import {
  computeActivationScore, ONBOARDING_STEP_KEYS,
  type Checklist, type OnboardingStepKey, type StepStatus,
} from '../lib/activation-score'

type Middleware = (req: express.Request, res: express.Response, next: express.NextFunction) => void | Promise<void>

interface Deps {
  supabase: SupabaseClient
  requireAuth: Middleware
}

const STATUSES: StepStatus[] = ['not_started', 'in_progress', 'blocked', 'done']

/** Per-step time estimate (minutes) for "est. time remaining". Only steps that
 *  are not yet `done` are summed. Kept next to the step keys it maps. */
const STEP_MINUTES: Record<OnboardingStepKey, number> = {
  create: 5, outlets: 10, catalog: 30, storefront: 15,
  payments: 15, comms: 10, team: 10, test_golive: 10,
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const isUuid = (s: unknown): s is string => typeof s === 'string' && UUID_RE.test(s)

function derive(steps: Checklist) {
  const total = ONBOARDING_STEP_KEYS.length
  const done = ONBOARDING_STEP_KEYS.filter(k => steps[k]?.status === 'done').length
  const percent = Math.round((done / total) * 100)
  const estMinutesRemaining = ONBOARDING_STEP_KEYS
    .filter(k => steps[k]?.status !== 'done')
    .reduce((m, k) => m + STEP_MINUTES[k], 0)
  return { percent, estMinutesRemaining }
}

/** Load the checklist row (empty object if none yet — a tenant with no wizard
 *  activity is legitimately "all not_started", not an error). */
async function loadChecklist(supabase: SupabaseClient, tenantId: string): Promise<Checklist> {
  const { data } = await supabase.from('tenant_onboarding_checklists')
    .select('steps').eq('tenant_id', tenantId).maybeSingle()
  return (data?.steps as Checklist) ?? {}
}

/** Read order signals from the instrumentation tables (real data, no fixtures):
 *  first_order activation event + week-1 order volume from the GMV rollup. */
async function loadSignals(supabase: SupabaseClient, tenantId: string) {
  const { data: ev } = await supabase.from('activation_events')
    .select('occurred_at').eq('tenant_id', tenantId).eq('step', 'first_order').maybeSingle()
  const firstOrderAt = (ev?.occurred_at as string | undefined) ?? null
  if (!firstOrderAt) return { firstOrderAt: null, ordersWeek1: 0 }

  const weekEnd = new Date(new Date(firstOrderAt).getTime() + 7 * 864e5).toISOString().slice(0, 10)
  const { data: gmv } = await supabase.from('platform_gmv_daily')
    .select('order_count, gmv_date')
    .eq('tenant_id', tenantId)
    .gte('gmv_date', firstOrderAt.slice(0, 10))
    .lte('gmv_date', weekEnd)
  const ordersWeek1 = (gmv ?? []).reduce((n, r: any) => n + (r.order_count ?? 0), 0)
  return { firstOrderAt, ordersWeek1 }
}

export function createNarutoOnboardingRouter(deps: Deps): express.Router {
  const r = express.Router()
  const { supabase, requireAuth } = deps
  const canRead = requirePlatformCapability(supabase, 'tenant.read')
  const canRun = requirePlatformCapability(supabase, 'onboarding.wizard.run')

  // ─── Checklist ─────────────────────────────────────────────────────────────
  r.get('/api/naruto/onboarding/:tenantId/checklist', requireAuth, canRead, async (req, res) => {
    const { tenantId } = req.params
    if (!isUuid(tenantId)) { res.status(400).json({ error: 'bad tenant id' }); return }
    const steps = await loadChecklist(supabase, tenantId)
    const signals = await loadSignals(supabase, tenantId)
    res.json({ steps, ...derive(steps), activation: computeActivationScore(steps, signals) })
  })

  r.patch('/api/naruto/onboarding/:tenantId/checklist/:step', requireAuth, canRun, async (req, res) => {
    const { tenantId, step } = req.params
    if (!isUuid(tenantId)) { res.status(400).json({ error: 'bad tenant id' }); return }
    if (!ONBOARDING_STEP_KEYS.includes(step as OnboardingStepKey)) {
      res.status(400).json({ error: 'unknown step' }); return
    }
    const { status, who_completed, blocking_reason } = req.body ?? {}
    if (!STATUSES.includes(status)) { res.status(400).json({ error: 'bad status' }); return }
    if (who_completed && who_completed !== 'operator' && who_completed !== 'merchant') {
      res.status(400).json({ error: 'bad who_completed' }); return
    }
    if (blocking_reason != null && (typeof blocking_reason !== 'string' || blocking_reason.length > 500)) {
      res.status(400).json({ error: 'bad blocking_reason' }); return
    }
    // A 'blocked' step must name what's missing — never a silent dead-end (§5).
    if (status === 'blocked' && !(blocking_reason && blocking_reason.trim())) {
      res.status(400).json({ error: 'blocked steps require a blocking_reason' }); return
    }

    const before = await loadChecklist(supabase, tenantId)
    const next: Checklist = {
      ...before,
      [step as OnboardingStepKey]: {
        status,
        ...(who_completed ? { who_completed } : {}),
        ...(status === 'blocked' ? { blocking_reason: String(blocking_reason).trim() } : {}),
        updated_at: new Date().toISOString(),
      },
    }
    const { error } = await supabase.from('tenant_onboarding_checklists')
      .upsert({ tenant_id: tenantId, steps: next, updated_at: new Date().toISOString() }, { onConflict: 'tenant_id' })
    if (error) { res.status(500).json({ error: error.message }); return }

    await recordPlatformAudit(supabase, req, {
      capability: 'onboarding.wizard.run', action: `onboarding.step.${step}`,
      tenant_id: tenantId,
      before: { [String(step)]: before[step as OnboardingStepKey] ?? null },
      after: { [String(step)]: next[step as OnboardingStepKey] },
      reason: who_completed ? `completed by ${who_completed}` : undefined,
    })
    res.json({ steps: next, ...derive(next) })
  })

  // ─── Outlets (Step 2) ──────────────────────────────────────────────────────
  const OUTLET_FIELDS = ['name', 'address', 'timezone', 'opening_hours', 'fulfilment',
    'delivery_radius_km', 'delivery_zones', 'capacity'] as const

  /** Keep only known columns; a hostile body can't inject tenant_id/id/etc. */
  function pickOutlet(body: any): Record<string, any> {
    const out: Record<string, any> = {}
    for (const k of OUTLET_FIELDS) if (body?.[k] !== undefined) out[k] = body[k]
    return out
  }

  r.get('/api/naruto/tenants/:tenantId/outlets', requireAuth, canRead, async (req, res) => {
    const { tenantId } = req.params
    if (!isUuid(tenantId)) { res.status(400).json({ error: 'bad tenant id' }); return }
    const { data, error } = await supabase.from('tenant_outlets')
      .select('*').eq('tenant_id', tenantId).order('created_at', { ascending: true })
    if (error) { res.status(500).json({ error: error.message }); return }
    res.json({ data: data ?? [] })
  })

  r.post('/api/naruto/tenants/:tenantId/outlets', requireAuth, canRun, async (req, res) => {
    const { tenantId } = req.params
    if (!isUuid(tenantId)) { res.status(400).json({ error: 'bad tenant id' }); return }
    const patch = pickOutlet(req.body)
    if (!patch.name || typeof patch.name !== 'string' || !patch.name.trim()) {
      res.status(400).json({ error: 'name is required' }); return
    }
    const { data, error } = await supabase.from('tenant_outlets')
      .insert({ tenant_id: tenantId, ...patch }).select('*').single()
    if (error) { res.status(500).json({ error: error.message }); return }
    await recordPlatformAudit(supabase, req, {
      capability: 'onboarding.wizard.run', action: 'onboarding.outlet.create',
      tenant_id: tenantId, before: null, after: data,
    })
    res.status(201).json(data)
  })

  r.patch('/api/naruto/tenants/:tenantId/outlets/:id', requireAuth, canRun, async (req, res) => {
    const { tenantId, id } = req.params
    if (!isUuid(tenantId) || !isUuid(id)) { res.status(400).json({ error: 'bad id' }); return }
    const patch = pickOutlet(req.body)
    if ('name' in patch && (!patch.name || !String(patch.name).trim())) {
      res.status(400).json({ error: 'name cannot be blank' }); return
    }
    const { data: before } = await supabase.from('tenant_outlets')
      .select('*').eq('id', id).eq('tenant_id', tenantId).maybeSingle()
    if (!before) { res.status(404).json({ error: 'outlet not found' }); return }
    const { data, error } = await supabase.from('tenant_outlets')
      .update({ ...patch, updated_at: new Date().toISOString() })
      .eq('id', id).eq('tenant_id', tenantId).select('*').single()
    if (error) { res.status(500).json({ error: error.message }); return }
    await recordPlatformAudit(supabase, req, {
      capability: 'onboarding.wizard.run', action: 'onboarding.outlet.update',
      tenant_id: tenantId, before, after: data,
    })
    res.json(data)
  })

  r.delete('/api/naruto/tenants/:tenantId/outlets/:id', requireAuth, canRun, async (req, res) => {
    const { tenantId, id } = req.params
    if (!isUuid(tenantId) || !isUuid(id)) { res.status(400).json({ error: 'bad id' }); return }
    const { data: before } = await supabase.from('tenant_outlets')
      .select('*').eq('id', id).eq('tenant_id', tenantId).maybeSingle()
    if (!before) { res.status(404).json({ error: 'outlet not found' }); return }
    const { error } = await supabase.from('tenant_outlets').delete().eq('id', id).eq('tenant_id', tenantId)
    if (error) { res.status(500).json({ error: error.message }); return }
    await recordPlatformAudit(supabase, req, {
      capability: 'onboarding.wizard.run', action: 'onboarding.outlet.delete',
      tenant_id: tenantId, before, after: null,
    })
    res.json({ ok: true })
  })

  return r
}
