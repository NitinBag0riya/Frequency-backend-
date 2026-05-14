import './env'   // must be first — loads .env with override=true
import express from 'express'
import fs from 'fs'
import path from 'path'
import cors from 'cors'
import crypto from 'crypto'
import helmet from 'helmet'
import rateLimit from 'express-rate-limit'
import { createClient } from '@supabase/supabase-js'
import Anthropic from '@anthropic-ai/sdk'
import {
  sheetsAppendRow, sheetsUpdateRange, sheetsReadRange, sheetsGetMetadata, listSpreadsheets,
  calendarCreateEvent, calendarCheckAvailability
} from './google'
import { createLeadsRouter } from './leads'
import { createAdminRouter } from './admin'
import { createPhase3Router } from './routes/phase3'
import { createDataSourcesRouter } from './routes/data-sources'
import { createConnectorsRouter }  from './routes/connectors'
import { createBillingRouter }     from './routes/billing'
import { createWaFeaturesRouter }  from './routes/wa-features'
import { createTelegramRouter }    from './routes/telegram'
import { createInstagramRouter }   from './routes/instagram'
import { createMetaAdsRouter }     from './routes/meta-ads'
import { createSuperAdminRouter }  from './routes/super-admin'
import { createTeamsRouter }       from './routes/teams'
import { createNotificationsRouter } from './routes/notifications'
import { createApprovalsRouter, requireApproval } from './routes/approvals'
import { createWorkflowRecosRouter } from './routes/workflow-recos'
import { createWaCallingRouter }     from './routes/wa-calling'
import {
  enqueueWorkflowExecution,
  workflowQueue, messageQueue, broadcastQueue, cronQueue,
  callDispatchQueue, callEventIngestQueue, callRecordingArchiveQueue, callTranscribeQueue,
  attachDebugListeners,
} from './queue'
import { createBullBoard } from '@bull-board/api'
import { BullMQAdapter } from '@bull-board/api/bullMQAdapter'
import { ExpressAdapter } from '@bull-board/express'
import { z } from 'zod'
import {
  validateBody,
  WorkflowCreateSchema, WorkflowPatchSchema,
  BroadcastCreateSchema,
  ContactCreateSchema, ContactPatchSchema,
  RazorpayConnectSchema, InboxSendSchema,
  CampaignCreateSchema, CampaignPatchSchema,
} from './validation'
// B6: per-route filter+sort column allowlist. Replaces the prior
// Object.entries(parsed).forEach((k,v) => q.ilike(k, ...)) which let any
// client-controlled key flow into the PostgREST column expression.
import { isAllowedColumn, FILTER_ALLOWLISTS, sanitizeSearch, type FilterAllowlistName } from './lib/safe-key'
// F5: standardized error response shape — every 4xx/5xx JSON body goes
// through this helper so the FE can branch on `error.code` reliably.
import { apiError } from './lib/api-error'

/**
 * Apply ?filters={"<col>":"<val>"} to a PostgREST query, gated by the
 * per-route column allowlist. Returns either the (possibly mutated) query
 * or a sentinel `{ error: 'invalid_filter_key', key }` shape that the caller
 * forwards as a 400 — explicit reject, not silent drop, so a misbehaving
 * client gets a clear failure mode.
 */
function applyAllowedFilters<T>(q: T, parsed: any, route: FilterAllowlistName): T | { __filterError: { key: string } } {
  if (!parsed || typeof parsed !== 'object') return q
  for (const [key, val] of Object.entries(parsed)) {
    if (!val) continue
    if (!isAllowedColumn(route, key)) {
      return { __filterError: { key } }
    }
    q = (q as any).ilike(key, `%${String(val)}%`)
  }
  return q
}

/**
 * Validate `?sortBy=<col>` against the per-route column allowlist. Returns
 * the validated key or `null` if the caller passed a column not in the
 * allowlist — in which case callers should either ignore it (use default)
 * or 400. We choose to 400 to surface integration bugs rather than silently
 * sort by created_at when the FE asked for something else.
 */
function validateSortBy(route: FilterAllowlistName, raw: string | undefined, fallback = 'created_at'): { ok: true; sortBy: string } | { ok: false; key: string } {
  if (!raw) return { ok: true, sortBy: fallback }
  if (!isAllowedColumn(route, raw)) return { ok: false, key: raw }
  return { ok: true, sortBy: raw }
}

// ── Boot-time security checks ────────────────────────────────────────────
// Refuse to start in production without the impersonation HMAC secret.
// Without it, super-admin.ts:408 would mint per-request throwaway secrets,
// turning impersonation into silent permadeny — annoying to debug, and a
// trap if NODE_ENV is set incorrectly in staging.
if (process.env.NODE_ENV === 'production') {
  const impSecret = process.env.IMPERSONATION_HMAC_SECRET ?? process.env.GOOGLE_TOKEN_SECRET
  if (!impSecret || impSecret.length < 32) {
    console.error('[boot] FATAL: IMPERSONATION_HMAC_SECRET missing or <32 chars in production. Refusing to start.')
    process.exit(1)
  }
}

// B4: OAuth state HMAC secret. Required to mint signed `state` blobs on the
// Google / Instagram / Facebook OAuth handoff. Without this we'd fall back
// to per-process random secrets that can't survive a process restart, which
// would silently 401 every callback that landed on a different worker.
if (process.env.NODE_ENV === 'production') {
  const oauthSecret = process.env.OAUTH_STATE_SECRET ?? process.env.IMPERSONATION_HMAC_SECRET
  if (!oauthSecret || oauthSecret.length < 32) {
    console.error('[boot] FATAL: OAUTH_STATE_SECRET missing or <32 chars in production. Refusing to start.')
    process.exit(1)
  }
}

// B11: Webhook verify token must be set + meaningfully long. The legacy
// fallback ('Frequency_webhook_secret') was a public string anyone reading
// this repo could use to spoof webhook subscription handshakes — refuse to
// boot without an explicit, sufficiently-long value.
{
  const t = process.env.WH_VERIFY_TOKEN ?? ''
  if (!t || t.length < 16) {
    console.error('[boot] FATAL: WH_VERIFY_TOKEN missing or <16 chars. Generate with: openssl rand -hex 32')
    process.exit(1)
  }
}

// B8: SMOKE_TEST_TOKEN bypass guardrail. The dev bypass below logs a request
// in as the seeded demo user when the literal string SMOKE_TEST_TOKEN is
// passed as auth. Production must NEVER allow this; explicitly refuse to
// boot if someone enables it there by mistake.
if (process.env.NODE_ENV === 'production' && process.env.ALLOW_SMOKE_TEST === '1') {
  console.error('[boot] FATAL: ALLOW_SMOKE_TEST=1 is not allowed in production. Refusing to start.')
  process.exit(1)
}

// Warn (not fatal) about missing Razorpay env vars. Without them, the
// billing routes would error opaquely on first use; loud boot warning makes
// the misconfiguration obvious before a customer discovers it.
{
  const missing: string[] = []
  if (!process.env.RAZORPAY_KEY_ID)         missing.push('RAZORPAY_KEY_ID')
  if (!process.env.RAZORPAY_KEY_SECRET)     missing.push('RAZORPAY_KEY_SECRET')
  if (!process.env.RAZORPAY_WEBHOOK_SECRET) missing.push('RAZORPAY_WEBHOOK_SECRET')
  if (missing.length > 0) {
    console.warn(`[boot] Razorpay billing partially configured — missing: ${missing.join(', ')}. /api/billing/* endpoints will error until set.`)
  }
}

// Same for email — notifications still deliver in-app without these, but
// any default_channels = ['in_app','email'] event will silently skip its
// email leg. Loud boot warning so the misconfiguration shows up in logs.
{
  const missing: string[] = []
  if (!process.env.RESEND_API_KEY)    missing.push('RESEND_API_KEY')
  if (!process.env.RESEND_FROM_EMAIL) missing.push('RESEND_FROM_EMAIL')
  if (missing.length > 0) {
    console.warn(`[boot] Email delivery not configured — missing: ${missing.join(', ')}. In-app notifications still work; email leg will be skipped + logged.`)
  }
}

// Defence-in-depth against runtime prototype pollution.
//
// What this blocks: AFTER the freeze runs, any code path that does
//   const x = req.body
//   target[x.something] = x.somethingElse
// where x came from `JSON.parse(...)` containing `{"__proto__": {...}}` —
// the `__proto__` is an own property post-parse (not a setter), so it
// doesn't pollute by itself; but any subsequent code that does
// `Object.assign({}, x)` or `{ ...x }` and then iterates with a `for…in`
// would inherit the polluted props. With the prototype frozen, those
// writes throw in strict mode / silently no-op in sloppy mode.
//
// What this does NOT block: any module-level pollution that ran BEFORE
// these two `Object.freeze` calls. ES module `import` statements at the
// top of this file all execute their top-level code first — so express,
// supabase-js, BullMQ, validation schemas, etc. all initialised against
// MUTABLE prototypes. That's still safe for production traffic because
// those libs reference their own captured methods internally; pollution
// arriving at runtime can't change the libs' captured references.
//
// In short: this blocks runtime DoS via attacker-supplied JSON, not boot-
// time manipulation by malicious dependencies. The combination with
// `pickAllowed`'s `hasOwnProperty.call` (src/security.ts) covers the
// main known vectors. For boot-time safety, run the freeze before any
// import — but Node's ESM/CJS hoisting makes that awkward without a
// dedicated bootstrap module.
Object.freeze(Object.prototype)
Object.freeze(Array.prototype)

const app = express()
const PORT = process.env.PORT || 3001

// F1: helmet — sets standard hardening response headers BEFORE any route
// can write to the response. Adds X-Content-Type-Options, X-Frame-Options,
// Strict-Transport-Security, Referrer-Policy, X-DNS-Prefetch-Control,
// X-Download-Options, X-Permitted-Cross-Domain-Policies, Origin-Agent-Cluster.
//
// Two helmet defaults disabled:
//   - contentSecurityPolicy: false. The FE app serves CSP via Vercel/Netlify
//     edge headers; this API never renders HTML so a server-side CSP would
//     only break the JSON responses (helmet's default CSP blocks inline
//     scripts which our /api/auth/google/callback uses to bounce the user).
//   - crossOriginEmbedderPolicy: false. OAuth popups (Facebook, Google,
//     Instagram) need to be embeddable / interact with opener.postMessage;
//     COEP would break that on browsers that honour it strictly.
app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false,
}))

// Trust the X-Forwarded-For header from a known proxy so `req.ip` reflects
// the actual client IP — critical for the per-IP rate limiter on
// /api/ingest/:token (src/leads.ts) and any future per-IP throttling.
//
// The number is the count of trusted proxy hops in front of us. In typical
// deployments:
//   - 1 = single reverse proxy (Render, Fly, single nginx, Vercel functions)
//   - 2 = CDN → load-balancer (Cloudflare → nginx → app)
// Override via TRUST_PROXY_HOPS env var if you have a deeper chain.
//
// CRITICAL: do NOT set this to `true` in prod — that trusts ANY upstream's
// XFF header, allowing spoofing from anywhere. The numeric "hop count" form
// only trusts the last N entries of the XFF chain, which the directly-attached
// proxy controls.
app.set('trust proxy', Number(process.env.TRUST_PROXY_HOPS ?? 1))

// CORS: TWO different policies depending on the path.
//   /api/ingest/* → permissive (origin: '*'). Webhook ingest is intentionally
//                   cross-origin (Zapier / n8n / arbitrary HTML forms POSTing
//                   rows). Token is the only credential, no cookies.
//   everything else → restrictive (origin: FRONTEND_URL). Defence-in-depth
//                     for cookie-borne CSRF (we use Authorization headers
//                     today but cookies could land tomorrow).
//
// Both `cors()` middlewares unconditionally write the
// `Access-Control-Allow-Origin` header on every matching request. So if BOTH
// fire on the same request, the SECOND one wins — overwriting the permissive
// `*` with the restrictive FRONTEND_URL on /api/ingest. We branch in a single
// router-level middleware so only ONE cors handler sees each request.
const ingestCors = cors({ origin: '*', methods: ['POST', 'OPTIONS'], maxAge: 86400 })
const restrictiveCors = cors({ origin: process.env.FRONTEND_URL || 'http://localhost:5173' })
app.use((req, res, next) => {
  // Match `/api/ingest` (exact) AND `/api/ingest/<token>`. The trailing-slash
  // form alone would miss preflights / probe requests sent without a token,
  // which would silently fall through to the restrictive CORS — confusing
  // for a third-party integrator hitting the URL by hand.
  if (req.path === '/api/ingest' || req.path.startsWith('/api/ingest/')) {
    return ingestCors(req, res, next)
  }
  return restrictiveCors(req, res, next)
})
// CRITICAL: the Razorpay webhook handler verifies an HMAC signature over
// the raw request bytes. If express.json() parses the body first, the
// stream is consumed and req.body becomes a parsed object — HMAC over
// `[object Object]` will never match. Mount express.raw() on the exact
// webhook path BEFORE the global JSON parser so the route gets a Buffer.
app.use('/api/billing/razorpay/webhook', express.raw({ type: 'application/json', limit: '1mb' }))

// WhatsApp Business Calling webhook — same raw-body pattern as Razorpay so
// HMAC verification gets the exact bytes Meta signed. Mount BEFORE the
// global express.json() so the parser only fires for this path.
const WA_CALLS_WEBHOOK_PATH = process.env.WA_CALLING_WEBHOOK_PATH || '/webhook/wa-calls'
app.use(WA_CALLS_WEBHOOK_PATH, express.raw({ type: 'application/json', limit: '1mb' }))

// B2: WhatsApp + Instagram inbound webhooks. Same raw-body requirement as
// the calling + Razorpay webhooks — Meta signs the exact bytes, so any JSON
// re-serialisation will break HMAC verification. Mount BEFORE the global
// express.json() parser.
app.use('/webhook/whatsapp', express.raw({ type: 'application/json', limit: '5mb' }))
app.use('/webhook/instagram', express.raw({ type: 'application/json', limit: '5mb' }))

// F2: tight global body limit. Default to 1 MB for every JSON endpoint —
// far more than any normal API call needs, but small enough to stop a
// malicious client from exhausting memory with a 50 MB payload. The routes
// that legitimately ship bigger bodies (CSV import, workflow blueprint
// save, contact bulk-insert) opt in to a higher per-route limit at their
// `app.post(...)` mount via an additional express.json({ limit: '...' })
// middleware — that limit overrides this default for the matched path.
app.use(express.json({ limit: '1mb' }))
app.use(express.urlencoded({ limit: '1mb', extended: true }))

// F2: per-route body-limit overrides for legitimate large-payload endpoints.
// Mounted as path-scoped middleware BEFORE the route handler runs — express
// matches in order, so when the matching express.json() with the larger
// limit fires first, the global 1 MB parser sees an already-parsed body and
// is a no-op. Audit performed: file uploads, bulk lead inserts, workflow
// blueprint saves (which can carry hundreds of node configs).
app.post('/api/lead-tables/:id/import', express.json({ limit: '20mb' }))
app.post('/api/workflows',              express.json({ limit: '5mb'  }))
app.patch('/api/workflows/:id',         express.json({ limit: '5mb'  }))
app.post('/api/workflows/preview',      express.json({ limit: '5mb'  }))
app.post('/api/workflows/:id/dry-run',  express.json({ limit: '5mb'  }))
// Skills + workflow-recos accept similar blueprint shapes.
app.post('/api/skills/:id/apply',       express.json({ limit: '5mb'  }))
app.post('/api/workflow-recos/:id/apply', express.json({ limit: '5mb' }))

// B7: Per-request ID. Set as early as possible so every downstream log,
// error response, and audit entry can reference the same opaque ID. Echoed
// back in the response header so clients can correlate (curl + grep server
// logs to find the matching trace).
app.use((req, res, next) => {
  const incoming = req.headers['x-request-id']
  const id = (typeof incoming === 'string' && incoming.length > 0 && incoming.length < 200)
    ? incoming
    : crypto.randomUUID()
  ;(req as any).id = id
  res.setHeader('x-request-id', id)
  next()
})

// F9: log line redaction. Even though logToFile() today only writes
// `${method} ${path}`, future contributors will inevitably reach for it to
// log a header / cookie / token value. Centralise the redaction here so
// any string that lands in the log file gets sensitive-token patterns
// rewritten BEFORE being persisted. Cheap belt-and-braces; no perf impact
// on the path-only happy path (no matches → no replacement).
const HEADER_REDACT_PATTERNS: Array<[RegExp, string]> = [
  // Bearer / Basic / arbitrary scheme followed by an opaque token.
  [/Authorization:\s*\S+/gi,                       'Authorization: [REDACTED]'],
  [/X-Impersonate-Token:\s*\S+/gi,                 'X-Impersonate-Token: [REDACTED]'],
  [/Cookie:\s*[^\r\n]+/gi,                         'Cookie: [REDACTED]'],
  [/Set-Cookie:\s*[^\r\n]+/gi,                     'Set-Cookie: [REDACTED]'],
  [/X-Telegram-Bot-Api-Secret-Token:\s*\S+/gi,     'X-Telegram-Bot-Api-Secret-Token: [REDACTED]'],
  [/x-hub-signature(?:-256)?:\s*\S+/gi,            'X-Hub-Signature: [REDACTED]'],
]
function redactLogLine(s: string): string {
  let out = s
  for (const [re, repl] of HEADER_REDACT_PATTERNS) out = out.replace(re, repl)
  return out
}
function logToFile(msg: string) {
  const line = `[${new Date().toISOString()}] ${redactLogLine(msg)}\n`
  try { fs.appendFileSync('debug.log', line) } catch(e) {}
}

// B12 + F9: log redaction. We deliberately log only `req.path` (not `req.url`)
// so query strings — which often carry tokens / verification codes / OAuth
// state — never reach the log file. Sensitive paths (webhooks + OAuth
// callbacks) skip body+query logging entirely; the redactObject helper
// rewrites well-known secret keys to '[REDACTED]' before any structured
// logger touches the payload.
const SENSITIVE_LOG_PATHS = new Set([
  '/webhook/whatsapp',
  '/webhook/instagram',
  '/webhook/telegram',
  '/api/billing/razorpay/webhook',
  // F9: OAuth callbacks carry `?code=...&state=...` — short-lived but
  // sensitive enough that a leaked log line within their TTL is exploitable.
  '/api/auth/google/callback',
  '/api/auth/instagram/callback',
  '/api/auth/facebook/callback',
  '/api/auth/airtable/callback',
  '/api/auth/shopify/callback',
  '/api/auth/razorpay/callback',
])
const SECRET_KEY_NAMES = new Set([
  'token', 'secret', 'password', 'code', 'access_token', 'refresh_token',
  'client_secret', 'authorization', 'cookie', 'set-cookie', 'api_key', 'apikey',
  // F9 additions
  'x-impersonate-token', 'impersonate_token', 'webhook_secret',
  'x-telegram-bot-api-secret-token', 'x-hub-signature', 'x-hub-signature-256',
])
function redactObject(input: unknown, depth = 0): unknown {
  if (depth > 4 || input == null) return input
  if (Array.isArray(input)) return input.map((v) => redactObject(v, depth + 1))
  if (typeof input !== 'object') return input
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    if (SECRET_KEY_NAMES.has(k.toLowerCase())) out[k] = '[REDACTED]'
    else out[k] = redactObject(v, depth + 1)
  }
  return out
}

/** Parse page / pageSize from query params, return offset + limit for Supabase .range() */
function parsePagination(query: Record<string, string>) {
  const page = Math.max(1, parseInt(query.page ?? '1', 10) || 1)
  const pageSize = Math.min(100, Math.max(1, parseInt(query.pageSize ?? '25', 10) || 25))
  const offset = (page - 1) * pageSize
  return { page, pageSize, offset }
}

app.use((req, res, next) => {
  // B12 + F9: log path only — req.url includes the query string which
  // routinely carries OAuth `code`, `state`, verify tokens, etc. For
  // SENSITIVE_LOG_PATHS we don't even log the path's exact form (the
  // tenant_id sub-path can be telemetry-flavoured PII); collapse to the
  // base path so request rate is still observable but per-tenant linkability
  // requires DB joins, not log scraping.
  const isSensitive = SENSITIVE_LOG_PATHS.has(req.path) ||
    Array.from(SENSITIVE_LOG_PATHS).some(p => req.path.startsWith(p + '/'))
  if (isSensitive) {
    // Find the base path that matched and log only that.
    const matched = Array.from(SENSITIVE_LOG_PATHS).find(p => req.path === p || req.path.startsWith(p + '/')) ?? req.path
    logToFile(`${req.method} ${matched} [body+query suppressed]`)
    console.log(`[request] ${req.method} ${matched} [body+query suppressed]`)
  } else {
    logToFile(`${req.method} ${req.path}`)
    console.log(`[request] ${req.method} ${req.path}`)
  }
  next()
})

// ── F3: Rate limiting ─────────────────────────────────────────────────────
// Layered limits — looser baseline on every `/api/*` request, with tighter
// limits on the endpoints that burn third-party credit (AI prompts → Anthropic,
// WhatsApp send → Meta credit) or that are obvious brute-force targets (auth).
//
// keyGenerator combines `req.ip` AND `req.user?.id` so a single bad actor
// can't burn through the quota by rotating tenants or IPs. Auth lands on the
// route handler — for unauthed paths req.user is undefined and we fall back
// to IP-only. We deliberately do NOT use `req.tenantId` because identifyTenant
// hasn't run by the time the rate-limit middleware fires.
//
// All limiter responses use the standardized error shape via `handler:`.
//
// Platform users (super-admin / impersonation flows) are skipped — internal
// dashboard browsing can spike well above the baseline and we don't want a
// support engineer locked out mid-investigation. Detection is best-effort:
// the X-Impersonate-Token header is the only signal available pre-auth.

function isPlatformRequest(req: express.Request): boolean {
  // Best-effort detection — the platform header is set by the Platform Console
  // FE only. Forging it just shifts the user past the limit; they still need
  // a valid bearer token to hit any authenticated endpoint downstream.
  return !!req.headers['x-impersonate-token'] || !!req.headers['x-platform-console']
}

function makeLimiter(opts: { windowMs: number; max: number; perUser?: boolean }) {
  return rateLimit({
    windowMs: opts.windowMs,
    max: opts.max,
    standardHeaders: true,
    legacyHeaders: false,
    skip: isPlatformRequest,
    keyGenerator: (req) => {
      const ip = req.ip ?? 'unknown'
      if (!opts.perUser) return ip
      const userId = (req as any).user?.id ?? 'anon'
      return `${ip}:${userId}`
    },
    handler: (req, res) => {
      return apiError(
        res,
        429,
        'rate_limited',
        'Too many requests — slow down and try again in a moment.',
        { retry_after_seconds: Math.ceil(opts.windowMs / 1000) },
      )
    },
  })
}

// Global per-IP+user baseline: 600/min — generous enough for a power user
// flipping between tabs, low enough to stop a single buggy client from
// saturating the API.
const globalLimiter = makeLimiter({ windowMs: 60_000, max: 600, perUser: true })
app.use('/api/', globalLimiter)

// AI endpoints — Anthropic burn risk. 10/min is plenty for human use of the
// workflow-from-prompt flow; abusive clients hit the wall fast.
const aiLimiter = makeLimiter({ windowMs: 60_000, max: 10, perUser: true })
app.use('/api/parse-workflow', aiLimiter)
app.use('/api/workflow-recos', aiLimiter)
app.use('/api/skills/match',   aiLimiter)

// WhatsApp / Telegram / Instagram send — every call costs Meta credit.
// 30/min covers manual inbox replies + a moderate broadcast trigger rate.
const sendLimiter = makeLimiter({ windowMs: 60_000, max: 30, perUser: true })
app.use('/api/inbox/send',           sendLimiter)
app.use('/api/broadcasts',           sendLimiter)  // covers /:id/send
app.use('/api/wa-calling/dispatch',  sendLimiter)

// Auth / onboarding — brute-force surface. IP-only keying so a single bad
// actor cycling user IDs can't bypass it. 10/min is tight but legitimate
// flows make at most 2–3 calls per minute.
const authLimiter = makeLimiter({ windowMs: 60_000, max: 10, perUser: false })
app.use('/api/auth/',     authLimiter)
app.use('/api/onboarding', authLimiter)

app.get('/api/ping', (req, res) => res.json({ pong: true }))

// Public catalogue of available plans — used by the UpgradeBanner so the
// modal can render the actual monthly price (₹) when surfacing a 402.
// No auth required: this is marketing-grade information, same as a public
// pricing page would expose.
app.get('/api/plans', async (_req, res) => {
  try {
    const { data, error } = await supabase
      .from('plans')
      .select('id, name, monthly_price_inr, features, limits, sort_order, trial_days, is_active')
      .eq('is_active', true)
      .order('sort_order', { ascending: true })
    if (error) throw error
    res.json(data || [])
  } catch (err: any) {
    res.status(500).json({ error: err.message })
  }
})

if (!process.env.ANTHROPIC_API_KEY) {
  console.error('[startup] ANTHROPIC_API_KEY is not set — workflow parsing will fail')
}
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://yiicpndeggaedxobyopu.supabase.co'
const supabase = createClient(SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY!)

const META_APP_ID     = process.env.META_APP_ID!
const META_APP_SECRET = process.env.META_APP_SECRET!
const GRAPH           = 'https://graph.facebook.com/v18.0'
// B11: no in-source default. Boot check above (line ~85) refuses to start
// if WH_VERIFY_TOKEN is unset or <16 chars, so this read is guaranteed to
// be a real value at this point.
const WH_VERIFY_TOKEN = process.env.WH_VERIFY_TOKEN!

// ── Auth middleware ───────────────────────────────────────────────────────────
async function requireAuth(req: express.Request, res: express.Response, next: express.NextFunction) {
  const token = req.headers.authorization?.replace('Bearer ', '') || (req.query.token as string)
  if (!token) { apiError(res, 401, 'unauthorized', 'Missing authentication token.'); return }

  // B8: Smoke test bypass — strictly gated. Two conditions BOTH required:
  //   1. NODE_ENV === 'development' (NOT just !=production — staging/test
  //      builds shouldn't accept it either)
  //   2. ALLOW_SMOKE_TEST === '1' (explicit opt-in env var)
  // The boot guard above ALSO refuses to start if ALLOW_SMOKE_TEST=1 lands
  // in production by accident (defense in depth).
  if (token === 'SMOKE_TEST_TOKEN'
      && process.env.NODE_ENV === 'development'
      && process.env.ALLOW_SMOKE_TEST === '1') {
    ;(req as any).user = { id: 'bfc37cf8-ad1a-4419-a65b-d5b6548abc41' } // demo user id from seed-demo.mjs
    next()
    return
  }

  const { data: { user }, error } = await supabase.auth.getUser(token)
  if (error || !user) { apiError(res, 401, 'invalid_token', 'Authentication token is invalid or expired.'); return }
  ;(req as any).user = user
  next()
}

// ── RBAC Middlewares ──────────────────────────────────────────────────────────

async function identifyTenant(req: express.Request, res: express.Response, next: express.NextFunction) {
  const user = (req as any).user
  if (!user) { apiError(res, 401, 'unauthorized', 'Authentication required.'); return }

  // Tenant ID comes from the X-Tenant-ID header ONLY. We deliberately
  // dropped the `?tenant_id=` query-param fallback: query params end up
  // in server access logs, browser history and HTTP referer headers,
  // making them a leaky channel for what is effectively an authorisation
  // dimension. The FE always sets the header (see lib/apiCall.ts).
  const headerTenantId = req.headers['x-tenant-id'] as string | undefined
  if (req.query.tenant_id && !headerTenantId) {
    console.warn(`[identifyTenant] DEPRECATED: caller sent ?tenant_id= query param without X-Tenant-ID header — ignoring. path=${req.path}`)
  }
  console.log(`[identifyTenant] user=${user.id}, header_tenant=${headerTenantId || '(none)'}`)

  // 0. Platform-scoped role check — runs first so Platform Console actions
  //    bypass per-tenant permission checks entirely. Two paths:
  //    (a) new RBAC: a row in user_role_assignments with tenant_id IS NULL
  //    (b) legacy:   user_roles row with role='super_admin' and tenant_id IS NULL
  const { data: platformAssignment } = await supabase
    .from('user_role_assignments')
    .select('role_definitions ( key, scope )')
    .eq('user_id', user.id).is('tenant_id', null).maybeSingle()
  const platformRoleKey = (platformAssignment as any)?.role_definitions?.key as string | undefined
  let isPlatform = !!platformRoleKey

  if (!isPlatform) {
    const { data: legacySuper } = await supabase
      .from('user_roles')
      .select('role')
      .eq('user_id', user.id).is('tenant_id', null).maybeSingle()
    if (legacySuper?.role === 'super_admin') isPlatform = true
  }

  if (isPlatform) {
    ;(req as any).isSuperAdmin = true
    ;(req as any).userRoleKey = platformRoleKey || 'super_admin'
    // Platform users may still target a specific tenant via header (e.g. when
    // viewing tenant-scoped data from the admin console). If a header is
    // present, accept it as-is — they're trusted at the platform layer.
    if (headerTenantId) (req as any).tenantId = headerTenantId
    next()
    return
  }

  // 1. If header provides a tenant ID, verify the user has access to it
  if (headerTenantId) {
    // Check new RBAC table first (where invited team members live)
    const { data: assignmentForHeader } = await supabase
      .from('user_role_assignments')
      .select('role_definitions ( key )')
      .eq('user_id', user.id)
      .eq('tenant_id', headerTenantId)
      .maybeSingle()
    const assignmentRole = (assignmentForHeader as any)?.role_definitions?.key
    if (assignmentRole) {
      console.log(`[identifyTenant] resolved via user_role_assignments: tenant=${headerTenantId}, role=${assignmentRole}`)
      ;(req as any).tenantId = headerTenantId
      ;(req as any).userRole = assignmentRole
      next()
      return
    }
    // Legacy user_roles fallback
    const { data: roleForHeader } = await supabase
      .from('user_roles')
      .select('role')
      .eq('user_id', user.id)
      .eq('tenant_id', headerTenantId)
      .maybeSingle()
    if (roleForHeader) {
      console.log(`[identifyTenant] resolved via user_roles: tenant=${headerTenantId}, role=${roleForHeader.role}`)
      ;(req as any).tenantId = headerTenantId
      ;(req as any).userRole = roleForHeader.role
      next()
      return
    }
    // Check if user owns the tenant
    const { data: ownedCheck } = await supabase
      .from('tenants')
      .select('id')
      .eq('id', headerTenantId)
      .eq('user_id', user.id)
      .eq('status', 'active')
      .maybeSingle()
    if (ownedCheck) {
      console.log(`[identifyTenant] resolved via tenant ownership: tenant=${headerTenantId}, role=owner`)
      ;(req as any).tenantId = headerTenantId
      ;(req as any).userRole = 'owner'
      next()
      return
    }
    console.log(`[identifyTenant] header tenant ${headerTenantId} not accessible by user, falling through`)
  }

  // 2. Auto-detect: Check new RBAC user_role_assignments first
  const { data: assignmentAuto } = await supabase
    .from('user_role_assignments')
    .select('tenant_id, role_definitions ( key )')
    .eq('user_id', user.id)
    .not('tenant_id', 'is', null)
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle()
  if (assignmentAuto?.tenant_id) {
    const role = (assignmentAuto as any).role_definitions?.key || 'member'
    console.log(`[identifyTenant] resolved via user_role_assignments auto: tenant=${assignmentAuto.tenant_id}, role=${role}`)
    ;(req as any).tenantId = assignmentAuto.tenant_id
    ;(req as any).userRole = role
    next()
    return
  }

  // 2b. Legacy fallback: Check user_roles table
  const { data: userRole } = await supabase
    .from('user_roles')
    .select('tenant_id, role')
    .eq('user_id', user.id)
    .not('tenant_id', 'is', null)
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle()

  if (userRole?.tenant_id) {
    console.log(`[identifyTenant] resolved via user_roles auto: tenant=${userRole.tenant_id}, role=${userRole.role}`)
    ;(req as any).tenantId = userRole.tenant_id
    ;(req as any).userRole = userRole.role
    next()
    return
  }

  // 3. Fallback: user is the owner of a tenant
  const { data: ownedTenant } = await supabase
    .from('tenants')
    .select('id')
    .eq('user_id', user.id)
    .eq('status', 'active')
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle()
  if (ownedTenant) {
    console.log(`[identifyTenant] resolved via tenant ownership fallback: tenant=${ownedTenant.id}`)
    ;(req as any).tenantId = ownedTenant.id
    ;(req as any).userRole = 'admin'
    next()
    return
  }

  console.log(`[identifyTenant] FAILED for user=${user.id} — no tenant found via any path`)
  apiError(res, 403, 'no_active_tenant', 'No active tenant found. Please complete onboarding to connect your WhatsApp account.')
}

/**
 * checkPermission — gates an API call against the layered permission stack:
 *
 *   1. **Tenant lifecycle**         — suspended / deleted tenants → 403
 *   2. **User-level disable**       — user_role_assignments.disabled_at set → 403
 *   3. **Per-tenant entitlement**   — explicit override (super-admin can disable a feature
 *                                     for one tenant even if their plan includes it)
 *   4. **Plan whitelist**           — feature must be in plans.features (or '*' for scale)
 *   5. **Plan quota**               — for action='edit' on metered features, check
 *                                     tenant_usage.count < plans.limits.<metric>
 *   6. **Role permission matrix**   — role_definitions.permissions[feature][action]
 *
 * Falls back gracefully to the legacy `user_roles` + `role_permissions` schema if
 * the user isn't yet in the new RBAC tables (migration 017 + auto-map happens lazily).
 *
 * Sets `req.userRoleKey` and `req.userPlan` for downstream handlers.
 */
// Human-readable labels for feature keys — used in 403 messages so users
// see "Workflows" instead of "whatsapp_automation". Keep in sync with the
// keys passed to checkPermission().
const FEATURE_LABELS: Record<string, string> = {
  whatsapp_automation: 'Workflows & Broadcasts',
  inbox: 'Inbox',
  leads: 'Contacts & Leads',
  integrations: 'Integrations',
  settings: 'Workspace Settings',
  google_sheets: 'Google Sheets',
}
const ACTION_VERBS: Record<string, string> = { view: 'view', edit: 'edit', delete: 'delete' }
function featureLabel(key: string) { return FEATURE_LABELS[key] || key.replace(/_/g, ' ') }

// Permission-key aliases. The legacy umbrella feature 'whatsapp_automation'
// was split in the new RBAC into the granular 'workflows' + 'broadcasts'
// permissions. 'leads' became 'contacts'. When the middleware checks
// permissions in role_definitions.permissions[feature] it tries the
// original key first, then any of these aliases. If ANY of them grants
// the action, access is granted. (Plan-whitelist checks still use the
// original feature key — that's a billing concept, not RBAC.)
const PERMISSION_KEY_ALIASES: Record<string, string[]> = {
  whatsapp_automation: ['workflows', 'broadcasts'],
  leads: ['contacts'],
}

function hasRolePermission(perms: any, feature: string, action: string): boolean {
  if (!perms) return false
  const tryKey = (k: string) => !!perms[k]?.[action]
  if (tryKey(feature)) return true
  for (const alias of PERMISSION_KEY_ALIASES[feature] || []) if (tryKey(alias)) return true
  return false
}

function checkPermission(feature: string, action: 'view' | 'edit' | 'delete' | string) {
  return async (req: express.Request, res: express.Response, next: express.NextFunction) => {
    if ((req as any).isSuperAdmin) { next(); return }

    const userId = (req as any).user?.id
    const tenantId = (req as any).tenantId
    if (!userId || !tenantId) { apiError(res, 401, 'unauthorized', 'Authentication required.'); return }

    // 1. Tenant lifecycle gate
    const { data: tenant } = await supabase.from('tenants')
      .select('status').eq('id', tenantId).maybeSingle()
    if (tenant?.status === 'suspended') { apiError(res, 403, 'tenant_suspended', 'This account is suspended. Contact support.'); return }
    if (tenant?.status === 'deleted')   { apiError(res, 403, 'tenant_deleted', 'This account has been deleted.'); return }

    // 2. User-disabled gate (new RBAC) — falls through to legacy if no row
    const { data: assignment } = await supabase.from('user_role_assignments')
      .select(`disabled_at, role_definitions ( key, permissions, allowed_apps, data_scope )`)
      .eq('user_id', userId).eq('tenant_id', tenantId)
      .maybeSingle()
    if (assignment?.disabled_at) {
      apiError(
        res, 403, 'user_disabled',
        'Your account has been disabled by a workspace administrator. Contact them to restore access.',
      ); return
    }

    // 3. Per-tenant entitlement override
    const { data: ent } = await supabase.from('tenant_entitlements')
      .select('is_enabled').eq('tenant_id', tenantId).eq('feature', feature).maybeSingle()
    if (ent && ent.is_enabled === false) {
      res.status(403).json({
        error: `${featureLabel(feature)} has been turned off for your workspace by an administrator.`,
        code: 'feature_disabled', feature,
      }); return
    }

    // 4. Plan whitelist + 5. Plan quota
    const { data: sub } = await supabase.from('tenant_subscriptions')
      .select('plan_id, status, plans ( features, limits )')
      .eq('tenant_id', tenantId).maybeSingle()
    if (sub) {
      const plan: any = (sub as any).plans
      const features: string[] = plan?.features ?? []
      if (!features.includes('*') && !features.includes(feature)) {
        // Feature not in plan — suggest upgrade.
        res.status(402).json({
          error: `${featureLabel(feature)} isn't included in your ${sub.plan_id} plan. Upgrade to unlock it.`,
          code: 'plan_upgrade_required', feature, plan: sub.plan_id,
        }); return
      }
      // (Quota check for metered features happens at write-points where the
      // metric is known — handled by the workers, not this generic middleware.)
      ;(req as any).userPlan = sub.plan_id
    }

    // 6. Role permission matrix — new RBAC path
    if (assignment?.role_definitions) {
      const rd: any = assignment.role_definitions
      ;(req as any).userRoleKey = rd.key
      ;(req as any).userDataScope = rd.data_scope
      ;(req as any).userAllowedApps = rd.allowed_apps
      // Workspace owner short-circuit — the literal account holder always has
      // full access within their own workspace (no SaaS treats the owner
      // role as anything but root). Skips per-feature permission lookups.
      if (rd.key === 'owner') { next(); return }
      // Otherwise, look up the permission with alias support so legacy
      // umbrella keys like 'whatsapp_automation' resolve via 'workflows' /
      // 'broadcasts' in role_definitions.
      if (hasRolePermission(rd.permissions, feature, action)) { next(); return }
      // Fall through to legacy check below — user might still be allowed via
      // legacy role_permissions during migration period.
    }

    // 6b. Workspace-owner safety net — even without a row in
    //     user_role_assignments, the user listed as tenants.user_id is the
    //     account holder and must always have full access.
    {
      const { data: ownership } = await supabase.from('tenants')
        .select('user_id').eq('id', tenantId).maybeSingle()
      if (ownership?.user_id === userId) {
        ;(req as any).userRoleKey = 'owner'
        next(); return
      }
    }

    // 7. Legacy fallback — read role_permissions (pre-017)
    const role = (req as any).userRole
    if (!role) {
      res.status(403).json({
        error: "You haven't been added to this workspace yet. Ask the workspace owner to invite you.",
        code: 'no_role_assignment',
      }); return
    }
    const { data: perm } = await supabase
      .from('role_permissions').select(`can_${action}`)
      .eq('tenant_id', tenantId).eq('role', role).eq('feature', feature)
      .maybeSingle()
    if (perm && (perm as any)[`can_${action}`]) { next(); return }
    const { data: sysPerm } = await supabase
      .from('role_permissions').select(`can_${action}`)
      .is('tenant_id', null).eq('role', role).eq('feature', feature)
      .maybeSingle()
    if (sysPerm && (sysPerm as any)[`can_${action}`]) { next(); return }

    // Look up the human label for the role too — fall back to the key.
    const { data: roleDef } = await supabase
      .from('role_definitions').select('label').eq('key', role).maybeSingle()
    const roleLabel = (roleDef as any)?.label || role.replace(/_/g, ' ')
    res.status(403).json({
      error: `Your role (${roleLabel}) can't ${ACTION_VERBS[action] || action} ${featureLabel(feature)}. Ask a workspace admin to update your permissions.`,
      code: 'permission_denied',
      feature, action, role,
    })
  }
}

// ── Health ────────────────────────────────────────────────────────────────────
app.get('/health', (_req, res) => res.json({ status: 'ok', service: 'Frequency-server' }))

// ── NLP Parse (streaming) ─────────────────────────────────────────────────────
const SYSTEM_PROMPT = `You are a workflow architect for Frequency — a WhatsApp Business automation platform that also integrates with email, Google Sheets, CRMs, and payment systems.

Parse the user's plain-language automation intent and return ONLY a compact JSON workflow blueprint. No prose, no markdown, no code blocks, no \`\`\`json fences — pure JSON only. Your entire response must start with { and end with }.

CRITICAL RULE — CLARIFYING QUESTIONS:
When key information is missing to build a complete, executable workflow, populate "clarifying_questions" with 2–5 targeted questions. Each targets exactly one unknown. Still build the best-guess workflow skeleton; set config_completion_percent to 20–45 when questions are present. Do NOT invent credentials, emails, or phone numbers.

NODE TYPES (use exact strings):
Triggers:  trigger_form_submit, trigger_webhook, trigger_sheet_row, trigger_inbound_keyword,
           trigger_scheduled, trigger_api, trigger_broadcast_reply, trigger_email_received
Actions:   send_text, send_template, send_interactive, collect_input, send_payment_link,
           update_crm, update_sheet, http_request, run_ai_responder, assign_agent,
           add_tag, wait_delay, send_email, forward_email
Logic:     condition_reply, condition_button_click, condition_variable, condition_time,
           split_ab, end_flow

WHATSAPP RULES (enforce for send_text / send_template / send_interactive nodes):
- Free-form text only valid within 24 h of last inbound message
- Outside 24 h window → approved template required (mark template_required: true)
- Marketing templates require opt-in proof
- Quick reply buttons: max 3; CTA buttons: max 2; never mix types

EMAIL RULES (enforce for trigger_email_received / send_email / forward_email nodes):
- trigger_email_received requires: email_provider (gmail|outlook|smtp), filter_from_email, optional filter_subject
- send_email / forward_email requires: smtp_provider (sendgrid|mailgun|ses|smtp), to_email, subject, body_template
- Always flag missing OAuth / API credentials in missing_config
- forward_email should preserve original sender in the forwarded body when possible

OUTPUT SCHEMA (omit keys with null / empty array values):
{
  "workflow_name": "string",
  "description": "string",
  "trigger_summary": "string",
  "clarifying_questions": [
    {
      "id": "q1",
      "question": "string — specific, friendly, one unknown per question",
      "why": "string — one sentence explaining why this matters",
      "example": "string — a concrete example answer",
      "type": "text|select|multiselect",
      "options": []
    }
  ],
  "nodes": [
    {
      "id": "node_1",
      "type": "string",
      "label": "string",
      "description": "string (≤15 words)",
      "position": 1,
      "config": {},
      "missing_config": [
        {
          "field": "",
          "label": "",
          "type": "text|textarea|select|number|url|email|phone",
          "required": true,
          "placeholder": "",
          "options": []
        }
      ],
      "connections": { "default": "node_2" },
      "template_required": false,
      "compliance_note": null,
      "warnings": []
    }
  ],
  "required_integrations": [{ "key": "", "name": "", "reason": "", "required": true }],
  "template_required": false,
  "templates_needed": [
    {
      "purpose": "",
      "suggested_name": "",
      "category": "MARKETING|UTILITY|AUTHENTICATION",
      "body_preview": "",
      "variables": [],
      "approval_time": "24-72 hours"
    }
  ],
  "compliance_flags": [{ "severity": "error|warning|info", "message": "", "how_to_fix": "" }],
  "missing_info": [],
  "config_completion_percent": 60,
  "overall_status": "ready_to_deploy|needs_config|needs_templates|needs_review",
  "blocking_issues": []
}

COMMON INTENT PATTERNS:
- "forward email from X to Y" → trigger_email_received (filter_from_email=X) → forward_email (to=Y). Ask: email provider, whether to include attachments, any subject filters.
- "when form submitted" → trigger_form_submit → send_template (outside 24 h). Ask: form provider (Typeform/Google Forms/custom), template body.
- "payment received" → trigger_webhook (Razorpay) → send_template (payment confirmation). Ask: webhook secret, template content.
- "every Monday" → trigger_scheduled (cron) → send_template. Ask: target audience/segment, template content.
- "respond to inbound message" → trigger_inbound_keyword → send_text (within 24 h) or send_template. Ask: keywords, reply content.

Be concise. Descriptions ≤15 words, compliance_note ≤20 words. Only include keys with actual values.`

// `identifyTenant` is required so we can attribute AI tokens to the right
// tenant for plan-limit enforcement (see lib/ai-usage.ts). Without it, a
// runaway prompt loop would burn unlimited tokens with no per-tenant accounting.
app.post('/api/parse-workflow', requireAuth, identifyTenant, async (req, res) => {
  const tenantId = (req as any).tenantId as string
  const { message, history = [] } = req.body
  if (!message || typeof message !== 'string') {
    res.status(400).json({ error: 'message (string) required' }); return
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    // User-facing — never leak the underlying provider name. The error
    // message lands in the FE toast for whoever hit /create. Server-side
    // log (above on boot) has the real ANTHROPIC_API_KEY hint for ops.
    res.status(503).json({ error: 'Frequency AI is unavailable right now. Please try again in a moment, or contact support if it persists.' })
    return
  }
  // Plan-limit checks BEFORE opening the SSE stream — once we send headers
  // we can't return a clean 402. Both gates must pass:
  //   1. ai_tokens_per_month — count cap (intuitive for users)
  //   2. ai_dollars_per_month — dollar-cost cap (margin firewall;
  //      a workflow looping AI calls past the dollar budget gets blocked
  //      even if it hasn't hit the token cap, because Sonnet output is
  //      15× the cost of Haiku input)
  {
    const { blockIfOverLimit } = await import('./lib/limits')
    if (await blockIfOverLimit(res, supabase, tenantId, 'ai_tokens_per_month'))   return
    if (await blockIfOverLimit(res, supabase, tenantId, 'ai_dollars_per_month'))  return
  }

  // ── SSE setup ───────────────────────────────────────────────────────────────
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8')
  res.setHeader('Cache-Control', 'no-cache, no-transform')
  res.setHeader('Connection', 'keep-alive')
  res.setHeader('X-Accel-Buffering', 'no')   // disable nginx buffering if behind proxy
  res.flushHeaders()

  // Heartbeat — comment line every 15s. Comments are ignored by EventSource
  // parsers but keep proxy connections alive during long Frequency AI
  // generations (provider: Anthropic).
  const heartbeat = setInterval(() => {
    if (!res.writableEnded) {
      try { res.write(': keepalive\n\n') } catch { /* socket gone */ }
    }
  }, 15_000)

  // Hard timeout — protect against Frequency AI provider (Anthropic) hangs.
  const TIMEOUT_MS = 90_000
  const abortCtl = new AbortController()
  const timeoutId = setTimeout(() => {
    console.warn('[parse-workflow] hard timeout reached, aborting upstream')
    abortCtl.abort()
  }, TIMEOUT_MS)

  // Detect client disconnect — abort upstream so we don't burn tokens for nothing.
  // IMPORTANT: Use `res.on('close')`, NOT `req.on('close')`. In Express 5 /
  // Node 22, `req` (the ReadableStream half of the socket) emits 'close' as
  // soon as the request body finishes reading — i.e. immediately for a small
  // POST. This is unrelated to whether the client is still connected. The
  // response object's 'close' event is the correct signal for client abort.
  let clientGone = false
  res.on('close', () => {
    if (res.writableEnded) return  // we ended the stream cleanly — not a disconnect
    console.warn('[parse-workflow] client closed before response end')
    clientGone = true
    abortCtl.abort()
  })

  const cleanup = () => {
    clearInterval(heartbeat)
    clearTimeout(timeoutId)
  }

  // Helper: write one SSE event, swallowing errors if socket is dead.
  const writeEvent = (obj: unknown) => {
    if (res.writableEnded) return
    try { res.write(`data: ${JSON.stringify(obj)}\n\n`) } catch { /* socket gone */ }
  }

  try {
    // Sanitize history: only keep {role, content} pairs and clamp to last 6 turns
    // to avoid runaway context. Server is the source of truth for shape.
    const safeHistory = (Array.isArray(history) ? history : [])
      .filter((m: any) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
      .slice(-6)
      .map((m: any) => ({ role: m.role as 'user' | 'assistant', content: m.content }))

    console.log(`[parse-workflow] streaming start (history=${safeHistory.length}, msg=${message.slice(0, 80)}...)`)

    const stream = anthropic.messages.stream({
      model: 'claude-sonnet-4-6',
      max_tokens: 6000,
      // Prompt-cache the (long, stable) system prompt for ~70% cost / latency win.
      // First call seeds the cache; subsequent calls in the next 5 min hit it.
      system: [
        { type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } },
      ] as any,
      messages: [...safeHistory, { role: 'user' as const, content: message }],
    }, { signal: abortCtl.signal as any })

    let charCount = 0
    for await (const chunk of stream) {
      if (clientGone) break
      if (chunk.type === 'content_block_delta' && chunk.delta.type === 'text_delta') {
        charCount += chunk.delta.text.length
        writeEvent({ text: chunk.delta.text })
      }
    }

    // Capture final usage for telemetry + per-tenant token accounting.
    // recordAiUsage is fire-and-forget — never blocks the SSE response close.
    const final = await stream.finalMessage().catch(() => null)
    const usage = final?.usage
    if (usage) {
      console.log(`[parse-workflow] done chars=${charCount} input=${usage.input_tokens} output=${usage.output_tokens} cache_read=${(usage as any).cache_read_input_tokens ?? 0} cache_create=${(usage as any).cache_creation_input_tokens ?? 0}`)
      void import('./lib/ai-usage').then(({ recordAiUsage }) =>
        recordAiUsage(supabase, tenantId, usage as any, 'parse_workflow', 'claude-sonnet-4-6'))
    }

    if (!clientGone) {
      writeEvent({ done: true })
      res.write('data: [DONE]\n\n')
      res.end()
    }
  } catch (err: any) {
    // Categorize: client-cancel (silent in logs) vs real upstream error (loud).
    const isAbort = err?.name === 'AbortError' || err?.message?.includes('aborted')
    if (isAbort && clientGone) {
      // User navigated away or hit Stop — not actionable, skip the log noise.
    } else {
      console.warn(`[parse-workflow] error name=${err?.name} status=${err?.status} msg=${err?.message?.slice(0, 200)}`)
    }
    writeEvent({
      error: isAbort && clientGone
        ? 'Request was cancelled.'
        : (err?.message ?? 'Unknown error from AI service'),
    })
    if (!res.writableEnded) {
      res.write('data: [DONE]\n\n')
      res.end()
    }
  } finally {
    cleanup()
  }
})

// ── Workflows CRUD ────────────────────────────────────────────────────────────
app.get('/api/workflows', requireAuth, identifyTenant, checkPermission('whatsapp_automation', 'view'), async (req, res) => {
  const tenantId = (req as any).tenantId
  const { page, pageSize, offset } = parsePagination(req.query as Record<string, string>)
  const { search, status, sortBy, sortOrder } = req.query as Record<string, string>

  let q = supabase.from('workflows').select('*', { count: 'exact' })
    .eq('tenant_id', tenantId)

  // F6: sanitize search before string-interpolating into PostgREST .or().
  // Strips PostgREST tree-building characters (commas/dots/parens/etc.) so
  // a malicious value can't append arbitrary predicates.
  const safeSearch = sanitizeSearch(search)
  if (safeSearch) q = q.or(`name.ilike.%${safeSearch}%,description.ilike.%${safeSearch}%,intent_text.ilike.%${safeSearch}%`)
  if (status && status !== 'all') q = q.eq('status', status)

  // B6: dynamic field filters with column allowlist (workflows scope).
  const filtersRaw = req.query.filters as string
  if (filtersRaw) {
    try {
      const parsed = JSON.parse(filtersRaw)
      const result = applyAllowedFilters(q, parsed, 'workflows')
      if ((result as any).__filterError) {
        res.status(400).json({ error: `Invalid filter key: ${(result as any).__filterError.key}`, allowed: FILTER_ALLOWLISTS.workflows })
        return
      }
      q = result as typeof q
    } catch (e) {}
  }

  // B6: gate sortBy too — same allowlist.
  const sortCheck = validateSortBy('workflows', sortBy)
  if (!sortCheck.ok) {
    res.status(400).json({ error: `Invalid sortBy: ${sortCheck.key}`, allowed: FILTER_ALLOWLISTS.workflows })
    return
  }
  q = q.order(sortCheck.sortBy, { ascending: sortOrder === 'asc' })
    .range(offset, offset + pageSize - 1)

  const { data, count, error } = await q
  if (error) { res.status(500).json({ error: error.message }); return }
  const total = count ?? 0
  res.json({ data: data ?? [], total, page, pageSize, totalPages: Math.ceil(total / pageSize) })
})

app.get('/api/workflows/:id', requireAuth, identifyTenant, checkPermission('whatsapp_automation', 'view'), async (req, res) => {
  const tenantId = (req as any).tenantId
  const { data, error } = await supabase.from('workflows').select('*')
    .eq('id', req.params.id).eq('tenant_id', tenantId).maybeSingle()
  if (error) { res.status(500).json({ error: error.message }); return }
  if (!data) { res.status(404).json({ error: 'Workflow not found' }); return }
  res.json(data)
})

app.post('/api/workflows', requireAuth, identifyTenant, checkPermission('whatsapp_automation', 'edit'), validateBody(WorkflowCreateSchema), async (req, res) => {
  const tenantId = (req as any).tenantId
  const userId   = (req as any).user.id

  // Workflow chaining: validate the upstream workflow lives in the SAME
  // tenant. Without this, a user could trigger off another tenant's
  // workflow completion (cross-tenant data leak via session.variables).
  // The CHECK constraint at DB level only blocks self-trigger; tenant
  // scoping has to happen here.
  if (req.body.triggered_by_workflow_id) {
    const { data: upstream } = await supabase.from('workflows')
      .select('id').eq('id', req.body.triggered_by_workflow_id).eq('tenant_id', tenantId).maybeSingle()
    if (!upstream) {
      res.status(400).json({ error: 'triggered_by_workflow_id must reference a workflow in this tenant' })
      return
    }
  }

  // Plan-limit check: only block if the new workflow is being created LIVE.
  // Drafts are free (users iterate before going live). The PATCH path that
  // flips draft→live also enforces below.
  if (req.body.status === 'live') {
    const { blockIfOverLimit } = await import('./lib/limits')
    if (await blockIfOverLimit(res, supabase, tenantId, 'workflows_max')) return

    // Pre-flight validation gate (mirror PATCH /api/workflows/:id). A
    // workflow created directly as 'live' must already have all its
    // required connectors connected and no blocking config errors.
    const { validateWorkflow } = await import('./engine/workflow-validator')
    const report = await validateWorkflow(supabase, tenantId, (req.body.nodes ?? []) as any[])
    if (!report.ok) {
      res.status(422).json({
        error:  'Workflow cannot be created live yet — fix the issues below or save as draft first',
        code:   'workflow_validation_failed',
        report,
      })
      return
    }
  }

  // workflows.user_id is NOT NULL (migration 001) — always set it from the
  // authenticated session so the FE never has to know about the DB shape.
  const { data, error } = await supabase.from('workflows')
    .insert({ ...req.body, tenant_id: tenantId, user_id: userId }).select().single()
  if (error) { res.status(500).json({ error: error.message }); return }
  res.json(data)
})

app.patch('/api/workflows/:id', requireAuth, identifyTenant, checkPermission('whatsapp_automation', 'edit'), validateBody(WorkflowPatchSchema), async (req, res) => {
  const tenantId = (req as any).tenantId
  // `validateBody` already replaced req.body with the parsed (strict-stripped)
  // result. Bind it to a typed local so the spread below visibly says "spread
  // the validated patch", not "spread arbitrary client input". See the
  // SECURITY CONTRACT in src/validation.ts before changing this pattern.
  const patch = req.body as z.infer<typeof WorkflowPatchSchema>

  // Same chaining checks as create, plus a cycle-detection walk: refuse if
  // setting this trigger would create A→B→…→A. The DB CHECK constraint
  // only blocks the trivial 1-hop self-trigger; multi-hop cycles need the
  // application-level walk in engine/chaining.ts.
  if (patch.triggered_by_workflow_id) {
    const { data: upstream } = await supabase.from('workflows')
      .select('id').eq('id', patch.triggered_by_workflow_id).eq('tenant_id', tenantId).maybeSingle()
    if (!upstream) {
      res.status(400).json({ error: 'triggered_by_workflow_id must reference a workflow in this tenant' })
      return
    }
    const { chainWouldCycle } = await import('./engine/chaining')
    if (await chainWouldCycle(supabase, String(req.params.id), patch.triggered_by_workflow_id)) {
      res.status(400).json({ error: 'This trigger would form a cycle in the workflow chain' })
      return
    }
  }

  // Plan-limit check: only enforce when transitioning TO 'live'. Reading
  // current status first so we don't double-count (already-live workflow
  // staying live, or going from live→paused). Cap is on live count.
  if (patch.status === 'live') {
    const { data: existing } = await supabase.from('workflows')
      .select('status, nodes').eq('id', req.params.id).eq('tenant_id', tenantId).maybeSingle()
    if (existing && existing.status !== 'live') {
      const { blockIfOverLimit } = await import('./lib/limits')
      if (await blockIfOverLimit(res, supabase, tenantId, 'workflows_max')) return
    }

    // Pre-flight validation gate. Refuse to set a workflow live if it has
    // missing connectors OR blocking config errors. Returns the full
    // ValidationReport in the 422 body so the FE can render the same UI
    // it shows on /preview without a second round-trip. Without this, a
    // user clicking "Set live" on a workflow that needs Razorpay would
    // only find out when an inbound message tried to fire it — by then
    // the customer was mid-conversation and saw a broken bot.
    //
    // Use the post-patch nodes if cfg.nodes is in the patch (they're
    // updating logic + flipping live in one PATCH), else the existing
    // nodes from the DB row.
    const nodesToValidate = (patch as any).nodes ?? existing?.nodes ?? []
    const { validateWorkflow } = await import('./engine/workflow-validator')
    const report = await validateWorkflow(supabase, tenantId, nodesToValidate as any[])
    if (!report.ok) {
      res.status(422).json({
        error:  'Workflow cannot be set live yet — fix the issues below',
        code:   'workflow_validation_failed',
        report,
      })
      return
    }
  }

  const { data, error } = await supabase.from('workflows')
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq('id', req.params.id).eq('tenant_id', tenantId).select().single()
  if (error) { res.status(500).json({ error: error.message }); return }
  res.json(data)
})

app.delete('/api/workflows/:id', requireAuth, identifyTenant, checkPermission('whatsapp_automation', 'delete'), async (req, res) => {
  const tenantId = (req as any).tenantId
  const { error } = await supabase.from('workflows')
    .delete().eq('id', req.params.id).eq('tenant_id', tenantId)
  if (error) { res.status(500).json({ error: error.message }); return }
  res.json({ success: true })
})

// ── Pre-flight workflow validation ───────────────────────────────────────────
//
// Two endpoints, same engine (engine/workflow-validator.ts):
//
//   POST /api/workflows/:id/dry-run   — validates a SAVED workflow.
//                                        Used by the FE before "Set live"
//                                        and by the worker before first run.
//   POST /api/workflows/preview        — validates an UNSAVED nodes[] array
//                                        (request body: { nodes: [...] }).
//                                        Used by the FE while the user is
//                                        still authoring — calls on each
//                                        change to update the "needs Razorpay
//                                        connected" sidebar live.
//
// Both return ValidationReport:
//   { ok, triggers, required_connectors, missing_connectors,
//     node_issues: [{node_id, severity, message}], summary }
//
// `ok=true` means "this workflow will execute end-to-end without surprises".
// `ok=false` AND missing_connectors.length > 0 → show "connect X" CTAs.
// `ok=false` AND node_issues with severity=error → show in node inspector.
//
// `view` permission is enough — validation is read-only.
app.post('/api/workflows/:id/dry-run', requireAuth, identifyTenant, checkPermission('whatsapp_automation', 'view'), async (req, res) => {
  const tenantId = (req as any).tenantId
  const { data: wf, error } = await supabase.from('workflows')
    .select('id, nodes').eq('id', req.params.id).eq('tenant_id', tenantId).maybeSingle()
  if (error)  { res.status(500).json({ error: error.message }); return }
  if (!wf)    { res.status(404).json({ error: 'Workflow not found' }); return }
  const { validateWorkflow } = await import('./engine/workflow-validator')
  const report = await validateWorkflow(supabase, tenantId, (wf.nodes as any[]) ?? [])
  res.json(report)
})

app.post('/api/workflows/preview', requireAuth, identifyTenant, checkPermission('whatsapp_automation', 'view'), async (req, res) => {
  const tenantId = (req as any).tenantId
  const nodes = (req.body as any)?.nodes
  if (!Array.isArray(nodes)) {
    res.status(400).json({ error: 'request body must include { nodes: [...] }' })
    return
  }
  // Cap node count so a maliciously-large blueprint can't DoS the validator
  // (each node = O(1) work, but per-node DB queries in connection probe are
  // already amortized — this is paranoia for very large generated workflows).
  if (nodes.length > 200) {
    res.status(400).json({ error: 'Workflow too large: max 200 nodes per preview call' })
    return
  }
  const { validateWorkflow } = await import('./engine/workflow-validator')
  const report = await validateWorkflow(supabase, tenantId, nodes)
  res.json(report)
})

// ── Tenants CRUD ──────────────────────────────────────────────────────────────
app.get('/api/tenants/:id/members', requireAuth, identifyTenant, async (req, res) => {
  // B1: cross-tenant data leak fix. The path param :id was previously trusted
  // as the tenant id, even though identifyTenant has already authoritatively
  // resolved the caller's tenant. A user belonging to tenant A could request
  // /api/tenants/<tenant-B>/members and get tenant B's roster. Reject
  // anything that doesn't match the resolved tenant. Super-admins (who can
  // legitimately target any tenant via X-Tenant-ID) bypass the check.
  if (!(req as any).isSuperAdmin && req.params.id !== (req as any).tenantId) {
    res.status(403).json({ error: 'Forbidden' }); return
  }
  const tenantId = (req as any).tenantId
  // Previously did `profiles:user_id(...)` PostgREST embed but the
  // `profiles` table doesn't exist in this schema — every call returned
  // 500 with PGRST200 "could not find a relationship". The newer
  // /api/team/members endpoint (routes/teams.ts) is the canonical reader
  // for team membership; this older one is kept as a back-compat alias
  // returning the minimal {id, role} shape that callers actually use
  // (the InboxPage falls back to seeded display names anyway).
  const { data, error } = await supabase
    .from('user_roles')
    .select('user_id, role')
    .eq('tenant_id', tenantId)

  if (error) { res.status(500).json({ error: error.message }); return }

  const members = (data || []).map((m: any) => ({
    id:    m.user_id,
    role:  m.role,
    name:  null,   // populated by /api/team/members; this endpoint stays lean
    avatar: null,
  }))

  res.json(members)
})

app.post('/api/onboarding', requireAuth, async (req, res) => {
  const user = (req as any).user
  const { business_name, full_name, phone } = req.body

  // Update Profile
  await supabase.from('profiles').update({
    full_name,
    wa_number: phone
  }).eq('id', user.id)

  // Generate the workspace slug from business_name BEFORE the tenant insert.
  // The DB has a UNIQUE constraint + reserved-word CHECK on slug; this util
  // (lib/slug.ts) handles slugify + collision suffix + reserved-word fallback
  // so the insert always succeeds with a clean slug. The user_id is used as
  // the fallback seed for the unlikely case where business_name slugifies to
  // empty (all non-Latin characters).
  const { ensureUniqueSlug } = await import('./lib/slug')
  const slug = await ensureUniqueSlug(supabase, business_name ?? '', user.id)

  // Create/Update Tenant
  const { data: tenant, error } = await supabase.from('tenants').upsert({
    user_id: user.id,
    business_name,
    slug,
    status: 'active'
  }).select().single()

  if (error) { res.status(500).json({ error: error.message }); return }

  // Mock sending email
  console.log(`[onboarding:email] Sending welcome email to ${user.email}`)

  res.json({ success: true, tenant })
})

app.get('/api/tenants', requireAuth, async (req, res) => {
  const user = (req as any).user

  // 1. Tenants the user owns
  const { data: ownedTenants, error: e1 } = await supabase.from('tenants')
    .select('id,slug,waba_id,phone_number_id,business_name,display_phone,status,google_email,created_at')
    .eq('user_id', user.id)
  if (e1) { res.status(500).json({ error: e1.message }); return }

  // 2. Tenants the user has access to via user_roles (team members)
  const { data: roleRows } = await supabase.from('user_roles')
    .select('tenant_id')
    .eq('user_id', user.id)
    .not('tenant_id', 'is', null)
  const roleTenantIds = (roleRows ?? []).map(r => r.tenant_id).filter(id => !(ownedTenants ?? []).find(t => t.id === id))

  let teamTenants: any[] = []
  if (roleTenantIds.length > 0) {
    const { data: extra } = await supabase.from('tenants')
      .select('id,slug,waba_id,phone_number_id,business_name,display_phone,status,google_email,created_at')
      .in('id', roleTenantIds)
    teamTenants = extra ?? []
  }

  const all = [...(ownedTenants ?? []), ...teamTenants]
  console.log(`[/api/tenants] user=${user.id}, found ${all.length} tenant(s)`)
  res.json(all)
})

app.delete('/api/tenants/:id', requireAuth, async (req, res) => {
  const user = (req as any).user
  const { error } = await supabase.from('tenants')
    .delete().eq('id', req.params.id).eq('user_id', user.id)
  if (error) { res.status(500).json({ error: error.message }); return }
  res.json({ success: true })
})

// ── Facebook Embedded Signup callback ─────────────────────────────────────────
// Frontend calls this after user completes Embedded Signup and gets a short-lived token + WABA ID
app.post('/api/auth/facebook/connect-waba', requireAuth, async (req, res) => {
  const user = (req as any).user
  const { code, waba_id, phone_number_id } = req.body
  if (!code || !waba_id || !phone_number_id) {
    res.status(400).json({ error: 'code, waba_id, phone_number_id required' }); return
  }

  try {
    // Exchange short-lived code for a long-lived user access token
    const tokenRes = await fetch(
      `${GRAPH}/oauth/access_token?client_id=${META_APP_ID}&client_secret=${META_APP_SECRET}&code=${code}`
    )
    const tokenData = await tokenRes.json() as any
    if (tokenData.error) throw new Error(tokenData.error.message)

    const shortToken: string = tokenData.access_token

    // Exchange for long-lived token (60 days)
    const longRes = await fetch(
      `${GRAPH}/oauth/access_token?grant_type=fb_exchange_token&client_id=${META_APP_ID}&client_secret=${META_APP_SECRET}&fb_exchange_token=${shortToken}`
    )
    const longData = await longRes.json() as any
    if (longData.error) throw new Error(longData.error.message)
    const longToken: string = longData.access_token

    // Fetch WABA info (business_name, etc.)
    const wabaRes = await fetch(
      `${GRAPH}/${waba_id}?fields=name,currency,timezone_id`,
      { headers: { Authorization: `Bearer ${longToken}` } }
    )
    const wabaData = await wabaRes.json() as any

    // Fetch phone number display info
    const phoneRes = await fetch(
      `${GRAPH}/${phone_number_id}?fields=display_phone_number,verified_name`,
      { headers: { Authorization: `Bearer ${longToken}` } }
    )
    const phoneData = await phoneRes.json() as any

    // Subscribe the app to the WABA webhook
    const subRes = await fetch(`${GRAPH}/${waba_id}/subscribed_apps`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${longToken}` }
    })
    const subData = await subRes.json() as any
    if (subData.success) {
      console.log(`[connect-waba] ✅ Webhook subscription active for WABA ${waba_id}`)
    } else {
      console.error(`[connect-waba] ⚠️ Webhook subscription FAILED for WABA ${waba_id}:`, subData)
    }

    // Resolve slug. On a WABA reconnect (existing tenant by waba_id) we keep
    // the existing slug — renaming a workspace's URL via reconnect would
    // break every team-member's bookmark. Only generate a fresh slug for
    // truly new tenants. The `select('slug').eq('waba_id', waba_id)` look-
    // ahead is the cheapest way to detect new-vs-existing without first
    // doing a SELECT+INSERT round trip.
    const { data: existingForWaba } = await supabase.from('tenants')
      .select('slug').eq('waba_id', waba_id).maybeSingle()
    const businessName = wabaData.name ?? phoneData.verified_name ?? 'My Business'
    let slugToWrite: string | undefined = existingForWaba?.slug ?? undefined
    if (!slugToWrite) {
      const { ensureUniqueSlug } = await import('./lib/slug')
      slugToWrite = await ensureUniqueSlug(supabase, businessName, user.id)
    }

    // Upsert tenant row
    const { data, error } = await supabase.from('tenants').upsert({
      user_id: user.id,
      waba_id,
      phone_number_id,
      access_token: longToken,
      business_name: businessName,
      slug: slugToWrite,
      display_phone: phoneData.display_phone_number,
      status: 'active',
      updated_at: new Date().toISOString(),
    }, { onConflict: 'waba_id' }).select().single()

    if (error) throw new Error(error.message)

    // Ensure the owner has a user_roles row so identifyTenant always resolves
    const { data: existingRole } = await supabase.from('user_roles')
      .select('id').eq('user_id', user.id).eq('tenant_id', data.id).maybeSingle()
    if (!existingRole) {
      await supabase.from('user_roles').insert({
        user_id: user.id,
        tenant_id: data.id,
        role: 'admin',
      })
    }

    console.log(`[connect-waba] tenant=${data.id} created/updated for user=${user.id}`)
    res.json({ success: true, tenant: data })
  } catch (err: any) {
    res.status(500).json({ error: err.message })
  }
})

// ── Google OAuth ──────────────────────────────────────────────────────────────
const GOOGLE_CLIENT_ID     = process.env.GOOGLE_CLIENT_ID!
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET!
const GOOGLE_REDIRECT_URI  = process.env.GOOGLE_REDIRECT_URI || 'http://localhost:3001/api/auth/google/callback'

app.get('/api/auth/google', requireAuth, async (req, res) => {
  const user = (req as any).user
  const scopes = [
    'https://www.googleapis.com/auth/calendar',
    'https://www.googleapis.com/auth/spreadsheets',
    'https://www.googleapis.com/auth/drive.readonly',
    'https://www.googleapis.com/auth/drive.file',
    'https://www.googleapis.com/auth/gmail.modify',
    'email', 'profile'
  ].join(' ')
  // B4: HMAC-signed state with 10-min TTL + nonce. Replaces the prior
  // unsigned base64 JSON which let any attacker mint a state pinning the
  // callback to another userId/tenantId.
  const { signOauthState } = await import('./lib/oauth-state')
  const state = signOauthState({
    userId: user.id,
    tenantId: typeof req.query.tenant_id === 'string' ? req.query.tenant_id : null,
  })
  const url = `https://accounts.google.com/o/oauth2/v2/auth?client_id=${GOOGLE_CLIENT_ID}&redirect_uri=${encodeURIComponent(GOOGLE_REDIRECT_URI)}&response_type=code&scope=${encodeURIComponent(scopes)}&access_type=offline&prompt=consent&state=${state}`
  
  logToFile(`Initiating OAuth for user: ${user.id}`)
  console.log('[google-auth] Initiating OAuth for user:', user.id)
  console.log('[google-auth] Redirect URI:', GOOGLE_REDIRECT_URI)
  
  res.redirect(url)
})

app.get('/api/auth/google/callback', async (req, res) => {
  const { code, state } = req.query as { code: string; state: string }
  if (!code) { res.status(400).send('Missing code'); return }

  try {
    // B4: verify HMAC + expiry on state. Refuse on any failure (forged,
    // expired, malformed) — single error path so a forged state can't be
    // distinguished from an expired one by timing or response body.
    const { verifyOauthState } = await import('./lib/oauth-state')
    const verified = verifyOauthState(state)
    if (!verified) { res.status(400).send('Invalid or expired state'); return }
    const userId = verified.u
    const tenantId = verified.t ?? undefined

    // Exchange code for tokens
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code, client_id: GOOGLE_CLIENT_ID, client_secret: GOOGLE_CLIENT_SECRET,
        redirect_uri: GOOGLE_REDIRECT_URI, grant_type: 'authorization_code'
      })
    })
    const tokens = await tokenRes.json() as any
    if (tokens.error) throw new Error(tokens.error_description ?? tokens.error)

    // Get user email
    const profileRes = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
      headers: { Authorization: `Bearer ${tokens.access_token}` }
    })
    const profile = await profileRes.json() as any
    const { encrypt } = await import('./google')

    const expiry = new Date(Date.now() + tokens.expires_in * 1000).toISOString()

    // Store on tenant if tenantId provided, otherwise on all user's tenants
    const update = {
      google_email: profile.email,
      google_access_token: encrypt(tokens.access_token),
      google_refresh_token: encrypt(tokens.refresh_token),
      google_token_expiry: expiry,
      updated_at: new Date().toISOString(),
    }

    logToFile(`Updating Google tokens for user ${userId}, tenant ${tenantId ?? 'auto-detect'}`)
    console.log(`[google-auth] Updating Google tokens for user ${userId}, tenant ${tenantId ?? 'auto-detect'}`)
    
    // Resolve tenantId if not in state — find the user's active tenant
    let resolvedTenantId = tenantId
    if (!resolvedTenantId) {
      const { data: role } = await supabase.from('user_roles')
        .select('tenant_id').eq('user_id', userId).not('tenant_id', 'is', null)
        .order('created_at', { ascending: true }).limit(1).maybeSingle()
      if (role?.tenant_id) {
        resolvedTenantId = role.tenant_id
      } else {
        const { data: owned } = await supabase.from('tenants')
          .select('id').eq('user_id', userId).eq('status', 'active')
          .order('created_at', { ascending: true }).limit(1).maybeSingle()
        resolvedTenantId = owned?.id
      }
      logToFile(`[google-auth] Auto-resolved tenant: ${resolvedTenantId}`)
      console.log(`[google-auth] Auto-resolved tenant: ${resolvedTenantId}`)
    }

    if (!resolvedTenantId) {
      throw new Error('No tenant found for user. Complete WhatsApp onboarding first.')
    }

    const { error: updErr, count } = await (supabase.from('tenants')
      .update(update).eq('id', resolvedTenantId) as any)
      .select('id', { count: 'exact' })
    
    if (updErr) {
      logToFile(`DB Update failed: ${updErr.message}`)
      throw new Error(`DB Update failed: ${updErr.message}`)
    }

    logToFile(`[google-auth] Updated ${count ?? '?'} tenant row(s) for tenant ${resolvedTenantId}`)
    console.log(`[google-auth] Updated ${count ?? '?'} tenant row(s) for tenant ${resolvedTenantId}`)

    logToFile('[google-auth] Success! Tokens saved.')
    console.log('[google-auth] Success! Tokens saved.')

    // Close the popup and notify parent.
    // Shape MUST be { ok: true } for openOAuthPopup() to resolve — it polls
    // for `e.data.ok` (see src/lib/connectors.ts openOAuthPopup).
    //
    // B10: lock postMessage targetOrigin to FRONTEND_URL. The previous '*'
    // would broadcast the OAuth result (including profile.email) to ANY
    // window that the user happened to have open via window.opener — a
    // cross-origin opener can sniff e.data and learn which Google account
    // was just connected. Pin to our own frontend instead.
    const successPayload = { ok: true, connector: 'google', label: profile.email }
    const FRONTEND_ORIGIN = process.env.FRONTEND_URL || 'http://localhost:5173'
    res.send(`
      <!doctype html><html><head><meta charset="utf-8"><title>Connected</title>
      <style>body{font:14px/1.5 system-ui,sans-serif;text-align:center;padding:32px;color:#1a1a1a}</style>
      </head><body>
      <div style="font-size:42px">✅</div>
      <h2 style="font-size:18px;margin:8px 0">Connected to Google</h2>
      <p>${profile.email ?? ''}</p>
      <p style="color:#6b7280;font-size:13px;margin-top:16px">You can close this window.</p>
      <script>
        try { window.opener?.postMessage(${JSON.stringify(successPayload)}, ${JSON.stringify(FRONTEND_ORIGIN)}); } catch(e){}
        setTimeout(() => { try { window.close(); } catch(e){} }, 1200);
      </script>
      </body></html>
    `)
  } catch (err: any) {
    console.error('[google-auth] FATAL ERROR:', err.message)
    res.status(500).send(`Google auth failed: ${err.message}`)
  }
})

// ── WA Templates (per-tenant) ─────────────────────────────────────────────────
async function getTenant(userId: string, tenantId?: string) {
  const q = supabase.from('tenants').select('*').eq('user_id', userId).eq('status', 'active')
  if (tenantId) q.eq('id', tenantId)
  const { data } = await q.order('created_at').limit(1).single()
  return data as any
}

app.get('/api/wa-templates', requireAuth, identifyTenant, checkPermission('whatsapp_automation', 'view'), async (req, res) => {
  const tenantId = (req as any).tenantId
  // Scope by tenant_id (the workspace) — NOT by user_id, so team members see
  // their workspace's templates and a user who owns multiple tenants doesn't
  // see the other tenant's templates here.
  const { data, error } = await supabase.from('wa_templates')
    .select('*').eq('tenant_id', tenantId).order('created_at', { ascending: false })
  if (error) { res.status(500).json({ error: error.message }); return }

  // Transform DB format → Meta components format so frontend stays consistent
  const formatted = (data ?? []).map((t: any) => {
    const components: any[] = []
    if (t.header) {
      const h = t.header
      if (h.type === 'text') components.push({ type: 'HEADER', format: 'TEXT', text: h.text ?? '' })
      else if (h.type === 'image') components.push({ type: 'HEADER', format: 'IMAGE' })
      else if (h.type === 'video') components.push({ type: 'HEADER', format: 'VIDEO' })
      else if (h.type === 'document') components.push({ type: 'HEADER', format: 'DOCUMENT' })
    }
    if (t.body) components.push({ type: 'BODY', text: t.body })
    if (t.footer) components.push({ type: 'FOOTER', text: t.footer })
    if (t.buttons?.length) components.push({ type: 'BUTTONS', buttons: t.buttons })
    return { id: t.id, name: t.name, status: t.status?.toUpperCase() ?? 'DRAFT', category: t.category?.toUpperCase() ?? 'MARKETING', language: t.language ?? 'en', components }
  })

  res.json(formatted)
})

app.post('/api/wa-templates', requireAuth, identifyTenant, checkPermission('whatsapp_automation', 'edit'), async (req, res) => {
  const tenantId = (req as any).tenantId
  const { data: tenant } = await supabase.from('tenants').select('*').eq('id', tenantId).maybeSingle()
  if (!tenant?.waba_id) { res.status(404).json({ error: 'No connected WhatsApp account' }); return }

  const { name, category = 'MARKETING', language = 'en_US', body, buttons = [] } = req.body
  const components: any[] = [{ type: 'BODY', text: body }]
  if (buttons.length > 0) {
    components.push({ type: 'BUTTONS', buttons: buttons.map((btn: string) => ({ type: 'QUICK_REPLY', text: btn })) })
  }
  try {
    const r = await fetch(`${GRAPH}/${tenant.waba_id}/message_templates`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tenant.access_token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, language, category, components })
    })
    const data = await r.json() as any
    if (data.error) { res.status(400).json({ error: data.error.message }); return }
    res.json(data)
  } catch (err: any) { res.status(500).json({ error: err.message }) }
})

app.delete('/api/wa-templates/:name', requireAuth, identifyTenant, checkPermission('whatsapp_automation', 'delete'), async (req, res) => {
  const tenantId = (req as any).tenantId
  const { data: tenant } = await supabase.from('tenants').select('*').eq('id', tenantId).maybeSingle()
  if (!tenant?.waba_id) { res.status(404).json({ error: 'No connected WhatsApp account' }); return }

  try {
    const r = await fetch(
      `${GRAPH}/${tenant.waba_id}/message_templates?name=${req.params.name}`,
      { method: 'DELETE', headers: { Authorization: `Bearer ${tenant.access_token}` } }
    )
    const data = await r.json() as any
    if (data.error) { res.status(400).json({ error: data.error.message }); return }
    res.json({ success: true })
  } catch (err: any) { res.status(500).json({ error: err.message }) }
})

// ── Broadcasts API ────────────────────────────────────────────────────────────
app.get('/api/broadcasts', requireAuth, identifyTenant, checkPermission('whatsapp_automation', 'view'), async (req, res) => {
  const tenantId = (req as any).tenantId
  const { page, pageSize, offset } = parsePagination(req.query as Record<string, string>)
  const { search, status, sortBy, sortOrder } = req.query as Record<string, string>

  let q = supabase.from('broadcasts').select('*', { count: 'exact' })
    .eq('tenant_id', tenantId)

  if (search) q = q.ilike('name', `%${search}%`)
  if (status && status !== 'all') q = q.eq('status', status)

  // B6: dynamic field filters with column allowlist (broadcasts scope).
  const filtersRaw = req.query.filters as string
  if (filtersRaw) {
    try {
      const parsed = JSON.parse(filtersRaw)
      const result = applyAllowedFilters(q, parsed, 'broadcasts')
      if ((result as any).__filterError) {
        res.status(400).json({ error: `Invalid filter key: ${(result as any).__filterError.key}`, allowed: FILTER_ALLOWLISTS.broadcasts })
        return
      }
      q = result as typeof q
    } catch (e) {}
  }

  const sortCheck = validateSortBy('broadcasts', sortBy)
  if (!sortCheck.ok) {
    res.status(400).json({ error: `Invalid sortBy: ${sortCheck.key}`, allowed: FILTER_ALLOWLISTS.broadcasts })
    return
  }
  q = q.order(sortCheck.sortBy, { ascending: sortOrder === 'asc' })
    .range(offset, offset + pageSize - 1)

  const { data, count, error } = await q
  if (error) { res.status(500).json({ error: error.message }); return }
  const total = count ?? 0
  res.json({ data: data ?? [], total, page, pageSize, totalPages: Math.ceil(total / pageSize) })
})

app.post('/api/broadcasts', requireAuth, identifyTenant, checkPermission('whatsapp_automation', 'edit'), validateBody(BroadcastCreateSchema), async (req, res) => {
  const tenantId = (req as any).tenantId
  const { data, error } = await supabase.from('broadcasts')
    .insert({ ...req.body, tenant_id: tenantId }).select().single()
  if (error) { res.status(500).json({ error: error.message }); return }
  res.json(data)
})

// Send broadcast — enqueue to broadcast.batch (immediate) or schedule via scheduled_jobs.
// Replaces the legacy fire-and-forget for-loop. Per-message delivery + retries
// are handled by message-sender.ts; broadcast-worker.ts fans out per contact.
//
// F4: wrapped in `withIdempotency`. A retry on this endpoint without
// idempotency would silently re-enqueue the batch — broadcast-worker would
// then send the same template to every contact a second time. Critical
// guard for any client that retries on 5xx / network failure.
app.post('/api/broadcasts/:id/send', requireAuth, identifyTenant, checkPermission('whatsapp_automation', 'edit'), async (req, res) => {
  const { withIdempotency } = await import('./lib/idempotency')
  return withIdempotency(supabase, req, res, 'POST /api/broadcasts/:id/send', async () => {
    const tenantId = (req as any).tenantId
    const { data: broadcast } = await supabase.from('broadcasts').select('id, scheduled_at, status, template_name')
      .eq('id', req.params.id).eq('tenant_id', tenantId).maybeSingle()
    if (!broadcast) return { status: 404, body: { error: 'Broadcast not found' } }
    if (!broadcast.template_name) return { status: 400, body: { error: 'Broadcast has no template_name' } }
    if (broadcast.status === 'sending' || broadcast.status === 'sent') {
      return { status: 409, body: { error: `Broadcast already ${broadcast.status}` } }
    }

    // Schedule for later if scheduled_at is in the future.
    const sched = broadcast.scheduled_at ? new Date(broadcast.scheduled_at) : null
    if (sched && sched.getTime() > Date.now() + 5_000) {
      await supabase.from('scheduled_jobs').insert({
        tenant_id: tenantId,
        kind: 'broadcast_send',
        payload: { broadcastId: broadcast.id },
        resume_at: sched.toISOString(),
      })
      await supabase.from('broadcasts').update({ status: 'scheduled' }).eq('id', broadcast.id)
      return { status: 200, body: { success: true, scheduled_for: sched.toISOString() } }
    }

    // Send now: enqueue, return immediately.
    const { broadcastQueue } = await import('./queue')
    await broadcastQueue.add('batch', { broadcastId: broadcast.id })
    await supabase.from('broadcasts').update({ status: 'sending' }).eq('id', broadcast.id)
    return { status: 200, body: { success: true, queued: true } }
  })
})

app.delete('/api/broadcasts/:id', requireAuth, identifyTenant, checkPermission('whatsapp_automation', 'delete'), async (req, res) => {
  const tenantId = (req as any).tenantId
  const { error } = await supabase.from('broadcasts').delete().eq('id', req.params.id).eq('tenant_id', tenantId)
  if (error) { res.status(500).json({ error: error.message }); return }
  res.json({ success: true })
})

// ── Contacts API ─────────────────────────────────────────────────────────────
app.get('/api/contacts', requireAuth, identifyTenant, checkPermission('leads', 'view'), async (req, res) => {
  const tenantId = (req as any).tenantId
  const { page, pageSize, offset } = parsePagination(req.query as Record<string, string>)
  const { search, tag, status, sortBy, sortOrder } = req.query as Record<string, string>

  let q = supabase.from('contacts').select('*', { count: 'exact' })
    .eq('tenant_id', tenantId)

  // F6: sanitize search before .or() interpolation (see lib/safe-key.ts).
  const safeSearch = sanitizeSearch(search)
  if (safeSearch) q = q.or(`name.ilike.%${safeSearch}%,phone.ilike.%${safeSearch}%,email.ilike.%${safeSearch}%`)
  if (tag) q = q.contains('tags', [tag])
  if (status && status !== 'all') q = q.eq('status', status)

  // B6: dynamic field filters with column allowlist (contacts scope).
  const filtersRaw = req.query.filters as string
  if (filtersRaw) {
    try {
      const parsed = JSON.parse(filtersRaw)
      const result = applyAllowedFilters(q, parsed, 'contacts')
      if ((result as any).__filterError) {
        res.status(400).json({ error: `Invalid filter key: ${(result as any).__filterError.key}`, allowed: FILTER_ALLOWLISTS.contacts })
        return
      }
      q = result as typeof q
    } catch (e) {}
  }

  const sortCheck = validateSortBy('contacts', sortBy)
  if (!sortCheck.ok) {
    res.status(400).json({ error: `Invalid sortBy: ${sortCheck.key}`, allowed: FILTER_ALLOWLISTS.contacts })
    return
  }
  q = q.order(sortCheck.sortBy, { ascending: sortOrder === 'asc' })
    .range(offset, offset + pageSize - 1)

  const { data, count, error } = await q
  if (error) { res.status(500).json({ error: error.message }); return }
  const total = count ?? 0
  res.json({ data: data ?? [], total, page, pageSize, totalPages: Math.ceil(total / pageSize) })
})

app.post('/api/contacts', requireAuth, identifyTenant, checkPermission('leads', 'edit'), validateBody(ContactCreateSchema), async (req, res) => {
  const tenantId = (req as any).tenantId
  const { name, phone, email, tags } = req.body

  // Plan-limit check: refuse with 402 if the tenant is at their contacts cap.
  // Standardised response shape so the FE can show the same upgrade modal
  // regardless of which limit was hit.
  const { blockIfOverLimit } = await import('./lib/limits')
  if (await blockIfOverLimit(res, supabase, tenantId, 'contacts_max')) return

  const cleanPhone = String(phone).replace(/^\+/, '')
  const { data, error } = await supabase.from('contacts')
    .insert({
      tenant_id: tenantId,
      name: name || 'New Contact',
      phone: cleanPhone,
      email,
      tags: tags || [],
      status: 'active'
    }).select().single()

  if (error) { res.status(500).json({ error: error.message }); return }
  res.json(data)
})

app.patch('/api/contacts/:id', requireAuth, identifyTenant, checkPermission('leads', 'edit'), validateBody(ContactPatchSchema), async (req, res) => {
  const tenantId = (req as any).tenantId
  // `validateBody` replaced req.body with the parsed (strict-stripped) result.
  // Bind it to a typed local so the spread reads as "the validated patch",
  // not "the raw request body". See SECURITY CONTRACT in src/validation.ts.
  const patch = req.body as z.infer<typeof ContactPatchSchema>
  const { data, error } = await supabase.from('contacts')
    .update(patch).eq('id', req.params.id).eq('tenant_id', tenantId).select().single()
  if (error) { res.status(500).json({ error: error.message }); return }
  res.json(data)
})

app.delete('/api/contacts/:id', requireAuth, identifyTenant, checkPermission('leads', 'delete'), async (req, res) => {
  const tenantId = (req as any).tenantId
  const { error } = await supabase.from('contacts').delete().eq('id', req.params.id).eq('tenant_id', tenantId)
  if (error) { res.status(500).json({ error: error.message }); return }
  res.json({ success: true })
})

// Messages for a specific contact phone
app.get('/api/contacts/:phone/messages', requireAuth, identifyTenant, checkPermission('inbox', 'view'), async (req, res) => {
  const tenantId = (req as any).tenantId
  const phone = decodeURIComponent(req.params.phone as string).replace(/^\+/, '')
  const { data, error } = await supabase.from('messages')
    .select('*').eq('tenant_id', tenantId)
    .eq('contact_phone', phone)
    .order('created_at', { ascending: true })
    .limit(100)
  if (error) { res.status(500).json({ error: error.message }); return }
  res.json(data)
})

// Send message from inbox (agent reply) — channel-aware. Routes to the right
// provider based on `channel` ('whatsapp' | 'instagram' | 'telegram'). Inserts
// the outbound message with the correct `channel` column so the unified inbox
// view filters correctly.
//
// F4: wrapped in `withIdempotency` — clients can pass an `Idempotency-Key`
// header to make retries safe. Without it, a client retry on network
// failure could double-send to WhatsApp (burning Meta credit + spamming
// the contact).
app.post('/api/inbox/send', requireAuth, identifyTenant, checkPermission('inbox', 'edit'), validateBody(InboxSendSchema), async (req, res) => {
  const { withIdempotency } = await import('./lib/idempotency')
  return withIdempotency(supabase, req, res, 'POST /api/inbox/send', async () => {
    const tenantId = (req as any).tenantId

    // Plan-limit check: refuse with 402 if the tenant is at their monthly
    // message cap. Critical revenue protection — without this, a Free-tier
    // tenant can blast unlimited messages. Use checkLimit here (not
    // blockIfOverLimit) because we need to return a HandlerResult, not write
    // directly to res — the idempotency wrapper handles serialization.
    const { checkLimit } = await import('./lib/limits')
    const limitCheck = await checkLimit(supabase, tenantId, 'messages_per_month')
    if (!limitCheck.allowed) {
      return {
        status: 402,
        body: {
          error: limitCheck.reason,
          code: 'plan_limit_exceeded',
          metric: 'messages_per_month',
          current: limitCheck.current,
          max: limitCheck.max,
          upgrade_to: (limitCheck as any).upgrade_to,
        },
      }
    }

    const {
      channel, phone, type,
      text, template_name, template_language, template_params,
      media_kind, media_url, caption, filename,
      interactive,
    } = req.body
    const cleanPhone = String(phone).replace(/^\+/, '')

    try {
      if (channel === 'whatsapp') {
        const { data: tenant } = await supabase.from('tenants').select('*').eq('id', tenantId).single()
        if (!tenant?.access_token) return { status: 404, body: { error: 'WhatsApp not connected for this tenant' } }
        if (type === 'text')              await sendTextMessage(tenant, cleanPhone, text)
        else if (type === 'template')     await sendTemplateMessage(tenant, cleanPhone, template_name, template_language ?? 'en_US', template_params ?? [])
        else if (type === 'media')        await sendWAMedia(tenant, cleanPhone, media_kind, media_url, caption, filename)
        else if (type === 'interactive')  await sendInteractiveMessage(tenant, cleanPhone, interactive)
      } else if (channel === 'telegram') {
        const { data: bot } = await supabase.from('tg_bots').select('*').eq('tenant_id', tenantId).maybeSingle()
        if (!bot?.bot_token) return { status: 404, body: { error: 'Telegram bot not connected for this tenant' } }
        const { decrypt } = await import('./crypto')
        const token = decrypt(bot.bot_token)
        if (type === 'text') {
          await tgSend(token, 'sendMessage', { chat_id: cleanPhone, text })
          await supabase.from('messages').insert({ tenant_id: tenantId, channel: 'telegram', direction: 'outbound', contact_phone: cleanPhone, content: { type: 'text', text }, status: 'sent' })
        } else if (type === 'media') {
          const method = ({ image: 'sendPhoto', video: 'sendVideo', audio: 'sendAudio', document: 'sendDocument' } as any)[media_kind!]
          const fieldKey = ({ image: 'photo', video: 'video', audio: 'audio', document: 'document' } as any)[media_kind!]
          await tgSend(token, method, { chat_id: cleanPhone, [fieldKey]: media_url, caption: caption ?? undefined })
          await supabase.from('messages').insert({ tenant_id: tenantId, channel: 'telegram', direction: 'outbound', contact_phone: cleanPhone, content: { type: media_kind, url: media_url, caption, filename }, status: 'sent' })
        } else {
          return { status: 400, body: { error: `Telegram does not support type=${type}` } }
        }
      } else if (channel === 'instagram') {
        const { data: ig } = await supabase.from('tenant_integrations')
          .select('access_token, metadata').eq('tenant_id', tenantId).eq('key', 'instagram').maybeSingle()
        if (!ig?.access_token) return { status: 404, body: { error: 'Instagram not connected for this tenant' } }
        const { decrypt } = await import('./crypto')
        const igToken = decrypt(ig.access_token)
        const igUserId = (ig.metadata as any)?.ig_user_id
        if (!igUserId) return { status: 400, body: { error: 'Instagram metadata missing ig_user_id; reconnect.' } }
        const payload: any = { recipient: { id: cleanPhone } }
        if (type === 'text') {
          payload.message = { text }
        } else if (type === 'media' && media_url && media_kind) {
          payload.message = { attachment: { type: media_kind, payload: { url: media_url, is_reusable: true } } }
        } else {
          return { status: 400, body: { error: `Instagram does not support type=${type}` } }
        }
        const r1 = await fetch(`${GRAPH}/${igUserId}/messages?access_token=${igToken}`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
        })
        const data = await r1.json() as any
        if (!r1.ok || data.error) throw new Error(data.error?.message ?? `IG send failed (${r1.status})`)
        await supabase.from('messages').insert({
          tenant_id: tenantId, channel: 'instagram', direction: 'outbound',
          contact_phone: cleanPhone,
          platform_message_id: data.message_id ?? null,
          content: type === 'text' ? { type: 'text', text } : { type: media_kind, url: media_url, caption, filename },
          status: 'sent',
        })
      } else {
        return { status: 400, body: { error: `Unsupported channel: ${channel}` } }
      }
      return { status: 200, body: { success: true } }
    } catch (err: any) {
      return { status: 500, body: { error: err.message } }
    }
  })
})

// WhatsApp Cloud API media send — image / video / audio / document.
async function sendWAMedia(tenant: any, to: string, kind: 'image'|'video'|'audio'|'document', url: string, caption?: string | null, filename?: string) {
  const payload: any = { messaging_product: 'whatsapp', to, type: kind }
  payload[kind] = { link: url }
  if (caption && (kind === 'image' || kind === 'video' || kind === 'document')) payload[kind].caption = caption
  if (filename && kind === 'document') payload[kind].filename = filename
  const r = await fetch(`${GRAPH}/${tenant.phone_number_id}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${tenant.access_token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
  const data = await r.json() as any
  if (!r.ok || data.error) throw new Error(data.error?.message ?? `WA media send failed (${r.status})`)
  if (data.messages?.[0]?.id) {
    await supabase.from('messages').insert({
      tenant_id: tenant.id, channel: 'whatsapp', direction: 'outbound',
      contact_phone: to, platform_message_id: data.messages[0].id,
      content: payload, status: 'sent',
    })
  }
  return data
}

// Telegram Bot API generic helper used by inbox/send for Telegram.
async function tgSend(token: string, method: string, body: any): Promise<any> {
  const r = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  })
  const data = await r.json() as any
  if (!data.ok) throw new Error(data.description ?? `Telegram API error (${r.status})`)
  return data.result
}

// Toggle bot pause on a contact
app.patch('/api/contacts/:id/bot-pause', requireAuth, identifyTenant, checkPermission('leads', 'edit'), async (req, res) => {
  const tenantId = (req as any).tenantId
  const { bot_paused } = req.body
  const { data, error } = await supabase.from('contacts')
    .update({ bot_paused })
    .eq('id', req.params.id).eq('tenant_id', tenantId)
    .select().single()
  if (error) { res.status(500).json({ error: error.message }); return }
  res.json(data)
})

// ── Skills API ────────────────────────────────────────────────────────────────
//
// Skills are workflow blueprints — a curated library of "starter
// workflows" that the AI parser matches user intent against. Two scopes:
//   * Global   (tenant_id NULL, is_global TRUE)  — platform-curated
//   * Tenant   (tenant_id NOT NULL)              — workspace-private
//
// All endpoints scope by tenant_id, NEVER by user_id, so a user who
// belongs to multiple workspaces doesn't leak custom skills across them.
app.get('/api/skills', requireAuth, identifyTenant, async (req, res) => {
  const tenantId = (req as any).tenantId
  // Global + this tenant's skills, sorted by usage.
  const { data, error } = await supabase.from('workflow_skills')
    .select('*')
    .or(`tenant_id.eq.${tenantId},is_global.eq.true`)
    .order('usage_count', { ascending: false })
  if (error) { res.status(500).json({ error: error.message }); return }
  res.json(data)
})

app.post('/api/skills', requireAuth, identifyTenant, checkPermission('whatsapp_automation', 'edit'), async (req, res) => {
  const user = (req as any).user
  const tenantId = (req as any).tenantId
  const { name, description, tags, workflow_json } = req.body
  const { data, error } = await supabase.from('workflow_skills')
    .insert({
      tenant_id: tenantId,
      user_id: user.id,           // attribution only — scope is tenant_id
      name, description, tags: tags ?? [], workflow_json,
      is_global: false,
    })
    .select().single()
  if (error) { res.status(500).json({ error: error.message }); return }
  res.json(data)
})

// Match user description to existing skills (keyword scoring). Considers
// global + this tenant's skills only.
app.post('/api/skills/match', requireAuth, identifyTenant, async (req, res) => {
  const tenantId = (req as any).tenantId
  const { description } = req.body as { description: string }
  if (!description) { res.status(400).json({ error: 'description required' }); return }

  const { data: skills } = await supabase.from('workflow_skills')
    .select('*')
    .or(`tenant_id.eq.${tenantId},is_global.eq.true`)
    .order('usage_count', { ascending: false })
    .limit(50)

  if (!skills?.length) { res.json({ matched: false }); return }

  // Score by word overlap between user description and skill description + tags
  const words = description.toLowerCase().replace(/[^a-z0-9\s]/g, '').split(/\s+/).filter((w: string) => w.length > 3)
  const scored = skills.map(s => {
    const haystack = (s.description + ' ' + (s.tags ?? []).join(' ')).toLowerCase()
    const score = words.reduce((acc: number, w: string) => acc + (haystack.includes(w) ? 1 : 0), 0)
    return { ...s, score }
  }).filter((s: any) => s.score > 0).sort((a: any, b: any) => b.score - a.score)

  if (scored.length > 0 && scored[0].score >= 2) {
    await supabase.from('workflow_skills').update({ usage_count: scored[0].usage_count + 1 }).eq('id', scored[0].id)
    res.json({ matched: true, skill: scored[0], score: scored[0].score })
  } else {
    res.json({ matched: false })
  }
})

// ── WhatsApp Webhook ──────────────────────────────────────────────────────────
// GET: Meta verification handshake
app.get('/webhook/whatsapp', (req, res) => {
  const mode      = req.query['hub.mode']
  const token     = req.query['hub.verify_token']
  const challenge = req.query['hub.challenge']
  if (mode === 'subscribe' && token === WH_VERIFY_TOKEN) {
    console.log('Webhook verified')
    res.status(200).send(challenge)
  } else {
    res.sendStatus(403)
  }
})

// POST: Inbound messages
//
// B2: HMAC verification of x-hub-signature-256. Without this, anyone who
// learns the public webhook URL can craft inbound messages, spoof status
// updates, and pollute every tenant's inbox / fire workflows under any
// WABA we host. The raw body parser is mounted above (before express.json)
// so req.body is a Buffer at this point — exactly the bytes Meta signed.
app.post('/webhook/whatsapp', async (req, res) => {
  const sigHeader = req.header('x-hub-signature-256') || req.header('X-Hub-Signature-256')
  const rawBody = req.body as Buffer
  const appSecret = process.env.META_APP_SECRET || ''
  if (!Buffer.isBuffer(rawBody)) {
    // Should never happen given the express.raw mount, but fail closed.
    console.warn('[wa-webhook] body is not a Buffer — raw parser not mounted? Refusing.')
    res.status(401).json({ error: 'invalid_signature' }); return
  }
  // Local helper kept inline to avoid an extra import cycle. Same constant-
  // time compare pattern as routes/wa-calling.ts:verifyMetaSignature.
  const verifyMetaSignature = (body: Buffer, header: string | undefined, secret: string): boolean => {
    if (!header || !secret) return false
    const prefix = 'sha256='
    if (!header.startsWith(prefix)) return false
    const provided = header.slice(prefix.length)
    const expected = crypto.createHmac('sha256', secret).update(body).digest('hex')
    if (provided.length !== expected.length) return false
    try {
      return crypto.timingSafeEqual(Buffer.from(provided, 'utf8'), Buffer.from(expected, 'utf8'))
    } catch { return false }
  }
  if (!verifyMetaSignature(rawBody, sigHeader, appSecret)) {
    console.warn('[wa-webhook] HMAC verification failed — rejecting')
    res.status(401).json({ error: 'invalid_signature' }); return
  }

  // ACK only AFTER signature verified so we don't lend our 200 to spoofed
  // payloads. Meta still gets a fast response — verification is microseconds.
  res.sendStatus(200)

  try {
    // Parse the now-verified raw bytes into JSON. We do this AFTER ack so a
    // malformed payload from Meta doesn't keep them retrying — the signature
    // already proved authenticity, and an unparseable body will surface in
    // logs but not block the webhook channel.
    let body: any
    try { body = JSON.parse(rawBody.toString('utf8')) }
    catch { console.warn('[wa-webhook] JSON parse failed (body verified but malformed)'); return }

    // ── Diagnostic logging ──
    const msgCount = body.entry?.reduce((acc: number, e: any) =>
      acc + (e.changes?.reduce((a2: number, c: any) =>
        a2 + (c.value?.messages?.length ?? 0), 0) ?? 0), 0) ?? 0
    const statusCount = body.entry?.reduce((acc: number, e: any) =>
      acc + (e.changes?.reduce((a2: number, c: any) =>
        a2 + (c.value?.statuses?.length ?? 0), 0) ?? 0), 0) ?? 0
    console.log(`[webhook] object=${body.object} | messages=${msgCount} | statuses=${statusCount}`)
    if (msgCount > 0) {
      const firstMsg = body.entry?.[0]?.changes?.[0]?.value?.messages?.[0]
      console.log(`[webhook] 📩 INBOUND from=${firstMsg?.from} type=${firstMsg?.type} text="${firstMsg?.text?.body ?? firstMsg?.button?.text ?? '(non-text)'}"`)
    }

    if (body.object !== 'whatsapp_business_account') return

    for (const entry of body.entry ?? []) {
      const wabaId: string = entry.id
      for (const change of entry.changes ?? []) {
        if (change.field !== 'messages') continue
        const value = change.value

        // Find tenant by WABA ID
        const { data: tenant } = await supabase.from('tenants')
          .select('*').eq('waba_id', wabaId).eq('status', 'active').single()
        if (!tenant) continue

        // Handle inbound messages
        for (const msg of value.messages ?? []) {
          await handleInboundMessage(tenant, msg, value.contacts?.[0])
        }

        // Handle status updates (delivered, read, etc.).
        // Scope by tenant_id too — even though Meta only delivers webhooks
        // for our own WABAs, defense-in-depth: a malicious or replayed
        // payload mentioning a foreign platform_message_id could otherwise
        // mutate another tenant's message status.
        for (const status of value.statuses ?? []) {
          const { error: statusErr } = await supabase.from('messages')
            .update({ status: status.status })
            .eq('platform_message_id', status.id)
            .eq('tenant_id', tenant.id)
          if (statusErr) {
            console.error(`[webhook] status update failed tenant=${tenant.id} msg=${status.id}:`, statusErr.message)
          }
        }
      }
    }
  } catch (err) {
    console.error('Webhook error:', err)
  }
})

async function handleInboundMessage(tenant: any, msg: any, contact: any) {
  const phone = msg.from // e.g. "919876543210"
  const text  = msg.text?.body ?? msg.button?.text ?? msg.interactive?.button_reply?.title ?? ''

  // Log the message (tenant-scoped)
  await supabase.from('messages').insert({
    tenant_id: tenant.id,
    channel: 'whatsapp',
    direction: 'inbound',
    contact_phone: phone,
    platform_message_id: msg.id,
    content: msg,
  })

  // Upsert contact (tenant-scoped — fixes the user_id vs tenant_id leak from 008)
  await supabase.from('contacts').upsert({
    tenant_id: tenant.id,
    user_id:   tenant.user_id,            // kept for legacy RLS policies
    phone:     `+${phone}`,
    name:      contact?.profile?.name ?? `+${phone}`,
  }, { onConflict: 'tenant_id,phone' })

  // Channel-aware delegation. Routes session-resume + keyword-trigger via
  // the shared helper used by Telegram + Instagram webhooks.
  const { routeInboundToWorkflow } = await import('./engine/inbound-router')
  await routeInboundToWorkflow(supabase, tenant, 'whatsapp', phone, text, msg)
}

// NOTE: The inline executor (executeNode/resumeWorkflowSession/interpolate) has
// moved to src/engine/executor.ts and is driven by the BullMQ workflow.execute
// worker (src/workers/workflow-executor.ts). The webhook now enqueues a job
// instead of running nodes inline. See migration 010 + audit roadmap §1.

// Local interpolate kept ONLY for the legacy direct-send routes below.
function interpolate(text: string, vars: Record<string, string> = {}) {
  return (text ?? '').replace(/\{\{(\w+)\}\}/g, (_, k) => vars[k] ?? `{{${k}}}`)
}

async function sendTextMessage(tenant: any, to: string, text: string) {
  const payload = { messaging_product: 'whatsapp', to, type: 'text', text: { body: text } }
  const r = await fetch(`${GRAPH}/${tenant.phone_number_id}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${tenant.access_token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  })
  const data = await r.json() as any
  if (data.messages?.[0]?.id) {
    await supabase.from('messages').insert({
      tenant_id: tenant.id,
      channel: 'whatsapp',
      direction: 'outbound',
      contact_phone: to,
      platform_message_id: data.messages[0].id,
      content: payload,
      status: 'sent',
    })
  }
  return data
}

async function sendTemplateMessage(tenant: any, to: string, templateName: string, language: string, parameters: string[]) {
  const components = parameters.length > 0 ? [{
    type: 'body',
    parameters: parameters.map(v => ({ type: 'text', text: v }))
  }] : []
  const payload = {
    messaging_product: 'whatsapp', to, type: 'template',
    template: { name: templateName, language: { code: language }, components }
  }
  const r = await fetch(`${GRAPH}/${tenant.phone_number_id}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${tenant.access_token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  })
  const data = await r.json() as any
  if (data.messages?.[0]?.id) {
    await supabase.from('messages').insert({
      tenant_id: tenant.id, channel: 'whatsapp', direction: 'outbound', contact_phone: to,
      platform_message_id: data.messages[0].id, content: payload, status: 'sent',
    })
  }
  return data
}

async function sendInteractiveMessage(tenant: any, to: string, config: any) {
  const payload = {
    messaging_product: 'whatsapp', to, type: 'interactive',
    interactive: {
      type: 'button',
      body: { text: config.body ?? '' },
      action: {
        buttons: (config.buttons ?? []).slice(0, 3).map((b: any, i: number) => ({
          type: 'reply', reply: { id: `btn_${i}`, title: b.text ?? b }
        }))
      }
    }
  }
  const r = await fetch(`${GRAPH}/${tenant.phone_number_id}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${tenant.access_token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  })
  return r.json()
}

// ── RBAC / Team API ───────────────────────────────────────────────────────────

// Helper: resolve current user's role for their tenant
async function getUserRole(userId: string): Promise<{ role: string | null; tenantId: string | null }> {
  // 1. Platform-scoped check, NEW RBAC first — anyone with a row in
  //    user_role_assignments where tenant_id IS NULL is a platform user
  //    (super_admin, customer_success, billing_ops, etc.).
  const { data: platformAssignment } = await supabase.from('user_role_assignments')
    .select('role_definitions ( key )').eq('user_id', userId).is('tenant_id', null).maybeSingle()
  const platformKey = (platformAssignment as any)?.role_definitions?.key
  if (platformKey) return { role: platformKey, tenantId: null }

  // 1b. Legacy super_admin via old user_roles table.
  const { data: superRole } = await supabase.from('user_roles')
    .select('role').eq('user_id', userId).is('tenant_id', null).limit(1)
  if (superRole?.[0]?.role === 'super_admin') return { role: 'super_admin', tenantId: null }

  // 2. New RBAC tenant assignment (this is where invited team members live).
  const { data: tenantAssignment } = await supabase.from('user_role_assignments')
    .select('tenant_id, role_definitions ( key )').eq('user_id', userId)
    .not('tenant_id', 'is', null).limit(1).maybeSingle()
  if (tenantAssignment?.tenant_id) {
    const key = (tenantAssignment as any).role_definitions?.key || 'member'
    return { role: key, tenantId: tenantAssignment.tenant_id }
  }

  // 3. Tenant ownership fallback — the user owns a tenant directly.
  const { data: tenants } = await supabase.from('tenants')
    .select('id').eq('user_id', userId).eq('status', 'active').limit(1)
  const tenantId = tenants?.[0]?.id ?? null
  if (!tenantId) return { role: null, tenantId: null }

  // 4. Legacy user_roles tenant assignment as last resort.
  const { data: roleRow } = await supabase.from('user_roles')
    .select('role').eq('user_id', userId).eq('tenant_id', tenantId).limit(1)
  return { role: roleRow?.[0]?.role ?? 'owner', tenantId }
}

// Platform-scope check used by legacy /api/admin/* endpoints. Returns true
// when the user has any platform-scoped role assignment OR the legacy
// super_admin row. Includes the ten + admins/owners platform roles
// (customer_success, billing_ops, etc.).
async function isPlatformUser(userId: string): Promise<boolean> {
  const { role } = await getUserRole(userId)
  if (!role) return false
  const PLATFORM_ROLES = new Set([
    'super_admin', 'platform_owner', 'customer_success', 'billing_ops',
    'engineering', 'trust_safety', 'sales_ae', 'support_lead',
  ])
  return PLATFORM_ROLES.has(role)
}

// Get current user's role info
app.get('/api/me/role', requireAuth, async (req, res) => {
  const user = (req as any).user
  const info = await getUserRole(user.id)
  res.json(info)
})

// NOTE: legacy /api/team CRUD endpoints used to live here. They've been
// removed in favour of the RBAC team router (see ./routes/teams.ts), which
// uses user_role_assignments + role_definitions and gates every route with
// requireTenantPerm. The legacy endpoints leaked role data without a
// permission check and used the deprecated user_roles table.

// Super admin: list all tenants with stats
app.get('/api/admin/tenants', requireAuth, async (req, res) => {
  const user = (req as any).user
  if (!(await isPlatformUser(user.id))) { res.status(403).json({ error: 'Platform Console access required.' }); return }

  const { data, error } = await supabase.from('tenants')
    .select('id,user_id,business_name,display_phone,waba_id,status,created_at')
    .order('created_at', { ascending: false })
  if (error) { res.status(500).json({ error: error.message }); return }
  res.json(data ?? [])
})

// Super admin: platform stats
app.get('/api/admin/stats', requireAuth, async (req, res) => {
  const user = (req as any).user
  if (!(await isPlatformUser(user.id))) { res.status(403).json({ error: 'Platform Console access required.' }); return }

  const [tenantsRes, contactsRes, msgsRes] = await Promise.all([
    supabase.from('tenants').select('*', { count: 'exact', head: true }),
    supabase.from('contacts').select('*', { count: 'exact', head: true }),
    supabase.from('messages').select('*', { count: 'exact', head: true }),
  ])
  res.json({
    tenants: tenantsRes.count ?? 0,
    contacts: contactsRes.count ?? 0,
    messages: msgsRes.count ?? 0,
  })
})

// Campaigns API
app.get('/api/campaigns', requireAuth, identifyTenant, checkPermission('whatsapp_automation', 'view'), async (req, res) => {
  const tenantId = (req as any).tenantId
  const { page, pageSize, offset } = parsePagination(req.query as Record<string, string>)
  const { search, status, sortBy, sortOrder } = req.query as Record<string, string>

  let q = supabase.from('campaigns').select('*', { count: 'exact' })
    .eq('tenant_id', tenantId)

  // F6: sanitize search before .or() interpolation (see lib/safe-key.ts).
  const safeSearch = sanitizeSearch(search)
  if (safeSearch) q = q.or(`name.ilike.%${safeSearch}%,description.ilike.%${safeSearch}%`)
  if (status && status !== 'all') q = q.eq('status', status)

  // B6: dynamic field filters with column allowlist (campaigns scope).
  const filtersRaw = req.query.filters as string
  if (filtersRaw) {
    try {
      const parsed = JSON.parse(filtersRaw)
      const result = applyAllowedFilters(q, parsed, 'campaigns')
      if ((result as any).__filterError) {
        res.status(400).json({ error: `Invalid filter key: ${(result as any).__filterError.key}`, allowed: FILTER_ALLOWLISTS.campaigns })
        return
      }
      q = result as typeof q
    } catch (e) {}
  }

  const sortCheck = validateSortBy('campaigns', sortBy)
  if (!sortCheck.ok) {
    res.status(400).json({ error: `Invalid sortBy: ${sortCheck.key}`, allowed: FILTER_ALLOWLISTS.campaigns })
    return
  }
  q = q.order(sortCheck.sortBy, { ascending: sortOrder === 'asc' })
    .range(offset, offset + pageSize - 1)

  const { data, count, error } = await q
  if (error) { res.status(500).json({ error: error.message }); return }
  const total = count ?? 0
  res.json({ data: data ?? [], total, page, pageSize, totalPages: Math.ceil(total / pageSize) })
})

app.post('/api/campaigns', requireAuth, identifyTenant, checkPermission('whatsapp_automation', 'edit'), validateBody(CampaignCreateSchema), async (req, res) => {
  const tenantId = (req as any).tenantId
  const { data, error } = await supabase.from('campaigns')
    .insert({ ...req.body, tenant_id: tenantId }).select().single()
  if (error) { res.status(500).json({ error: error.message }); return }
  res.json(data)
})

app.patch('/api/campaigns/:id', requireAuth, identifyTenant, checkPermission('whatsapp_automation', 'edit'), validateBody(CampaignPatchSchema), async (req, res) => {
  const tenantId = (req as any).tenantId
  // `validateBody` replaced req.body with the parsed (.partial().strict()
  // -stripped) result. Binding to a typed local makes the spread read as
  // "spread the validated patch" — tenant_id / user_id / id / created_at
  // can't land here because Zod 400'd them at validation. See SECURITY
  // CONTRACT in src/validation.ts before changing this pattern.
  const patch = req.body as z.infer<typeof CampaignPatchSchema>
  const { data, error } = await supabase.from('campaigns')
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq('id', req.params.id).eq('tenant_id', tenantId).select().single()
  if (error) { res.status(500).json({ error: error.message }); return }
  res.json(data)
})

app.delete('/api/campaigns/:id', requireAuth, identifyTenant, checkPermission('whatsapp_automation', 'delete'), async (req, res) => {
  const tenantId = (req as any).tenantId
  const { error } = await supabase.from('campaigns').delete()
    .eq('id', req.params.id).eq('tenant_id', tenantId)
  if (error) { res.status(500).json({ error: error.message }); return }
  res.json({ success: true })
})

// ── Integrations API ──────────────────────────────────────────────────────────
app.get('/api/integrations', requireAuth, identifyTenant, checkPermission('integrations', 'view'), async (req, res) => {
  const userId = (req as any).user.id
  const tenantId = (req as any).tenantId
  const { data: dbIntegrations, error } = await supabase.from('tenant_integrations')
    .select('key,status,label,config,connected_at').eq('tenant_id', tenantId)
  
  if (error) { res.status(500).json({ error: error.message }); return }
  
  const integrations = [...(dbIntegrations ?? [])]
  
  // Synthesize WhatsApp + Google integrations from the tenants row
  const { data: tenant } = await supabase.from('tenants')
    .select('waba_id,google_email,google_access_token,updated_at')
    .eq('id', tenantId).maybeSingle()

  if (tenant) {
    console.log(`[integrations] tenant=${tenantId} google_email=${tenant.google_email ?? 'null'} has_google_token=${!!tenant.google_access_token}`)
    if (tenant.waba_id && !integrations.find(i => i.key === 'whatsapp')) {
      integrations.push({ key: 'whatsapp', status: 'connected', label: tenant.waba_id, config: null, connected_at: tenant.updated_at } as any)
    }
    if (tenant.google_access_token) {
      const googleApps = ['google_drive', 'google_calendar', 'google_sheets', 'google_gmail']
      googleApps.forEach(key => {
        if (!integrations.find(i => i.key === key)) {
          integrations.push({ key, status: 'connected', label: tenant.google_email, config: null, connected_at: tenant.updated_at } as any)
        }
      })
    }
  }
  
  res.json(integrations)
})

// Google Sheets endpoints for lead importing
app.get('/api/google/spreadsheets', requireAuth, identifyTenant, checkPermission('google_sheets', 'view'), async (req, res) => {
  const userId = (req as any).user.id
  const tenantId = (req as any).tenantId
  const { data: tenant } = await supabase.from('tenants').select('*').eq('user_id', userId).eq('id', tenantId).maybeSingle()
  if (!tenant || !tenant.google_access_token) {
    res.status(400).json({ error: 'Google account not connected' }); return
  }
  try {
    const files = await listSpreadsheets(tenant)
    res.json(files)
  } catch (err: any) { res.status(500).json({ error: err.message }) }
})

app.get('/api/google/spreadsheets/:id', requireAuth, identifyTenant, checkPermission('google_sheets', 'view'), async (req, res) => {
  const tenantId = (req as any).tenantId
  const { data: tenant } = await supabase.from('tenants').select('*').eq('id', tenantId).maybeSingle()
  if (!tenant || !tenant.google_access_token) {
    res.status(400).json({ error: 'Google account not connected' }); return
  }
  try {
    const meta = await sheetsGetMetadata(tenant, String(req.params.id))
    const sheets = await Promise.all((meta.sheets ?? []).map(async (s: any) => {
      const name = s.properties.title
      // Read a larger chunk to ensure we get the data and headers correctly
      const values = await sheetsReadRange(tenant, String(req.params.id), `${name}!1:1000`)
      
      if (!values || values.length === 0) return { name, headers: [], rows: [] }

      // Find the best header row (most non-empty cells in first 20 rows)
      let headerIndex = -1
      let maxCols = 0
      for (let i = 0; i < Math.min(values.length, 20); i++) {
        const nonApparentEmpty = (values[i] || []).filter((v: any) => v && String(v).trim().length > 0).length
        if (nonApparentEmpty > maxCols) {
          maxCols = nonApparentEmpty
          headerIndex = i
        }
      }

      // If no good header found, default to first row
      if (headerIndex === -1) headerIndex = 0

      const headers = (values[headerIndex] ?? []).map((h: any, i: number) => String(h || '').trim() || `Column_${i + 1}`)
      
      // Filter out rows that are completely empty or are actually the header row
      const rows = values.slice(headerIndex + 1).filter(row => row.some(cell => cell && String(cell).trim())).map(row => {
        const obj: Record<string, string> = {}
        headers.forEach((h, i) => { 
          const val = row[i]
          obj[h] = (val === undefined || val === null) ? '' : String(val).trim()
        })
        return obj
      })
      
      return { name, headers, rows }
    }))
    res.json({ name: meta.properties.title, sheets })
  } catch (err: any) { 
    console.error('[google-sheets] READ ERROR:', err)
    res.status(500).json({ error: err.message }) 
  }
})

app.post('/api/integrations/razorpay', requireAuth, identifyTenant, checkPermission('integrations', 'edit'), validateBody(RazorpayConnectSchema), async (req, res) => {
  const tenantId = (req as any).tenantId
  const { key_id, key_secret } = req.body
  const { error } = await supabase.from('tenant_integrations').upsert({
    tenant_id: tenantId, key: 'razorpay', status: 'active',
    label: key_id,
    config: { key_id, key_secret_preview: key_secret.slice(0, 6) + '…' },
  }, { onConflict: 'tenant_id,key' })
  if (error) { res.status(500).json({ error: error.message }); return }
  res.json({ success: true })
})

app.delete('/api/integrations/:key', requireAuth, identifyTenant, checkPermission('integrations', 'delete'), async (req, res) => {
  const tenantId = (req as any).tenantId
  const key = String(req.params.key)

  if (key === 'whatsapp') {
    const { error } = await supabase.from('tenants')
      .update({ waba_id: null, phone_number_id: null, display_phone: null, business_name: null })
      .eq('id', tenantId)
    if (error) { res.status(500).json({ error: error.message }); return }
    res.json({ success: true })
    return
  }

  if (key.startsWith('google_')) {
    const { error } = await supabase.from('tenants')
      .update({ google_email: null, google_access_token: null, google_refresh_token: null, google_token_expiry: null })
      .eq('id', tenantId)
    if (error) { res.status(500).json({ error: error.message }); return }
    res.json({ success: true })
    return
  }

  const { error } = await supabase.from('tenant_integrations')
    .delete().eq('tenant_id', tenantId).eq('key', key)
  if (error) { res.status(500).json({ error: error.message }); return }
  res.json({ success: true })
})

app.get('/api/features', async (req, res) => {
  const { data } = await supabase.from('system_features').select('*').order('name')
  res.json(data || [])
})

// ── Role Management API ───────────────────────────────────────────────────────

app.get('/api/roles', requireAuth, identifyTenant, checkPermission('settings', 'view'), async (req, res) => {
  const tenantId = (req as any).tenantId
  const { data } = await supabase.from('role_permissions').select('*').eq('tenant_id', tenantId)
  res.json(data || [])
})

app.post('/api/roles/permissions', requireAuth, identifyTenant, checkPermission('settings', 'edit'), async (req, res) => {
  const tenantId = (req as any).tenantId
  const { role, feature, can_view, can_edit, can_delete } = req.body
  
  const { data, error } = await supabase.from('role_permissions').upsert({
    tenant_id: tenantId,
    role,
    feature,
    can_view,
    can_edit,
    can_delete,
    updated_at: new Date().toISOString()
  })

  if (error) { res.status(500).json({ error: error.message }); return }
  res.json({ success: true })
})

app.get('/api/team', requireAuth, identifyTenant, checkPermission('settings', 'view'), async (req, res) => {
  const tenantId = (req as any).tenantId
  const { data, error } = await supabase.from('user_roles').select('*').eq('tenant_id', tenantId)
  if (error) { res.status(500).json({ error: error.message }); return }
  res.json({ success: true, team: data || [] })
})

app.post('/api/team/invite', requireAuth, identifyTenant, checkPermission('settings', 'edit'), async (req, res) => {
  const tenantId = (req as any).tenantId
  const { email, role } = req.body
  
  try {
    // 1. Trigger Supabase Invitation
    const { data: invite, error: inviteError } = await supabase.auth.admin.inviteUserByEmail(email, {
      redirectTo: `${process.env.FRONTEND_URL || 'http://localhost:5173'}/auth`
    })

    if (inviteError) {
      // If user already exists, we'll just add the role instead of failing
      if (inviteError.message.includes('already registered')) {
        // Find user ID by email (hacky but effective for development)
        const { data: existingUser } = await supabase.auth.admin.listUsers()
        const user = existingUser.users.find(u => u.email === email)
        if (user) {
          await supabase.from('user_roles').upsert({
            user_id: user.id,
            tenant_id: tenantId,
            role
          })
          return res.json({ success: true, message: `${email} is already on Frequency and has been added to your team.` })
        }
      }
      return res.status(500).json({ error: inviteError.message })
    }

    // 2. Map the new role for the invited user ID
    const { error: roleError } = await supabase.from('user_roles').upsert({
      user_id: invite.user.id,
      tenant_id: tenantId,
      role
    })

    if (roleError) return res.status(500).json({ error: roleError.message })
    
    res.json({ success: true, message: `Invitation sent to ${email}` })
  } catch (err: any) {
    res.status(500).json({ error: err.message })
  }
})

// ── Dev seed endpoint ─────────────────────────────────────────────────────────
if (process.env.NODE_ENV !== 'production') {
  app.post('/api/dev/seed', requireAuth, async (req, res) => {
    const user = (req as any).user

    const contacts = [
      { user_id: user.id, name: 'Rahul Sharma',  phone: '919876543210', tags: ['lead', 'premium'], status: 'active',    attributes: { source: 'website',  city: 'Mumbai'    } },
      { user_id: user.id, name: 'Priya Patel',   phone: '918765432109', tags: ['customer', 'vip'], status: 'active',    attributes: { source: 'referral', city: 'Delhi'     } },
      { user_id: user.id, name: 'Amit Kumar',    phone: '917654321098', tags: ['lead'],             status: 'active',    attributes: { source: 'ad',       city: 'Bangalore' } },
      { user_id: user.id, name: 'Sneha Reddy',   phone: '916543210987', tags: ['customer'],         status: 'active',    attributes: { source: 'website',  city: 'Hyderabad' } },
      { user_id: user.id, name: 'Vijay Nair',    phone: '915432109876', tags: ['opted_out'],        status: 'opted_out', attributes: {}                                       },
    ]
    const { error: cErr, data: contactRows } = await supabase.from('contacts')
      .upsert(contacts, { onConflict: 'phone' }).select('id,name,phone')
    if (cErr) { res.status(500).json({ error: cErr.message }); return }

    // Seed broadcasts
    const broadcasts = [
      { user_id: user.id, name: 'May Diwali Promo',     template_name: 'diwali_offer',   status: 'sent',      audience: { all: true },                stats: { sent: 1240, delivered: 1198, read: 876, replied: 43, failed: 42 },  sent_at: new Date(Date.now() - 7  * 86400e3).toISOString() },
      { user_id: user.id, name: 'Cart Recovery Wave 1', template_name: 'cart_recovery',  status: 'sent',      audience: { tags: ['lead'] },           stats: { sent: 312,  delivered: 298,  read: 201, replied: 18, failed: 14 },  sent_at: new Date(Date.now() - 3  * 86400e3).toISOString() },
      { user_id: user.id, name: 'New Product Launch',   template_name: 'product_launch', status: 'scheduled', audience: { all: true },                stats: { sent: 0, delivered: 0, read: 0, replied: 0, failed: 0 },           scheduled_at: new Date(Date.now() + 2 * 86400e3).toISOString() },
      { user_id: user.id, name: 'VIP Reactivation',     template_name: 'vip_promo',      status: 'draft',     audience: { tags: ['customer', 'vip'] }, stats: { sent: 0, delivered: 0, read: 0, replied: 0, failed: 0 } },
    ]
    // Delete existing seed broadcasts then re-insert (avoids constraint issues)
    await supabase.from('broadcasts').delete()
      .eq('user_id', user.id)
      .in('name', broadcasts.map((b: any) => b.name))
    const { error: bErr } = await supabase.from('broadcasts').insert(broadcasts)
    if (bErr) { res.status(500).json({ error: bErr.message }); return }

    // Seed messages (inbox) — only if we have a tenant
    const { data: tenantRow } = await supabase.from('tenants')
      .select('id').eq('user_id', user.id).eq('status', 'active').limit(1)
    const tenantId = tenantRow?.[0]?.id

    let messagesSeeded = 0
    if (tenantId && contactRows && contactRows.length > 0) {
      const now = Date.now()
      const msgs: any[] = []
      const convos = [
        { name: 'Rahul Sharma', phone: '919876543210', thread: [
          { dir: 'inbound',  text: "Hi! I saw your ad on Instagram. What products do you offer?",           ago: 3600 },
          { dir: 'outbound', text: "Hello Rahul! We offer premium skincare products. Would you like to see our catalog?", ago: 3500 },
          { dir: 'inbound',  text: "Yes please! Also what are your delivery charges?",                      ago: 3000 },
          { dir: 'outbound', text: "Free delivery on orders above ₹499. Here's our catalog link 🛍️",      ago: 2900 },
          { dir: 'inbound',  text: "Great! I'll place an order today.",                                     ago: 1800 },
        ]},
        { name: 'Priya Patel', phone: '918765432109', thread: [
          { dir: 'inbound',  text: "When will my order #ORD-4521 be delivered?",                            ago: 7200 },
          { dir: 'outbound', text: "Hi Priya! Your order is out for delivery and will arrive by 6 PM today.", ago: 7100 },
          { dir: 'inbound',  text: "Thank you! 😊",                                                         ago: 7000 },
        ]},
        { name: 'Amit Kumar', phone: '917654321098', thread: [
          { dir: 'inbound',  text: "Do you have any offers running this week?",                              ago: 86400 },
          { dir: 'outbound', text: "Yes Amit! Use code SAVE20 for 20% off on all orders till Sunday!",     ago: 86300 },
          { dir: 'inbound',  text: "Amazing! Will use it. Thanks",                                          ago: 86200 },
        ]},
        { name: 'Sneha Reddy', phone: '916543210987', thread: [
          { dir: 'inbound',  text: "I have a complaint. My package arrived damaged.",                        ago: 14400 },
          { dir: 'outbound', text: "We are really sorry to hear that Sneha! Please share a photo of the damage.", ago: 14300 },
          { dir: 'inbound',  text: "Sending photo now",                                                     ago: 14200 },
          { dir: 'inbound',  text: "Here's the photo [image]",                                              ago: 14100 },
          { dir: 'outbound', text: "Thank you! We will initiate a replacement within 24 hours.",            ago: 14000 },
        ]},
      ]

      for (const convo of convos) {
        const contact = contactRows.find((c: any) => c.phone === convo.phone)
        if (!contact) continue
        for (const m of convo.thread) {
          msgs.push({
            tenant_id: tenantId,
            contact_id: contact.id,
            direction: m.dir,
            content: m.text,
            message_type: 'text',
            status: m.dir === 'outbound' ? 'delivered' : 'received',
            created_at: new Date(now - m.ago * 1000).toISOString(),
          })
        }
      }

      const { error: mErr } = await supabase.from('messages').insert(msgs)
      if (!mErr) messagesSeeded = msgs.length
    }

    // Seed campaigns
    const campaignNames = ['Lead Nurture Drip', 'Post-Purchase Review', 'Cart Recovery Sequence', 'VIP Loyalty Program']
    await supabase.from('campaigns').delete().eq('user_id', user.id).in('name', campaignNames)
    const campaigns = [
      { user_id: user.id, name: 'Lead Nurture Drip',      description: '5-touch drip for new website leads',     type: 'drip',      status: 'active',    stats: { enrolled: 248,  active: 112, converted: 34, revenue: 68000  } },
      { user_id: user.id, name: 'Post-Purchase Review',   description: 'Ask for Google review 3 days after order', type: 'triggered', status: 'active',    stats: { enrolled: 891,  active: 45,  converted: 221,revenue: 0      } },
      { user_id: user.id, name: 'Cart Recovery Sequence', description: '3-message cart abandonment recovery',     type: 'drip',      status: 'paused',    stats: { enrolled: 134,  active: 0,   converted: 22, revenue: 44000  } },
      { user_id: user.id, name: 'VIP Loyalty Program',   description: 'Exclusive offers for repeat customers',   type: 'drip',      status: 'draft',     stats: { enrolled: 0,    active: 0,   converted: 0,  revenue: 0      } },
    ]
    await supabase.from('campaigns').insert(campaigns)

    res.json({
      success: true,
      seeded: {
        contacts: contacts.length,
        broadcasts: broadcasts.length,
        messages: messagesSeeded,
        campaigns: campaigns.length,
      }
    })
  })
}

// ── Lead Intake module ────────────────────────────────────────────────────────
app.use('/api', createLeadsRouter(supabase, requireAuth, identifyTenant, checkPermission))
app.use('/api/admin', createAdminRouter(supabase, requireAuth, isPlatformUser))

// ── Phase 3: campaigns, analytics, execution logs, activity ──────────────────
app.use(createPhase3Router({ supabase, requireAuth, identifyTenant, checkPermission }))

// ── Data-source mirroring (Google Sheets → Lead Tables, more sources later) ──
app.use(createDataSourcesRouter({ supabase, requireAuth, identifyTenant, checkPermission }))

// ── Connector registry + per-app OAuth, capabilities ─────────────────────────
app.use(createConnectorsRouter({ supabase, requireAuth, identifyTenant, checkPermission }))

// ── Billing (Razorpay subscriptions + webhook) ───────────────────────────────
// NOTE: the webhook route inside this router uses express.raw() to bypass the
// global JSON parser — needed for HMAC signature verification on raw bytes.
app.use(createBillingRouter({ supabase, requireAuth, identifyTenant, checkPermission }))

// ── Channel-specific feature endpoints (omnichannel) ─────────────────────────
app.use(createWaFeaturesRouter({ supabase, requireAuth, identifyTenant, checkPermission }))
app.use(createTelegramRouter({ supabase, requireAuth, identifyTenant, checkPermission }))
app.use(createInstagramRouter({ supabase, requireAuth, identifyTenant, checkPermission }))
app.use(createMetaAdsRouter({ supabase, requireAuth, identifyTenant, checkPermission }))

// ── Super-admin API (platform-level operations) ──────────────────────────────
app.use(createSuperAdminRouter({ supabase, requireAuth }))

// ── Tenant team management (RBAC) ────────────────────────────────────────────
app.use(createTeamsRouter({ supabase, requireAuth, identifyTenant }))

// ── Notifications (in-app bell + preferences) ────────────────────────────────
app.use(createNotificationsRouter({ supabase, requireAuth, identifyTenant }))

// ── Approval requests (broadcast >threshold, bulk delete, etc.) ──────────────
app.use(createApprovalsRouter({ supabase, requireAuth, identifyTenant, checkPermission }))

// ── Workflow recommendations (AI-generated once, cached forever) ─────────────
app.use(createWorkflowRecosRouter({ supabase, requireAuth, identifyTenant }))

// ── WhatsApp Business Calling (intent → initiate → dispatch → events) ───────
// The router owns the public /webhook/wa-calls endpoint AND all /api/calls/*
// routes. The raw-body parser for the webhook is mounted at the app level
// above (before express.json) so HMAC verification sees the exact bytes.
app.use(createWaCallingRouter({ supabase, requireAuth, identifyTenant, checkPermission }))

// ── Bull Board (queue dashboard) ──────────────────────────────────────────────
// Mounted at /admin/queues. Guarded — only super_admin (or local dev) can view.
const bullBoardAdapter = new ExpressAdapter()
bullBoardAdapter.setBasePath('/admin/queues')
createBullBoard({
  queues: [
    new BullMQAdapter(workflowQueue),
    new BullMQAdapter(messageQueue),
    new BullMQAdapter(broadcastQueue),
    new BullMQAdapter(cronQueue),
    // WA Business Calling queues — visible in Bull Board so ops can spot
    // stuck dispatches / archive backlogs / transcribe retries.
    new BullMQAdapter(callDispatchQueue),
    new BullMQAdapter(callEventIngestQueue),
    new BullMQAdapter(callRecordingArchiveQueue),
    new BullMQAdapter(callTranscribeQueue),
  ],
  serverAdapter: bullBoardAdapter,
})
async function requireSuperAdminOrLocal(req: express.Request, res: express.Response, next: express.NextFunction) {
  // F8: removed the `req.hostname === 'localhost'` bypass. Previously, any
  // request to http://localhost:3001/admin/queues from a dev machine got
  // unauthenticated access to BullMQ — fine for solo dev, but a footgun on
  // shared dev VMs / port-forwarded staging where "localhost" can mean an
  // attacker-controlled origin. Local dev now logs in as a platform user
  // exactly like prod does (the dev seed creates a super-admin user).
  const token = req.headers.authorization?.replace('Bearer ', '') || (req.query.token as string)
  if (!token) { res.status(401).send('auth required'); return }
  const { data: { user } } = await supabase.auth.getUser(token)
  if (!user) { res.status(401).send('invalid token'); return }
  // Use the same platform-user helper as the rest of the admin surface,
  // so any role with platform scope (Engineering, Trust & Safety, etc.)
  // can reach Bull Board — not just super_admin.
  if (!(await isPlatformUser(user.id))) { res.status(403).send('Platform Console access required'); return }
  next()
}
app.use('/admin/queues', requireSuperAdminOrLocal, bullBoardAdapter.getRouter())

// ── F5: Global error handler ─────────────────────────────────────────────
// Last-resort catch-all for thrown exceptions in route handlers + any
// failure from express-internal middleware (body-parser size overrun, CORS
// pre-flight, etc.). Standardises the response shape so clients never see:
//   - Stack traces
//   - Internal file paths
//   - Postgres error messages with column names
//   - body-parser's default plaintext 413 PayloadTooLargeError
//
// Important: this MUST be mounted AFTER every route + router, because
// express picks error middleware by signature (4-arg) AND insertion order.
app.use((err: any, req: express.Request, res: express.Response, _next: express.NextFunction) => {
  // Don't double-respond if a handler already sent headers.
  if (res.headersSent) return _next(err)

  const isBodySizeError = err?.type === 'entity.too.large' || err?.status === 413
  const isJsonParseError = err?.type === 'entity.parse.failed' || err?.statusCode === 400 && /JSON/.test(String(err?.message))

  if (isBodySizeError) {
    return apiError(
      res,
      413,
      'payload_too_large',
      'Request body exceeds the size limit for this endpoint.',
    )
  }
  if (isJsonParseError) {
    return apiError(res, 400, 'invalid_json', 'Request body is not valid JSON.')
  }

  // Anything else — log the full thing server-side, return a safe generic
  // error to the client. Stack traces NEVER leave the server.
  console.error(`[unhandled-error] req_id=${(req as any).id} path=${req.path} err=${err?.message ?? err}`)
  if (err?.stack) console.error(err.stack)
  return apiError(
    res,
    err?.status && err.status >= 400 && err.status < 600 ? err.status : 500,
    'internal_error',
    'Something went wrong on our end. The request ID is in the response header — share it with support if this persists.',
  )
})

if (process.env.NODE_ENV !== 'production') attachDebugListeners()

const server = app.listen(PORT, () => {
  console.log(`Frequency server running on http://localhost:${PORT}`)
  console.log(`  → Bull Board: http://localhost:${PORT}/admin/queues`)
})

// Graceful shutdown — finish in-flight requests + close queue connections.
async function shutdown(signal: string) {
  console.log(`[shutdown] received ${signal}`)
  const { closeQueues } = await import('./queue')
  server.close(async () => {
    await closeQueues()
    process.exit(0)
  })
  // Hard-exit if shutdown hangs >10s
  setTimeout(() => process.exit(1), 10_000).unref()
}
process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT',  () => shutdown('SIGINT'))
