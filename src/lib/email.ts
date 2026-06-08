/**
 * Email delivery — Resend HTTP wrapper.
 *
 * No npm dependency on the `resend` SDK to keep the surface tiny + auditable.
 * Resend's REST API is straightforward (Bearer auth + JSON), and rolling our
 * own gives us control over retries, error shapes, and timeouts without
 * tracking another package's update cadence.
 *
 * Used by the notifications helper (routes/notifications.ts) when an event
 * type's `default_channels` includes 'email'. The user's prefs can override
 * to disable email per-event-type.
 *
 * Env:
 *   RESEND_API_KEY     — re_… (test or live)
 *   RESEND_FROM_EMAIL  — e.g. "Frequency <hello@frequency.in>"
 *   RESEND_REPLY_TO    — optional; defaults to no Reply-To
 *
 * Picked Resend because:
 *   - Free tier covers MVP (3k emails/month)
 *   - Simple REST API (no SDK juggling)
 *   - Reasonable India deliverability (rented IPs include Asia-Pacific)
 *   - Stripe-billed so we get one Razorpay-isolated invoice instead of
 *     spreading SaaS spend across multiple providers
 */

const BASE = 'https://api.resend.com'

export interface SendEmailArgs {
  to:       string | string[]
  subject:  string
  html:     string
  text?:    string
  reply_to?: string
  /** Idempotency key — Resend dedupes within 24h on this. We use it for
   *  notification deliveries so a worker retry doesn't double-send. */
  idempotency_key?: string
}

export interface SendEmailResult {
  id: string
}

/**
 * Send a single email via Resend. Throws if the API key isn't configured
 * or if Resend returns a non-2xx — caller should catch + log to
 * notification_delivery_log so we have a record of why it failed.
 *
 * Returns the Resend message id so we can reference it in delivery logs.
 */
export async function sendEmail(args: SendEmailArgs): Promise<SendEmailResult> {
  const apiKey = process.env.RESEND_API_KEY
  const from = process.env.RESEND_FROM_EMAIL
  if (!apiKey || !from) {
    throw new Error('Email not configured: set RESEND_API_KEY (re_…) and RESEND_FROM_EMAIL (e.g. "Frequency <hello@frequency.in>" or just "hello@frequency.in")')
  }

  const headers: Record<string, string> = {
    'Authorization': `Bearer ${apiKey}`,
    'Content-Type':  'application/json',
  }
  if (args.idempotency_key) headers['Idempotency-Key'] = args.idempotency_key

  const res = await fetch(`${BASE}/emails`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      from,
      to:        Array.isArray(args.to) ? args.to : [args.to],
      subject:   args.subject,
      html:      args.html,
      text:      args.text,
      reply_to:  args.reply_to ?? process.env.RESEND_REPLY_TO ?? undefined,
    }),
  })
  const body = await res.json().catch(() => ({} as any))
  if (!res.ok) {
    throw new Error(`Resend send failed (${res.status}): ${(body as any)?.message ?? (body as any)?.error ?? 'unknown'}`)
  }
  return { id: (body as any)?.id ?? '' }
}
