/**
 * Supabase "Send Email" hook → Brevo.
 *
 * Instead of Supabase mailing auth emails itself over SMTP (which Brevo's IP
 * restriction blocks from Supabase's egress IPs), Supabase POSTs the email
 * intent here and WE send it via Brevo from Fly — whose IP is authorised. This
 * puts EVERY email (registration, magic-link, reset, invite, email-change) on
 * Brevo alongside the app's transactional email, with zero SMTP/IP juggling.
 *
 * Security: Supabase signs the request with Standard Webhooks (symmetric HMAC).
 * We verify `webhook-signature` against SUPABASE_EMAIL_HOOK_SECRET before sending.
 * Templates are the pre-rendered auth-dist HTML (same look as before); we fill
 * {{ .ConfirmationURL }} + {{ .Token }} ourselves.
 */
import express from 'express'
import crypto from 'node:crypto'
import { sendEmail } from '../lib/email'
import { AUTH_TEMPLATES } from '../emails/auth-templates'

const log = {
  info: (...a: unknown[]) => console.log('[auth-email-hook]', ...a),
  warn: (...a: unknown[]) => console.warn('[auth-email-hook]', ...a),
  error: (...a: unknown[]) => console.error('[auth-email-hook]', ...a),
}

// email_action_type → { template file, subject }. Subjects mirror the Supabase
// Auth template subjects so nothing visibly changes for the user.
const ACTIONS: Record<string, { file: string; subject: string }> = {
  signup:               { file: 'confirm-signup.html', subject: 'Confirm your email · Frequency' },
  recovery:             { file: 'reset-password.html',  subject: 'Reset your Frequency password' },
  magiclink:            { file: 'magic-link.html',      subject: 'Your Frequency sign-in link' },
  invite:               { file: 'invite.html',          subject: "You've been invited to Frequency" },
  email_change:         { file: 'change-email.html',    subject: 'Confirm your new email · Frequency' },
  email_change_new:     { file: 'change-email.html',    subject: 'Confirm your new email · Frequency' },
  email_change_current: { file: 'change-email.html',    subject: 'Confirm your email change · Frequency' },
}

// Templates are embedded (see emails/auth-templates.ts) so they ship in dist/.
function template(file: string): string {
  const html = AUTH_TEMPLATES[file]
  if (!html) throw new Error(`auth template not found: ${file}`)
  return html
}

/** Standard Webhooks verify: signature = base64(HMAC-SHA256("{id}.{ts}.{body}", key)). */
function verify(secretRaw: string, id: string, ts: string, body: string, sigHeader: string): boolean {
  // Secret format: "v1,whsec_<base64>" (or bare "whsec_<base64>"); key = decode(base64).
  const b64 = secretRaw.replace(/^v1,/, '').replace(/^whsec_/, '')
  const key = Buffer.from(b64, 'base64')
  const expected = crypto.createHmac('sha256', key).update(`${id}.${ts}.${body}`).digest('base64')
  // Header holds space-separated "v1,<sig>" pairs — accept if any matches.
  for (const part of sigHeader.split(' ')) {
    const sig = part.split(',')[1] ?? part
    const a = Buffer.from(sig), b = Buffer.from(expected)
    if (a.length === b.length && crypto.timingSafeEqual(a, b)) return true
  }
  return false
}

export function createAuthEmailHookRouter(): express.Router {
  const r = express.Router()

  // rawBody is captured by the express.json verify hook mounted for this path in
  // index.ts (before the global parser), so HMAC runs over the exact signed bytes.
  r.post('/api/hooks/auth-email', async (req, res) => {
    try {
      const secret = process.env.SUPABASE_EMAIL_HOOK_SECRET
      if (!secret) { log.error('SUPABASE_EMAIL_HOOK_SECRET unset — refusing'); res.status(503).json({ error: 'hook not configured' }); return }
      const raw = ((req as any).rawBody as Buffer | undefined)?.toString('utf8') ?? JSON.stringify(req.body ?? {})
      const id = String(req.header('webhook-id') ?? '')
      const ts = String(req.header('webhook-timestamp') ?? '')
      const sig = String(req.header('webhook-signature') ?? '')
      if (!verify(secret, id, ts, raw, sig)) { log.warn('bad signature'); res.status(401).json({ error: 'bad signature' }); return }

      const payload = req.body as {
        user: { email: string }
        email_data: { token: string; token_hash: string; redirect_to: string; email_action_type: string; site_url?: string; token_hash_new?: string }
      }
      const ed = payload.email_data
      const action = ACTIONS[ed.email_action_type]
      if (!action) { log.warn(`unknown email_action_type: ${ed.email_action_type}`); res.status(200).json({ skipped: true }); return }

      // Link to OUR branded domain (getfrequency.app/auth/confirm), never the raw
      // supabase.co/auth/v1/verify URL — that reads as phishing + hurts trust.
      // The FE route verifies token_hash via verifyOtp on our domain, then routes
      // the user on (recovery → set password; else → `next`).
      // Prefer Supabase's configured Site URL (the auth domain, currently
      // beta.getfrequency.app) since that's where /auth/confirm is deployed.
      const feBase = (ed.site_url || process.env.FRONTEND_URL || 'https://beta.getfrequency.app').replace(/\/$/, '')
      const tokenHash = ed.email_action_type.startsWith('email_change') && ed.token_hash_new ? ed.token_hash_new : ed.token_hash
      const type = ed.email_action_type === 'email_change_new' ? 'email_change' : ed.email_action_type
      const confirmationUrl = `${feBase}/auth/confirm?token_hash=${encodeURIComponent(tokenHash)}&type=${encodeURIComponent(type)}&next=${encodeURIComponent(ed.redirect_to || '/')}`

      const html = template(action.file)
        .split('{{ .ConfirmationURL }}').join(confirmationUrl)
        .split('{{ .Token }}').join(ed.token || '')

      await sendEmail({ to: payload.user.email, subject: action.subject, html })
      log.info(`sent ${ed.email_action_type} → ${payload.user.email} via Brevo`)
      res.status(200).json({ ok: true })
    } catch (err: any) {
      log.error('auth-email hook failed:', err?.message ?? err)
      res.status(500).json({ error: 'send failed' })
    }
  })

  return r
}
