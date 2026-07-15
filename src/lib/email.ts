/**
 * Email delivery — Brevo (formerly Sendinblue) HTTP wrapper.
 *
 * No npm dependency on the `@getbrevo/brevo` SDK to keep the surface tiny +
 * auditable. Brevo's REST API is straightforward (api-key header + JSON), and
 * rolling our own gives us control over retries, error shapes, and timeouts
 * without tracking another package's update cadence.
 *
 * The public `sendEmail()` signature is unchanged from the old Resend wrapper,
 * so every call site keeps working untouched.
 *
 * Env:
 *   BREVO_API_KEY     — xkeysib-… (the single key Brevo uses for email + SMS)
 *   BREVO_FROM_EMAIL  — e.g. "Frequency <hello@frequency.in>" or "hello@frequency.in"
 *   BREVO_REPLY_TO    — optional; defaults to no Reply-To
 *
 * Back-compat: if BREVO_* are unset we fall back to the old RESEND_FROM_EMAIL /
 * RESEND_REPLY_TO for the sender/reply addresses (same string format) so the
 * from-address config doesn't have to be re-entered — only the API key must be
 * swapped to BREVO_API_KEY. The Resend API key itself is never reused (Brevo
 * won't accept it).
 *
 * Picked Brevo because:
 *   - Free tier covers MVP (300 emails/day)
 *   - One provider + one key for BOTH transactional email and India SMS
 *   - Simple REST API (no SDK juggling)
 */

const BASE = 'https://api.brevo.com/v3'

export interface SendEmailArgs {
  to:       string | string[]
  subject:  string
  html:     string
  text?:    string
  reply_to?: string
  /** Kept for call-site compatibility. Brevo has no idempotency header, so this
   *  is a no-op — a worker retry can double-send. If exactly-once matters,
   *  dedupe upstream on this key before calling. */
  idempotency_key?: string
}

export interface SendEmailResult {
  id: string
}

/**
 * The Brevo REST API wants the raw `xkeysib-…` string in the `api-key` header.
 * Some Brevo connector / "MCP" keys are handed out base64-wrapped as
 * `{"api_key":"xkeysib-…"}` — accept either shape so the Fly secret can be set
 * to whichever the dashboard gave you. Returns undefined if unset.
 * Exported for tests.
 */
export function brevoApiKey(): string | undefined {
  const raw = process.env.BREVO_API_KEY
  if (!raw) return undefined
  if (raw.startsWith('xkeysib-')) return raw
  try {
    const key = JSON.parse(Buffer.from(raw, 'base64').toString('utf8'))?.api_key
    if (typeof key === 'string' && key.startsWith('xkeysib-')) return key
  } catch { /* not a wrapped key — fall through to raw */ }
  return raw
}

/** True when email is configured (API key + a from address). Callers use this
 *  to gate email-dependent features instead of poking at RESEND_* directly. */
export function emailConfigured(): boolean {
  return !!(brevoApiKey() && (process.env.BREVO_FROM_EMAIL || process.env.RESEND_FROM_EMAIL))
}

/** Parse "Name <email@host>" or "email@host" → {email, name?}. Exported for tests. */
export function parseSender(raw: string): { email: string; name?: string } {
  const m = raw.match(/^\s*(.*?)\s*<([^>]+)>\s*$/)
  if (m) return { email: m[2].trim(), name: m[1].trim() || undefined }
  return { email: raw.trim() }
}

/**
 * Send a single email via Brevo. Throws if the API key isn't configured or if
 * Brevo returns a non-2xx — caller should catch + log to
 * notification_delivery_log so we have a record of why it failed.
 *
 * Returns the Brevo messageId so we can reference it in delivery logs.
 */
export async function sendEmail(args: SendEmailArgs): Promise<SendEmailResult> {
  const apiKey = brevoApiKey()
  const fromRaw = process.env.BREVO_FROM_EMAIL || process.env.RESEND_FROM_EMAIL
  if (!apiKey || !fromRaw) {
    throw new Error('Email not configured: set BREVO_API_KEY (xkeysib-…) and BREVO_FROM_EMAIL (e.g. "Frequency <hello@frequency.in>" or just "hello@frequency.in")')
  }

  const toList = (Array.isArray(args.to) ? args.to : [args.to]).map(email => ({ email }))
  const replyRaw = args.reply_to ?? process.env.BREVO_REPLY_TO ?? process.env.RESEND_REPLY_TO

  const res = await fetch(`${BASE}/smtp/email`, {
    method: 'POST',
    headers: {
      'api-key':      apiKey,
      'Content-Type': 'application/json',
      'Accept':       'application/json',
    },
    body: JSON.stringify({
      sender:      parseSender(fromRaw),
      to:          toList,
      subject:     args.subject,
      htmlContent: args.html,
      textContent: args.text,
      replyTo:     replyRaw ? parseSender(replyRaw) : undefined,
    }),
  })
  const body = await res.json().catch(() => ({} as any))
  if (!res.ok) {
    throw new Error(`Brevo email send failed (${res.status}): ${(body as any)?.message ?? (body as any)?.code ?? 'unknown'}`)
  }
  return { id: (body as any)?.messageId ?? '' }
}
