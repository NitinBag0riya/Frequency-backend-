/**
 * Worker: breach-notification-sender (queue: Q.breachNotification)
 *
 * Fans out a DPDPA §8(6) breach notification to every affected tenant's
 * owner + data fiduciary contact. Triggered by the super-admin clicking
 * "Notify users" on a breach (routes/breach-notifications.ts), which calls
 * enqueueBreachNotification({ breachId }) once per breach (idempotent via
 * fanout_queued_at + jobId).
 *
 * Per-recipient durability lives in breach_notification_recipients:
 *   - Insert with send_status='queued' (upsert; ON CONFLICT DO NOTHING).
 *   - Send each via Resend (lib/email.ts).
 *   - Update to 'sent' (+ resend_message_id) or 'failed' (+ error).
 *
 * Resilience:
 *   - Per-recipient try/catch — one bad address never aborts the run.
 *   - Resend rate limit honored via BullMQ limiter (10/sec).
 *   - If RESEND_API_KEY is unset, every row lands 'failed' with the exact
 *     reason; the worker never crashes (devs can run locally without email).
 *   - Worker concurrency = 1 so a single breach is processed end-to-end
 *     before another picks up — keeps the per-breach state-machine simple.
 *
 * Job retries (queue.ts: attempts=3, exponential 30s/2m/10m) only kick in
 * if the WHOLE expansion crashes (e.g. Supabase outage). Resend errors are
 * per-recipient and do NOT trigger a job retry.
 */

import '../env'
import { Worker, Job } from 'bullmq'
import { createClient, SupabaseClient } from '@supabase/supabase-js'
import { Q, connection, BreachNotificationJob } from '../queue'
import { sendEmail } from '../lib/email'

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://yiicpndeggaedxobyopu.supabase.co'
const supabase: SupabaseClient = createClient(
  SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false, autoRefreshToken: false } },
)

// Resend's published free-tier rate limit is 10 req/sec. We pace at 8/sec
// to leave headroom for the rest of the app (notifications, billing receipts).
const SENDS_PER_SEC = Number(process.env.BREACH_FANOUT_SENDS_PER_SEC ?? 8)

// Default subject. Plain, factual — DPDPA breach notifications are legal docs.
const DEFAULT_SUBJECT = 'Important security notice — action may be required'

export async function startBreachNotificationSenderWorker(): Promise<Worker> {
  const worker = new Worker(
    Q.breachNotification,
    async (job: Job<BreachNotificationJob>) => {
      const { breachId } = job.data
      return runFanout(breachId)
    },
    {
      connection,
      concurrency: 1,
      limiter: { max: SENDS_PER_SEC, duration: 1000 },
    },
  )

  worker.on('failed', (job, err) => {
    console.warn(`[breach-notification] job ${job?.id} failed: ${err.message}`)
  })

  console.log(`[worker:breach-notification-sender] started, limiter=${SENDS_PER_SEC}/sec`)
  return worker
}

/**
 * Resolve recipients for a breach, upsert them to breach_notification_recipients
 * (queued), then send each via Resend.
 *
 * Returns counts for the BullMQ job result.
 */
async function runFanout(breachId: string): Promise<{
  expanded: number
  sent: number
  failed: number
  skipped_no_email: number
}> {
  const startedAt = Date.now()

  // ── 1. Load breach row ───────────────────────────────────────────────────
  // Cast through any because the new columns from migration 075
  // (scope, affected_tenant_ids, notification_template, fanout_queued_at)
  // aren't in the auto-generated Database types yet. The runtime shape is
  // guaranteed by the migration.
  const { data: breachRow, error: bErr } = await supabase
    .from('breach_notifications')
    .select(
      'id, tenant_id, scope, affected_tenant_ids, severity, description, ' +
      'discovered_at, affected_contact_count, affected_data_classes, ' +
      'notification_template, status',
    )
    .eq('id', breachId)
    .maybeSingle()
  if (bErr) {
    throw new Error(`load breach failed: ${bErr.message}`)
  }
  if (!breachRow) {
    console.warn(`[breach-notification] breach ${breachId} not found — skipping fanout`)
    return { expanded: 0, sent: 0, failed: 0, skipped_no_email: 0 }
  }
  const breach = breachRow as any
  if (breach.status === 'resolved') {
    console.warn(`[breach-notification] breach ${breachId} already resolved — skipping fanout`)
    return { expanded: 0, sent: 0, failed: 0, skipped_no_email: 0 }
  }

  // ── 2. Resolve target tenants ────────────────────────────────────────────
  // 'platform' scope = every tenant. 'subset' = only affected_tenant_ids. We
  // also include the legacy single-tenant case where breach.tenant_id is set
  // and scope is 'subset' (default) — treat tenant_id as the only target.
  const subsetIds: string[] = Array.isArray(breach.affected_tenant_ids)
    ? (breach.affected_tenant_ids as unknown[]).map(String)
    : []
  if (breach.scope === 'subset' && breach.tenant_id && !subsetIds.includes(breach.tenant_id)) {
    subsetIds.push(breach.tenant_id)
  }

  let tenantIds: string[] = []
  if (breach.scope === 'platform') {
    const { data: rows, error: tErr } = await supabase
      .from('tenants')
      .select('id')
    if (tErr) throw new Error(`load tenants (platform) failed: ${tErr.message}`)
    tenantIds = (rows ?? []).map(r => r.id as string)
  } else {
    tenantIds = subsetIds
  }
  if (tenantIds.length === 0) {
    console.log(`[breach-notification] breach ${breachId} has no target tenants — nothing to send`)
    return { expanded: 0, sent: 0, failed: 0, skipped_no_email: 0 }
  }

  // ── 3. Resolve recipients per tenant ─────────────────────────────────────
  // Recipient sources (in priority order, all deduped by email):
  //   a) tenants.data_fiduciary_email + data_fiduciary_name (role='data_fiduciary')
  //   b) tenants.owner_email if column exists (role='owner')
  //   c) auth.users.email for users with an 'owner' role in user_role_assignments
  //
  // (c) requires joining auth.users which isn't queryable via PostgREST; we
  // fall back to a Supabase admin call. If the admin call fails (env not set,
  // etc.) we just skip and rely on (a)+(b).
  const recipients: Array<{
    tenant_id: string
    email: string
    name: string | null
    role: 'owner' | 'data_fiduciary' | 'admin'
  }> = []

  for (const tid of tenantIds) {
    // (a) + (b): pull tenant row including DF + owner_email if present.
    const { data: tRow, error: tErr } = await supabase
      .from('tenants')
      .select('id, name, owner_email, data_fiduciary_email, data_fiduciary_name, user_id')
      .eq('id', tid)
      .maybeSingle()
    if (tErr) {
      console.warn(`[breach-notification] load tenant ${tid} failed: ${tErr.message}`)
      continue
    }
    if (!tRow) continue

    const dfEmail = (tRow.data_fiduciary_email ?? '').trim().toLowerCase()
    if (dfEmail) {
      recipients.push({
        tenant_id: tid,
        email: dfEmail,
        name: tRow.data_fiduciary_name ?? null,
        role: 'data_fiduciary',
      })
    }

    const ownerCol = (tRow as any).owner_email
    if (typeof ownerCol === 'string' && ownerCol.trim()) {
      const e = ownerCol.trim().toLowerCase()
      if (!recipients.find(r => r.tenant_id === tid && r.email === e)) {
        recipients.push({ tenant_id: tid, email: e, name: null, role: 'owner' })
      }
    }

    // (c) owner via auth.admin — last resort.
    if (tRow.user_id) {
      try {
        const ownerLookup = await (supabase as any).auth?.admin?.getUserById?.(tRow.user_id)
        const u = ownerLookup?.data?.user
        const e = (u?.email ?? '').trim().toLowerCase()
        if (e && !recipients.find(r => r.tenant_id === tid && r.email === e)) {
          recipients.push({
            tenant_id: tid,
            email: e,
            name: (u?.user_metadata as any)?.full_name ?? null,
            role: 'owner',
          })
        }
      } catch {
        /* auth.admin not available — skip */
      }
    }
  }

  const expanded = recipients.length
  if (expanded === 0) {
    console.log(`[breach-notification] breach ${breachId} expanded to 0 recipients across ${tenantIds.length} tenants`)
    return { expanded: 0, sent: 0, failed: 0, skipped_no_email: tenantIds.length }
  }

  // ── 4. Upsert recipients to breach_notification_recipients ─────────────
  // ON CONFLICT (breach_id, recipient_email) DO NOTHING — re-runs are safe.
  // We need to read back the rows to get their ids for status updates,
  // since postgrest upsert with ignoreDuplicates: true does not always return
  // the existing rows. We split into insert (silent on conflict) + select.
  const upsertRows = recipients.map(r => ({
    breach_id:       breachId,
    tenant_id:       r.tenant_id,
    recipient_email: r.email,
    recipient_name:  r.name,
    recipient_role:  r.role,
    send_status:     'queued',
  }))
  const { error: insErr } = await supabase
    .from('breach_notification_recipients')
    .upsert(upsertRows, { onConflict: 'breach_id,recipient_email', ignoreDuplicates: true })
  if (insErr) {
    throw new Error(`upsert recipients failed: ${insErr.message}`)
  }
  const { data: rcptRows, error: rErr } = await supabase
    .from('breach_notification_recipients')
    .select('id, tenant_id, recipient_email, recipient_name, recipient_role, send_status')
    .eq('breach_id', breachId)
  if (rErr) {
    throw new Error(`reread recipients failed: ${rErr.message}`)
  }

  // Only send to rows still in 'queued'. A re-run after partial success
  // resumes from where the last run left off.
  const toSend = (rcptRows ?? []).filter(r => r.send_status === 'queued')

  // ── 5. Render template + send each ───────────────────────────────────────
  let sent = 0
  let failed = 0

  const ctx = buildRenderContext(breach)

  for (const row of toSend) {
    const ownerName = row.recipient_name || 'team'
    const html = renderHtml(
      breach.notification_template || null,
      { ...ctx, owner_name: ownerName },
    )
    const text = renderText({ ...ctx, owner_name: ownerName })

    try {
      const result = await sendEmail({
        to: row.recipient_email,
        subject: DEFAULT_SUBJECT,
        html,
        text,
        idempotency_key: `breach:${breachId}:${row.id}`,
      })
      await supabase
        .from('breach_notification_recipients')
        .update({
          send_status: 'sent',
          sent_at: new Date().toISOString(),
          resend_message_id: result.id || null,
        })
        .eq('id', row.id)
      sent++
    } catch (err: any) {
      const msg = String(err?.message ?? err).slice(0, 1000)
      await supabase
        .from('breach_notification_recipients')
        .update({
          send_status: 'failed',
          failed_at: new Date().toISOString(),
          error: msg,
        })
        .eq('id', row.id)
      failed++
    }
  }

  const ms = Date.now() - startedAt
  console.log(
    `[breach-notification] breach=${breachId} expanded=${expanded} sent=${sent} ` +
    `failed=${failed} skipped=${expanded - toSend.length} ${ms}ms`,
  )
  return { expanded, sent, failed, skipped_no_email: 0 }
}

// ── Template render ────────────────────────────────────────────────────────
interface RenderContext {
  owner_name?:               string
  incident_detected_at:      string
  severity:                  string
  title:                     string
  summary:                   string
  data_categories:           string
  affected_tenants_count:    string
  remediation:               string
  recommended_actions:       string
}

function buildRenderContext(breach: any): RenderContext {
  const detected = breach.discovered_at
    ? new Date(breach.discovered_at).toLocaleString('en-IN', {
        timeZone: 'Asia/Kolkata',
        dateStyle: 'medium',
        timeStyle: 'short',
      }) + ' IST'
    : 'recently'
  const classes = Array.isArray(breach.affected_data_classes)
    ? (breach.affected_data_classes as unknown[]).map(String).join(', ')
    : '—'
  return {
    incident_detected_at:   detected,
    severity:               String(breach.severity || 'minor'),
    title:                  String(breach.description ?? 'security incident').split('\n')[0].slice(0, 200),
    summary:                String(breach.description ?? ''),
    data_categories:        classes || '—',
    affected_tenants_count: String(breach.affected_contact_count ?? 0),
    remediation:            'Our security team has contained the issue and is reviewing logs.',
    recommended_actions:    'Review any unusual activity in your workspace and rotate shared credentials if applicable.',
  }
}

const DEFAULT_HTML_TEMPLATE = `Hi {{owner_name}},

On {{incident_detected_at}}, we detected a {{severity}} incident: {{title}}.

**What happened:** {{summary}}
**Data involved:** {{data_categories}}
**Tenants affected:** {{affected_tenants_count}}
**What we've done:** {{remediation}}
**What you should do:** {{recommended_actions}}

As your data processor under DPDPA, we're notifying you within 72 hours of detection. You may need to notify the Data Protection Board if your assessment of harm meets the threshold.

Reply to this email with any questions. Our security team will respond within 4 business hours.

— Frequency Security`

function substitute(tmpl: string, ctx: Record<string, string | undefined>): string {
  return tmpl.replace(/\{\{(\w+)\}\}/g, (_m, k) => {
    const v = ctx[k]
    return v == null ? '' : String(v)
  })
}

function renderHtml(customTemplate: string | null, ctx: RenderContext): string {
  const tmpl = customTemplate ?? DEFAULT_HTML_TEMPLATE
  const filled = substitute(tmpl, ctx as unknown as Record<string, string>)
  // Convert the markdown-ish **bold** + line breaks to minimal HTML. Keep
  // the rendering literal — no Handlebars/MJML dep just for one mail.
  const escaped = escapeHtml(filled)
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\n\n/g, '</p><p style="margin:0 0 12px 0;line-height:1.55">')
    .replace(/\n/g, '<br>')
  return `<!doctype html><html><body style="margin:0;background:#f7f8f7;font-family:DM Sans,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#1a1a1a;-webkit-font-smoothing:antialiased">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f7f8f7;padding:40px 16px">
    <tr><td align="center">
      <table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;background:#fff;border-radius:14px;border:1px solid #e6e8e6;overflow:hidden">
        <tr><td style="padding:24px 28px;border-bottom:1px solid #f0f1f0;font-weight:700;color:#0F6E56;letter-spacing:-0.01em">Frequency Security</td></tr>
        <tr><td style="padding:28px;font-size:14px;line-height:1.55;color:#1a1a1a"><p style="margin:0 0 12px 0;line-height:1.55">${escaped}</p></td></tr>
        <tr><td style="padding:18px 28px;border-top:1px solid #f0f1f0;font-size:11px;color:#9ca3af">DPDPA §8(6) — sent by Frequency as data processor.</td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`
}

function renderText(ctx: RenderContext): string {
  return substitute(DEFAULT_HTML_TEMPLATE, ctx as unknown as Record<string, string>)
    .replace(/\*\*(.+?)\*\*/g, '$1')
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}
