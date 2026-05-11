/**
 * Centralized env loader. Use `import './env'` (or transitively) at the top
 * of any entry point.
 *
 * Why `override: true`:
 *   The shell environment may export an EMPTY ANTHROPIC_API_KEY (or other
 *   secret) — e.g. from a stale `export ANTHROPIC_API_KEY=` line — which
 *   silently shadows the real value in .env when dotenv runs in default
 *   (non-override) mode. This produced the "Could not resolve authentication
 *   method" failures in /api/parse-workflow even though the .env file was
 *   correct. Override mode makes .env the source of truth.
 *
 * If you ever need shell vars to win (e.g. CI), set `process.env.DOTENV_NO_OVERRIDE=1`.
 */
import dotenv from 'dotenv'
dotenv.config({ override: process.env.DOTENV_NO_OVERRIDE !== '1' })

/**
 * WA Business Calling env validation.
 *
 * In production, refuse to start if the required webhook + Meta keys are
 * missing — silent miscount of recording consent / billing minutes is worse
 * than a loud boot failure. In dev, warn so local hacking still works.
 *
 * Concurrency / TTL defaults match `01-backend-design.md` §11. Concrete
 * values are pulled at worker-start time via `Number(process.env.X ?? default)`
 * (see `src/queue.ts` and each `src/workers/call-*.ts`), so editing this
 * block alone doesn't change worker behavior — the read sites above are
 * the authoritative reference.
 */
{
  const isProd = process.env.NODE_ENV === 'production'
  const required = ['META_APP_SECRET']
  const missing = required.filter((k) => !process.env[k] || String(process.env[k]).length < 8)
  if (missing.length > 0) {
    const msg = `[boot] WA Calling required env vars missing or empty: ${missing.join(', ')}. ` +
                `Webhook HMAC verification will reject every Meta delivery until set.`
    if (isProd) {
      console.error(`[boot] FATAL: ${msg} Refusing to start.`)
      process.exit(1)
    } else {
      console.warn(`[boot] WARN: ${msg}`)
    }
  }
}

// Defaults consumed by the calling feature. NOT mutated here — code reads
// the live `process.env.X` to allow dynamic test overrides. This object is
// exported for self-documentation: greppable single source of "what env
// the calling feature uses, and what default each falls back to".
export const CALLING_ENV_DEFAULTS = Object.freeze({
  WA_CALLING_WEBHOOK_PATH:            '/webhook/wa-calls',
  CALL_DISPATCH_CONCURRENCY:          '5',
  CALL_EVENT_INGEST_CONCURRENCY:      '50',
  CALL_RECORDING_ARCHIVE_CONCURRENCY: '10',
  CALL_TRANSCRIBE_CONCURRENCY:        '3',
  RECORDING_TTL_SECONDS:              '3600',
  RECORDING_RAW_TTL_SECONDS:          '600',
  META_CALLS_API_BASE:                'https://graph.facebook.com/v18.0',
  TRANSCRIBE_MODEL:                   'claude-sonnet-4-6',
  TRANSCRIBE_AI_DOLLAR_FLOOR:         '0.05',
  CALL_TRANSCRIPT_PII_REDACT:         '1',
})
