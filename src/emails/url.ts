/**
 * CTA-URL safety for emails.
 *
 * Moved verbatim from lib/email.ts (renderNotificationEmail's helper) so the
 * scheme allowlist lives next to the templates that depend on it.
 *
 * SECURITY: React auto-escapes children + attribute *values* when rendering,
 * but it does NOT sanitize href *schemes* — `<a href="javascript:…">` renders
 * as-is. So any user-influenced link MUST pass through absoluteUrl() BEFORE it
 * reaches a <Button href> / <Link href>. Only http(s) absolute URLs and
 * same-origin relative paths survive; everything else (javascript:, data:,
 * vbscript:, file:, mailto:, custom schemes, protocol-relative //evil.com) is
 * replaced with the app root so the CTA degrades to "open Frequency" rather
 * than becoming a dangerous link.
 */

import { APP_URL } from './theme'

export function absoluteUrl(link: string | null | undefined, appUrl: string = APP_URL): string {
  const base = (appUrl || APP_URL).replace(/\/$/, '')
  if (link == null) return base
  const trimmed = String(link).trim()
  if (!trimmed) return base

  // Protocol-relative (`//evil.com`, `/\evil.com`) → reject to app root. Must
  // be checked BEFORE the same-origin `/` test, which would otherwise treat
  // `//host` as a path.
  if (/^\/[/\\]/.test(trimmed)) return base

  // Bare same-origin paths: must start with `/`, `?`, or `#`.
  if (trimmed.startsWith('/') || trimmed.startsWith('?') || trimmed.startsWith('#')) {
    return `${base}${trimmed.startsWith('/') ? '' : '/'}${trimmed}`
  }
  // Absolute http(s) only. (Protocol-relative `//host` is NOT http(s)-prefixed
  // so it correctly falls through to the app root.)
  if (/^https?:\/\//i.test(trimmed)) return trimmed
  // javascript:, data:, vbscript:, mailto:, custom schemes, raw words → root.
  return base
}
