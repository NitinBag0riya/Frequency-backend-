/**
 * POS approval-request notify: fan-out for the Phase-3 "Notify manager" seam.
 *
 * storefront-api's `POST /admin/pos/approval-request` (Phase 3, P3-BE-APPROVAL)
 * gathers eligible operator emails for a blocked PIN gate (cancel bill, free
 * bill, discount-over-limit, waive-off, reprint) and forwards them to
 * `POST /api/internal/pos-approval-request` — the same shared-secret internal
 * seam as `/api/internal/storefront-order` (src/index.ts).
 *
 * Resolves each manager email to a Supabase auth user, then fires:
 *   1. push  — sendExpoPush (expo-push.ts): instant, in-app, no Meta gate.
 *   2. WhatsApp — sendWaNotification (whatsapp-notifications.ts): REUSES the
 *      already-approved `frequency_notification` utility template. No new
 *      Meta template is authored or submitted here.
 * Both channels are best-effort per manager: an unresolvable email is
 * skipped (never thrown), and one channel failing never blocks the other or
 * the next manager.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import crypto from 'node:crypto'
import { findAuthUserByEmail } from './auth-users'
import { sendExpoPush } from './expo-push'
import { sendWaNotification } from './whatsapp-notifications'

export interface PosApprovalContext {
  billNo?: string | number | null
  amountInr?: number | null
  requestedBy?: string | null
}

export interface PosApprovalRequestBody {
  tenantId: string
  action: string
  context?: PosApprovalContext
  managerEmails: string[]
}

/**
 * Same timing-safe shared-secret compare as `/api/internal/storefront-order`.
 * Fail-closed: an unset `secretEnv` always returns false, so the route is
 * inert until `INTERNAL_TRIGGER_SECRET` is explicitly configured.
 */
export function verifyInternalSecret(secretEnv: string | undefined, provided: string): boolean {
  const secret = secretEnv ?? ''
  if (!secret) return false
  const providedBuf = Buffer.from(provided, 'utf8')
  const secretBuf = Buffer.from(secret, 'utf8')
  if (providedBuf.length !== secretBuf.length) return false
  return crypto.timingSafeEqual(providedBuf, secretBuf)
}

const ACTION_LABEL: Record<string, string> = {
  cancel_bill: 'Cancel bill',
  free_bill: 'Free bill',
  discount_over_limit: 'Discount over limit',
  waive_off: 'Waive-off',
  reprint: 'Reprint',
}

/** Plain-word (R3) message: "PIN needed: Cancel bill #A-142 (₹1,240) — Ravi is asking". */
export function buildApprovalMessage(
  action: string,
  context: PosApprovalContext = {},
): { title: string; body: string } {
  const label = ACTION_LABEL[action] ?? action
  const bill = context.billNo != null ? ` #${context.billNo}` : ''
  const amount = typeof context.amountInr === 'number' ? ` (₹${context.amountInr})` : ''
  const who = context.requestedBy ? ` — ${context.requestedBy} is asking` : ''
  const title = `PIN needed: ${label}${bill}`
  return { title, body: `${title}${amount}${who}` }
}

export interface DispatchResult {
  /** Managers successfully resolved to a Supabase auth user (notify attempted). */
  notified: number
  /** Manager emails that don't match any Supabase auth user — skipped, not thrown. */
  skipped: string[]
}

/**
 * Best-effort fan-out to every manager email. Never throws: an unresolvable
 * email is skipped, and a failing push or WhatsApp send for a resolved
 * manager is caught + logged, never blocking the other channel or the next
 * manager in the list.
 */
export async function dispatchPosApprovalRequest(
  sb: SupabaseClient,
  args: PosApprovalRequestBody,
): Promise<DispatchResult> {
  const { title, body } = buildApprovalMessage(args.action, args.context)
  const result: DispatchResult = { notified: 0, skipped: [] }

  for (const email of args.managerEmails ?? []) {
    let user: { id: string } | null = null
    try {
      user = await findAuthUserByEmail(sb, email)
    } catch (e: any) {
      console.warn(`[pos-approval-notify] user lookup failed for ${email}: ${e?.message ?? e}`)
    }
    if (!user?.id) { result.skipped.push(email); continue }
    result.notified++

    await sendExpoPush(sb, user.id, {
      title,
      body,
      data: { kind: 'pos_approval_request', action: args.action, tenantId: args.tenantId },
      channel: 'system',
    }).catch((e: any) => console.warn(`[pos-approval-notify] push failed for ${email}: ${e?.message ?? e}`))

    await sendWaNotification(sb, { tenantId: args.tenantId, userId: user.id, title, body })
      .catch((e: any) => console.warn(`[pos-approval-notify] WA failed for ${email}: ${e?.message ?? e}`))
  }

  return result
}
