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

/**
 * Render a notification's title + body into a minimal but readable HTML
 * email. Inline styles only (Gmail strips <style>; everything outside the
 * literal body gets stripped on most clients).
 *
 * link is optional — when present, renders a primary CTA button.
 *
 * Kept template-free on purpose: a notification's body is already short
 * and contextual, so wrapping it in a generic chrome ("Frequency"
 * banner + tagline + CTA + footer) is enough. If we later want
 * per-event-type richer templates, switch to MJML or a tagged-template
 * lib then.
 */
export function renderNotificationEmail(args: {
  title: string
  body?: string | null
  link?: string | null
  appUrl?: string
}): { html: string; text: string } {
  const { title, body, link, appUrl = process.env.FRONTEND_URL ?? 'https://app.frequency.in' } = args
  const cta = link
    ? `<tr><td style="padding-top:24px"><a href="${escapeAttr(absoluteUrl(link, appUrl))}" style="display:inline-block;background:#0F6E56;color:#fff;text-decoration:none;font-weight:600;padding:10px 20px;border-radius:8px;font-family:DM Sans,system-ui,sans-serif;font-size:14px">Open in Frequency →</a></td></tr>`
    : ''

  const html = `<!doctype html><html><body style="margin:0;background:#f7f8f7;font-family:DM Sans,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#1a1a1a;-webkit-font-smoothing:antialiased">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f7f8f7;padding:40px 16px">
    <tr><td align="center">
      <table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;background:#fff;border-radius:14px;border:1px solid #e6e8e6;overflow:hidden">
        <tr><td style="padding:24px 28px;border-bottom:1px solid #f0f1f0;font-weight:700;color:#0F6E56;letter-spacing:-0.01em">Frequency</td></tr>
        <tr><td style="padding:28px">
          <h1 style="margin:0 0 8px 0;font-size:18px;font-weight:600;line-height:1.35">${escapeHtml(title)}</h1>
          ${body ? `<p style="margin:0;font-size:14px;line-height:1.55;color:#4b5563">${escapeHtml(body)}</p>` : ''}
          ${cta ? `<table role="presentation" cellpadding="0" cellspacing="0">${cta}</table>` : ''}
        </td></tr>
        <tr><td style="padding:18px 28px;border-top:1px solid #f0f1f0;font-size:11px;color:#9ca3af">
          You're receiving this because of your <a href="${escapeAttr(appUrl)}/settings/notifications" style="color:#9ca3af">notification preferences</a>.
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`

  const text = [
    title,
    body ? '\n' + body : '',
    link ? `\n\nOpen: ${absoluteUrl(link, appUrl)}` : '',
    '\n\n— Frequency',
  ].join('')

  return { html, text }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}
function escapeAttr(s: string): string {
  return escapeHtml(s)
}
/**
 * Resolve a notification link to an absolute URL safe for use in href.
 *
 * SECURITY: ONLY http(s) absolute URLs OR same-origin relative paths
 * survive. Anything else (javascript:, data:, vbscript:, file:, ftp:,
 * mailto:, tel:, custom schemes) is replaced with the app root. This
 * prevents an attacker who's controlled the `link` field on a
 * notification (e.g., via a workflow node that writes to data) from
 * sending an XSS-bait email that becomes clickable in Gmail.
 */
function absoluteUrl(link: string, appUrl: string): string {
  const trimmed = String(link).trim()
  // Bare same-origin paths: must start with `/` (or `?` / `#`). Anything
  // else with a `:` before any `/` is a scheme — only allow http(s).
  if (trimmed.startsWith('/') || trimmed.startsWith('?') || trimmed.startsWith('#')) {
    return `${appUrl.replace(/\/$/, '')}${trimmed.startsWith('/') ? '' : '/'}${trimmed}`
  }
  if (/^https?:\/\//i.test(trimmed)) return trimmed
  // Anything else (javascript:, data:, mailto:, custom, raw word) → fallback
  // to app root so the CTA still works as "Open Frequency" rather than a
  // dangerous href.
  return appUrl
}
