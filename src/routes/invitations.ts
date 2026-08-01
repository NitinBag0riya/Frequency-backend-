/**
 * Self-serve invitation codes — public, rate-limited.
 *
 *   POST /api/invitations/self-serve  { email }
 *     → mints (or reuses) an unused invitation_code pinned to that email and
 *       emails the code to them, so a visitor can unlock /auth signup INSTANTLY
 *       without waiting for a manual admin review.
 *
 * Why a dedicated router + service-role client:
 *   invitation_codes INSERT is RLS-locked to super admins (see the invitation
 *   migration `20260530000000_invitation_system.sql`). A public self-serve mint
 *   therefore MUST run server-side with the service-role key — never the browser.
 *
 * Abuse controls (issuance is instant, so these matter):
 *   - per-IP rate limit (5/min) — same posture as the waitlist router
 *   - ONE live (unused, unexpired) code per email — repeat requests reuse the
 *     same code instead of minting a pile of them (this IS the idempotency)
 *   - per-email cooldown (COOLDOWN_MS) so we don't re-send the email on every
 *     click / refresh
 *   - codes expire (EXPIRES_DAYS) so a leaked-but-unused code can't live forever
 *
 * Email: sent via Resend (lib/email). If email isn't configured (local dev has
 * empty RESEND_* keys) the code is still created and — ONLY outside production —
 * returned as `devCode` so the flow is testable end-to-end without an inbox.
 */

import express from 'express'
import type { SupabaseClient } from '@supabase/supabase-js'
import rateLimit from 'express-rate-limit'
import { z } from 'zod'
import { apiError } from '../lib/api-error'
import { sendEmail } from '../lib/email'

interface Deps { supabase: SupabaseClient }

const RequestSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
})

const EXPIRES_DAYS = 7
const COOLDOWN_MS  = 2 * 60_000 // don't re-email the same address within 2 min

// Expiry copy is honest per-code: self-serve codes expire (EXPIRES_DAYS), but
// admin-minted codes have no expiry (expires_at null) — so we only claim an
// expiry when one actually exists.
function expiryNote(expiresDays: number | null): string {
  return expiresDays != null
    ? `This code expires in ${expiresDays} day${expiresDays === 1 ? '' : 's'} and can be used once.`
    : `This code can be used once.`
}

function inviteEmailHtml(code: string, appUrl: string, expiresDays: number | null): string {
  const gateUrl = `${appUrl}/home?mode=code`
  return `<!doctype html><html><body style="margin:0;background:#FBF8F3;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#FBF8F3;padding:32px 16px;">
    <tr><td align="center">
      <table width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;background:#ffffff;border-radius:16px;border:1px solid rgba(15,15,15,0.08);overflow:hidden;">
        <tr><td style="padding:28px 32px 8px;">
          <div style="font-size:18px;font-weight:700;color:#0F1115;">Frequency</div>
          <div style="display:inline-block;margin-top:12px;padding:4px 10px;border-radius:999px;background:rgba(15,110,86,0.10);color:#0F6E56;font-size:12px;font-weight:600;">Private beta · invite</div>
        </td></tr>
        <tr><td style="padding:8px 32px 4px;">
          <h1 style="margin:12px 0 4px;font-size:22px;line-height:1.2;color:#0F1115;">Your invite code</h1>
          <p style="margin:0;color:#5B6470;font-size:14px;line-height:1.5;">Use this code to unlock sign-up. It's tied to <strong>this email address</strong>.</p>
        </td></tr>
        <tr><td style="padding:20px 32px;">
          <div style="text-align:center;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:28px;letter-spacing:4px;font-weight:700;color:#0F6E56;background:#F3F7F5;border:1px dashed rgba(15,110,86,0.35);border-radius:12px;padding:18px;">${code}</div>
        </td></tr>
        <tr><td style="padding:0 32px 8px;" align="center">
          <a href="${gateUrl}" style="display:inline-block;background:#0F6E56;color:#ffffff;text-decoration:none;font-weight:600;font-size:14px;padding:12px 22px;border-radius:12px;">Enter your code &rarr;</a>
        </td></tr>
        <tr><td style="padding:12px 32px 28px;">
          <p style="margin:0;color:#7C8493;font-size:12px;line-height:1.5;">${expiryNote(expiresDays)} If you didn't request it, you can safely ignore this email.</p>
        </td></tr>
      </table>
      <div style="color:#7C8493;font-size:11px;margin-top:16px;">&copy; NITIN BHAIYA AI STUDIO &middot; Made in India</div>
    </td></tr>
  </table></body></html>`
}

/**
 * Shared invite-email builder — the single source of truth for the subject/HTML/
 * text of an invite-code email. Used by BOTH the public self-serve mint (below)
 * and the super-admin send endpoint in index.ts (`POST /api/invitations/:id/send`),
 * so admin-minted and self-serve invites are byte-for-byte the same email.
 *
 * `expiresDays` = null means the code never expires (admin-minted codes) — the
 * copy adapts so we don't promise a 7-day expiry that doesn't apply.
 */
export function buildInviteEmail(
  code: string,
  appUrl: string,
  opts?: { expiresDays?: number | null },
): { subject: string; html: string; text: string } {
  const expiresDays = opts?.expiresDays ?? null
  const gateUrl = `${appUrl}/home?mode=code`
  const expiryText = expiresDays != null
    ? ` It expires in ${expiresDays} day${expiresDays === 1 ? '' : 's'} and can be used once.`
    : ' It can be used once.'
  return {
    subject: 'Your Frequency invite code',
    html: inviteEmailHtml(code, appUrl, expiresDays),
    text: `Your Frequency invite code is ${code}. Enter it at ${gateUrl}.${expiryText}`,
  }
}

export function createInvitationsRouter({ supabase }: Deps): express.Router {
  const router = express.Router()

  // Per-IP cap — there's no legitimate reason for one IP to request many codes.
  const limiter = rateLimit({
    windowMs: 60_000,
    max: 5,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: { code: 'rate_limited', message: 'Too many code requests from this IP. Try again in a minute.' } },
  })

  // ── POST /self-serve — mint-or-reuse a code + email it ───────────────────
  router.post('/self-serve', limiter, async (req, res) => {
    const parsed = RequestSchema.safeParse(req.body)
    if (!parsed.success) {
      return apiError(res, 400, 'invalid_payload', 'Please enter a valid email address.')
    }
    const { email } = parsed.data
    const isProd = process.env.NODE_ENV === 'production'
    const appUrl = process.env.FRONTEND_URL ?? 'https://getfrequency.app'

    try {
      // One live code per email: reuse the newest unused code for this address.
      // Expiry is checked in JS (not a PostgREST .or() filter) because a
      // timestamp value contains dots, which the .or() grammar treats as
      // separators — filtering here keeps it robust.
      const { data: live } = await supabase
        .from('invitation_codes')
        .select('id,code,sent_at,expires_at')
        .eq('status', 'unused')
        .ilike('email', email)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle()

      const liveValid = live && (!live.expires_at || new Date(live.expires_at).getTime() > Date.now())

      let code: string
      let codeId: string
      let cooling = false

      if (liveValid && live) {
        code = live.code
        codeId = live.id
        // Cooldown: if we emailed this address very recently, don't re-send.
        if (live.sent_at && Date.now() - new Date(live.sent_at).getTime() < COOLDOWN_MS) {
          cooling = true
        }
      } else {
        // Mint a fresh code via the DB generator (keeps the FREQ-XXXXXX format
        // in one place, shared with the admin mint path).
        const { data: gen, error: genErr } = await supabase.rpc('generate_invitation_code')
        if (genErr || !gen) {
          console.error('[invitations:self-serve] generate rpc failed:', genErr?.message)
          return apiError(res, 503, 'mint_failed', 'Could not create a code right now. Please try again.')
        }
        code = gen as unknown as string
        const expires = new Date(Date.now() + EXPIRES_DAYS * 86_400_000).toISOString()
        const { data: ins, error: insErr } = await supabase
          .from('invitation_codes')
          .insert({ code, email, status: 'unused', notes: 'self-serve', expires_at: expires, sent_at: new Date().toISOString() })
          .select('id')
          .single()
        if (insErr || !ins) {
          console.error('[invitations:self-serve] insert failed:', insErr?.message, (insErr as any)?.code)
          return apiError(res, 503, 'mint_failed', 'Could not create a code right now. Please try again.')
        }
        codeId = ins.id
      }

      // Email the code (unless we're inside the cooldown window).
      let emailed = false
      if (!cooling) {
        try {
          const { subject, html, text } = buildInviteEmail(code, appUrl, { expiresDays: EXPIRES_DAYS })
          await sendEmail({
            to: email,
            subject,
            html,
            text,
            idempotency_key: `invite-${codeId}`,
          })
          emailed = true
          await supabase.from('invitation_codes').update({ sent_at: new Date().toISOString() }).eq('id', codeId)
        } catch (e: any) {
          // Email not configured (local dev) or a Resend hiccup: the code still
          // exists. Log + fall through — in dev we return it so the flow is
          // verifiable without an inbox.
          console.warn('[invitations:self-serve] email send failed:', e?.message)
        }
      }

      return res.json({
        ok: true,
        emailed,
        cooling,
        // NEVER leak the code in production — emailing it is the whole point.
        // In dev (empty RESEND_* keys) return it so the self-serve flow is
        // testable end-to-end locally.
        ...(!isProd ? { devCode: code } : {}),
      })
    } catch (e: any) {
      console.error('[invitations:self-serve] unexpected:', e?.message)
      return apiError(res, 503, 'unavailable', 'Could not process your request. Please try again.')
    }
  })

  return router
}
