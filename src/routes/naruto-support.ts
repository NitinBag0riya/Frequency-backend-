/**
 * Naruto Platform OS §7 — Support console (server side).
 *
 * The operator "solve any tenant problem from this panel without SQL" surface.
 * Everything here runs server-side against REAL data with the wave-1 capability
 * guard + audit; nothing is faked. Where a health check needs a source that
 * isn't in this DB, it returns `ok:null` ("unknown") with a WIRE note in its
 * remediation rather than a fabricated green.
 *
 *   GET  /api/naruto/tenants/:id/diagnostics          health checks   (diagnostics.read)
 *   GET  /api/naruto/tenants/:id/timeline             merged feed     (tenant.read)
 *   GET  /api/naruto/tenants/:id/notes                internal notes  (tenant.read)
 *   POST /api/naruto/tenants/:id/notes                add note        (support.fix.run)
 *   DELETE /api/naruto/tenants/:id/notes/:noteId      remove note     (support.fix.run)
 *   POST /api/naruto/tenants/:id/fixes/:action        one-click fix   (per-action cap)
 *
 * Impersonation is NOT re-implemented here — the Support console calls the
 * existing wave-1 endpoints (super-admin.ts POST /tenants/:id/impersonate +
 * /impersonate/claim + /impersonate/stop) via the FE lib/impersonation.ts.
 *
 * WIRE(naruto): register in index.ts next to the other naruto routers (~:5992):
 *   import { createNarutoSupportRouter } from './routes/naruto-support'
 *   app.use(createNarutoSupportRouter({ supabase, requireAuth }))
 * Router declares full /api/naruto/* paths, so mount at root (no prefix).
 */
import express from 'express'
import type { SupabaseClient } from '@supabase/supabase-js'
import { requirePlatformCapability, resolvePlatformRole } from '../lib/platform-guard'
import { recordPlatformAudit } from '../lib/platform-audit'
import { can, normalizeRole, type PlatformCapability } from '../lib/platform-rbac'
import { buildInviteEmail } from './invitations'
import { sendEmail } from '../lib/email'

type Mw = (req: express.Request, res: express.Response, next: express.NextFunction) => void | Promise<void>
interface Deps { supabase: SupabaseClient; requireAuth: Mw }

const DAY = 86_400_000

// ── Diagnostics contract ──────────────────────────────────────────────────────
// Each check is a pure verdict over data gathered server-side:
//   ok = true   → healthy (green)
//   ok = false  → problem (red/amber); `remediation` says what to do, `fix` names
//                 the one-click action key when one applies
//   ok = null   → UNKNOWN — the source isn't wired yet; `remediation` is a WIRE
//                 note naming the exact source needed. Never a fabricated green.
export interface DiagnosticCheck {
  key: string
  label: string
  ok: boolean | null
  verdict: string
  remediation: string | null
  fix?: string | null
}

// ── One-click fix registry (§7) ──────────────────────────────────────────────
// `wired: true` fixes are performed here (audited). `wired: false` fixes name the
// EXACT endpoint that must exist to perform them — the FE surfaces the note and
// dispatch returns 501 rather than pretending it worked. `replay-webhook` and
// `impersonate` already have live endpoints elsewhere; the FE calls those directly.
export interface FixSpec { cap: PlatformCapability; wired: boolean; label: string; endpoint?: string }
export const FIX_REGISTRY: Record<string, FixSpec> = {
  'resend-invite': {
    cap: 'support.invite.resend', wired: true,
    label: 'Resend owner invite',
  },
  'revoke-session': {
    cap: 'support.session.revoke', wired: false,
    label: 'Revoke owner sessions',
    endpoint: 'POST /api/naruto/tenants/:id/revoke-sessions → GoTrue admin sign-out for the tenant owner (auth.admin logout: DELETE /admin/users/{userId}/sessions via the service key; supabase-js has no per-user helper, so call the GoTrue admin REST endpoint directly). Audit under support.session.revoke.',
  },
  'replay-webhook': {
    cap: 'support.fix.run', wired: false,
    label: 'Replay failed webhooks',
    endpoint: 'POST /api/super-admin/webhook-failures/:deadLetterId/replay — ALREADY EXISTS (super-admin.ts:1125). The console calls it per failed row; no new endpoint needed.',
  },
  'resync-aggregator-menu': {
    cap: 'support.fix.run', wired: false,
    label: 'Re-sync aggregator menu',
    endpoint: 'POST /api/naruto/tenants/:id/aggregator/:channel/resync-menu → push the current catalog to Swiggy/Zomato via the desktop bridge (project_frequency_desktop / DynoAPIs adapter). Audit under support.fix.run.',
  },
  'reissue-qr': {
    cap: 'support.fix.run', wired: false,
    label: 'Re-issue QR pack',
    endpoint: 'POST /api/naruto/tenants/:id/qr/reissue → regenerate the table/outlet/general QR pack (see FE components/admin/storefront/NarutoQrPack). Audit under support.fix.run.',
  },
  'clear-stuck-order': {
    cap: 'support.fix.run', wired: false,
    label: 'Clear a stuck order',
    endpoint: 'POST /api/naruto/orders/:orderId/force-resolve → drive the order through the server-enforced state machine (reference_order_lifecycle_rules). Needs the order id from §8 stuck-orders queue. Audit under support.fix.run.',
  },
  'retrigger-notification': {
    cap: 'support.fix.run', wired: false,
    label: 'Re-trigger a notification',
    endpoint: 'POST /api/naruto/tenants/:id/notifications/:notificationId/resend → re-enqueue through the notify pipeline (routes/notifications.ts). Audit under support.fix.run.',
  },
  'purge-cdn': {
    cap: 'support.fix.run', wired: false,
    label: 'Purge CDN cache',
    endpoint: 'POST /api/naruto/tenants/:id/purge-cdn → purge the tenant storefront edge/CDN cache (Vercel purge API for the tenant slug + custom domains). Audit under support.fix.run.',
  },
}

// ─────────────────────────────────────────────────────────────────────────────
// Diagnostics — gather signals off the existing dashboard-DB rails, best-effort
// per source (a failed read degrades to `unknown`, never throws the whole panel).
// ─────────────────────────────────────────────────────────────────────────────
export async function runDiagnostics(supabase: SupabaseClient, tenantId: string): Promise<DiagnosticCheck[]> {
  const now = Date.now()
  const checks: DiagnosticCheck[] = []

  const { data: tenant } = await supabase.from('tenants')
    .select('id, slug, status, last_active_at, business_type').eq('id', tenantId).maybeSingle()
  const t = tenant as any

  // 1. Storefront reachable — slug + custom-domain verification/SSL.
  try {
    const { data: domains } = await supabase.from('tenant_domains')
      .select('hostname, kind, is_primary, verified, ssl_status').eq('tenant_id', tenantId)
    const custom = (domains ?? []).filter((d: any) => d.kind === 'custom')
    if (!t?.slug) {
      checks.push({ key: 'storefront', label: 'Storefront reachable', ok: null,
        verdict: 'No storefront slug on this tenant — cannot resolve a store URL.',
        remediation: 'Run onboarding Step 4 (storefront setup) to provision the slug.' })
    } else if (custom.length && !custom.some((d: any) => d.verified && d.ssl_status === 'active')) {
      const d = custom[0]
      checks.push({ key: 'storefront', label: 'Storefront reachable', ok: false,
        verdict: `Base store live at order.getfrequency.app/${t.slug}, but custom domain ${d.hostname} is ${d.verified ? 'verified' : 'unverified'} / SSL ${d.ssl_status}.`,
        remediation: 'Finish DNS + SSL in Storefront setup (copy-paste records); recheck the domain.' })
    } else {
      checks.push({ key: 'storefront', label: 'Storefront reachable', ok: true,
        verdict: custom.length
          ? `Live at ${custom[0].hostname} (verified, SSL active).`
          : `Live at order.getfrequency.app/${t.slug}.`,
        remediation: null })
    }
  } catch {
    checks.push({ key: 'storefront', label: 'Storefront reachable', ok: null,
      verdict: 'Could not read storefront domains.', remediation: 'Transient read error — retry.' })
  }

  // 2. Payment gateway configured — lives in storefront-api's DB, not this one.
  checks.push({ key: 'payment_gateway', label: 'Payment gateway configured', ok: null,
    verdict: 'Gateway config (Razorpay routeAccountId + online-payments toggle) lives in storefront-api, not the dashboard DB.',
    remediation: 'WIRE(naruto): read storefront-api GET /admin/config (X-Tenant-ID) for { onlinePaymentsEnabled, routeAccountId } and verdict on those. Until then, verify in Payments (§5 Step 5).' })

  // 3. WhatsApp templates approved.
  try {
    const { data: tpls } = await supabase.from('wa_templates')
      .select('status').eq('tenant_id', tenantId)
    if (!tpls || tpls.length === 0) {
      checks.push({ key: 'whatsapp_templates', label: 'WhatsApp templates approved', ok: null,
        verdict: 'No WhatsApp templates on record — tenant may not use WA messaging.',
        remediation: 'If they should: submit templates for approval in Comms (§5 Step 6).' })
    } else {
      const approved = tpls.filter((x: any) => x.status === 'approved').length
      const rejected = tpls.filter((x: any) => x.status === 'rejected').length
      const pending = tpls.filter((x: any) => x.status === 'pending').length
      if (rejected > 0) {
        checks.push({ key: 'whatsapp_templates', label: 'WhatsApp templates approved', ok: false,
          verdict: `${rejected} template(s) rejected by Meta, ${approved} approved, ${pending} pending.`,
          remediation: 'Fix and resubmit the rejected templates (Comms).' })
      } else if (approved === 0) {
        checks.push({ key: 'whatsapp_templates', label: 'WhatsApp templates approved', ok: false,
          verdict: `No approved templates yet (${pending} pending review).`,
          remediation: 'Awaiting Meta approval — chase if stuck > 24h.' })
      } else {
        checks.push({ key: 'whatsapp_templates', label: 'WhatsApp templates approved', ok: true,
          verdict: `${approved} approved${pending ? `, ${pending} pending` : ''}.`, remediation: null })
      }
    }
  } catch {
    checks.push({ key: 'whatsapp_templates', label: 'WhatsApp templates approved', ok: null,
      verdict: 'Could not read WhatsApp templates.', remediation: 'Transient read error — retry.' })
  }

  // 4. Webhooks delivering — recent unreplayed dead-letters.
  try {
    const since = new Date(now - DAY).toISOString()
    const { data: dead } = await supabase.from('webhook_dead_letter')
      .select('id, source, direction').eq('tenant_id', tenantId)
      .is('replayed_at', null).gte('created_at', since)
    const n = dead?.length ?? 0
    checks.push(n === 0
      ? { key: 'webhooks', label: 'Webhooks delivering', ok: true,
          verdict: 'No failed webhooks in the last 24h.', remediation: null }
      : { key: 'webhooks', label: 'Webhooks delivering', ok: false,
          verdict: `${n} webhook(s) dead-lettered in the last 24h (${[...new Set((dead ?? []).map((d: any) => d.source))].join(', ')}).`,
          remediation: 'Replay them once the upstream is healthy.', fix: 'replay-webhook' })
  } catch {
    checks.push({ key: 'webhooks', label: 'Webhooks delivering', ok: null,
      verdict: 'Could not read webhook dead-letter queue.', remediation: 'Transient read error — retry.' })
  }

  // 5. Aggregator sync current — most-recent aggregator order as a freshness proxy.
  try {
    const { data: last } = await supabase.from('aggregator_orders')
      .select('created_at, placed_at').eq('tenant_id', tenantId)
      .order('created_at', { ascending: false }).limit(1).maybeSingle()
    const l = last as any
    if (!l) {
      checks.push({ key: 'aggregator_sync', label: 'Aggregator sync current', ok: null,
        verdict: 'No aggregator orders on record — cannot tell if Swiggy/Zomato is unconfigured or just quiet.',
        remediation: 'WIRE(naruto): add a per-channel last_sync_at source (outlet channel sync state) to distinguish not-configured from stale.', fix: 'resync-aggregator-menu' })
    } else {
      const ageH = (now - new Date(l.placed_at ?? l.created_at).getTime()) / 3_600_000
      checks.push(ageH <= 48
        ? { key: 'aggregator_sync', label: 'Aggregator sync current', ok: true,
            verdict: `Last aggregator order ${Math.round(ageH)}h ago.`, remediation: null }
        : { key: 'aggregator_sync', label: 'Aggregator sync current', ok: false,
            verdict: `No aggregator order in ${Math.round(ageH / 24)}d — sync may be stale or the tenant is quiet.`,
            remediation: 'Re-sync the menu / check the desktop bridge is online.', fix: 'resync-aggregator-menu' })
    }
  } catch {
    checks.push({ key: 'aggregator_sync', label: 'Aggregator sync current', ok: null,
      verdict: 'Could not read aggregator orders.', remediation: 'Transient read error — retry.' })
  }

  // 6. Owner last login.
  if (!t?.last_active_at) {
    checks.push({ key: 'owner_last_login', label: 'Owner last login', ok: null,
      verdict: 'No login recorded — the owner may never have signed in.',
      remediation: 'Resend the owner invite and nudge them to log in once.', fix: 'resend-invite' })
  } else {
    const ageD = (now - new Date(t.last_active_at).getTime()) / DAY
    checks.push(ageD <= 30
      ? { key: 'owner_last_login', label: 'Owner last login', ok: true,
          verdict: `Owner active ${ageD < 1 ? 'today' : `${Math.round(ageD)}d ago`}.`, remediation: null }
      : { key: 'owner_last_login', label: 'Owner last login', ok: false,
          verdict: `Owner not seen in ${Math.round(ageD)}d — churn risk.`,
          remediation: 'Reach out; consider a re-engagement nudge.' })
  }

  // 7. Plan limits exceeded — no usage-vs-limit engine in this DB yet.
  checks.push({ key: 'plan_limits', label: 'Plan limits within bounds', ok: null,
    verdict: 'No usage-vs-limit engine present to evaluate outlets/seats/sends/items against plan caps.',
    remediation: 'WIRE(naruto): once §3 plan limits (soft_cap/hard_cap) + usage counters land, compare live usage to the plan and verdict here.' })

  return checks
}

// ─────────────────────────────────────────────────────────────────────────────
// Timeline — merge signup + lifecycle + platform audit + notes + errors.
// ─────────────────────────────────────────────────────────────────────────────
interface TimelineItem {
  ts: string
  kind: 'signup' | 'lifecycle' | 'audit' | 'note' | 'error'
  title: string
  detail?: string | null
  actor?: string | null
}

async function buildTimeline(supabase: SupabaseClient, tenantId: string): Promise<TimelineItem[]> {
  const items: TimelineItem[] = []

  const { data: t } = await supabase.from('tenants')
    .select('created_at, lifecycle_state, state_entered_at, business_name').eq('id', tenantId).maybeSingle()
  const tr = t as any
  if (tr?.created_at) items.push({ ts: tr.created_at, kind: 'signup', title: 'Tenant created', detail: tr.business_name ?? null })
  if (tr?.state_entered_at && tr?.lifecycle_state) {
    items.push({ ts: tr.state_entered_at, kind: 'lifecycle', title: `Lifecycle → ${tr.lifecycle_state}`, detail: null })
  }

  // Platform audit rows targeting this tenant (config/plan/payment/support actions).
  const { data: audit } = await supabase.from('super_admin_audit')
    .select('created_at, action, capability, actor_role, reason')
    .eq('target_tenant_id', tenantId).order('created_at', { ascending: false }).limit(60)
  for (const a of (audit ?? []) as any[]) {
    items.push({ ts: a.created_at, kind: 'audit', title: a.action || a.capability || 'platform action',
      detail: a.reason ?? null, actor: a.actor_role ?? null })
  }

  // Internal notes.
  const { data: notes } = await supabase.from('tenant_notes')
    .select('created_at, body, author_role').eq('tenant_id', tenantId)
    .order('created_at', { ascending: false }).limit(40)
  for (const n of (notes ?? []) as any[]) {
    items.push({ ts: n.created_at, kind: 'note', title: 'Internal note', detail: n.body, actor: n.author_role ?? null })
  }

  // Errors — dead-lettered webhooks.
  const { data: dead } = await supabase.from('webhook_dead_letter')
    .select('created_at, source, direction, last_error').eq('tenant_id', tenantId)
    .order('created_at', { ascending: false }).limit(30)
  for (const d of (dead ?? []) as any[]) {
    items.push({ ts: d.created_at, kind: 'error', title: `Webhook failed: ${d.source} (${d.direction})`, detail: d.last_error ?? null })
  }

  return items
    .filter(i => i.ts)
    .sort((a, b) => new Date(b.ts).getTime() - new Date(a.ts).getTime())
    .slice(0, 120)
}

// ─────────────────────────────────────────────────────────────────────────────
// Wired fix: resend owner invite. Resolves the owner email, finds the latest
// UNUSED invitation_code for it, and re-sends via the same buildInviteEmail +
// sendEmail path the existing invite endpoint uses (no duplication).
// ─────────────────────────────────────────────────────────────────────────────
async function resendOwnerInvite(supabase: SupabaseClient, tenantId: string):
  Promise<{ ok: true; email: string } | { ok: false; status: number; message: string }> {
  const { data: t } = await supabase.from('tenants')
    .select('user_id, billing_email').eq('id', tenantId).maybeSingle()
  const tr = t as any
  if (!tr) return { ok: false, status: 404, message: 'Tenant not found.' }

  let email: string | null = (tr.billing_email as string) ?? null
  if (!email && tr.user_id) {
    try {
      const { data: u } = await supabase.auth.admin.getUserById(tr.user_id)
      email = (u as any)?.user?.email ?? null
    } catch { /* fall through */ }
  }
  if (!email) return { ok: false, status: 422, message: 'No owner email on file to resend to.' }

  const { data: code } = await supabase.from('invitation_codes')
    .select('id, code, email, status, expires_at')
    .eq('email', email.toLowerCase()).eq('status', 'unused')
    .order('created_at', { ascending: false }).limit(1).maybeSingle()
  const c = code as any
  if (!c) return { ok: false, status: 404, message: `No pending invite for ${email} — the owner may already have an account.` }

  const appUrl = process.env.FRONTEND_URL ?? 'https://getfrequency.app'
  const expiresDays = c.expires_at
    ? Math.max(1, Math.ceil((new Date(c.expires_at).getTime() - Date.now()) / DAY)) : null
  const { subject, html, text } = buildInviteEmail(c.code, appUrl, { expiresDays })
  await sendEmail({ to: c.email, subject, html, text, idempotency_key: `invite-${c.id}-${Date.now()}` })
  await supabase.from('invitation_codes').update({ sent_at: new Date().toISOString() }).eq('id', c.id)
  return { ok: true, email: c.email }
}

export function createNarutoSupportRouter({ supabase, requireAuth }: Deps): express.Router {
  const r = express.Router()

  // ── Diagnostics ─────────────────────────────────────────────────────────────
  r.get('/api/naruto/tenants/:id/diagnostics',
    requireAuth, requirePlatformCapability(supabase, 'diagnostics.read'),
    async (req, res) => {
      const id = String(req.params.id)
      const { data: t } = await supabase.from('tenants').select('id').eq('id', id).maybeSingle()
      if (!t) { res.status(404).json({ error: 'Tenant not found' }); return }
      try {
        const checks = await runDiagnostics(supabase, id)
        res.json({ tenantId: id, ranAt: new Date().toISOString(), checks })
      } catch (e: any) {
        res.status(500).json({ error: e?.message ?? 'Diagnostics failed' })
      }
    })

  // ── Timeline ────────────────────────────────────────────────────────────────
  r.get('/api/naruto/tenants/:id/timeline',
    requireAuth, requirePlatformCapability(supabase, 'tenant.read'),
    async (req, res) => {
      const id = String(req.params.id)
      try {
        res.json({ tenantId: id, items: await buildTimeline(supabase, id) })
      } catch (e: any) {
        res.status(500).json({ error: e?.message ?? 'Timeline failed' })
      }
    })

  // ── Notes (read) ────────────────────────────────────────────────────────────
  r.get('/api/naruto/tenants/:id/notes',
    requireAuth, requirePlatformCapability(supabase, 'tenant.read'),
    async (req, res) => {
      const id = String(req.params.id)
      const { data, error } = await supabase.from('tenant_notes')
        .select('id, body, pinned, author_user_id, author_role, created_at')
        .eq('tenant_id', id).order('pinned', { ascending: false }).order('created_at', { ascending: false })
      if (error) { res.status(500).json({ error: error.message }); return }
      res.json({ notes: data ?? [] })
    })

  // ── Notes (add) — gated on support.fix.run (the "acting support member" cap;
  //    platform_finance / platform_onboarding intentionally can't add notes). ──
  r.post('/api/naruto/tenants/:id/notes',
    requireAuth, requirePlatformCapability(supabase, 'support.fix.run'),
    async (req, res) => {
      const id = String(req.params.id)
      const body = String((req.body ?? {}).body ?? '').trim()
      const pinned = (req.body ?? {}).pinned === true
      if (!body) { res.status(400).json({ error: 'Note body required' }); return }
      if (body.length > 4000) { res.status(400).json({ error: 'Note too long (max 4000 chars)' }); return }
      const { data: t } = await supabase.from('tenants').select('id').eq('id', id).maybeSingle()
      if (!t) { res.status(404).json({ error: 'Tenant not found' }); return }
      const { data, error } = await supabase.from('tenant_notes').insert({
        tenant_id: id, body, pinned,
        author_user_id: (req as any).user?.id ?? null,
        author_role: (req as any).platformRole ?? null,
      }).select('id, body, pinned, author_user_id, author_role, created_at').single()
      if (error) { res.status(500).json({ error: error.message }); return }
      await recordPlatformAudit(supabase, req, {
        capability: 'support.fix.run', action: 'support.note.add', tenant_id: id,
        before: null, after: { body: body.slice(0, 200), pinned },
      })
      res.status(201).json({ note: data })
    })

  // ── Notes (delete) ──────────────────────────────────────────────────────────
  r.delete('/api/naruto/tenants/:id/notes/:noteId',
    requireAuth, requirePlatformCapability(supabase, 'support.fix.run'),
    async (req, res) => {
      const id = String(req.params.id)
      const noteId = String(req.params.noteId)
      const { data: existing } = await supabase.from('tenant_notes')
        .select('body').eq('id', noteId).eq('tenant_id', id).maybeSingle()
      if (!existing) { res.status(404).json({ error: 'Note not found' }); return }
      const { error } = await supabase.from('tenant_notes').delete().eq('id', noteId).eq('tenant_id', id)
      if (error) { res.status(500).json({ error: error.message }); return }
      await recordPlatformAudit(supabase, req, {
        capability: 'support.fix.run', action: 'support.note.delete', tenant_id: id,
        before: { body: String((existing as any).body).slice(0, 200) }, after: null,
      })
      res.json({ ok: true })
    })

  // ── One-click fixes ───────────────────────────────────────────────────────
  // Capability varies by :action, so resolve the role once and check per-action
  // rather than via a fixed-capability middleware.
  r.post('/api/naruto/tenants/:id/fixes/:action',
    requireAuth,
    async (req, res) => {
      const id = String(req.params.id)
      const action = String(req.params.action)
      const spec = FIX_REGISTRY[action]
      if (!spec) { res.status(404).json({ error: `Unknown fix: ${action}` }); return }

      const user = (req as any).user
      const canonical = normalizeRole(await resolvePlatformRole(supabase, user.id))
      if (!canonical || !can(spec.cap, canonical)) {
        res.status(403).json({ error: `Platform role lacks capability: ${spec.cap}` }); return
      }
      ;(req as any).platformRole = canonical  // for the audit row

      if (!spec.wired) {
        // Honest 501 — the FE shows the exact endpoint needed; no fake success.
        res.status(501).json({ wired: false, action, requiredCapability: spec.cap, requiredEndpoint: spec.endpoint })
        return
      }

      const reason = typeof req.body?.reason === 'string' ? req.body.reason : null
      try {
        if (action === 'resend-invite') {
          const out = await resendOwnerInvite(supabase, id)
          if (!out.ok) { res.status(out.status).json({ error: out.message }); return }
          await recordPlatformAudit(supabase, req, {
            capability: spec.cap, action: 'support.invite.resend', tenant_id: id,
            after: { email: out.email }, reason,
          })
          res.json({ ok: true, action, detail: `Invite re-sent to ${out.email}.` })
          return
        }
        res.status(500).json({ error: `Fix ${action} marked wired but has no handler` })
      } catch (e: any) {
        res.status(500).json({ error: e?.message ?? 'Fix failed' })
      }
    })

  return r
}
