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
