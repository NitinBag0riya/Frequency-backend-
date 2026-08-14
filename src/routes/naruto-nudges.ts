/**
 * Naruto §6 nudge engine + §16 platform-team notifications — the platform API.
 *
 * This module is NEW. It exposes:
 *   • Nudge rules CRUD (list + toggle/tune) and an operator MANUAL-SEND override
 *     — the "send this nudge now" button in /naruto. Both reuse lib/nudge-engine.
 *   • Platform-team notification inbox (list / unread-count / mark-read) reading
 *     the platform_notifications table (§16).
 *   • The Overview needs-attention aggregate (§15) — one endpoint returning every
 *     queue's LIVE count so the FE makes a single call. Genuinely-absent signals
 *     (no KYC sync yet) return null → the FE renders "—", never a fabricated 0.
 *
 * Capabilities (reused — no new capability strings invented, per platform-rbac.ts):
 *   • reads (rules list, notifications, needs-attention)  → 'audit.read'
 *     (the lowest-common platform read gate; platform_readonly has it)
 *   • writes (rule edit, manual send, run-now)            → 'announcement.write'
 *     (nudges ARE outbound platform comms; owner + platform_admin hold it)
 *   • mark-notification-read                              → 'audit.read'
 *     (dismissing your own alert inbox is a read-tier action)
 *
 * WIRE(naruto) — mount (flowgpt-server/src/index.ts, by the other create*Router
 * mounts near createNarutoTenantsRouter):
 *     import { createNarutoNudgesRouter } from './routes/naruto-nudges'
 *     app.use(createNarutoNudgesRouter({ supabase, requireAuth }))
 *   (Router declares full /api/naruto/* paths — mount at root, no prefix.)
 */

import express from 'express'
import type { SupabaseClient } from '@supabase/supabase-js'
import { requirePlatformCapability } from '../lib/platform-guard'
import { recordPlatformAudit } from '../lib/platform-audit'
import {
  runNudgeTick, sendNudge, candidateForTenant, type NudgeRule,
} from '../lib/nudge-engine'

type Middleware = (req: express.Request, res: express.Response, next: express.NextFunction) => void | Promise<void>
interface Deps { supabase: SupabaseClient; requireAuth: Middleware }

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const isUuid = (s: unknown): s is string => typeof s === 'string' && UUID_RE.test(s)

export function createNarutoNudgesRouter({ supabase, requireAuth }: Deps): express.Router {
  const r = express.Router()
  const canRead = requirePlatformCapability(supabase, 'audit.read')
  const canWrite = requirePlatformCapability(supabase, 'announcement.write')

  // ── Nudge rules ────────────────────────────────────────────────────────────
  r.get('/api/naruto/nudge-rules', requireAuth, canRead, async (_req, res) => {
    const { data, error } = await supabase.from('platform_nudge_rules').select('*').order('id')
    if (error) { res.status(500).json({ error: error.message }); return }
    res.json(data ?? [])
  })

  // Tune a rule: enable/disable, channel, cooldown, condition. Never lets a caller
  // rewrite `trigger`/`template_key` to unknown keys silently — only known columns.
  r.patch('/api/naruto/nudge-rules/:id', requireAuth, canWrite, async (req, res) => {
    const id = String(req.params.id)
    const patch: Record<string, any> = { updated_at: new Date().toISOString(), updated_by: (req as any).user?.id ?? null }
    const b = req.body ?? {}
    if (typeof b.enabled === 'boolean') patch.enabled = b.enabled
    if (['email', 'whatsapp', 'both'].includes(b.channel)) patch.channel = b.channel
    if (Number.isFinite(b.cooldown_hours) && b.cooldown_hours >= 1) patch.cooldown_hours = Math.floor(b.cooldown_hours)
    if (b.condition && typeof b.condition === 'object') patch.condition = b.condition
    if (typeof b.label === 'string') patch.label = b.label.slice(0, 200)
    if (typeof b.description === 'string') patch.description = b.description.slice(0, 1000)

    const { data: before } = await supabase.from('platform_nudge_rules').select('*').eq('id', id).maybeSingle()
    if (!before) { res.status(404).json({ error: 'Unknown rule' }); return }
    const { data, error } = await supabase.from('platform_nudge_rules').update(patch).eq('id', id).select().maybeSingle()
    if (error) { res.status(500).json({ error: error.message }); return }
    await recordPlatformAudit(supabase, req, {
      capability: 'announcement.write', action: 'nudge_rule.update', before, after: data,
      reason: String(b.reason ?? '').trim() || null,
    })
    res.json(data)
  })

  // Operator manual-send override: fire one rule at one tenant now. `force`
  // bypasses cooldown (the operator has decided to send regardless).
  r.post('/api/naruto/nudges/:ruleId/send', requireAuth, canWrite, async (req, res) => {
    const ruleId = String(req.params.ruleId)
    const tenantId = String(req.body?.tenantId ?? '')
    const reason = String(req.body?.reason ?? '').trim()
    if (!isUuid(tenantId)) { res.status(400).json({ error: 'valid tenantId required' }); return }
    if (!reason) { res.status(400).json({ error: 'reason required for a manual send' }); return }

    const { data: rule } = await supabase.from('platform_nudge_rules').select('*').eq('id', ruleId).maybeSingle()
    if (!rule) { res.status(404).json({ error: 'Unknown rule' }); return }
    const cand = await candidateForTenant(supabase, tenantId)
    if (!cand) { res.status(404).json({ error: 'Unknown tenant' }); return }

    const outcome = await sendNudge(supabase, rule as NudgeRule, cand, {
      source: 'manual', actorUserId: (req as any).user?.id ?? null, force: req.body?.force !== false,
    })
    await recordPlatformAudit(supabase, req, {
      capability: 'announcement.write', action: 'nudge.manual_send', tenant_id: tenantId,
      after: outcome as any, reason,
    })
    res.json(outcome)
  })

  // Run the evaluator now (ops button; the daily scheduler runs it automatically).
  r.post('/api/naruto/nudges/run', requireAuth, canWrite, async (req, res) => {
    const result = await runNudgeTick(supabase)
    await recordPlatformAudit(supabase, req, {
      capability: 'announcement.write', action: 'nudge.run_now', after: result as any,
      reason: 'manual evaluator run',
    })
    res.json(result)
  })

  // ── Platform-team notification inbox (§16) ─────────────────────────────────
  r.get('/api/naruto/platform-notifications', requireAuth, canRead, async (req, res) => {
    const unreadOnly = String(req.query.unread ?? '') === '1'
    let q = supabase.from('platform_notifications').select('*').order('created_at', { ascending: false }).limit(100)
    if (unreadOnly) q = q.is('read_at', null)
    const { data, error } = await q
    if (error) { res.status(500).json({ error: error.message }); return }
    res.json(data ?? [])
  })

  r.get('/api/naruto/platform-notifications/unread-count', requireAuth, canRead, async (_req, res) => {
    const { count, error } = await supabase.from('platform_notifications')
      .select('id', { count: 'exact', head: true }).is('read_at', null)
    if (error) { res.status(500).json({ error: error.message }); return }
    res.json({ count: count ?? 0 })
  })

  r.post('/api/naruto/platform-notifications/:id/read', requireAuth, canRead, async (req, res) => {
    const id = String(req.params.id)
    if (!isUuid(id)) { res.status(400).json({ error: 'bad id' }); return }
    const { error } = await supabase.from('platform_notifications')
      .update({ read_at: new Date().toISOString() }).eq('id', id).is('read_at', null)
    if (error) { res.status(500).json({ error: error.message }); return }
    res.json({ ok: true })
  })

  r.post('/api/naruto/platform-notifications/read-all', requireAuth, canRead, async (_req, res) => {
    const { error } = await supabase.from('platform_notifications')
      .update({ read_at: new Date().toISOString() }).is('read_at', null)
    if (error) { res.status(500).json({ error: error.message }); return }
    res.json({ ok: true })
  })

  // ── Overview needs-attention aggregate (§15) ───────────────────────────────
  // ONE call → every queue's live count. Each value is a number (live) or null
  // (signal genuinely unavailable — FE shows "—", never a fabricated 0).
  r.get('/api/naruto/overview/needs-attention', requireAuth, canRead, async (_req, res) => {
    const now = Date.now()
    const stalledCutoff = new Date(now - 3 * 24 * 3600_000).toISOString()   // >3d
    const dayAgo = new Date(now - 24 * 3600_000).toISOString()
    // Each count is its own query builder (Supabase builders aren't reusable).
    const q = (table: string) => supabase.from(table).select('id', { count: 'exact', head: true })

    const safe = async (p: PromiseLike<{ count: number | null; error: any }>): Promise<number | null> => {
      try { const { count, error } = await p; return error ? null : (count ?? 0) } catch { return null }
    }

    const [
      onboardingStalled, atRisk, suspended, approvalsPending, unreadNotifications,
      paymentFailures, limitsExceeded, breaches,
    ] = await Promise.all([
      // Onboarding stalled >3d — pre-live lifecycle states past the cutoff.
      safe(q('tenants').in('lifecycle_state', ['provisioned', 'configuring', 'ready_to_launch'])
        .lt('state_entered_at', stalledCutoff).is('deleted_at', null)),
      // At-risk — lifecycle recompute flags GMV decline / login gap.
      safe(q('tenants').eq('lifecycle_state', 'at_risk').is('deleted_at', null)),
      // Suspended.
      safe(q('tenants').eq('status', 'suspended').is('deleted_at', null)),
      // Approvals waiting (wave-4 proposals).
      safe(q('platform_action_proposals').eq('status', 'pending')),
      // Unread platform-team notifications (§16).
      safe(q('platform_notifications').is('read_at', null)),
      // Payment/webhook failures — open, last 24h.
      safe(q('webhook_dead_letter').in('source', ['razorpay', 'cashfree', 'payment'])
        .is('replayed_at', null).gte('created_at', dayAgo)),
      // Plan limits exceeded — emitted by the nudge evaluator as notifications.
      safe(q('platform_notifications').eq('kind', 'limit.exceeded').is('read_at', null)),
      // Breach notifications — unread breach-kind alerts (emitter WIRE-noted on
      // the breach worker; 0 until wired — honest, not fabricated).
      safe(q('platform_notifications').eq('kind', 'breach.open').is('read_at', null)),
    ])

    res.json({
      counts: {
        onboarding_stalled: onboardingStalled,
        kyc_pending: null,               // no Route/KYC sync yet → "—" (not fabricated)
        suspended,
        payment_failures: paymentFailures,
        limits_exceeded: limitsExceeded,
        approvals_pending: approvalsPending,
        breaches,
        at_risk: atRisk,
        unread_notifications: unreadNotifications,
      },
    })
  })

  return r
}
