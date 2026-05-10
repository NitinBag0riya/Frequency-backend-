/**
 * Slack notification delivery.
 *
 * Per-tenant Slack incoming webhook URL is stored in `tenant_integrations`
 * row keyed by (tenant_id, key='slack'). The user pastes the webhook URL
 * from Slack's "Incoming Webhooks" app config; we validate the shape
 * (https://hooks.slack.com/...) and POST a Block Kit payload per
 * notification.
 *
 * Why webhook URL not OAuth: Incoming Webhooks is the simplest path that
 * doesn't require us to register a Slack App with marketplace approval +
 * scope review. Webhook URLs are tenant-secret (anyone with the URL can
 * post to that channel) so we encrypt at rest using the same crypto helper
 * used for connector OAuth tokens.
 *
 * Send pattern: Slack ignores duplicate sends naturally (same content
 * posts repeatedly), so no dedup window — we rely on the
 * `notification_delivery_log` "already sent" check the same way email does.
 *
 * Failures: log + write 'failed' row to delivery log. Slack 4xx (bad URL,
 * deactivated webhook) is permanent — caller should surface this to the
 * user via Settings → Notifications so they can re-paste a fresh webhook.
 * 5xx is treated as transient (still logs as failed; future retry worker
 * will handle).
 */

import type { SupabaseClient } from '@supabase/supabase-js'

const SLACK_WEBHOOK_PREFIX = 'https://hooks.slack.com/'

export interface SlackNotificationArgs {
  /** The webhook URL stored on the tenant_integrations row. */
  webhookUrl: string
  title:      string
  body?:      string | null
  link?:      string | null
  /** App URL for converting relative links to absolute. */
  appUrl?:    string
  /** Severity → Slack accent colour. info/success/warning/error. */
  severity?:  'info' | 'success' | 'warning' | 'error'
}

export interface SlackResult {
  ok: true
}

/**
 * POST a Block Kit message to a Slack incoming webhook. Throws on non-2xx
 * (caller catches + writes to notification_delivery_log).
 */
export async function sendSlackNotification(args: SlackNotificationArgs): Promise<SlackResult> {
  if (!args.webhookUrl.startsWith(SLACK_WEBHOOK_PREFIX)) {
    throw new Error(`Slack webhook URL must start with ${SLACK_WEBHOOK_PREFIX}`)
  }
  const appUrl = args.appUrl ?? process.env.FRONTEND_URL ?? 'https://app.frequency.in'
  const absoluteLink = args.link ? toAbsoluteSafeUrl(args.link, appUrl) : null

  // Block Kit — section + optional context with link button.
  // Slack strips colour from `attachments` only when the wrapper
  // includes `color`, so we keep both: `blocks` for content, `attachments`
  // for the side accent bar (matches user severity colour).
  const blocks: any[] = [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*${escapeSlack(args.title)}*${args.body ? `\n${escapeSlack(args.body)}` : ''}`,
      },
    },
  ]
  if (absoluteLink) {
    blocks.push({
      type: 'actions',
      elements: [
        {
          type: 'button',
          text: { type: 'plain_text', text: 'Open in Frequency' },
          url:  absoluteLink,
          style: args.severity === 'error' ? 'danger' : 'primary',
        },
      ],
    })
  }

  const payload = {
    blocks,
    attachments: [
      {
        color: severityColour(args.severity),
        // `fallback` shows in mobile push notifications + screen readers
        // when blocks are unavailable.
        fallback: `${args.title}${args.body ? ` — ${args.body}` : ''}`,
      },
    ],
  }

  const res = await fetch(args.webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
  // Slack returns 200 with body 'ok' on success, 4xx with text body on error.
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`Slack webhook ${res.status}: ${text.slice(0, 200)}`)
  }
  return { ok: true }
}

/**
 * Resolve the tenant's stored Slack webhook URL. Returns null if Slack
 * isn't configured for this tenant — caller should treat as "skip slack
 * delivery for this notification" rather than an error.
 *
 * NOTE on storage: webhook URL lives in `tenant_integrations.config.webhook_url`.
 * If a future migration moves Slack to OAuth (real Slack App), update this
 * single function — every caller goes through here.
 */
export async function getTenantSlackWebhook(
  supabase: SupabaseClient,
  tenantId: string,
): Promise<string | null> {
  const { data } = await supabase.from('tenant_integrations')
    .select('config')
    .eq('tenant_id', tenantId)
    .eq('key', 'slack')
    .maybeSingle()
  const url = (data as any)?.config?.webhook_url
  if (typeof url !== 'string' || !url.startsWith(SLACK_WEBHOOK_PREFIX)) return null
  return url
}

// ── Helpers ───────────────────────────────────────────────────────────────

/** Slack mrkdwn escapes: < > & only. URLs use angle-bracket syntax separately. */
function escapeSlack(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/** Map our severity enum to Slack attachment colour bar (hex). */
function severityColour(s?: string): string {
  switch (s) {
    case 'success': return '#22c55e'
    case 'warning': return '#f59e0b'
    case 'error':   return '#ef4444'
    default:        return '#0F6E56'   // brand teal
  }
}

/**
 * SECURITY: same allowlist as lib/email.ts — only http(s) absolute or
 * `/`-rooted relative paths reach the action button. Anything else falls
 * back to app root. Stops a workflow node that writes a malicious link
 * field (javascript:, data:, …) from becoming a Slack-clickable URL.
 */
function toAbsoluteSafeUrl(link: string, appUrl: string): string {
  const trimmed = String(link).trim()
  if (trimmed.startsWith('/') || trimmed.startsWith('?') || trimmed.startsWith('#')) {
    return `${appUrl.replace(/\/$/, '')}${trimmed.startsWith('/') ? '' : '/'}${trimmed}`
  }
  if (/^https?:\/\//i.test(trimmed)) return trimmed
  return appUrl
}
