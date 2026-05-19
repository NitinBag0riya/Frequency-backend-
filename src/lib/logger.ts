/**
 * Minimal leveled logger — wraps console with a runtime-gated debug level.
 *
 * Audit context: the comprehensive P0+P1+P2 review found 99 `console.log`
 * calls across the BE, of which **nine in src/index.ts fire on EVERY
 * authed request** (the identifyTenant middleware chain). At 100 req/min
 * that's ~900 lines/min of structured-but-unparseable noise — enough to
 * swamp any log aggregator (Vercel/Fly/Loki) for nothing useful.
 *
 * This module gives us a way to silence the noisy paths without losing
 * the operationally-meaningful logs (boot banner, OAuth handshake,
 * webhook intake, worker startup). The strategy is incremental:
 *
 *   - `logger.debug(...)`  → no-op unless DEBUG env var is `1` / `true`.
 *                            Use for per-request middleware traces, query
 *                            resolution chains, and other "useful when
 *                            debugging, noise in prod" lines.
 *   - `logger.info(...)`   → always emits via console.log. Use for
 *                            boot banners, OAuth flow milestones, real
 *                            tenant-create / webhook-subscribe events.
 *   - `logger.warn(...)`   → console.warn. Use for recoverable issues.
 *   - `logger.error(...)`  → console.error. Use for failures.
 *
 * Intentionally NOT a pino/winston dep. The 2026 BE runs on a single
 * dyno; the structured-aggregator world is a P3+ concern. This module
 * exists to make the noise-vs-signal split toggleable, not to chase a
 * fancy logging stack.
 */

/** True if DEBUG env var is set to a truthy string. Read once at module
 *  load — restart the process to toggle. (We don't re-read every call to
 *  avoid the per-call env-string parse cost on a hot path.) */
const DEBUG_ENABLED = (() => {
  const v = String(process.env.DEBUG ?? '').toLowerCase().trim()
  return v === '1' || v === 'true' || v === 'yes'
})()

export const logger = {
  /** No-op unless DEBUG=1. Use for per-request middleware traces. */
  debug: DEBUG_ENABLED
    ? (...args: unknown[]) => { console.log(...args) }
    : (..._args: unknown[]) => { /* gated off */ },

  /** Always emits. Use for boot banners + ops milestones. */
  info: (...args: unknown[]) => { console.log(...args) },

  /** Always emits via console.warn. Recoverable issues. */
  warn: (...args: unknown[]) => { console.warn(...args) },

  /** Always emits via console.error. Failures. */
  error: (...args: unknown[]) => { console.error(...args) },

  /** Convenience to check the runtime flag, e.g. for branch logic that
   *  skips an expensive payload-stringify when debug is off. */
  isDebugEnabled: () => DEBUG_ENABLED,
}
