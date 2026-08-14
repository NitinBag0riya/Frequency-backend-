/**
 * Platform approval engine + dangerous-action gating (Naruto §1.2).
 *
 * This is the PLATFORM-operator gate: certain /naruto mutations are too big to
 * let one operator fire alone — plan downgrades, bulk entitlement changes, payout
 * / Route-account changes, tenant suspend, tenant delete. Each runs through a
 * rule: propose (pending) → a DIFFERENT approver approves → the mutation applies.
 *
 * (Separate from routes/approvals.ts, which gates TENANT team-members inside one
 * tenant. Different scope, different tables — do not conflate.)
 *
 * ── The retrofit contract — `withApproval` ───────────────────────────────────
 * A dangerous endpoint wraps its mutation body in an `apply(ctx)` executor and
 * hands it to `withApproval`. If a rule requires approval, the proposal is
 * recorded and the call returns { status:'pending', proposalId } WITHOUT running
 * apply. Otherwise apply runs immediately and is audited. The SAME `apply(ctx)`
 * is replayed by the approve endpoint later, so define it once, args-driven:
 *
 *     // 1. register the executor at router setup (restart-safe):
 *     registerPlatformAction('tenant.suspend', suspendExecutor)
 *     // 2. in the handler:
 *     const out = await withApproval({
 *       supabase, req, action: 'tenant.suspend', tenantId: id,
 *       args: { reason }, reason, before: () => loadTenant(id), apply: suspendExecutor,
 *     })
 *     if (out.status === 'pending') { res.json(out); return }
 *     res.json(out.result)
 *
 * Auditing is OWNED by this layer: `apply` must NOT write its own audit row —
 * withApproval (immediate + break-glass) and the approve endpoint each record
 * exactly one `recordPlatformAudit`. Retrofitted endpoints drop their inline
 * audit() call (see the WIRE(naruto) notes in super-admin.ts / naruto-payments.ts).
 *
 * ── Break-glass (§1.2) ───────────────────────────────────────────────────────
 * `withApproval({ ..., breakGlass: true })` lets a platform_owner bypass the rule:
 * apply runs immediately, the audit row carries break_glass:true (flagged red),
 * and the platform team is notified (critical). Non-owners cannot break-glass.
 */

import express from 'express'
import type { SupabaseClient } from '@supabase/supabase-js'
import { can, normalizeRole, type PlatformCapability } from '../lib/platform-rbac'
import { resolvePlatformRole } from '../lib/platform-guard'
import { recordPlatformAudit } from '../lib/platform-audit'

// ── WIRE(naruto) — this module is NEW; the files below are prior-wave, not edited here ──
//   index.ts (near the other create*Router mounts, ~line 5998):
//     import { createPlatformApprovalsRouter } from './routes/platform-approvals'
//     app.use(createPlatformApprovalsRouter({ supabase, requireAuth }))
//
//   Retrofit these dangerous endpoints onto withApproval (drop their inline audit()):
//     • super-admin.ts  POST   /tenants/:id/suspend          → action 'tenant.suspend'
//     • super-admin.ts  DELETE /tenants/:id                  → action 'tenant.delete'
//     • super-admin.ts  POST   /tenants/:id/subscription     → action 'plan.downgrade'
//         (only when the target plan tier < current tier; upgrades stay direct)
//     • naruto-payments.ts route-account setter / payout     → 'payments.route_account' / 'payments.payout'
//     • the future bulk-entitlement endpoint (§2.3)          → 'entitlement.bulk'
//   Pattern for each: register the executor in the create*Router, then wrap the
//   handler body — see the `withApproval` docstring above.

type Middleware = (req: express.Request, res: express.Response, next: express.NextFunction) => void | Promise<void>
type Json = Record<string, any> | null | undefined

interface Deps {
  supabase: SupabaseClient
  requireAuth: Middleware
}

/** The dangerous actions §1.2 gates, mapped to the capability that authorizes
 *  actually performing them. Configuring the RULES needs `approval_rule.write`;
 *  APPROVING a proposal needs the action's own capability below (a second person
 *  who could have done it themselves). Single source of truth for both. */
export const ACTION_CAPABILITY: Record<string, PlatformCapability> = {
  'plan.downgrade':         'plan.assign.write',
  'entitlement.bulk':       'entitlement.bulk.write',
  'payments.route_account': 'payments.route_account.write',
  'payments.payout':        'payments.route_account.write',
  'tenant.suspend':         'tenant.suspend',
  'tenant.delete':          'tenant.delete',
}

// ── Executor registry ────────────────────────────────────────────────────────
export interface ApplyCtx {
  supabase: SupabaseClient
  req: express.Request
  tenantId?: string | null
  args: any
  before?: Json
}
export type ActionExecutor = (ctx: ApplyCtx) => Promise<Json>

const EXECUTORS = new Map<string, ActionExecutor>()

/** Register the replayable executor for an action. Call at router setup so an
 *  approval survives a process restart between propose and approve.
 *  ponytail: without setup-time registration the executor only exists after the
 *  first propose in THIS process; approve then 409s "not wired" until re-proposed.
 *  Upgrade path: every dangerous endpoint registers here in its create*Router. */
export function registerPlatformAction(action: string, executor: ActionExecutor): void {
  EXECUTORS.set(action, executor)
}

// ── Notifications ─────────────────────────────────────────────────────────────
/** Best-effort platform-team notify sink (§16). Never throws. */
export async function notifyPlatformTeam(
  supabase: SupabaseClient,
  n: { kind: string; title: string; body?: string; severity?: 'info' | 'warn' | 'critical'; ref_type?: string; ref_id?: string; actor_user_id?: string | null; tenant_id?: string | null },
): Promise<void> {
  try {
    await supabase.from('platform_notifications').insert({
      kind: n.kind, title: n.title, body: n.body ?? null,
      severity: n.severity ?? 'info', ref_type: n.ref_type ?? null, ref_id: n.ref_id ?? null,
      actor_user_id: n.actor_user_id ?? null, tenant_id: n.tenant_id ?? null,
    })
  } catch (e) {
    console.error('[platform-notify] insert failed', e)
  }
}

// ── withApproval ──────────────────────────────────────────────────────────────
export interface WithApprovalOpts {
  supabase: SupabaseClient
  req: express.Request
  action: string
  tenantId?: string | null
  args?: any
  /** Why (required — audited and stored on the proposal). */
  reason: string
  /** Before-image: a value or a loader run before the mutation. */
  before?: Json | (() => Promise<Json> | Json)
  /** The replayable mutation. MUST NOT write its own audit row. */
  apply: ActionExecutor
  /** platform_owner explicit rule bypass (§1.2). */
  breakGlass?: boolean
}

export type WithApprovalResult =
  | { status: 'applied'; result: Json; breakGlass?: boolean }
  | { status: 'pending'; proposalId: string }

/** Thrown when a break-glass is attempted by a non-owner. Caller → 403. */
export class BreakGlassDenied extends Error {
  constructor() { super('Break-glass requires platform_owner'); this.name = 'BreakGlassDenied' }
}

export async function withApproval(opts: WithApprovalOpts): Promise<WithApprovalResult> {
  const { supabase, req, action, tenantId, reason } = opts
  const args = opts.args ?? {}
  const capability = ACTION_CAPABILITY[action] ?? ('approval_rule.write' as PlatformCapability)

  // Auto-register so the immediate + approve paths share one executor.
  registerPlatformAction(action, opts.apply)

  const before = typeof opts.before === 'function'
    ? await (opts.before as () => Promise<Json>)()
    : opts.before

  // ── Break-glass: owner-only immediate bypass ───────────────────────────────
  if (opts.breakGlass) {
    if (normalizeRole((req as any).platformRole) !== 'platform_owner') throw new BreakGlassDenied()
    const after = await opts.apply({ supabase, req, tenantId, args, before })
    await recordPlatformAudit(supabase, req, {
      capability, action, tenant_id: tenantId ?? null, before, after, reason, break_glass: true,
    })
    await notifyPlatformTeam(supabase, {
      kind: 'action.break_glass', severity: 'critical', tenant_id: tenantId ?? null,
      actor_user_id: (req as any).user?.id ?? null, ref_type: 'audit',
      title: `Break-glass: ${action}`, body: reason,
    })
    return { status: 'applied', result: after, breakGlass: true }
  }

  // ── Rule lookup ────────────────────────────────────────────────────────────
  const { data: rule } = await supabase.from('platform_approval_rules')
    .select('*').eq('action', action).maybeSingle()

  if (rule?.requires_approval) {
    const { data: proposal, error } = await supabase.from('platform_action_proposals').insert({
      action, tenant_id: tenantId ?? null, args, before_json: before ?? null, reason,
      proposer_user_id: (req as any).user?.id ?? null, proposer_role: (req as any).platformRole ?? null,
      status: 'pending',
    }).select('id').single()
    if (error) throw new Error(`Could not record proposal: ${error.message}`)
    await notifyPlatformTeam(supabase, {
      kind: 'approval.waiting', severity: 'warn', tenant_id: tenantId ?? null,
      actor_user_id: (req as any).user?.id ?? null, ref_type: 'proposal', ref_id: proposal.id,
      title: `Approval needed: ${rule.label ?? action}`, body: reason,
    })
    return { status: 'pending', proposalId: proposal.id }
  }

  // ── No rule → apply immediately, audit here ────────────────────────────────
  const after = await opts.apply({ supabase, req, tenantId, args, before })
  await recordPlatformAudit(supabase, req, {
    capability, action, tenant_id: tenantId ?? null, before, after, reason,
  })
  return { status: 'applied', result: after }
}

// ── Router ────────────────────────────────────────────────────────────────────
export function createPlatformApprovalsRouter({ supabase, requireAuth }: Deps): express.Router {
  const r = express.Router()

  /** Resolve + stamp the caller's canonical platform role, then check `cap`.
   *  Returns true on pass; sends 401/403 and returns false otherwise. */
  async function guard(req: express.Request, res: express.Response, cap: PlatformCapability): Promise<boolean> {
    const user = (req as any).user
    if (!user) { res.status(401).json({ error: 'Auth required' }); return false }
    const canonical = normalizeRole(await resolvePlatformRole(supabase, user.id))
    ;(req as any).platformRole = canonical
    ;(req as any).isSuperAdmin = !!canonical
    if (!canonical || !can(cap, canonical)) {
      res.status(403).json({ error: `Platform role lacks capability: ${cap}` }); return false
    }
    return true
  }

  // ── Proposals queue ──────────────────────────────────────────────────────
  // List — any platform role may view (audit.read is the lowest-common gate).
  r.get('/api/super-admin/proposals', requireAuth, async (req, res) => {
    if (!(await guard(req, res, 'audit.read'))) return
    const status = String(req.query.status ?? '').trim()
    let q = supabase.from('platform_action_proposals').select('*').order('created_at', { ascending: false }).limit(200)
    if (status) q = q.eq('status', status)
    const { data, error } = await q
    if (error) { res.status(500).json({ error: error.message }); return }
    res.json(data ?? [])
  })

  r.get('/api/super-admin/proposals/pending-count', requireAuth, async (req, res) => {
    if (!(await guard(req, res, 'audit.read'))) return
    const { count, error } = await supabase.from('platform_action_proposals')
      .select('id', { count: 'exact', head: true }).eq('status', 'pending')
    if (error) { res.status(500).json({ error: error.message }); return }
    res.json({ count: count ?? 0 })
  })

  // Approve — runs the registered executor + audits. Requires the action's own
  // capability AND an approver role from the rule AND NOT being the proposer.
  r.post('/api/super-admin/proposals/:id/approve', requireAuth, async (req, res) => {
    const user = (req as any).user
    if (!user) { res.status(401).json({ error: 'Auth required' }); return }

    const { data: p } = await supabase.from('platform_action_proposals')
      .select('*').eq('id', String(req.params.id)).maybeSingle()
    if (!p) { res.status(404).json({ error: 'Proposal not found' }); return }
    if (p.status !== 'pending') { res.status(409).json({ error: `Already ${p.status}` }); return }

    // Self-approval block (§1.2 — "a second approver, not the proposer").
    if (p.proposer_user_id === user.id) {
      res.status(403).json({ error: 'You proposed this — a different approver is required.' }); return
    }

    // Capability = the action's own acting capability.
    const cap = ACTION_CAPABILITY[p.action] ?? ('approval_rule.write' as PlatformCapability)
    if (!(await guard(req, res, cap))) return
    const canonical = (req as any).platformRole as string

    // Approver-role allowlist from the rule (owner always allowed).
    const { data: rule } = await supabase.from('platform_approval_rules')
      .select('approver_roles').eq('action', p.action).maybeSingle()
    const allowed: string[] = rule?.approver_roles ?? []
    if (canonical !== 'platform_owner' && allowed.length > 0 && !allowed.includes(canonical)) {
      res.status(403).json({ error: `Role ${canonical} may not approve ${p.action}` }); return
    }

    const executor = EXECUTORS.get(p.action)
    if (!executor) {
      res.status(409).json({ error: `No executor registered for ${p.action} — endpoint not yet wired to withApproval.` }); return
    }

    // Claim the row so a double-click / concurrent approver can't apply twice.
    const { data: claimed } = await supabase.from('platform_action_proposals')
      .update({ status: 'approved', approver_user_id: user.id, decided_at: new Date().toISOString(), decision_reason: String(req.body?.reason ?? '').trim() || null })
      .eq('id', p.id).eq('status', 'pending').select('id').maybeSingle()
    if (!claimed) { res.status(409).json({ error: 'Already decided by someone else.' }); return }

    try {
      const after = await executor({ supabase, req, tenantId: p.tenant_id, args: p.args, before: p.before_json })
      await supabase.from('platform_action_proposals')
        .update({ status: 'applied', after_json: (after ?? null) as any, applied_at: new Date().toISOString() })
        .eq('id', p.id)
      await recordPlatformAudit(supabase, req, {
        capability: cap, action: p.action, tenant_id: p.tenant_id,
        before: p.before_json, after, reason: p.reason,
      })
      res.json({ status: 'applied', proposalId: p.id })
    } catch (e: any) {
      await supabase.from('platform_action_proposals')
        .update({ status: 'failed', error: String(e?.message ?? e).slice(0, 500) }).eq('id', p.id)
      res.status(500).json({ error: `Apply failed: ${e?.message ?? e}` })
    }
  })

  r.post('/api/super-admin/proposals/:id/reject', requireAuth, async (req, res) => {
    const user = (req as any).user
    if (!user) { res.status(401).json({ error: 'Auth required' }); return }
    const reason = String(req.body?.reason ?? '').trim()
    if (!reason) { res.status(400).json({ error: 'Reason required to reject' }); return }

    const { data: p } = await supabase.from('platform_action_proposals')
      .select('*').eq('id', String(req.params.id)).maybeSingle()
    if (!p) { res.status(404).json({ error: 'Proposal not found' }); return }
    if (p.status !== 'pending') { res.status(409).json({ error: `Already ${p.status}` }); return }

    // Rejecting is a read-tier decision — any approver-capable role, incl. the
    // proposer withdrawing their own request.
    const cap = ACTION_CAPABILITY[p.action] ?? ('approval_rule.write' as PlatformCapability)
    if (!(await guard(req, res, cap))) return

    const { data: claimed } = await supabase.from('platform_action_proposals')
      .update({ status: 'rejected', approver_user_id: user.id, decision_reason: reason, decided_at: new Date().toISOString() })
      .eq('id', p.id).eq('status', 'pending').select('id').maybeSingle()
    if (!claimed) { res.status(409).json({ error: 'Already decided by someone else.' }); return }
    await recordPlatformAudit(supabase, req, {
      capability: cap, action: `${p.action}.rejected`, tenant_id: p.tenant_id,
      before: p.before_json, after: null, reason,
    })
    res.json({ status: 'rejected', proposalId: p.id })
  })

  // ── Approval-rules config (which actions gate + who approves) ─────────────
  r.get('/api/super-admin/platform-approval-rules', requireAuth, async (req, res) => {
    if (!(await guard(req, res, 'audit.read'))) return
    const { data, error } = await supabase.from('platform_approval_rules').select('*').order('action')
    if (error) { res.status(500).json({ error: error.message }); return }
    res.json(data ?? [])
  })

  r.patch('/api/super-admin/platform-approval-rules/:action', requireAuth, async (req, res) => {
    if (!(await guard(req, res, 'approval_rule.write'))) return
    const action = String(req.params.action)
    const patch: Record<string, any> = { updated_at: new Date().toISOString(), updated_by: (req as any).user?.id ?? null }
    if (typeof req.body?.requires_approval === 'boolean') patch.requires_approval = req.body.requires_approval
    if (Array.isArray(req.body?.approver_roles)) {
      // Only accept known platform role keys.
      patch.approver_roles = req.body.approver_roles.filter((k: any) => typeof k === 'string' && normalizeRole(k))
    }
    const { data: before } = await supabase.from('platform_approval_rules').select('*').eq('action', action).maybeSingle()
    const { data, error } = await supabase.from('platform_approval_rules').update(patch).eq('action', action).select().maybeSingle()
    if (error) { res.status(500).json({ error: error.message }); return }
    if (!data) { res.status(404).json({ error: 'Unknown action' }); return }
    await recordPlatformAudit(supabase, req, {
      capability: 'approval_rule.write', action: 'approval_rule.update', before, after: data,
      reason: String(req.body?.reason ?? '').trim() || null,
    })
    res.json(data)
  })

  return r
}
