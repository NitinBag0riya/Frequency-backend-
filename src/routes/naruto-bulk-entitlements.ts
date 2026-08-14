/**
 * Naruto Platform OS — §2.3 bulk entitlement operations + the background-job
 * pattern (spec Part V §16 "all long jobs are background jobs with progress,
 * cancel, result report, retry").
 *
 * The flow:
 *   1. Filter tenants        GET  /tenants        (vertical / plan / lifecycle / feature-state)
 *   2. Preview the diff      POST /preview        per-tenant before→after via the resolver,
 *                                                 "N affected, M no-ops" — NO writes.
 *   3. Apply (background)     POST /apply          creates a job + one item per tenant, returns
 *                                                 immediately, runs the fan-out OUT of band.
 *   4. Watch / control        GET  /jobs/:id       progress + per-tenant result
 *                            POST /jobs/:id/cancel stop between items
 *                            POST /jobs/:id/retry  re-run only the failed items
 *   5. Undo (24h)            POST /jobs/:id/reverse restore every applied item's pre-image
 *
 * Every write is capability-gated (`entitlement.bulk.write`) and audited via
 * `recordPlatformAudit` — the apply, the retry and the reverse each land a row.
 *
 * The change itself reuses the EXISTING stores — `tenant_entitlements` for a
 * feature ON/OFF/INHERIT override (identical shape to the single-tenant editor
 * in super-admin.ts), `tenant_subscriptions.plan_id` for a plan change. The diff
 * is computed with the SAME pure resolver the runtime uses (`decideFeature` +
 * `businessGroup` from lib/entitlements), so the preview cannot drift from what
 * a tenant will actually get.
 *
 * Background execution — the queue/worker (BullMQ, src/queue.ts) is Redis-backed
 * and Redis is intermittently suspended in this environment; adding a queue would
 * also require editing the shared worker process. The spec explicitly allows the
 * fallback: "a job table + a poller is fine — but do NOT block the request." So
 * the job runs as a fire-and-forget in-process async fan-out (`runJob`) that
 * writes progress to the job/job_items rows the FE polls. Non-blocking by
 * construction: the route responds the moment the rows are inserted.
 *   ponytail: an in-process runner dies with the process. Ceiling: a mid-flight
 *   restart leaves items 'pending' — the /retry endpoint re-runs them, so no
 *   item is lost, only delayed. Swap `runJob` for a BullMQ queue + worker
 *   subscriber if bulk volume ever outgrows one process.
 *
 * WIRE(naruto): mount in flowgpt-server/src/index.ts next to the other naruto
 * routers (search "createNarutoTenantsRouter"):
 *   import { createNarutoBulkEntitlementsRouter } from './routes/naruto-bulk-entitlements'
 *   app.use(createNarutoBulkEntitlementsRouter({ supabase, requireAuth }))
 */

import express from 'express'
import type { SupabaseClient } from '@supabase/supabase-js'
import { requirePlatformCapability } from '../lib/platform-guard'
import { recordPlatformAudit } from '../lib/platform-audit'
import { businessGroup, decideFeature, type BusinessGroup } from '../lib/entitlements'
import { withApproval, registerPlatformAction, BreakGlassDenied, type ActionExecutor } from './platform-approvals'

type Middleware = (req: express.Request, res: express.Response, next: express.NextFunction) => void | Promise<void>

interface Deps {
  supabase: SupabaseClient
  requireAuth: Middleware
}

const P = '/api/naruto/bulk-entitlements'
const FEATURE_KEY = /^[a-z0-9_.]{1,64}$/
const PLAN_KEY = /^[a-z0-9_-]{1,64}$/
const MAX_SELECTION = 1000

// ─── Action model ────────────────────────────────────────────────────────────
type FeatureAction = { kind: 'feature_override'; feature: string; target: 'on' | 'off' | 'inherit' }
type PlanAction = { kind: 'plan_change'; plan_id: string }
type Action = FeatureAction | PlanAction

/** Parse + validate the change spec at the trust boundary. Returns a typed
 *  action or an error string. */
function parseAction(a: any): { action: Action } | { error: string } {
  if (!a || typeof a !== 'object') return { error: 'action is required' }
  if (a.kind === 'feature_override') {
    if (typeof a.feature !== 'string' || !FEATURE_KEY.test(a.feature)) return { error: `invalid feature key: ${String(a.feature)}` }
    if (a.target !== 'on' && a.target !== 'off' && a.target !== 'inherit') return { error: "target must be 'on' | 'off' | 'inherit'" }
    return { action: { kind: 'feature_override', feature: a.feature, target: a.target } }
  }
  if (a.kind === 'plan_change') {
    if (typeof a.plan_id !== 'string' || !PLAN_KEY.test(a.plan_id)) return { error: `invalid plan id: ${String(a.plan_id)}` }
    return { action: { kind: 'plan_change', plan_id: a.plan_id } }
  }
  return { error: "action.kind must be 'feature_override' | 'plan_change'" }
}

function parseTenantIds(ids: any): { ids: string[] } | { error: string } {
  if (!Array.isArray(ids) || ids.length === 0) return { error: 'tenantIds must be a non-empty array' }
  if (ids.length > MAX_SELECTION) return { error: `selection too large (max ${MAX_SELECTION})` }
  const out: string[] = []
  for (const id of ids) {
    if (typeof id !== 'string' || id.length === 0 || id.length > 64) return { error: `invalid tenant id: ${String(id)}` }
    out.push(id)
  }
  return { ids: [...new Set(out)] }
}

// ─── Per-tenant plan (the diff row) ──────────────────────────────────────────
interface PlanItem {
  tenantId: string
  name: string
  vertical: BusinessGroup
  /** Feature not offered to the vertical (hard gate) — never written. */
  locked: boolean
  /** Nothing changes in storage → no write. */
  noop: boolean
  beforeLabel: string
  afterLabel: string
  /** Storage pre-image (reverse target) + image to write (undefined for no-op). */
  before_json: Record<string, any> | null
  after_json: Record<string, any> | null
}

function grantsAccess(status: string | null | undefined): boolean {
  return status === 'active' || status === 'trial'
}

/** Storage image the tenant_entitlements override carries (subset persisted). */
export interface OverrideImage {
  is_enabled: boolean | null
  override_reason: any
  expires_at: any
  quota_override: any
}

/**
 * Pure core of the feature-override apply: given the target and the existing
 * override row, decide whether it's a no-op and produce the reverse pre-image
 * (before_json) + the image to write (after_json). Extracted so the noop rule
 * and the create/delete inversion are unit-testable without a DB.
 *
 * Invariant the /reverse endpoint relies on: applyItem(before_json) is the exact
 * inverse of applyItem(after_json) — null means "delete the row", an object
 * means "upsert that row".
 */
export function featureOverrideImages(
  target: 'on' | 'off' | 'inherit',
  verticalLocked: boolean,
  existing: OverrideImage | null,
): { noop: boolean; before_json: OverrideImage | null; after_json: OverrideImage | null } {
  const desired: boolean | null = target === 'inherit' ? null : target === 'on'
  const rowExists = !!existing
  const storageNoop = target === 'inherit' ? !rowExists : rowExists && existing!.is_enabled === desired
  const noop = verticalLocked || storageNoop

  const before_json = existing
    ? { is_enabled: existing.is_enabled, override_reason: existing.override_reason ?? null, expires_at: existing.expires_at ?? null, quota_override: existing.quota_override ?? null }
    : null
  const after_json: OverrideImage | null = noop || target === 'inherit'
    ? null
    : { is_enabled: desired, override_reason: existing?.override_reason ?? null, expires_at: existing?.expires_at ?? null, quota_override: existing?.quota_override ?? null }
  return { noop, before_json, after_json }
}

/**
 * Compute the whole selection's before→after in a fixed number of queries
 * (independent of tenant count), using the same resolver the runtime uses.
 * Shared by /preview (read-only) and /apply (drives the writes).
 */
async function planSelection(supabase: SupabaseClient, tenantIds: string[], action: Action): Promise<PlanItem[]> {
  const { data: tenants } = await supabase.from('tenants')
    .select('id, business_name, business_type').in('id', tenantIds)
  const byId = new Map<string, any>((tenants ?? []).map((t: any) => [t.id, t]))

  const { data: subs } = await supabase.from('tenant_subscriptions')
    .select('tenant_id, plan_id, status').in('tenant_id', tenantIds)
  const subById = new Map<string, any>((subs ?? []).map((s: any) => [s.tenant_id, s]))

  if (action.kind === 'plan_change') {
    return tenantIds.map((id): PlanItem => {
      const t = byId.get(id)
      const cur = subById.get(id)?.plan_id ?? null
      const noop = cur === action.plan_id
      return {
        tenantId: id,
        name: t?.business_name ?? 'Unknown',
        vertical: businessGroup(t?.business_type),
        locked: false,
        noop,
        beforeLabel: cur ?? '—',
        afterLabel: action.plan_id,
        before_json: { plan_id: cur },
        after_json: noop ? null : { plan_id: action.plan_id },
      }
    })
  }

  // feature_override — resolve current vs proposed via decideFeature.
  const feature = action.feature
  const { data: featRow } = await supabase.from('features')
    .select('verticals, default_enabled').eq('key', feature).maybeSingle()
  const verticals: string[] = (featRow as any)?.verticals ?? ['*']
  const defaultEnabled = !!(featRow as any)?.default_enabled

  const planIds = [...new Set((subs ?? []).map((s: any) => s.plan_id).filter(Boolean))]
  const grantSet = new Set<string>()
  if (planIds.length) {
    const { data: grants } = await supabase.from('plan_features')
      .select('plan_id').eq('feature_key', feature).in('plan_id', planIds)
    for (const g of (grants ?? []) as any[]) grantSet.add(g.plan_id)
  }

  const { data: overrides } = await supabase.from('tenant_entitlements')
    .select('tenant_id, is_enabled, override_reason, expires_at, quota_override')
    .eq('feature', feature).in('tenant_id', tenantIds)
  const ovById = new Map<string, any>((overrides ?? []).map((o: any) => [o.tenant_id, o]))

  const now = Date.now()
  const desired: boolean | null = action.target === 'inherit' ? null : action.target === 'on'

  return tenantIds.map((id): PlanItem => {
    const t = byId.get(id)
    const bg = businessGroup(t?.business_type)
    const verticalLocked = !(verticals.includes('*') || verticals.includes(bg))

    const ovRaw = ovById.get(id) ?? null
    const ovActive = ovRaw && (!ovRaw.expires_at || new Date(ovRaw.expires_at).getTime() > now)
    // Only an ACTIVE override row counts toward the decision + the pre-image.
    const existing: OverrideImage | null = ovActive ? ovRaw : null
    const curOverrideEnabled: boolean | null = existing && existing.is_enabled !== null ? existing.is_enabled : null
    const planGranted = grantsAccess(subById.get(id)?.status) && grantSet.has(subById.get(id)?.plan_id)

    const curResolved = decideFeature({ vertical_locked: verticalLocked, override_enabled: curOverrideEnabled, plan_granted: planGranted, default_enabled: defaultEnabled }).resolved
    const newResolved = decideFeature({ vertical_locked: verticalLocked, override_enabled: desired, plan_granted: planGranted, default_enabled: defaultEnabled }).resolved

    const { noop, before_json, after_json } = featureOverrideImages(action.target, verticalLocked, existing)

    return {
      tenantId: id,
      name: t?.business_name ?? 'Unknown',
      vertical: bg,
      locked: verticalLocked,
      noop,
      beforeLabel: verticalLocked ? 'Locked' : curResolved ? 'On' : 'Off',
      afterLabel: verticalLocked ? 'Locked' : newResolved ? 'On' : 'Off',
      before_json,
      after_json,
    }
  })
}

// ─── Apply / reverse one storage write ───────────────────────────────────────
async function applyItem(supabase: SupabaseClient, action: Action, tenantId: string, image: Record<string, any> | null, actorId: string | null, reason: string | null): Promise<void> {
  if (action.kind === 'plan_change') {
    const planId = image?.plan_id ?? action.plan_id
    const { error } = await supabase.from('tenant_subscriptions')
      .update({ plan_id: planId, updated_at: new Date().toISOString() }).eq('tenant_id', tenantId)
    if (error) throw new Error(error.message)
    return
  }
  // feature_override
  if (image === null) {
    const { error } = await supabase.from('tenant_entitlements').delete().eq('tenant_id', tenantId).eq('feature', action.feature)
    if (error) throw new Error(error.message)
    return
  }
  const row = {
    tenant_id: tenantId,
    feature: action.feature,
    is_enabled: image.is_enabled ?? true,
    override_reason: image.override_reason ?? reason ?? null,
    expires_at: image.expires_at ?? null,
    quota_override: image.quota_override ?? null,
    granted_by: actorId,
    granted_at: new Date().toISOString(),
  }
  const { error } = await supabase.from('tenant_entitlements').upsert(row, { onConflict: 'tenant_id,feature' })
  if (error) throw new Error(error.message)
}

// ─── Counters helper ─────────────────────────────────────────────────────────
async function recountAndFinalize(supabase: SupabaseClient, jobId: string, finalStatus?: 'completed' | 'cancelled'): Promise<void> {
  const { data: items } = await supabase.from('entitlement_bulk_job_items').select('status').eq('job_id', jobId)
  const rows = (items ?? []) as { status: string }[]
  const succeeded = rows.filter(r => r.status === 'applied').length
  const failed = rows.filter(r => r.status === 'failed').length
  const patch: Record<string, any> = { succeeded, failed }
  if (finalStatus) { patch.status = finalStatus; patch.finished_at = new Date().toISOString() }
  await supabase.from('entitlement_bulk_jobs').update(patch).eq('id', jobId)
}

/**
 * The background runner — processes 'pending' items one at a time, re-checking
 * the job's cancel flag between items. Fire-and-forget; never awaited by a route.
 */
async function runJob(supabase: SupabaseClient, jobId: string): Promise<void> {
  try {
    const { data: job } = await supabase.from('entitlement_bulk_jobs').select('action, reason, actor_user_id').eq('id', jobId).maybeSingle()
    if (!job) return
    const action = (job as any).action as Action
    const reason = (job as any).reason ?? null
    const actorId = (job as any).actor_user_id ?? null

    // Snapshot the pending item ids; process sequentially.
    const { data: pending } = await supabase.from('entitlement_bulk_job_items')
      .select('id, tenant_id, after_json').eq('job_id', jobId).eq('status', 'pending')
    for (const item of (pending ?? []) as any[]) {
      // Cancel check — cheap header read between items.
      const { data: st } = await supabase.from('entitlement_bulk_jobs').select('status').eq('id', jobId).maybeSingle()
      if ((st as any)?.status === 'cancelling') { await recountAndFinalize(supabase, jobId, 'cancelled'); return }
      try {
        await applyItem(supabase, action, item.tenant_id, item.after_json, actorId, reason)
        await supabase.from('entitlement_bulk_job_items').update({ status: 'applied', error: null, updated_at: new Date().toISOString() }).eq('id', item.id)
      } catch (e: any) {
        await supabase.from('entitlement_bulk_job_items').update({ status: 'failed', error: String(e?.message ?? e).slice(0, 500), updated_at: new Date().toISOString() }).eq('id', item.id)
      }
    }
    await recountAndFinalize(supabase, jobId, 'completed')
  } catch (e) {
    console.error('[bulk-entitlements] runJob failed', jobId, e)
    // Leave items as-is; /retry can re-run pending. Don't wedge the job header.
    await supabase.from('entitlement_bulk_jobs').update({ status: 'completed', finished_at: new Date().toISOString() }).eq('id', jobId).eq('status', 'running')
  }
}

// ─── Router ──────────────────────────────────────────────────────────────────
export function createNarutoBulkEntitlementsRouter(deps: Deps): express.Router {
  const { supabase, requireAuth } = deps
  const router = express.Router()
  // Read (tenant list, preview) is capability-gated too — it exposes tenant
  // config. entitlement.bulk.write is the only capability this surface uses.
  const gate = [requireAuth, requirePlatformCapability(supabase, 'entitlement.bulk.write')] as const

  // Bulk-apply executor — the replayable job-creation body (§2.3). Registered at
  // setup so an approval survives a process restart between propose and approve.
  // Auditing is owned by withApproval; this must NOT write its own audit row.
  const bulkApplyExecutor: ActionExecutor = async ({ args }) => {
    const { ids, action, reason, filter, idempotencyKey, actorId } = args
    // Idempotency — a double-clicked Apply returns the first job, no re-fan-out.
    if (idempotencyKey) {
      const { data: existing } = await supabase.from('entitlement_bulk_jobs')
        .select('*').eq('actor_user_id', actorId).eq('idempotency_key', idempotencyKey).maybeSingle()
      if (existing) return { job: existing, deduped: true }
    }
    const items = await planSelection(supabase, ids, action)
    const affected = items.filter(i => !i.noop)
    const noopCount = items.length - affected.length
    const { data: job, error: jobErr } = await supabase.from('entitlement_bulk_jobs').insert({
      actor_user_id: actorId, action, filter, status: 'running',
      total: items.length, affected: affected.length, noop: noopCount, reason, idempotency_key: idempotencyKey,
    }).select().single()
    if (jobErr || !job) {
      if (idempotencyKey) {
        const { data: raced } = await supabase.from('entitlement_bulk_jobs')
          .select('*').eq('actor_user_id', actorId).eq('idempotency_key', idempotencyKey).maybeSingle()
        if (raced) return { job: raced, deduped: true }
      }
      throw new Error(jobErr?.message ?? 'could not create job')
    }
    const itemRows = items.map(i => ({
      job_id: job.id, tenant_id: i.tenantId, tenant_name: i.name,
      status: i.noop ? 'noop' : 'pending', before_json: i.before_json, after_json: i.after_json,
    }))
    const { error: itemErr } = await supabase.from('entitlement_bulk_job_items').insert(itemRows)
    if (itemErr) throw new Error(itemErr.message)
    // Fire-and-forget — non-blocking. The FE polls GET /jobs/:id.
    void runJob(supabase, job.id)
    return { job, affected: affected.length, noop: noopCount, total: items.length }
  }
  registerPlatformAction('entitlement.bulk', bulkApplyExecutor)

  // ── 1. Filter tenants ──────────────────────────────────────────────────────
  // vertical / plan / lifecycle / feature-state (current override for ?feature=).
  router.get(`${P}/tenants`, ...gate, async (req, res) => {
    try {
      const { vertical, plan, lifecycle, feature, search } = req.query as Record<string, string>
      const { data: tenants, error } = await supabase.from('tenants')
        .select('id, business_name, business_type, status, lifecycle_state, deleted_at')
        .is('deleted_at', null)
        .order('business_name', { ascending: true })
      if (error) { res.status(500).json({ error: error.message }); return }

      const ids = (tenants ?? []).map((t: any) => t.id)
      const { data: subs } = ids.length
        ? await supabase.from('tenant_subscriptions').select('tenant_id, plan_id, status').in('tenant_id', ids)
        : { data: [] as any[] }
      const subById = new Map<string, any>((subs ?? []).map((s: any) => [s.tenant_id, s]))

      // Feature-state column (only when a feature is named).
      const ovById = new Map<string, any>()
      if (feature && FEATURE_KEY.test(feature) && ids.length) {
        const { data: ovs } = await supabase.from('tenant_entitlements')
          .select('tenant_id, is_enabled, expires_at').eq('feature', feature).in('tenant_id', ids)
        const now = Date.now()
        for (const o of (ovs ?? []) as any[]) {
          const active = !o.expires_at || new Date(o.expires_at).getTime() > now
          if (active) ovById.set(o.tenant_id, o)
        }
      }

      let rows = (tenants ?? []).map((t: any) => {
        const ov = ovById.get(t.id)
        const featureState = !feature ? undefined
          : ov ? (ov.is_enabled === true ? 'on' : ov.is_enabled === false ? 'off' : 'inherit') : 'inherit'
        return {
          id: t.id,
          name: t.business_name ?? 'Unnamed',
          vertical: businessGroup(t.business_type),
          plan_id: subById.get(t.id)?.plan_id ?? null,
          status: subById.get(t.id)?.status ?? t.status ?? null,
          lifecycle_state: t.lifecycle_state ?? null,
          feature_state: featureState,
        }
      })

      if (vertical && vertical !== 'all') rows = rows.filter(r => r.vertical === vertical)
      if (plan && plan !== 'all') rows = rows.filter(r => r.plan_id === plan)
      if (lifecycle && lifecycle !== 'all') rows = rows.filter(r => r.lifecycle_state === lifecycle)
      if (feature && req.query.feature_state && req.query.feature_state !== 'all') {
        rows = rows.filter(r => r.feature_state === req.query.feature_state)
      }
      if (search && search.trim()) {
        const q = search.trim().toLowerCase()
        rows = rows.filter(r => r.name.toLowerCase().includes(q))
      }
      res.json({ data: rows, total: rows.length })
    } catch (e: any) {
      res.status(500).json({ error: e?.message ?? 'tenant list failed' })
    }
  })

  // ── 2. Preview diff (NO writes) ─────────────────────────────────────────────
  router.post(`${P}/preview`, ...gate, async (req, res) => {
    const t = parseTenantIds(req.body?.tenantIds); if ('error' in t) { res.status(400).json({ error: t.error }); return }
    const a = parseAction(req.body?.action); if ('error' in a) { res.status(400).json({ error: a.error }); return }
    try {
      const items = await planSelection(supabase, t.ids, a.action)
      const affected = items.filter(i => !i.noop).length
      res.json({
        affected,
        noop: items.length - affected,
        total: items.length,
        items: items.map(i => ({ tenantId: i.tenantId, name: i.name, vertical: i.vertical, locked: i.locked, noop: i.noop, before: i.beforeLabel, after: i.afterLabel })),
      })
    } catch (e: any) {
      res.status(500).json({ error: e?.message ?? 'preview failed' })
    }
  })

  // ── 3. Apply (background job) ───────────────────────────────────────────────
  router.post(`${P}/apply`, ...gate, async (req, res) => {
    const t = parseTenantIds(req.body?.tenantIds); if ('error' in t) { res.status(400).json({ error: t.error }); return }
    const a = parseAction(req.body?.action); if ('error' in a) { res.status(400).json({ error: a.error }); return }
    const reason: string | null = typeof req.body?.reason === 'string' && req.body.reason.trim() ? req.body.reason.trim().slice(0, 400) : null
    const filter = (req.body?.filter && typeof req.body.filter === 'object' && !Array.isArray(req.body.filter)) ? req.body.filter : {}
    const idempotencyKey: string | null = typeof req.body?.idempotencyKey === 'string' ? req.body.idempotencyKey.slice(0, 120) : null
    const actorId = (req as any).user?.id ?? null

    try {
      // §2.3 — a bulk change is a §1.2 dangerous action. An approval rule may gate
      // it (propose → second approver → the SAME executor runs on approve). No rule
      // → applies immediately + audits here (withApproval owns the audit row).
      const out = await withApproval({
        supabase, req, action: 'entitlement.bulk',
        reason: reason ?? 'Bulk entitlement change',
        breakGlass: !!req.body?.break_glass,
        before: null,
        args: { ids: t.ids, action: a.action, reason, filter, idempotencyKey, actorId },
        apply: bulkApplyExecutor,
      })
      if (out.status === 'pending') { res.json(out); return }
      res.json(out.result)
    } catch (e: any) {
      if (e instanceof BreakGlassDenied) { res.status(403).json({ error: e.message }); return }
      res.status(500).json({ error: e?.message ?? 'apply failed' })
    }
  })

  // ── 4a. Job status (progress + per-tenant result) ───────────────────────────
  router.get(`${P}/jobs/:id`, ...gate, async (req, res) => {
    const jobId = String(req.params.id)
    const { data: job } = await supabase.from('entitlement_bulk_jobs').select('*').eq('id', jobId).maybeSingle()
    if (!job) { res.status(404).json({ error: 'job not found' }); return }
    const { data: items } = await supabase.from('entitlement_bulk_job_items')
      .select('id, tenant_id, tenant_name, status, error, updated_at').eq('job_id', jobId).order('tenant_name', { ascending: true })
    const reversible = !job.reversed_at && new Date(job.expires_at).getTime() > Date.now()
    res.json({ job: { ...job, reversible }, items: items ?? [] })
  })

  // ── 4b. Recent jobs (drives the reverse/history panel after reload) ─────────
  router.get(`${P}/jobs`, ...gate, async (req, res) => {
    const limit = Math.min(50, Math.max(1, parseInt(String(req.query.limit ?? '20'), 10) || 20))
    const { data: jobs } = await supabase.from('entitlement_bulk_jobs')
      .select('*').order('created_at', { ascending: false }).limit(limit)
    const now = Date.now()
    res.json({ data: (jobs ?? []).map((j: any) => ({ ...j, reversible: !j.reversed_at && new Date(j.expires_at).getTime() > now })) })
  })

  // ── 4c. Cancel (stop between items) ─────────────────────────────────────────
  router.post(`${P}/jobs/:id/cancel`, ...gate, async (req, res) => {
    const jobId = String(req.params.id)
    const { data: job } = await supabase.from('entitlement_bulk_jobs').select('status').eq('id', jobId).maybeSingle()
    if (!job) { res.status(404).json({ error: 'job not found' }); return }
    if (job.status !== 'running') { res.status(409).json({ error: `job is ${job.status}, cannot cancel` }); return }
    await supabase.from('entitlement_bulk_jobs').update({ status: 'cancelling' }).eq('id', jobId).eq('status', 'running')
    await recordPlatformAudit(supabase, req, { capability: 'entitlement.bulk.write', action: 'entitlement.bulk.cancel', after: { job_id: jobId } })
    res.json({ success: true })
  })

  // ── 4d. Retry (re-run only the failed items) ────────────────────────────────
  router.post(`${P}/jobs/:id/retry`, ...gate, async (req, res) => {
    const jobId = String(req.params.id)
    const { data: job } = await supabase.from('entitlement_bulk_jobs').select('status, reversed_at').eq('id', jobId).maybeSingle()
    if (!job) { res.status(404).json({ error: 'job not found' }); return }
    if (job.reversed_at) { res.status(409).json({ error: 'job was reversed' }); return }
    const { data: failed } = await supabase.from('entitlement_bulk_job_items').select('id').eq('job_id', jobId).eq('status', 'failed')
    if (!failed?.length) { res.status(400).json({ error: 'no failed items to retry' }); return }
    await supabase.from('entitlement_bulk_job_items').update({ status: 'pending', error: null, updated_at: new Date().toISOString() }).eq('job_id', jobId).eq('status', 'failed')
    await supabase.from('entitlement_bulk_jobs').update({ status: 'running', finished_at: null }).eq('id', jobId)
    await recordPlatformAudit(supabase, req, { capability: 'entitlement.bulk.write', action: 'entitlement.bulk.retry', after: { job_id: jobId, retried: failed.length } })
    void runJob(supabase, jobId)
    res.json({ success: true, retried: failed.length })
  })

  // ── 5. Reverse (undo the whole op within 24h) ───────────────────────────────
  router.post(`${P}/jobs/:id/reverse`, ...gate, async (req, res) => {
    const jobId = String(req.params.id)
    const reason: string | null = typeof req.body?.reason === 'string' && req.body.reason.trim() ? req.body.reason.trim().slice(0, 400) : null
    const { data: job } = await supabase.from('entitlement_bulk_jobs').select('*').eq('id', jobId).maybeSingle()
    if (!job) { res.status(404).json({ error: 'job not found' }); return }
    if (job.reversed_at) { res.status(409).json({ error: 'already reversed' }); return }
    if (new Date(job.expires_at).getTime() <= Date.now()) { res.status(409).json({ error: 'reverse window (24h) has expired' }); return }
    if (job.status === 'running' || job.status === 'cancelling') { res.status(409).json({ error: 'job still running — cancel first' }); return }

    const action = job.action as Action
    const actorId = (req as any).user?.id ?? null
    const { data: applied } = await supabase.from('entitlement_bulk_job_items')
      .select('id, tenant_id, before_json').eq('job_id', jobId).eq('status', 'applied')

    let reversed = 0, failed = 0
    for (const item of (applied ?? []) as any[]) {
      try {
        // Restore the pre-image → applyItem with before_json is the exact inverse.
        await applyItem(supabase, action, item.tenant_id, item.before_json, actorId, reason)
        await supabase.from('entitlement_bulk_job_items').update({ status: 'reversed', updated_at: new Date().toISOString() }).eq('id', item.id)
        reversed++
      } catch (e: any) {
        await supabase.from('entitlement_bulk_job_items').update({ error: `reverse failed: ${String(e?.message ?? e).slice(0, 400)}`, updated_at: new Date().toISOString() }).eq('id', item.id)
        failed++
      }
    }
    await supabase.from('entitlement_bulk_jobs').update({ reversed_at: new Date().toISOString() }).eq('id', jobId)
    await recordPlatformAudit(supabase, req, {
      capability: 'entitlement.bulk.write', action: 'entitlement.bulk.reverse', tenant_id: null,
      before: { job_id: jobId }, after: { reversed, failed }, reason,
    })
    res.json({ success: true, reversed, failed })
  })

  return router
}
