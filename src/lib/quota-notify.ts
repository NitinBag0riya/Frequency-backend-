/**
 * Idempotent quota notification helper.
 *
 * Called from `src/lib/quota.ts:checkAndConsumeQuota` when usage crosses
 * 80% (approaching) or 100% (exhausted). Wraps `emitNotification` with the
 * "fire once per (tenant, quota, day, level)" idempotency guard.
 *
 * Idempotency mechanism: insert-then-emit pattern against
 * public.quota_notification_log (migration 063). The unique index
 * (tenant_id, quota_key, bucket_date, level) makes the insert conflict on
 * duplicates; we only proceed if the insert actually wrote a row. This is
 * persistent across worker restarts — Redis flags would lose state on a
 * Redis restart and the tenant could get hammered with re-notifies.
 *
 * Recipient resolution:
 *   - Workspace owner (tenants.user_id) — always notified, even if they
 *     haven't accepted a role assignment (some legacy tenants pre-date
 *     user_role_assignments).
 *   - All non-disabled users in user_role_assignments for this tenant
 *     whose role's permissions include billing.view.
 *   - Falls back to "owner only" if no role rows exist (covers brand-new
 *     tenants whose owner is the only user).
 *
 * Channels: in_app + email (per the notification_event_types seed in 063).
 * Each recipient's preferences override defaults — a Sales Rep who has
 * muted billing notifications won't get one even if they have billing.view.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import type { QuotaKey } from './quota'

const QUOTA_LABEL: Record<QuotaKey, string> = {
  messages_per_day:    'daily message',
  messages_per_minute: 'per-minute message',
  broadcasts_per_day:  'daily broadcast',
  ai_requests_per_day: 'daily AI request',
}

/**
 * Fire a quota.approaching or quota.exhausted notification. Returns the
 * number of notifications actually created (0 if dedup-skipped or no
 * eligible recipients).
 *
 * Caller (lib/quota.ts) wraps this in try/catch + void — never blocks the
 * send path.
 */
export async function fireQuotaNotification(
  supabase: SupabaseClient,
  args: {
    tenantId: string
    quotaKey: QuotaKey
    level:    'approaching' | 'exhausted'
    usage:    number
    cap:      number
    planId:   string
    resetsAt: string
  },
): Promise<number> {
  // ── 1. Idempotency check ─────────────────────────────────────────────
  // bucket_date = IST date the rate-limit window is keyed under. Inserting
  // first means the unique-index conflict short-circuits any duplicate
  // attempts even when two workers race in the same millisecond.
  const { istDateKey } = await import('./rate-limit')
  const bucketDate = istDateKey()

  const { data: logRow, error: logErr } = await supabase
    .from('quota_notification_log')
    .insert({
      tenant_id: args.tenantId,
      quota_key: args.quotaKey,
      bucket_date: bucketDate,
      level: args.level,
      current_usage: args.usage,
      cap: args.cap,
    })
    .select('id')
    .maybeSingle()

  // PostgREST returns code 23505 (unique violation) when the row already
  // exists. That's the idempotency happy-path — we just dedup-skipped.
  if (logErr) {
    if (logErr.code === '23505' || /duplicate/i.test(logErr.message)) {
      return 0
    }
    // Other errors (RLS misconfig, table missing) — log loudly so the bug
    // surfaces, but still proceed without idempotency rather than blocking
    // the user-facing notification.
    console.warn(`[quota-notify] log insert failed (proceeding without dedup): ${logErr.message}`)
  }

  // ── 2. Resolve recipient list ─────────────────────────────────────────
  const recipientIds = await resolveBillingRecipients(supabase, args.tenantId)
  if (recipientIds.length === 0) {
    console.warn(`[quota-notify] no eligible recipients for tenant=${args.tenantId}`)
    return 0
  }

  // ── 3. Emit ──────────────────────────────────────────────────────────
  const eventKey = args.level === 'exhausted' ? 'quota.exhausted' : 'quota.approaching'
  const { emitNotification } = await import('../routes/notifications')

  const created = await emitNotification(supabase, {
    tenant_id: args.tenantId,
    event_key: eventKey,
    recipient_user_ids: recipientIds,
    link: '/settings/billing',
    data: {
      quota_key:   args.quotaKey,
      quota_label: QUOTA_LABEL[args.quotaKey] ?? args.quotaKey,
      used:        args.usage,
      cap:         args.cap,
      percent:     Math.min(100, Math.round((args.usage / Math.max(1, args.cap)) * 100)),
      resets_at:   formatResetsAt(args.resetsAt),
      plan:        args.planId,
    },
  })

  // Stamp the audit trail with the actual recipients (best-effort; ignore
  // failures — the notification has already shipped).
  if (logRow?.id && created.length > 0) {
    void supabase.from('quota_notification_log')
      .update({ fired_to_user_ids: recipientIds })
      .eq('id', logRow.id)
      .then(() => undefined, () => undefined)
  }

  return created.length
}

// ── Recipient resolution ─────────────────────────────────────────────────
async function resolveBillingRecipients(
  supabase: SupabaseClient,
  tenantId: string,
): Promise<string[]> {
  const recipients = new Set<string>()

  // Always include the workspace owner — they pay the bill, they get the
  // alert. Cheap single-row lookup.
  const { data: tenant } = await supabase.from('tenants')
    .select('user_id').eq('id', tenantId).maybeSingle()
  if (tenant?.user_id) recipients.add(tenant.user_id)

  // Optionally include any teammates whose role permissions include
  // billing.view (Workspace Admins, by default). One join; cheap.
  const { data: roleRows } = await supabase
    .from('user_role_assignments')
    .select('user_id, role_definitions ( permissions )')
    .eq('tenant_id', tenantId)
    .is('disabled_at', null)

  for (const r of (roleRows ?? []) as any[]) {
    const perms = r?.role_definitions?.permissions
    if (!perms) continue
    const billing = perms.billing
    if (billing && (billing === true || billing.view === true)) {
      if (r.user_id) recipients.add(r.user_id)
    }
  }

  return Array.from(recipients)
}

function formatResetsAt(iso: string): string {
  // Human-readable IST format for the email body — "Tomorrow 12:00 AM IST"
  // is clearer than a raw ISO timestamp. Fall back to the ISO if parsing
  // fails (defensive — we control the producer but who knows).
  try {
    const d = new Date(iso)
    return d.toLocaleString('en-IN', {
      timeZone: 'Asia/Kolkata',
      day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit',
      hour12: true,
    }) + ' IST'
  } catch {
    return iso
  }
}
