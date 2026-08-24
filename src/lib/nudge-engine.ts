/**
 * Nudge engine (Naruto §6) + platform-team notification emission (§16).
 *
 * A rules table (platform_nudge_rules) drives automated email/WhatsApp sequences
 * fired when a tenant's onboarding stalls ("menu up but payments not connected").
 * A DAILY evaluator (runNudgeTick) — reusing the existing in-process
 * daily-scheduler, NOT a new worker loop — selects candidate tenants per rule,
 * respects each rule's cooldown (platform_nudge_log), and sends via the EXISTING
 * send paths: email (lib/email.sendEmail) + WhatsApp (lib/whatsapp-notifications.
 * sendWaNotification). Operators can also fire a rule manually from /naruto
 * (sendNudge with source:'manual', force to bypass cooldown).
 *
 * The same tick also emits §16 platform_notifications for signals that need
 * periodic detection — onboarding stalls, plan-limit breaches, payment-failure
 * spikes — each deduped through platform_nudge_log's '__notify_*' markers so the
 * platform team is alerted at most once per window. (Break-glass + approval-
 * waiting are emitted inline at their action sites in routes/platform-approvals.
 * ts; suspensions/KYC/breach are WIRE-noted at their sites.)
 *
 * Pure-ish + decoupled: no express here. It inlines a 5-line platform_notifications
 * insert rather than importing routes/platform-approvals.notifyPlatformTeam (a
 * lib must not depend on a route module). Same table, same shape.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { sendEmail, emailConfigured } from './email'
import { sendWaNotification } from './whatsapp-notifications'
import { checkLimit, type LimitMetric } from './limits'
import { ONBOARDING_STEP_KEYS, type OnboardingStepKey } from './activation-score'

// ── Types ─────────────────────────────────────────────────────────────────────
export interface NudgeRule {
  id: string
  label: string
  description?: string | null
  trigger: string
  condition: Record<string, any>
  channel: 'email' | 'whatsapp' | 'both'
  template_key: string
  cooldown_hours: number
  enabled: boolean
}

/** A tenant selected by a trigger, with the context a template needs. */
export interface Candidate {
  tenantId: string
  tenantName: string
  ownerEmail: string | null
  ownerUserId: string | null
  context: Record<string, any>
}

export interface SendOutcome {
  tenantId: string
  ruleId: string
  status: 'sent' | 'failed' | 'skipped'
  detail?: string
}

// ── Message templates (keyed by rule.template_key) ─────────────────────────────
// Kept tiny + inline — these are transactional operator nudges, not marketing
// campaigns. Reuse the merchant dashboard link; no brand chrome needed.
interface Template { subject: (c: Candidate) => string; text: (c: Candidate) => string }
// Fallback is the APEX. `app.getfrequency.app` is not a Vercel domain on this
// account (frequency-fe serves getfrequency.app + www only), so it 404s —
// which meant an unset DASHBOARD_URL silently mailed merchants dead links.
const DASH = process.env.DASHBOARD_URL || 'https://getfrequency.app'

export const TEMPLATES: Record<string, Template> = {
  catalog_done_payments_pending: {
    subject: c => `${c.tenantName}: connect payments to start taking orders`,
    text: c =>
      `Your catalog is live on ${c.tenantName} — the last step before you can take real orders is connecting payments.\n\n` +
      `Finish it here: ${DASH}/settings/payments\n\nNeed a hand? Just reply to this email.`,
  },
  onboarding_stalled: {
    subject: c => `${c.tenantName}: pick up where you left off`,
    text: c =>
      `Your Frequency setup is paused partway. A few more steps and you're ready to go live.\n\n` +
      `Resume: ${DASH}\n\nReply if anything's blocking you — we'll sort it.`,
  },
  no_first_order: {
    subject: c => `${c.tenantName}: let's get your first order in`,
    text: c =>
      `You're live but haven't taken a first order yet. Share your storefront link or QR to start.\n\n` +
      `Your storefront + QR: ${DASH}/storefront\n\nWant us to review your setup? Reply here.`,
  },
}

function templateFor(key: string): Template {
  // Fail-soft to a generic nudge so a mis-keyed rule still sends something useful.
  return TEMPLATES[key] ?? {
    subject: c => `${c.tenantName}: a quick nudge from Frequency`,
    text: () => `You have an open setup step on Frequency. Continue here: ${DASH}`,
  }
}

// ── Owner resolution ───────────────────────────────────────────────────────────
/** Owner email (billing_email, else the auth user) + owner user id (for WhatsApp). */
async function resolveOwner(sb: SupabaseClient, tenant: any): Promise<{ email: string | null; userId: string | null }> {
  const userId = tenant.user_id ?? null
  let email: string | null = tenant.billing_email ?? null
  if (!email && userId) {
    const { data } = await sb.auth.admin.getUserById(userId)
    email = data?.user?.email ?? null
  }
  return { email, userId }
}

// ── Trigger evaluators (registry) ──────────────────────────────────────────────
// Each returns the tenants a rule should nudge. Trigger params come from
// rule.condition. Add a trigger here + reference it by key from a rule row.
type TriggerFn = (sb: SupabaseClient, rule: NudgeRule) => Promise<Candidate[]>

const NOT_DELETED = (q: any) => q.is('deleted_at', null)

async function toCandidates(sb: SupabaseClient, tenants: any[], ctx: (t: any) => Record<string, any> = () => ({})): Promise<Candidate[]> {
  const out: Candidate[] = []
  for (const t of tenants) {
    const { email, userId } = await resolveOwner(sb, t)
    out.push({
      tenantId: t.id,
      tenantName: t.business_name || t.slug || t.id,
      ownerEmail: email, ownerUserId: userId, context: ctx(t),
    })
  }
  return out
}

/** Build a Candidate for one tenant — used by the operator manual-send override. */
export async function candidateForTenant(sb: SupabaseClient, tenantId: string): Promise<Candidate | null> {
  const { data: t } = await sb.from('tenants')
    .select('id, business_name, slug, user_id, billing_email').eq('id', tenantId).maybeSingle()
  if (!t) return null
  const [c] = await toCandidates(sb, [t])
  return c ?? null
}

export const TRIGGERS: Record<string, TriggerFn> = {
  /** A specific onboarding step is not done while its prerequisites are, and the
   *  tenant has been stalled `min_hours`. Covers "catalog done, payments pending". */
  step_stalled: async (sb, rule) => {
    const step = String(rule.condition.step ?? '') as OnboardingStepKey
    if (!ONBOARDING_STEP_KEYS.includes(step)) return []
    const requires: OnboardingStepKey[] = Array.isArray(rule.condition.requires_done) ? rule.condition.requires_done : []
    const minHours = Number(rule.condition.min_hours ?? 72)
    const cutoff = new Date(Date.now() - minHours * 3600_000).toISOString()

    // Stalled tenants (still in a pre-live state past the cutoff).
    const { data: tenants } = await NOT_DELETED(
      sb.from('tenants')
        .select('id, business_name, slug, user_id, billing_email, lifecycle_state, state_entered_at')
        .in('lifecycle_state', ['provisioned', 'configuring', 'ready_to_launch'])
        .lt('state_entered_at', cutoff),
    )
    if (!tenants?.length) return []

    // Filter by checklist: step not done AND all prerequisites done.
    const ids = tenants.map((t: any) => t.id)
    const { data: checklists } = await sb.from('tenant_onboarding_checklists')
      .select('tenant_id, steps').in('tenant_id', ids)
    const byTenant = new Map<string, any>((checklists ?? []).map((c: any) => [c.tenant_id, c.steps ?? {}]))
    const matched = tenants.filter((t: any) => {
      const steps = byTenant.get(t.id) ?? {}
      const stepDone = steps[step]?.status === 'done'
      const prereqDone = requires.every(k => steps[k]?.status === 'done')
      return !stepDone && prereqDone
    })
    return toCandidates(sb, matched, () => ({ step }))
  },

  /** Tenant sitting in a pre-live lifecycle state past `min_hours`. */
  lifecycle_stalled: async (sb, rule) => {
    const states: string[] = Array.isArray(rule.condition.states)
      ? rule.condition.states : ['provisioned', 'configuring', 'ready_to_launch']
    const minHours = Number(rule.condition.min_hours ?? 72)
    const cutoff = new Date(Date.now() - minHours * 3600_000).toISOString()
    const { data: tenants } = await NOT_DELETED(
      sb.from('tenants')
        .select('id, business_name, slug, user_id, billing_email, lifecycle_state, state_entered_at')
        .in('lifecycle_state', states)
        .lt('state_entered_at', cutoff),
    )
    return toCandidates(sb, tenants ?? [], (t: any) => ({ state: t.lifecycle_state }))
  },

  /** Tenant is live/healthy but has no first_order activation event after min_hours. */
  no_first_order: async (sb, rule) => {
    const minHours = Number(rule.condition.min_hours ?? 72)
    const cutoff = new Date(Date.now() - minHours * 3600_000).toISOString()
    const { data: tenants } = await NOT_DELETED(
      sb.from('tenants')
        .select('id, business_name, slug, user_id, billing_email, lifecycle_state, state_entered_at')
        .in('lifecycle_state', ['live', 'healthy'])
        .lt('state_entered_at', cutoff),
    )
    if (!tenants?.length) return []
    const ids = tenants.map((t: any) => t.id)
    const { data: firsts } = await sb.from('activation_events')
      .select('tenant_id').eq('step', 'first_order').in('tenant_id', ids)
    const hasFirst = new Set((firsts ?? []).map((r: any) => r.tenant_id))
    return toCandidates(sb, tenants.filter((t: any) => !hasFirst.has(t.id)))
  },
}

// ── Cooldown / dedupe ──────────────────────────────────────────────────────────
/** True when no successful send for (tenant, ruleId) inside the cooldown window. */
export async function cooldownOk(sb: SupabaseClient, tenantId: string, ruleId: string, cooldownHours: number): Promise<boolean> {
  const since = new Date(Date.now() - cooldownHours * 3600_000).toISOString()
  const { data } = await sb.from('platform_nudge_log')
    .select('id').eq('tenant_id', tenantId).eq('rule_id', ruleId).eq('status', 'sent')
    .gte('sent_at', since).limit(1)
  return !(data && data.length)
}

async function logNudge(sb: SupabaseClient, row: {
  tenantId: string; ruleId: string; channel?: string | null; status: 'sent' | 'failed' | 'skipped';
  detail?: string; source?: 'auto' | 'manual'; actorUserId?: string | null
}): Promise<void> {
  try {
    await sb.from('platform_nudge_log').insert({
      tenant_id: row.tenantId, rule_id: row.ruleId, channel: row.channel ?? null,
      status: row.status, detail: row.detail ?? null,
      source: row.source ?? 'auto', actor_user_id: row.actorUserId ?? null,
    })
  } catch (e) { console.error('[nudge] log insert failed', e) }
}

// ── §16 platform-team notification emit (inlined; same table/shape as
//    routes/platform-approvals.notifyPlatformTeam — see file header for why). ────
//
// WIRE(naruto) — emitters that belong at prior-wave call sites (NOT edited here;
// each is a one-liner calling notifyTeam(sb, {...}) at the site of the event):
//   • Suspension — routes/super-admin.ts POST /tenants/:id/suspend (~:213), after
//       the status flip succeeds:
//         notifyTeam(sb, { kind:'tenant.suspended', severity:'warn', tenant_id:id,
//           title:`Tenant suspended: ${name}`, body: reason })
//     (Break-glass + approval-waiting already emit from routes/platform-approvals.ts.)
//   • KYC rejection — when the Razorpay Route sync lands in routes/naruto-payments.ts
//       (route-account setter), on a 'rejected'/'action_required' KYC status:
//         notifyTeam(sb, { kind:'kyc.rejected', severity:'warn', tenant_id, title, body })
//     No Route/KYC sync exists yet → the Overview 'KYC pending' count stays null ("—").
//   • Breach — workers/breach-notification-sender.ts, when a breach incident opens:
//         notifyTeam(sb, { kind:'breach.open', severity:'critical', tenant_id, title, body })
//     Until wired, the Overview 'breaches' count reads unread kind='breach.open' = 0.
// The daily tick below already emits onboarding.stalled / limit.exceeded /
// payments.failure_spike itself (periodic detection — no natural single call site).
export async function notifyTeam(sb: SupabaseClient, n: {
  kind: string; title: string; body?: string; severity?: 'info' | 'warn' | 'critical';
  ref_type?: string; ref_id?: string; tenant_id?: string | null
}): Promise<void> {
  try {
    await sb.from('platform_notifications').insert({
      kind: n.kind, title: n.title, body: n.body ?? null, severity: n.severity ?? 'info',
      ref_type: n.ref_type ?? null, ref_id: n.ref_id ?? null, tenant_id: n.tenant_id ?? null,
    })
  } catch (e) { console.error('[nudge] notify insert failed', e) }
}

/** Emit a notification at most once per (tenant|scope, key) within windowHours,
 *  deduped via a '__notify_<key>' marker row in platform_nudge_log. */
async function notifyOnce(sb: SupabaseClient, opts: {
  key: string; tenantId: string | null; windowHours: number;
  kind: string; title: string; body?: string; severity?: 'info' | 'warn' | 'critical'; ref_type?: string
}): Promise<boolean> {
  const marker = `__notify_${opts.key}`
  const scopeId = opts.tenantId ?? '00000000-0000-0000-0000-000000000000'
  if (!(await cooldownOk(sb, scopeId, marker, opts.windowHours))) return false
  await notifyTeam(sb, {
    kind: opts.kind, title: opts.title, body: opts.body, severity: opts.severity,
    ref_type: opts.ref_type, tenant_id: opts.tenantId,
  })
  await logNudge(sb, { tenantId: scopeId, ruleId: marker, status: 'sent', detail: opts.kind })
  return true
}

// ── Sending ────────────────────────────────────────────────────────────────────
/**
 * Send one rule's nudge to one tenant. Respects cooldown unless `force` (operator
 * override). Returns the outcome and always logs it. Never throws.
 */
export async function sendNudge(
  sb: SupabaseClient, rule: NudgeRule, cand: Candidate,
  opts: { source?: 'auto' | 'manual'; actorUserId?: string | null; force?: boolean } = {},
): Promise<SendOutcome> {
  const source = opts.source ?? 'auto'
  if (!opts.force && !(await cooldownOk(sb, cand.tenantId, rule.id, rule.cooldown_hours))) {
    return { tenantId: cand.tenantId, ruleId: rule.id, status: 'skipped', detail: 'cooldown' }
  }

  const tpl = templateFor(rule.template_key)
  const subject = tpl.subject(cand)
  const text = tpl.text(cand)
  const wantEmail = rule.channel === 'email' || rule.channel === 'both'
  const wantWa = rule.channel === 'whatsapp' || rule.channel === 'both'

  const notes: string[] = []
  let anySent = false

  if (wantEmail) {
    if (!cand.ownerEmail) notes.push('email:no-owner-email')
    else if (!emailConfigured()) notes.push('email:not-configured')
    else {
      try {
        await sendEmail({ to: cand.ownerEmail, subject, html: `<p>${text.replace(/\n/g, '<br>')}</p>`, text })
        anySent = true; notes.push('email:sent')
      } catch (e: any) { notes.push(`email:fail(${e?.message ?? e})`) }
    }
  }

  if (wantWa) {
    // Fail-soft: early-onboarding tenants usually have no WABA yet (that IS a
    // later step), so WhatsApp nudges degrade to a logged 'failed' note while
    // the email lands. Honest, not silent.
    if (!cand.ownerUserId) notes.push('wa:no-owner')
    else {
      try {
        await sendWaNotification(sb, { tenantId: cand.tenantId, userId: cand.ownerUserId, title: subject, body: text })
        anySent = true; notes.push('wa:sent')
      } catch (e: any) { notes.push(`wa:fail(${e?.message ?? e})`) }
    }
  }

  const status: SendOutcome['status'] = anySent ? 'sent' : 'failed'
  await logNudge(sb, { tenantId: cand.tenantId, ruleId: rule.id, channel: rule.channel, status, detail: notes.join('; '), source, actorUserId: opts.actorUserId })
  return { tenantId: cand.tenantId, ruleId: rule.id, status, detail: notes.join('; ') }
}

// ── Daily evaluator ─────────────────────────────────────────────────────────────
export interface TickResult {
  rulesEvaluated: number
  sent: number
  skipped: number
  failed: number
  notified: number
}

/** Load enabled rules → evaluate triggers → send (cooldown-gated) → emit §16
 *  notifications for stalls / limit breaches / payment-failure spikes. Idempotent
 *  across ticks via cooldown + notify-once markers. Called by the daily scheduler
 *  AND reusable for a manual "run now" from /naruto. */
export async function runNudgeTick(sb: SupabaseClient): Promise<TickResult> {
  const res: TickResult = { rulesEvaluated: 0, sent: 0, skipped: 0, failed: 0, notified: 0 }

  const { data: rules } = await sb.from('platform_nudge_rules').select('*').eq('enabled', true)
  for (const rule of (rules ?? []) as NudgeRule[]) {
    const trigger = TRIGGERS[rule.trigger]
    if (!trigger) { console.warn(`[nudge] rule ${rule.id}: unknown trigger '${rule.trigger}'`); continue }
    res.rulesEvaluated++
    let candidates: Candidate[] = []
    try { candidates = await trigger(sb, rule) }
    catch (e) { console.error(`[nudge] trigger ${rule.trigger} failed`, e); continue }

    for (const cand of candidates) {
      const out = await sendNudge(sb, rule, cand, { source: 'auto' })
      res[out.status]++
      // §16: a stalled onboarding is also a platform-team signal — notify once.
      if (rule.trigger !== 'no_first_order') {
        const did = await notifyOnce(sb, {
          key: `onboarding_stalled_${cand.tenantId}`, tenantId: cand.tenantId, windowHours: 96,
          kind: 'onboarding.stalled', severity: 'warn', ref_type: 'tenant',
          title: `Onboarding stalled: ${cand.tenantName}`,
          body: `Blocked on '${cand.context.step ?? cand.context.state ?? 'setup'}' past the ${rule.cooldown_hours}h mark.`,
        })
        if (did) res.notified++
      }
    }
  }

  // §16: plan-limit breaches + payment-failure spikes (periodic detection).
  res.notified += await emitLimitBreachNotifications(sb)
  res.notified += await emitPaymentSpikeNotifications(sb)
  return res
}

// Metrics worth alerting the platform team about (a hard-cap breach = the tenant
// is blocked from a core action, an upsell/support signal).
const ALERT_METRICS: LimitMetric[] = ['team_size_max', 'contacts_max', 'messages_per_month']

/** Emit 'limit.exceeded' notifications for tenants at a hard cap. ponytail:
 *  loops active tenants × 3 metrics (fine at platform scale, ~dozens of tenants);
 *  if tenant count grows into the thousands, materialize usage in a nightly
 *  rollup table and read that instead. */
export async function emitLimitBreachNotifications(sb: SupabaseClient): Promise<number> {
  let n = 0
  const { data: tenants } = await sb.from('tenants')
    .select('id, business_name, slug').eq('status', 'active').is('deleted_at', null)
  for (const t of (tenants ?? []) as any[]) {
    for (const metric of ALERT_METRICS) {
      let check
      try { check = await checkLimit(sb, t.id, metric) } catch { continue }
      if (check.allowed || check.max < 0) continue
      const did = await notifyOnce(sb, {
        key: `limit_${metric}_${t.id}`, tenantId: t.id, windowHours: 24 * 7,
        kind: 'limit.exceeded', severity: 'warn', ref_type: 'tenant',
        title: `Plan limit reached: ${t.business_name || t.slug}`,
        body: `${metric} at ${check.current}/${check.max}${check.upgrade_to ? ` — upsell to ${check.upgrade_to}` : ''}.`,
      })
      if (did) n++
    }
  }
  return n
}

/** Emit a 'payments.failure_spike' notification when open payment webhook
 *  failures in the last 24h cross a threshold. Global signal (not tenant-scoped).*/
export async function emitPaymentSpikeNotifications(sb: SupabaseClient): Promise<number> {
  const SPIKE = Number(process.env.NUDGE_PAYMENT_SPIKE_THRESHOLD ?? 5)
  const since = new Date(Date.now() - 24 * 3600_000).toISOString()
  const { count } = await sb.from('webhook_dead_letter')
    .select('id', { count: 'exact', head: true })
    .in('source', ['razorpay', 'cashfree', 'payment'])
    .is('replayed_at', null).gte('created_at', since)
  if ((count ?? 0) < SPIKE) return 0
  const did = await notifyOnce(sb, {
    key: 'payment_spike', tenantId: null, windowHours: 6,
    kind: 'payments.failure_spike', severity: 'critical', ref_type: 'audit',
    title: `Payment failure spike: ${count} in 24h`,
    body: `${count} unreplayed payment webhook failures in the last 24h (threshold ${SPIKE}).`,
  })
  return did ? 1 : 0
}
