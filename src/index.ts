import './env'   // must be first — loads .env with override=true
import { logger } from './lib/logger'
import express from 'express'
import fs from 'fs'
import path from 'path'
import cors from 'cors'
import crypto from 'crypto'
import helmet from 'helmet'
import rateLimit, { ipKeyGenerator } from 'express-rate-limit'
import { createClient } from '@supabase/supabase-js'
import Anthropic from '@anthropic-ai/sdk'
import {
  sheetsAppendRow, sheetsUpdateRange, sheetsReadRange, sheetsGetMetadata, listSpreadsheets,
  calendarCreateEvent, calendarCheckAvailability, gmailSendEmail,
  getValidGoogleToken,
} from './google'
import { createLeadsRouter } from './leads'
import { createAdminRouter } from './admin'
import { createPhase3Router } from './routes/phase3'
import { createDataSourcesRouter } from './routes/data-sources'
import { createConnectorsRouter }  from './routes/connectors'
import { createBillingRouter }     from './routes/billing'
import { createCtwaAnalyticsRouter } from './routes/ctwa-analytics'
import { createWaitlistRouter }    from './routes/waitlist'
import { createPublicStatusRouter } from './routes/public-status'
import { createWaFeaturesRouter }  from './routes/wa-features'
import { createWaTemplatesRouter } from './routes/wa-templates'
import { createTelegramRouter }    from './routes/telegram'
import { createInstagramRouter }   from './routes/instagram'
import { createMetaAdsRouter }     from './routes/meta-ads'
import { createSuperAdminRouter }  from './routes/super-admin'
import { createTeamsRouter }       from './routes/teams'
import { createTenantAuditRouter } from './routes/tenant-audit'
import { createNotificationsRouter } from './routes/notifications'
import { createFormsRouter } from './routes/forms'
import { createSitesRouter } from './routes/sites'
import { createDevicesRouter }       from './routes/devices'
import { createUsageRouter }         from './routes/usage'
import { createWedgeSurfaceRouter }  from './routes/wedge-surface'
import { createApprovalsRouter, requireApproval } from './routes/approvals'
import { createWorkflowRecosRouter } from './routes/workflow-recos'
import { createWorkflowTemplatesRouter } from './routes/workflow-templates'
import { createWorkflowVersionsRouter } from './routes/workflow-versions'
import { createWorkflowInsightsRouter } from './routes/workflow-insights'
import { createN8nImportRouter }        from './routes/n8n-import'
import { createIntegrationRequestsRouter } from './routes/integration-requests'
import { createWaCallingRouter }     from './routes/wa-calling'
import { createAiResponderRouter }   from './routes/ai-responder'
import { createDsrRouter }           from './routes/dsr'
import { createBreachNotificationsRouter } from './routes/breach-notifications'
import { createDataResidencyRouter } from './routes/data-residency'
// P1 #16 — Inbox agent-collision presence audit. Live presence is in Supabase
// Realtime channels (ephemeral); this router only persists the audit trail.
import { createInboxPresenceRouter }   from './routes/inbox-presence'
import { createVoiceTranscriptsRouter } from './routes/voice-transcripts'
import { createPrivacyCenterRouter } from './routes/privacy-center'
// P1 #11 — Shopify integration (OAuth start/callback, webhook receiver,
// tenant-facing list/disconnect/fulfill endpoints).
import { createShopifyOAuthRouter }   from './routes/shopify-oauth'
import { createShopifyWebhookRouter } from './routes/shopify-webhook'
import { createShopifyRouter }        from './routes/shopify'
// P1 #12 — Agency white-label dashboard (migration 079). Lifecycle, members,
// sub-accounts, revshare ledger, payouts. Single router, requireAuth on every
// route; membership + role gates enforced in-handler.
import { createAgencyRouter }         from './routes/agency'
// P1 #18 — Bulk contact import + saved segments (migration 084).
// The router is thin; heavy lifting is in workers/contact-import-processor.ts
// which the API process enqueues against via enqueueContactImport.
import { createContactImportRouter }  from './routes/contact-import'
import { createSegmentsRouter }       from './routes/segments'
// P2 #19 — Click-tracking on broadcast links (migration 085).
//   r-redirect:                public GET /r/:token, logs a click + 302s.
//   broadcast-link-analytics:  tenant-scoped read-side rollups for the FE.
import { createRedirectRouter }                from './routes/r-redirect'
import { createBroadcastLinkAnalyticsRouter } from './routes/broadcast-link-analytics'
// P2 #22 — Sales CRM Lite (migration 087). Pipeline view tied to conversations.
import { createCrmRouter }                     from './routes/crm'
// Phase 1A (migration 093) — Quick Replies + Internal Notes for the
// conversation composer. Stage-aware suggestions tied to the CRM Pipeline.
import { createComposerToolsRouter }           from './routes/composer-tools'
// Phase 1B (migration 094) — PII detection + masking + audit log.
// DPDPA/BFSI/healthcare/fintech sales unblock. Render-time mask, no
// plaintext stored masked — see src/lib/pii-masking.ts for the design.
import { createPiiRouter }                     from './routes/pii'
// Phase 3 (migration 095) — SLA tracking. Per-tenant first_response +
// resolution targets, breach event log. Worker scans every 30s; this
// router serves config + breach reads.
import { createSlaRouter }                     from './routes/sla'
import {
  PICKER_CATALOG, composePickerPromptSection, flattenPickers,
} from './connectors/picker-catalog'
import { enqueueContactImport }       from './workers/contact-import-processor'
import { syncTenant as syncTenantTemplates } from './workers/template-sync'
import {
  enqueueWorkflowExecution,
  workflowQueue, messageQueue, broadcastQueue, cronQueue,
  callDispatchQueue, callEventIngestQueue, callRecordingArchiveQueue, callTranscribeQueue,
  attachDebugListeners,
  connection as redisConnection,
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
  RazorpayConnectSchema, InboxSendSchema, InboxReactSchema,
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

// Multi-origin allowlist for the restrictive CORS:
//   - FRONTEND_URL (canonical custom-domain origin, e.g. https://getfrequency.app)
//   - FRONTEND_URL_ALIASES (comma-separated additional origins; useful for the
//     www.* variant, the canonical Vercel preview URL, and any per-deploy
//     preview URLs you want to whitelist)
//   - Vercel preview URLs (regex: any *.vercel.app under our project's slug)
//   - localhost on common dev ports
// In development we also allow any localhost origin to keep the DX painless.
const FRONTEND_PRIMARY = process.env.FRONTEND_URL || 'http://localhost:5173'
const FRONTEND_ALIASES = (process.env.FRONTEND_URL_ALIASES ?? '')
  .split(',').map(s => s.trim()).filter(Boolean)
const STATIC_ALLOWED = new Set([FRONTEND_PRIMARY, ...FRONTEND_ALIASES])
// Match the canonical Vercel project + any per-deploy preview hostname so
// the team can curl staging links without re-deploying. Adjust the slug
// when you rename the Vercel project.
const VERCEL_PREVIEW_RE = /^https:\/\/[a-z0-9-]+(-[a-z0-9]+)?\.vercel\.app$/

const restrictiveCors = cors({
  origin: (origin, cb) => {
    // Same-origin / non-browser tools (curl, server-to-server) send no Origin
    // — let them through, the route auth still applies.
    if (!origin) return cb(null, true)
    if (STATIC_ALLOWED.has(origin)) return cb(null, true)
    if (VERCEL_PREVIEW_RE.test(origin)) return cb(null, true)
    if (process.env.NODE_ENV !== 'production' && /^https?:\/\/(localhost|127\.0\.0\.1):\d+$/.test(origin)) {
      return cb(null, true)
    }
    return cb(new Error(`CORS blocked: origin ${origin} not in allowlist`), false)
  },
  credentials: false,
})
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

// P1 #11 — Shopify webhook. Same raw-body requirement: Shopify HMAC-signs the
// exact byte sequence. We attach rawBody via the express.json `verify` hook
// so downstream middlewares still see a parsed object on req.body AND the
// handler can re-hash the original bytes via (req as any).rawBody.
app.use('/api/webhooks/shopify', express.json({
  limit: '5mb',
  verify: (req: any, _res, buf) => { req.rawBody = Buffer.from(buf) },
}))

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
app.post('/api/workflows/:id/simulate', express.json({ limit: '2mb'  }))
// P1 #14 — publish-preview / revert / explain take the full nodes_json blob,
// so they share the same 5mb cap as POST /api/workflows.
app.post('/api/workflows/:id/publish-preview', express.json({ limit: '5mb' }))
app.post('/api/workflows/:id/revert',          express.json({ limit: '1mb' }))
app.post('/api/workflows/:id/explain',         express.json({ limit: '1mb' }))
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
  // P1 #11 — Shopify direct OAuth callback + inbound webhook. Both carry
  // signed payloads (state HMAC and Shopify HMAC respectively).
  '/api/shopify/callback',
  '/api/webhooks/shopify',
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
    // Per-request console line is debug-only — fires on every request,
    // which floods log aggregators. The file log above keeps the on-disk
    // audit trail intact. Flip DEBUG=1 to mirror to stdout.
    logger.debug(`[request] ${req.method} ${matched} [body+query suppressed]`)
  } else {
    logToFile(`${req.method} ${req.path}`)
    logger.debug(`[request] ${req.method} ${req.path}`)
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
    // Use the library's ipKeyGenerator helper so IPv6 addresses are collapsed
    // to /64 prefix — otherwise an attacker can rotate within their own /64
    // to bypass the limit (ERR_ERL_KEY_GEN_IPV6).
    keyGenerator: (req) => {
      const ipKey = ipKeyGenerator(req.ip ?? 'unknown')
      if (!opts.perUser) return ipKey
      const userId = (req as any).user?.id ?? 'anon'
      return `${ipKey}:${userId}`
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
// /api/workflows/:id/analyze — protect the AI call (GET insights is cheap;
// only the POST that re-runs Claude needs rate-limiting). The path has a
// dynamic :id segment, so we match by regex tail.
app.use(/^\/api\/workflows\/[^/]+\/analyze$/, aiLimiter)

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
  // Per-request resolution trace. Silenced by default — fires 1× per
  // authed request, ~100 req/min on a quiet tenant. Flip DEBUG=1 to see.
  logger.debug(`[identifyTenant] user=${user.id}, header_tenant=${headerTenantId || '(none)'}`)

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
      logger.debug(`[identifyTenant] resolved via user_role_assignments: tenant=${headerTenantId}, role=${assignmentRole}`)
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
      logger.debug(`[identifyTenant] resolved via user_roles: tenant=${headerTenantId}, role=${roleForHeader.role}`)
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
      logger.debug(`[identifyTenant] resolved via tenant ownership: tenant=${headerTenantId}, role=owner`)
      ;(req as any).tenantId = headerTenantId
      ;(req as any).userRole = 'owner'
      next()
      return
    }
    // SECURITY: caller sent an X-Tenant-ID header they have NO access to.
    // The previous behavior was to silently fall through and resolve to the
    // caller's own tenant — which (a) lies to clients about which tenant
    // they're operating on, (b) enables cross-tenant probing (caught by the
    // behavioral smoke harness: a foreign user spoofing primary's tenant
    // header got 200 with empty array, masking the rejection signal),
    // and (c) widens the blast radius if any downstream handler trusts
    // req.tenantId without re-validating. Hard-reject instead.
    logger.warn(`[identifyTenant] SECURITY: user=${user.id} sent header tenant ${headerTenantId} they have no access to — rejecting`)
    apiError(res, 403, 'tenant_access_denied', 'You do not have access to the requested tenant.')
    return
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
    logger.debug(`[identifyTenant] resolved via user_role_assignments auto: tenant=${assignmentAuto.tenant_id}, role=${role}`)
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
    logger.debug(`[identifyTenant] resolved via user_roles auto: tenant=${userRole.tenant_id}, role=${userRole.role}`)
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
    logger.debug(`[identifyTenant] resolved via tenant ownership fallback: tenant=${ownedTenant.id}`)
    ;(req as any).tenantId = ownedTenant.id
    ;(req as any).userRole = 'admin'
    next()
    return
  }

  // This one is a real auth failure — keep at warn so it surfaces in prod.
  logger.warn(`[identifyTenant] FAILED for user=${user.id} — no tenant found via any path`)
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

// ── Workflow Builder · Picker Catalog ──────────────────────────────────────
// Single source of truth for which fields back live-data dropdowns in
// the AI-generated workflow blueprint. The FE reads this on mount and
// dispatches to DynamicLiveDataPicker for any missing_config field whose
// name matches a catalog entry. Adding a new app to Frequency's
// workflow builder is a 10-line edit to connectors/picker-catalog.ts —
// the prompt composer + this endpoint + the FE picker all read from
// that same registry, no other files change. No auth gate — the catalog
// describes shape, not tenant data. Live-data resolution still goes
// through the auth-gated app endpoints (e.g. /api/google/spreadsheets).
app.get('/api/workflow-builder/picker-catalog', (_req, res) => {
  res.json({
    categories: PICKER_CATALOG,
    fields: flattenPickers(),
  })
})

// ── NLP Parse (streaming) ─────────────────────────────────────────────────────
const SYSTEM_PROMPT = `You are a workflow architect for Frequency — a WhatsApp Business automation platform that also integrates with email, Google Sheets, CRMs, and payment systems.

Parse the user's plain-language automation intent and return ONLY a compact JSON workflow blueprint. No prose, no markdown, no code blocks, no \`\`\`json fences — pure JSON only. Your entire response must start with { and end with }.

CRITICAL RULE — CLARIFYING QUESTIONS:
When key information is missing to build a complete, executable workflow, populate "clarifying_questions" with 2–5 targeted questions. Each targets exactly one unknown. Still build the best-guess workflow skeleton; set config_completion_percent to 20–45 when questions are present. Do NOT invent credentials, emails, or phone numbers.

CRITICAL RULE — LARGE / MULTI-WORKFLOW INPUT:
If the user pastes a large existing workflow (n8n JSON, Zapier zap, Make scenario, or a multi-page spec) AND/OR asks for "multiple workflows" or "linked workflows", DO NOT try to translate the entire thing into one giant blueprint. Output budget is ~16K tokens — overruns get truncated mid-JSON and the parser rejects them. Instead:
  1. Identify the SINGLE most important workflow (usually the first trigger → first conversion path) and emit a complete blueprint for THAT one.
  2. List the remaining workflows as "blocking_issues" entries with severity:"info" and clear messages like "Step 2: Visit reminder cron — ask separately for a Frequency blueprint of this."
  3. Use clarifying_questions to confirm scope: "I see this spans 5 separate flows. I built the first (Lead intake → BHK qualification). Want me to do (a) Visit booking, (b) Drip nurture, (c) Stale recovery next — pick one?"
  4. NEVER copy n8n-specific node types (n8n-nodes-base.*) — translate to Frequency node types from the list below.
  5. NEVER preserve hardcoded webhook URLs, phone-number IDs, or template names from the source — emit them as missing_config[] picker fields so the user wires them via our existing connectors.

Output a single, complete, balanced JSON object. Better to ship one tight workflow that parses than half of a giant one that gets cut off.

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

${composePickerPromptSection()}


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
          "type": "text|textarea|select|number|url|email|phone|template_picker|integration_picker",
          "required": true,
          "placeholder": "",
          "options": [],
          "depends_on": ""
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

COMMON INTENT PATTERNS (with picker chains — emit these as missing_config[]):

- "forward email from X to Y" → trigger_email_received (filter_from_email=X) → forward_email (to=Y).
  Pickers: email_provider, gmail_account_id, filter_from_email (text), filter_subject (text).

- "when form submitted" → trigger_form_submit → send_template (outside 24 h).
  Pickers: form provider (select), template_name + template_language.

- "payment received" → trigger_webhook (Razorpay) → send_template (payment confirmation).
  Pickers: webhook_secret (text), template_name, template_language.

- "every Monday at 10am send a campaign to hot leads" →
  trigger_scheduled (cron) → send_template (broadcast-style).
  Pickers: segment_id (live), template_name (live), template_language.

- "respond to inbound 'pricing' message" → trigger_inbound_keyword → send_text or send_template.
  Pickers: channel, quick_reply_id (live) OR template_name.

- "when status in my Leads table changes to 'Qualified', notify the assigned agent on WhatsApp" →
  trigger_sheet_row (table_id) → condition_variable (column_name_status, column_value_status='Qualified') → send_text.
  Pickers: table_id, column_name_status (depends_on table_id), column_value_status (depends_on column_name_status),
           assigned_agent_id, template_name (if outside 24h).

- "send Razorpay payment link of ₹500 when customer says 'pay'" →
  trigger_inbound_keyword → http_request (Razorpay create) → send_text.
  Pickers: operation_razorpay='create_payment_link', amount_paise=50000, customer_email, description.

- "when Razorpay payment is captured, mark customer row in my Customers table as Paid" →
  trigger_webhook (razorpay.payment.captured) → update_sheet/update_table.
  Pickers: table_id (live), column_name_status, column_value_status='Paid'.

- "move deal to 'Closed Won' when customer says 'yes'" →
  trigger_inbound_keyword → update_crm (operation_deal='move_stage').
  Pickers: deal_id (from {{contact.deal_id}} — assumes attribute was set earlier), pipeline_stage_id (live), operation_deal='move_stage'.

TOKEN GRAMMAR — supported namespaces in {{...}} placeholders (anything else renders as a literal '{{x.y}}' string in the sent message, which is a visible bug):
  • {{trigger.text}}        — inbound message text (keyword / IG comment text)
  • {{trigger.<key>}}       — any field on the trigger payload (story_id, comment_id, order_id from shopify, email_from from gmail, etc.)
  • {{contact.name}}        — contact's display name (empty string if unknown)
  • {{contact.phone}}       — E.164 phone with leading +
  • {{contact.tags}}        — array of tag strings
  • {{contact.<attribute>}} — any custom attribute the tenant set (e.g. {{contact.budget}}, {{contact.city}})
  • {{<output_var>}}        — variables set by previous nodes via response_variable (e.g. {{ai_reply}}, {{collected_email}}, {{http_response}})

NEVER use {{conversation.*}}, {{user.*}}, {{tenant.*}}, {{message.*}} — those namespaces don't exist in the executor. Only reference fields you've explicitly seeded or set as a step output.

- "broadcast offer to all VIP segment customers every Friday at 6pm" →
  trigger_scheduled → send_template (broadcast to segment).
  Pickers: segment_id (live), template_name (live), template_language.

- "assign new inbound conversations from Instagram to Priya's team" →
  trigger_inbound_keyword (channel=instagram) → assign_agent.
  Pickers: channel='instagram', team_id (live) OR assigned_agent_id (live).

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
      // Bumped from 6000 → 16000 after users hit truncation pasting large
      // existing workflow JSON (e.g. an n8n export). Sonnet 4.6 supports
      // up to 64K output tokens; 16K is ~12K words of JSON which covers
      // every realistic Frequency blueprint while keeping latency
      // bounded. Truncation is also explicitly detected below via
      // stop_reason='max_tokens' so we can surface a clean error.
      max_tokens: 16000,
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
      console.log(`[parse-workflow] done chars=${charCount} input=${usage.input_tokens} output=${usage.output_tokens} cache_read=${(usage as any).cache_read_input_tokens ?? 0} cache_create=${(usage as any).cache_creation_input_tokens ?? 0} stop=${final?.stop_reason}`)
      void import('./lib/ai-usage').then(({ recordAiUsage }) =>
        recordAiUsage(supabase, tenantId, usage as any, 'parse_workflow', 'claude-sonnet-4-6'))
    }

    // Truncation detection — the LLM hit our max_tokens budget mid-response.
    // The streamed text will end mid-JSON (unbalanced braces) so the FE's
    // extractFirstJsonObject() returns null and shows "replied with prose
    // instead of a workflow blueprint" — confusing because the AI WAS
    // returning a blueprint, just not the whole thing. Surface a specific
    // error before the FE attempts to parse so the user sees actionable copy.
    if (!clientGone && final?.stop_reason === 'max_tokens') {
      writeEvent({
        error: 'truncated',
        message: 'Your workflow was too large to generate in one go. Break the ask into smaller pieces — e.g. split a multi-stage automation into separate workflows that trigger each other via webhook, or describe one stage at a time and add the rest as follow-up.',
      })
      writeEvent({ done: true })
      res.write('data: [DONE]\n\n')
      res.end()
      return
    }

    // ── P1 #14: emit a `preview` event before [DONE] ───────────────────────
    // Existing FE consumers (parseWorkflowStream) ignore unknown event keys
    // by inspecting `json.text` / `json.error` / `json.done` only — so
    // adding `{ type: 'preview', ... }` is non-breaking. New consumers that
    // want the preview-before-publish UX can opt in to handling it.
    //
    // We do BEST-EFFORT parsing + validation here. If the assistant's reply
    // doesn't parse cleanly, we still close the stream normally — the FE
    // continues to work the old way (the streamed text IS the result).
    if (!clientGone) {
      try {
        const assistantText = final?.content
          ?.filter(b => b.type === 'text')
          .map(b => (b as any).text as string)
          .join('') ?? ''
        // Robust extraction — mirrors FE lib/whatsapp-nlp.ts so the
        // preview-validator behaviour matches what the FE will actually
        // accept. Strips a single code fence if present, then walks
        // balanced braces from the first '{'.
        const extractFirstJsonObject = (text: string): string | null => {
          if (!text) return null
          const fenceMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/)
          const candidate = fenceMatch ? fenceMatch[1] : text
          const start = candidate.indexOf('{')
          if (start === -1) return null
          let depth = 0, inString = false, escape = false
          for (let i = start; i < candidate.length; i++) {
            const ch = candidate[i]
            if (escape) { escape = false; continue }
            if (ch === '\\' && inString) { escape = true; continue }
            if (ch === '"') { inString = !inString; continue }
            if (inString) continue
            if (ch === '{') depth++
            else if (ch === '}') {
              depth--
              if (depth === 0) return candidate.slice(start, i + 1)
            }
          }
          return null
        }
        const jsonStr = extractFirstJsonObject(assistantText)
        if (jsonStr) {
          let parsed: any
          try { parsed = JSON.parse(jsonStr) }
          catch { parsed = JSON.parse(jsonStr.replace(/,(\s*[}\]])/g, '$1')) }
          // Envelope unwrap — accept the blueprint nested under common
          // wrapper keys so a wrapped response still produces a preview.
          const ENVELOPE_KEYS = ['blueprint', 'workflow', 'result', 'data', 'output']
          let workflowObj: any = parsed
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed.nodes) && typeof parsed.workflow_name !== 'string') {
            for (const k of ENVELOPE_KEYS) {
              const cand = parsed[k]
              if (cand && typeof cand === 'object' && (Array.isArray(cand.nodes) || typeof cand.workflow_name === 'string' || typeof cand.name === 'string')) {
                workflowObj = cand
                break
              }
            }
          }
          const proposedNodes = Array.isArray(workflowObj?.nodes) ? workflowObj.nodes : []
          if (proposedNodes.length > 0) {
            const { validateWorkflow } = await import('./engine/workflow-validator')
            const report = await validateWorkflow(supabase, tenantId, proposedNodes)
            // Confidence heuristic — entirely deterministic so the FE can
            // trust the chip. low ↔ structural errors present; medium ↔ no
            // errors but at least one warning OR a missing connector; high
            // ↔ ok + no warnings.
            const hasError   = report.node_issues.some(i => i.severity === 'error')
            const hasWarning = report.node_issues.some(i => i.severity === 'warning')
            const confidence: 'low' | 'medium' | 'high' =
              hasError ? 'low'
              : (hasWarning || report.missing_connectors.length > 0) ? 'medium'
              : 'high'
            writeEvent({
              type: 'preview',
              nodes_json: proposedNodes,
              blueprint: workflowObj,
              validation: report,
              confidence,
            })
          }
        }
      } catch (e: any) {
        // Don't break the stream on a parse / validate failure — the FE
        // already has the full text and will degrade gracefully.
        console.warn('[parse-workflow] preview emit skipped:', e?.message?.slice(0, 120))
      }

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

// ── In-app Copilot (AI assistant for both visitors and signed-in users) ───────
//
// Streams Anthropic responses with tool_use so the assistant can navigate
// the user, open dialogs, or open external links as part of its reply. The
// FE sends the current intent registry as `intents` (route + title +
// optional event + optional answer hint) so the model can speak about real
// pages the app actually exposes — no hallucinated routes.
//
// Auth-optional: signed-in users get the AUTHED persona (in-app helper);
// visitors hit the PUBLIC persona (marketing / pricing / sales).
//
// Cost guard: 512-token cap + Haiku-class model (cheap, fast, plenty good
// for short Q&A). Hard 45s timeout + heartbeat. No per-tenant usage
// accounting yet — separate from /api/parse-workflow billing because this
// is a discoverability tool, not a paid feature.
type CopilotIntentMeta = {
  id: string
  title: string
  route: string
  event?: string
  hint?: string  // short product fact the model can quote (`answer` from FE)
}

function buildCopilotSystemPrompt(opts: {
  persona: 'authed' | 'public'
  pagePath: string
  intents: CopilotIntentMeta[]
}): string {
  const { persona, pagePath, intents } = opts
  const intentList = intents
    .map(i => {
      const parts = [`- "${i.title}" → ${i.route}`]
      if (i.event) parts.push(`(also fires dialog event: ${i.event})`)
      if (i.hint) parts.push(`\n    fact: ${i.hint}`)
      return parts.join(' ')
    })
    .join('\n')

  const personaBlock = persona === 'authed'
    ? `You are talking to a logged-in user inside the Frequency app. They're currently on the page: ${pagePath}.
Your job is to help them find features fast: answer in 1-3 short sentences, then use the navigate tool to take them where they want to go. Open dialogs (open_dialog tool) when the destination is a modal on the current page. Never recommend signing up — they're already in.`
    : `You are talking to a visitor on the Frequency marketing site. They're currently on the page: ${pagePath}. You haven't talked to them before.
Your job is sales-grade Q&A: answer their question in 2-4 short sentences with real product facts (use the facts under "fact:" below — don't invent), then use the navigate tool to send them to /auth to start a free trial when it's a natural next step. Use external_link for "talk to sales" / mailto: requests.`

  return `You are the Frequency in-app assistant. Frequency is a conversation OS for Indian SMBs — one tool that bundles WhatsApp Business API + Instagram DMs + Telegram, AI-built workflow automation, Razorpay payments, broadcasts, and a unified CRM. Pricing is INR-only with GST invoices; pricing starts at ₹999/month with a 7-day free trial (no card needed).

${personaBlock}

Rules:
1. Answer first (1-4 sentences). Only then call a tool.
2. NEVER call a tool without first writing a short text reply explaining what you're doing.
3. Use ONLY the routes in the catalogue below. Do not invent paths.
4. If the user asks something you don't have a fact for, say "I'm not sure — email hello@getfrequency.app and we'll get back to you" instead of guessing.
5. Tone: warm, direct, no marketing fluff. Indian SMB audience — talk in clear short sentences, no jargon.

Formatting (the UI renders a small subset of markdown):
- Use **bold** for key facts: prices, numbers, product names. Use it sparingly — 1-3 bolds per reply max.
- Use \`backticks\` for routes, event names, or technical terms.
- Use a blank line (\\n\\n) between paragraphs when the reply is more than 2 sentences.
- Use "- " bullets ONLY for genuine lists of 2-4 items. Don't bullet single facts.
- DO NOT use headings (#, ##), tables, or links — they won't render.

Catalogue of places you can navigate them to (use the navigate tool):
${intentList}

Tools you can call:
- navigate(path) — go to a route inside the app (must come from the catalogue above)
- open_dialog(event) — fire a CustomEvent that opens an in-app dialog (only when the catalogue entry lists an event)
- external_link(url) — for mailto: / tel: / https:// destinations (e.g. mailto:hello@getfrequency.app)

IMPORTANT — pair navigate + open_dialog when the catalogue requires it:
If a catalogue entry includes "(also fires dialog event: X)", you MUST call BOTH navigate(path) AND open_dialog(X) — in that order — to complete the action. The route alone lands the user on the right page but they still need the dialog to actually do the thing (connect a channel, import a sheet, etc.). Calling navigate without the matching open_dialog leaves them stuck.`
}

const COPILOT_TOOLS = [
  {
    name: 'navigate',
    description: 'Navigate the user to a route inside the Frequency app. Use this whenever the user wants to do something specific (create workflow, see pricing, etc.) and the route is listed in the catalogue.',
    input_schema: {
      type: 'object' as const,
      properties: {
        path: { type: 'string', description: 'Path to navigate to, must be from the catalogue. e.g. "/workflows", "/auth", "/home#pricing".' },
      },
      required: ['path'],
    },
  },
  {
    name: 'open_dialog',
    description: 'Fire a CustomEvent that opens an in-app dialog. ONLY use when the catalogue explicitly lists a dialog event for the destination.',
    input_schema: {
      type: 'object' as const,
      properties: {
        event: { type: 'string', description: 'Event name, e.g. "open-apps-modal".' },
      },
      required: ['event'],
    },
  },
  {
    name: 'external_link',
    description: 'Open an external URL via the browser (mailto:, tel:, https://). Use for "talk to sales" / "book a demo" / external links.',
    input_schema: {
      type: 'object' as const,
      properties: {
        url: { type: 'string', description: 'Full external URL, e.g. "mailto:hello@getfrequency.app".' },
      },
      required: ['url'],
    },
  },
]

// Tight rate limit — copilot is conversational so callers fire often.
app.use('/api/copilot/', makeLimiter({ windowMs: 60_000, max: 20, perUser: true }))

app.post('/api/copilot/stream', async (req, res) => {
  const { message, history = [], persona = 'public', page_path = '/', intents = [] } = req.body ?? {}
  if (!message || typeof message !== 'string' || message.length > 1000) {
    res.status(400).json({ error: 'message (string, 1-1000 chars) required' }); return
  }
  if (!Array.isArray(intents) || intents.length === 0) {
    res.status(400).json({ error: 'intents (non-empty array) required' }); return
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    res.status(503).json({ error: 'Assistant is offline right now. Please try again.' }); return
  }

  // ── SSE setup ─────────────────────────────────────────────────────────────
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8')
  res.setHeader('Cache-Control', 'no-cache, no-transform')
  res.setHeader('Connection', 'keep-alive')
  res.setHeader('X-Accel-Buffering', 'no')
  res.flushHeaders()

  const heartbeat = setInterval(() => {
    if (!res.writableEnded) { try { res.write(': keepalive\n\n') } catch { /* socket gone */ } }
  }, 15_000)

  const TIMEOUT_MS = 45_000
  const abortCtl = new AbortController()
  const timeoutId = setTimeout(() => abortCtl.abort(), TIMEOUT_MS)

  let clientGone = false
  res.on('close', () => {
    if (res.writableEnded) return
    clientGone = true
    abortCtl.abort()
  })

  const cleanup = () => { clearInterval(heartbeat); clearTimeout(timeoutId) }
  const writeEvent = (obj: unknown) => {
    if (res.writableEnded) return
    try { res.write(`data: ${JSON.stringify(obj)}\n\n`) } catch { /* socket gone */ }
  }

  try {
    // Clamp history to last 8 turns and shape — server is source of truth.
    const safeHistory = (Array.isArray(history) ? history : [])
      .filter((m: any) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.length < 4000)
      .slice(-8)
      .map((m: any) => ({ role: m.role as 'user' | 'assistant', content: m.content }))

    // Clamp intents — strip anything we don't recognise.
    const safeIntents: CopilotIntentMeta[] = (intents as any[])
      .filter(i => i && typeof i.id === 'string' && typeof i.title === 'string' && typeof i.route === 'string')
      .slice(0, 50)
      .map(i => ({
        id: String(i.id).slice(0, 60),
        title: String(i.title).slice(0, 120),
        route: String(i.route).slice(0, 200),
        event: typeof i.event === 'string' ? String(i.event).slice(0, 60) : undefined,
        hint: typeof i.hint === 'string' ? String(i.hint).slice(0, 600) : undefined,
      }))

    const system = buildCopilotSystemPrompt({
      persona: persona === 'authed' ? 'authed' : 'public',
      pagePath: typeof page_path === 'string' ? page_path.slice(0, 200) : '/',
      intents: safeIntents,
    })

    const stream = anthropic.messages.stream({
      model: 'claude-haiku-4-5',   // fast + cheap for short conversational Q&A
      max_tokens: 512,
      system: [
        { type: 'text', text: system, cache_control: { type: 'ephemeral' } },
      ] as any,
      tools: COPILOT_TOOLS as any,
      messages: [...safeHistory, { role: 'user' as const, content: message }],
    }, { signal: abortCtl.signal as any })

    // Track the current content block so we can buffer tool_use input until
    // the block finishes (Anthropic streams JSON input as `partial_json`
    // deltas, and we need the full payload before dispatching).
    let currentTool: { name: string; inputJson: string } | null = null

    for await (const chunk of stream) {
      if (clientGone) break

      if (chunk.type === 'content_block_start') {
        if (chunk.content_block.type === 'tool_use') {
          currentTool = { name: chunk.content_block.name, inputJson: '' }
        }
      } else if (chunk.type === 'content_block_delta') {
        if (chunk.delta.type === 'text_delta') {
          writeEvent({ text: chunk.delta.text })
        } else if (chunk.delta.type === 'input_json_delta' && currentTool) {
          currentTool.inputJson += chunk.delta.partial_json
        }
      } else if (chunk.type === 'content_block_stop') {
        if (currentTool) {
          // Parse the buffered JSON and emit a single tool event. Bad JSON
          // is silently dropped — better to deliver text-only than crash.
          try {
            const args = currentTool.inputJson ? JSON.parse(currentTool.inputJson) : {}
            writeEvent({ tool: { name: currentTool.name, args } })
          } catch (e: any) {
            console.warn('[copilot] tool args parse failed', currentTool.name, e?.message)
          }
          currentTool = null
        }
      }
    }

    writeEvent({ done: true })
    if (!res.writableEnded) { res.write('data: [DONE]\n\n'); res.end() }
  } catch (err: any) {
    if (err?.name === 'AbortError') {
      writeEvent({ error: 'Assistant timed out — please try a shorter question.' })
    } else {
      console.warn('[copilot] stream error', err?.message)
      writeEvent({ error: 'Assistant ran into a problem. Try again in a moment.' })
    }
    if (!res.writableEnded) { res.write('data: [DONE]\n\n'); res.end() }
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
  if (error) { res.status((error as any).code === 'PGRST116' ? 404 : 500).json({ error: (error as any).code === 'PGRST116' ? 'not found' : error.message }); return }
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
  if (error) { res.status((error as any).code === 'PGRST116' ? 404 : 500).json({ error: (error as any).code === 'PGRST116' ? 'not found' : error.message }); return }
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

// ── Workflow simulate (test mode / dry-run) ────────────────────────────────
//
// Runs the workflow end-to-end through the SAME executor as a live run, but
// with ExecCtx.simulate=true so every side-effecting branch (send message,
// HTTP, payment link, DB writes, AI inference, queue enqueue) is
// short-circuited. The runner records a per-node trace into
// workflow_simulation_runs.steps[]. The FE polls GET /:run_id for the result.
//
// `view` permission is enough — a simulation has no side effects, so any
// member who can view the workflow can also test it.
//
// Request body: { trigger_input?: { ...vars seeded into session.variables } }
//   trigger_input is OPTIONAL — empty {} works for triggerless smoke tests.
//   The shape mirrors what would arrive in session.variables on a real run:
//   e.g. { name: 'Asha', phone: '+919876543210', message: 'Hi' }
//
// Response: { run_id: uuid }
//   The runner runs synchronously inside this request (simulations are
//   fast because there's no real I/O — no fetch, no DB writes outside the
//   final run row). The run is already in its terminal state by the time
//   this responds, but the FE still polls GET /:run_id to fetch the trace
//   so the API contract stays uniform with the future "long-running
//   simulate" mode we may add later.
app.post('/api/workflows/:id/simulate', requireAuth, identifyTenant, checkPermission('whatsapp_automation', 'view'), async (req, res) => {
  const tenantId = (req as any).tenantId
  const userId   = (req as any).user?.id ?? null
  const wfId     = req.params.id
  const triggerInput = (req.body as any)?.trigger_input ?? {}
  if (typeof triggerInput !== 'object' || Array.isArray(triggerInput) || triggerInput == null) {
    res.status(400).json({ error: 'trigger_input must be a JSON object' })
    return
  }

  // Load workflow + tenant — service role bypasses RLS but we still scope
  // the SELECT by tenant_id so a caller can't simulate another tenant's
  // workflow even with a forged id.
  const [{ data: wf, error: wfErr }, { data: tenant, error: tErr }] = await Promise.all([
    supabase.from('workflows').select('id, tenant_id, name, nodes').eq('id', wfId).eq('tenant_id', tenantId).maybeSingle(),
    supabase.from('tenants').select('*').eq('id', tenantId).maybeSingle(),
  ])
  if (wfErr || tErr) { res.status(500).json({ error: wfErr?.message ?? tErr?.message ?? 'load failed' }); return }
  if (!wf)     { res.status(404).json({ error: 'Workflow not found' }); return }
  if (!tenant) { res.status(404).json({ error: 'Tenant not found' });   return }

  // Insert the run row up-front so we always have a run_id to hand back even
  // if the executor crashes mid-way. The runner's persistSimulationResult
  // UPDATE-s the same row with the terminal status + trace.
  const { data: runRow, error: insErr } = await supabase.from('workflow_simulation_runs').insert({
    tenant_id: tenantId,
    workflow_id: wfId,
    started_by: userId,
    trigger_input: triggerInput,
    status: 'running',
  }).select('id').single()
  if (insErr || !runRow) { res.status(500).json({ error: insErr?.message ?? 'failed to start run' }); return }
  const runId = runRow.id

  // Drive the simulation synchronously — runner is in-memory only, no I/O
  // (no fetch, no queue, no scheduled_jobs). Total wall time is bounded by
  // the runner's internal step + wall-clock caps.
  try {
    const { runSimulation, persistSimulationResult } = await import('./engine/simulate-runner')
    const result = await runSimulation({ tenant, workflow: wf, triggerInput })
    await persistSimulationResult(supabase, runId, result)
  } catch (err: any) {
    // Persist a failed run so the FE can still render the failure cleanly.
    try {
      await supabase.from('workflow_simulation_runs').update({
        status: 'failed',
        finished_at: new Date().toISOString(),
        error: err?.message ?? String(err),
      }).eq('id', runId)
    } catch { /* swallow — already in failure path */ }
  }

  res.status(202).json({ run_id: runId })
})

// GET a simulation run by id. FE polls this until status != 'running'.
// Tenant-scoped: we resolved the tenant from the JWT, so the WHERE clause
// rejects any cross-tenant lookup attempt.
app.get('/api/workflow-simulations/:run_id', requireAuth, identifyTenant, checkPermission('whatsapp_automation', 'view'), async (req, res) => {
  const tenantId = (req as any).tenantId
  const { data, error } = await supabase
    .from('workflow_simulation_runs')
    .select('*')
    .eq('id', req.params.run_id)
    .eq('tenant_id', tenantId)
    .maybeSingle()
  if (error) { res.status(500).json({ error: error.message }); return }
  if (!data) { res.status(404).json({ error: 'Simulation run not found' }); return }
  res.json(data)
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
  const { business_name, full_name, phone } = req.body ?? {}

  // Defensive validation — caller must supply business_name + full_name.
  // Previously this handler would crash deep in the slugify / upsert path
  // when called with an empty body (smoke harness exposed it as a 500
  // panic on POST /api/onboarding with body=`{}`).
  if (typeof business_name !== 'string' || business_name.trim().length === 0) {
    res.status(400).json({ error: 'business_name is required' })
    return
  }
  if (typeof full_name !== 'string' || full_name.trim().length === 0) {
    res.status(400).json({ error: 'full_name is required' })
    return
  }

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

  if (error) { res.status((error as any).code === 'PGRST116' ? 404 : 500).json({ error: (error as any).code === 'PGRST116' ? 'not found' : error.message }); return }

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

// Redirect-mode fallback. Embedded Signup is registered with redirect_uri
// /api/auth/meta/callback in the Meta dashboard, but the FE uses popup mode
// (override_default_response_type=true) so this is never hit in normal flow.
// Kept as defense-in-depth: if someone ever drops the override flag, Meta
// would redirect here instead of 404ing. We bounce to /onboarding so the
// SPA picks the code out of the query string and finishes the connect.
app.get('/api/auth/meta/callback', (req, res) => {
  const code = String(req.query.code ?? '')
  const frontend = process.env.FRONTEND_URL ?? 'https://getfrequency.app'
  res.redirect(`${frontend}/onboarding?code=${encodeURIComponent(code)}`)
})

// ── Facebook Embedded Signup callback ─────────────────────────────────────────
// Frontend calls this after user completes Embedded Signup. Two modes:
//   • Picker mode: FE got waba_id + phone_number_id from the popup's
//     WA_EMBEDDED_SIGNUP postMessage → pass them through.
//   • Discovery mode: FE only has `code` (postMessage didn't fire because
//     Meta skipped the picker — happens on reconnects where the WABA is
//     already authorized to our app). We use /debug_token's granular_scopes
//     to find the WABA(s) the user just authorized, then fetch the first
//     phone number on it. Takes the first WABA when multiple — multi-WABA
//     picker UX can come later.
app.post('/api/auth/facebook/connect-waba', requireAuth, async (req, res) => {
  const user = (req as any).user
  let { code, access_token: tokenFromBody, waba_id, phone_number_id } = req.body as {
    code?: string;
    access_token?: string;
    waba_id?: string;
    phone_number_id?: string;
  }
  if (!code && !tokenFromBody) {
    res.status(400).json({ error: 'code or access_token required' }); return
  }

  try {
    // Two paths to a short-lived user token:
    //   1) FE sent access_token directly (token-flow / FB.login default
    //      response_type=token). Skip code exchange entirely — the
    //      redirect_uri-mismatch error is impossible if we never exchange.
    //   2) FE sent code (legacy code-flow). We exchange with redirect_uri=
    //      empty per Meta docs, but Meta rejects this under Strict Mode
    //      for SDK-minted codes because the OAuth dialog used the SDK's
    //      session-specific staticxx.facebook.com URI which we can't
    //      reconstruct server-side. Token flow above is the fix; we keep
    //      this branch for backward-compat with any legacy callers.
    let shortToken: string
    if (tokenFromBody) {
      shortToken = tokenFromBody
    } else {
      const tokenRes = await fetch(
        `${GRAPH}/oauth/access_token?client_id=${META_APP_ID}&client_secret=${META_APP_SECRET}&redirect_uri=&code=${code}`
      )
      const tokenData = await tokenRes.json() as any
      if (tokenData.error) throw new Error(tokenData.error.message)
      shortToken = tokenData.access_token
    }

    // Exchange for long-lived token (60 days)
    const longRes = await fetch(
      `${GRAPH}/oauth/access_token?grant_type=fb_exchange_token&client_id=${META_APP_ID}&client_secret=${META_APP_SECRET}&fb_exchange_token=${shortToken}`
    )
    const longData = await longRes.json() as any
    if (longData.error) throw new Error(longData.error.message)
    const longToken: string = longData.access_token

    // Discovery mode: no waba_id/phone_number_id from FE → look them up.
    // /debug_token returns the granular_scopes block, which lists the
    // exact WABA IDs the user just consented to. Way more reliable than
    // walking /me/businesses → /{biz}/owned_whatsapp_business_accounts
    // (which also surfaces WABAs the user might NOT have included in
    // this consent). App access token is the standard auth for /debug_token.
    if (!waba_id || !phone_number_id) {
      const appAccessToken = `${META_APP_ID}|${META_APP_SECRET}`
      const debugRes = await fetch(
        `${GRAPH}/debug_token?input_token=${longToken}&access_token=${appAccessToken}`
      )
      const debugData = await debugRes.json() as any
      const scopes: Array<{ scope: string; target_ids?: string[] }> = debugData?.data?.granular_scopes ?? []
      const wabaScope = scopes.find(s => s.scope === 'whatsapp_business_management') ?? scopes.find(s => s.scope === 'whatsapp_business_messaging')
      const discoveredWaba = wabaScope?.target_ids?.[0]
      if (!discoveredWaba) {
        throw new Error('No WhatsApp Business Account was authorized in the Meta popup. Please retry and complete every picker step, or use the manual setup form.')
      }
      waba_id = discoveredWaba

      // Fetch the first phone number on this WABA
      const phonesRes = await fetch(
        `${GRAPH}/${waba_id}/phone_numbers?fields=id,display_phone_number,verified_name`,
        { headers: { Authorization: `Bearer ${longToken}` } }
      )
      const phonesData = await phonesRes.json() as any
      const firstPhone = phonesData?.data?.[0]
      if (!firstPhone?.id) {
        throw new Error('No phone number is registered on this WABA yet. Add one in Meta Business Manager → WhatsApp Accounts → Phone Numbers.')
      }
      phone_number_id = firstPhone.id
      console.log(`[connect-waba] discovery mode: WABA=${waba_id} phone=${phone_number_id}`)
    }

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

    // Resolve slug and link to existing tenant row.
    // 1. Look for an existing tenant row for this user where waba_id is null (Step 1 profile setup)
    const { data: existingNullWaba } = await supabase.from('tenants')
      .select('id, slug, business_name')
      .eq('user_id', user.id)
      .is('waba_id', null)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()

    // 2. Look for an existing tenant with this waba_id (reconnect flow)
    const { data: existingForWaba } = await supabase.from('tenants')
      .select('id, slug, business_name')
      .eq('waba_id', waba_id)
      .maybeSingle()

    // 3. Fall back to ANY active tenant owned by this user. Important when
    // the user is reconnecting to a DIFFERENT WABA than their existing
    // tenant has — without this lookup the upsert would create a parallel
    // tenant, orphaning the original's flows/templates/contacts. We update
    // the existing tenant with the new waba_id instead.
    let existingForUser: { id: string; slug: string; business_name: string | null } | null = null
    if (!existingForWaba && !existingNullWaba) {
      const { data } = await supabase.from('tenants')
        .select('id, slug, business_name')
        .eq('user_id', user.id)
        .eq('status', 'active')
        .order('created_at', { ascending: true })  // oldest = original
        .limit(1)
        .maybeSingle()
      existingForUser = data
    }

    const targetId = existingForWaba?.id ?? existingNullWaba?.id ?? existingForUser?.id
    const businessName = wabaData.name ?? phoneData.verified_name ?? 'My Business'

    let slugToWrite = existingForWaba?.slug ?? existingNullWaba?.slug ?? existingForUser?.slug ?? undefined
    if (!slugToWrite) {
      const { ensureUniqueSlug } = await import('./lib/slug')
      slugToWrite = await ensureUniqueSlug(supabase, businessName, user.id)
    }

    // Upsert tenant row using primary key 'id' if resolved to keep Step 1 and Step 2 linked.
    // Otherwise upsert by waba_id.
    const upsertPayload: any = {
      user_id: user.id,
      waba_id,
      phone_number_id,
      access_token: longToken,
      business_name: existingNullWaba?.business_name ?? businessName,
      slug: slugToWrite,
      display_phone: phoneData.display_phone_number,
      status: 'active',
      updated_at: new Date().toISOString(),
    }
    if (targetId) {
      upsertPayload.id = targetId
    }

    const { data, error } = await supabase.from('tenants').upsert(
      upsertPayload,
      targetId ? {} : { onConflict: 'waba_id' }
    ).select().single()

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

    // Auto-trigger a destructive template sync so the picker reflects what's
    // actually on the newly-connected WABA. Without this, a tenant that
    // switches WABAs (or reconnects with different credentials) keeps the
    // OLD WABA's templates in their picker — clicking them then fails with
    // Meta's #132001 "Template name does not exist in the translation"
    // because they're not registered on the new WABA. Self-healing here
    // beats relying on the 15-min cron tick + operator-initiated refresh.
    //
    // Errors are non-fatal — connect-waba already succeeded; sync failure
    // is just an "out-of-date templates" problem the cron will eventually
    // pick up. Logged so we have a trail when it does fail.
    try {
      const sync = await syncTenantTemplates(data as any)
      console.log(`[connect-waba] auto-sync tenant=${data.id} fetched=${sync.fetched} updated=${sync.updated} deleted=${sync.deleted}`)
    } catch (syncErr: any) {
      console.warn(`[connect-waba] auto-sync failed tenant=${data.id}: ${syncErr?.message ?? syncErr}`)
    }

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
    return {
      id: t.id,
      name: t.name,
      status: t.status?.toUpperCase() ?? 'DRAFT',
      category: t.category?.toUpperCase() ?? 'MARKETING',
      language: t.language ?? 'en',
      components,
      // Also expose the flat columns so the inbox / composer preview can
      // render a WhatsApp-style template card without re-parsing the
      // components array client-side. components[] stays for any caller
      // that needs Meta's canonical shape; both views are kept in sync
      // by the template-sync worker.
      body:    t.body ?? null,
      header:  t.header ?? null,
      footer:  t.footer ?? null,
      buttons: t.buttons ?? [],
      // Surfaced on the WATemplatesPage rejection-state banner — when Meta
      // rejects a template, the rejected_reason field is what the user
      // needs to understand what to change. Null when status != rejected
      // or for templates created before the rejection_reason column.
      rejection_reason: t.rejection_reason ?? null,
      // Category-change diff (template-sync worker stamps these when Meta
      // reclassifies the template). The wedge-surface banner reads them.
      previous_category:   t.previous_category ?? null,
      category_changed_at: t.category_changed_at ?? null,
    }
  })

  res.json(formatted)
})

app.post('/api/wa-templates', requireAuth, identifyTenant, checkPermission('whatsapp_automation', 'edit'), async (req, res) => {
  const tenantId = (req as any).tenantId
  const { data: tenant } = await supabase.from('tenants').select('*').eq('id', tenantId).maybeSingle()
  if (!tenant?.waba_id) { res.status(404).json({ error: 'No connected WhatsApp account' }); return }

  // Accept TWO payload shapes:
  //   1. Full Meta shape:  { name, category, language, components: [...] }
  //   2. Legacy short:     { name, category, language, body, buttons: string[] }
  // (1) is what the new FE composer sends — preserves header/footer/
  // media headers/URL+phone+copy_code buttons. (2) is the original
  // body-only shape; kept for back-compat with older callers.
  const { name, category = 'MARKETING', language = 'en_US', body, buttons = [], components: providedComponents } = req.body
  if (!name) { res.status(400).json({ error: 'name required' }); return }

  let components: any[]
  if (Array.isArray(providedComponents) && providedComponents.length > 0) {
    components = providedComponents
  } else {
    if (!body) { res.status(400).json({ error: 'body or components required' }); return }
    components = [{ type: 'BODY', text: String(body) }]
    if (Array.isArray(buttons) && buttons.length > 0) {
      components.push({
        type: 'BUTTONS',
        buttons: buttons.map((btn: any) => typeof btn === 'string'
          ? { type: 'QUICK_REPLY', text: btn }
          : btn),
      })
    }
  }

  try {
    const r = await fetch(`${GRAPH}/${tenant.waba_id}/message_templates`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tenant.access_token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, language, category, components })
    })
    const data = await r.json() as any
    if (!r.ok || data.error) {
      res.status(400).json({ error: data.error?.message ?? `Meta create failed (${r.status})` })
      return
    }
    // Insert into wa_templates immediately so the new row is visible in
    // the inbox composer picker without waiting up to 15min for the next
    // template-sync run. Status comes from Meta's response if present,
    // otherwise 'pending' (most CREATE responses don't include status —
    // Meta sets it asynchronously after their internal review).
    const { parseComponents } = await import('./lib/wa-components')
    const parsed = parseComponents(components)
    await supabase.from('wa_templates').upsert({
      tenant_id:  tenantId,
      user_id:    tenant.user_id ?? null,
      name,
      language,
      category:   String(category).toLowerCase(),
      status:     String(data.status ?? 'pending').toLowerCase(),
      meta_template_id: data.id ?? null,
      body:    parsed.body,
      header:  parsed.header,
      footer:  parsed.footer,
      buttons: parsed.buttons,
      last_synced_at: new Date().toISOString(),
    }, { onConflict: 'tenant_id,name,language' }).then(() => {}, e => console.warn('[wa-templates create] DB upsert non-fatal:', e?.message))

    res.json({ id: data.id, status: data.status ?? 'pending', name, language, category })
  } catch (err: any) { res.status(500).json({ error: err.message }) }
})

app.delete('/api/wa-templates/:name', requireAuth, identifyTenant, checkPermission('whatsapp_automation', 'delete'), async (req, res) => {
  const tenantId = (req as any).tenantId
  const { data: tenant } = await supabase.from('tenants').select('*').eq('id', tenantId).maybeSingle()
  if (!tenant?.waba_id || !tenant?.access_token) {
    res.status(404).json({ error: 'No connected WhatsApp account' })
    return
  }

  // Defense-in-depth: Meta Graph occasionally returns non-JSON (HTML error
  // pages from upstream LB / Cloudflare) for bad creds or rate-limit
  // pressure. Coerce any parse failure to a clean 400 with the raw body
  // truncated, rather than bubbling a 500 to the client.
  try {
    const r = await fetch(
      `${GRAPH}/${tenant.waba_id}/message_templates?name=${encodeURIComponent(String(req.params.name ?? ''))}`,
      { method: 'DELETE', headers: { Authorization: `Bearer ${tenant.access_token}` } }
    )
    const text = await r.text().catch(() => '')
    let data: any = null
    try { data = text ? JSON.parse(text) : null } catch { /* non-JSON below */ }
    if (!r.ok || data?.error) {
      const msg = data?.error?.message ?? text.slice(0, 200) ?? `Meta Graph returned ${r.status}`
      res.status(400).json({ error: msg, upstream_status: r.status })
      return
    }
    res.json({ success: true })
  } catch (err: any) {
    // Network/fetch error → 502 (bad gateway) is more accurate than 500.
    res.status(502).json({ error: `Meta Graph unreachable: ${err?.message ?? 'unknown'}` })
  }
})

// ── Force-resync templates against the currently connected WABA ──────────────
// Triggers an immediate, destructive template sync for the calling tenant.
// "Destructive" = templates we have locally that Meta no longer returns get
// DELETED. This is what makes the picker self-heal after a WABA switch:
// without this, the 103 templates the tenant synced on WABA A stay in the
// table forever, even after switching to WABA B which has none of them →
// every send fails with #132001.
//
// Called by:
//   - FE "Refresh templates" button on /apps WhatsApp
//   - The connect-waba flow itself (auto-trigger after a successful
//     reconnect) so the picker reflects the new WABA without operator
//     action.
app.post('/api/wa-templates/sync', requireAuth, identifyTenant, checkPermission('whatsapp_automation', 'edit'), async (req, res) => {
  const tenantId = (req as any).tenantId
  const { data: tenant, error: tErr } = await supabase
    .from('tenants')
    .select('id, waba_id, access_token, user_id')
    .eq('id', tenantId)
    .maybeSingle()
  if (tErr) { res.status(500).json({ error: tErr.message }); return }
  if (!tenant?.waba_id || !tenant?.access_token) {
    res.status(404).json({ error: 'No connected WhatsApp account' })
    return
  }
  try {
    const result = await syncTenantTemplates(tenant as any)
    res.json({ success: true, ...result })
  } catch (err: any) {
    // Meta API errors here are usually token/permission issues, not network
    // — surface them so the operator can react (e.g. re-connect WABA).
    res.status(502).json({ error: `Template sync failed: ${err?.message ?? 'unknown'}` })
  }
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
  // P1 #18: if segment_id is supplied, validate that the segment belongs
  // to this tenant before we link it. Defense-in-depth — RLS would block
  // a stranger's segment from being readable anyway, but a 400 here is a
  // cleaner failure mode than a downstream resolve-zero-contacts.
  const incoming = req.body as any
  if (incoming.segment_id) {
    const { data: seg, error: segErr } = await supabase.from('contact_segments')
      .select('id').eq('id', incoming.segment_id).eq('tenant_id', tenantId)
      .is('archived_at', null).maybeSingle()
    if (segErr) { res.status(500).json({ error: segErr.message }); return }
    if (!seg) {
      res.status(400).json({ error: 'segment_id does not belong to this tenant (or is archived)' })
      return
    }
  }
  const { data, error } = await supabase.from('broadcasts')
    .insert({ ...req.body, tenant_id: tenantId }).select().single()
  if (error) { res.status((error as any).code === 'PGRST116' ? 404 : 500).json({ error: (error as any).code === 'PGRST116' ? 'not found' : error.message }); return }
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

  if (error) { res.status((error as any).code === 'PGRST116' ? 404 : 500).json({ error: (error as any).code === 'PGRST116' ? 'not found' : error.message }); return }
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
  if (error) { res.status((error as any).code === 'PGRST116' ? 404 : 500).json({ error: (error as any).code === 'PGRST116' ? 'not found' : error.message }); return }
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
  const userRoleKey = (req as any).userRoleKey as string | undefined
  const phone = decodeURIComponent(req.params.phone as string).replace(/^\+/, '')
  const { data, error } = await supabase.from('messages')
    .select('*').eq('tenant_id', tenantId)
    .eq('contact_phone', phone)
    .order('created_at', { ascending: true })
    .limit(100)
  if (error) { res.status(500).json({ error: error.message }); return }

  // Phase 1B — PII masking pass.
  //
  // The caller's role decides whether to apply masking. The tenant's
  // config decides WHICH field families. We mask message bodies in
  // the JSONB `content` column WITHOUT mutating the stored row (only
  // the response payload is masked; storage stays plaintext for DSR
  // / GDPR / audit accuracy).
  //
  // Each masked message gets an extra `_pii_fields` array with the
  // detected field spans (start, end, field_index, value_hash). The
  // FE uses field_index to request unmask of a SPECIFIC field via
  // POST /api/pii/unmask without sending the original value over.
  try {
    const { getTenantPiiConfig, maskMessageForRole } = await import('./routes/pii')
    const cfg = await getTenantPiiConfig(supabase, tenantId)
    const masked = (data ?? []).map((row: any) => {
      // Pull the text body from common JSONB shapes; media-only messages
      // have nothing to mask.
      const content = row.content
      let text: string = ''
      if (typeof content === 'string') {
        text = content
      } else if (content && typeof content === 'object') {
        if (typeof content.text === 'string') text = content.text
        else if (typeof content.body === 'string') text = content.body
        else if (content.type === 'interactive' && content?.interactive?.body?.text) text = content.interactive.body.text
        else if (content.caption) text = String(content.caption)
      }
      if (!text) return row

      const r = maskMessageForRole(text, cfg, userRoleKey ?? null)
      if (!r.masked) return row

      // Write the masked text back into the shape it came from (immutable
      // copy — never mutate the DB row).
      const nextContent: any = (typeof content === 'object' && content !== null) ? { ...content } : { type: 'text', text: r.text }
      if (typeof content === 'string') {
        // Older shape: store as same-string-shape (FE only reads .text/.body anyway).
        return { ...row, content: r.text, _pii_fields: r.fields, _pii_source: text }
      }
      if (typeof nextContent.text === 'string')    nextContent.text = r.text
      else if (typeof nextContent.body === 'string') nextContent.body = r.text
      else if (nextContent?.interactive?.body?.text) nextContent.interactive = { ...nextContent.interactive, body: { ...nextContent.interactive.body, text: r.text } }
      else if (typeof nextContent.caption === 'string') nextContent.caption = r.text
      // `_pii_source` is the original text (server-side use only — passed
      // back to /api/pii/unmask so the BE can re-detect and reveal the
      // value at a specific field_index). We send it to the FE because:
      //   (a) the FE already has it via the DB row if the BE didn't mask
      //   (b) we need to round-trip it to unmask; the BE doesn't cache it
      //   (c) it doesn't leak anything the FE doesn't already see when
      //       unmasking — and unmasking is audit-logged
      // Field-by-field disclosure is still gated by the unmask endpoint.
      return { ...row, content: nextContent, _pii_fields: r.fields, _pii_source: text }
    })
    res.json(masked)
    return
  } catch (e: any) {
    // PII masking failure is HARD — refuse to serve the raw messages.
    // Better to break the inbox than leak unmasked PII to an agent who
    // shouldn't see it. Surface a clear 500 + log.
    console.error('[inbox.messages] PII masking failed — refusing to serve:', e?.message ?? e)
    res.status(500).json({ error: 'PII policy unavailable; inbox temporarily disabled' })
    return
  }
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
      reply_to_platform_message_id,
    } = req.body
    // Normalise phone for the channel:
    //   - WhatsApp / SMS: strip leading "+" → digits only ("919876543210").
    //   - Telegram     : the FE composer passes `contact.phone` which is
    //                    prefixed with "tg:" (e.g. "tg:7797429783"). The
    //                    Telegram Bot API expects a NUMERIC chat_id —
    //                    "tg:" makes the sendMessage call fail with a
    //                    400. Strip both the "+" and any "tg:" prefix
    //                    so the same outbound path works regardless of
    //                    which identifier shape the FE handed us.
    //   - Instagram    : raw PSID, no prefix.
    const cleanPhone = String(phone).replace(/^\+/, '').replace(/^tg:/i, '')

    // v1.1 audit fix — outbound PII gate.
    //
    // Scan the outbound body (text / caption / interactive body) against
    // the tenant's enabled PII detectors. Behaviour per
    // pii_masking_config.outbound_action:
    //   off   → skip (legacy behaviour)
    //   warn  → still send, but include `pii_warning` in the response so
    //           the FE can chip the sent message and prompt the agent to
    //           verify before similar sends in the future
    //   block → 400 with the detected-field metadata so the agent knows
    //           which span to remove before retrying
    //
    // Bypass on explicit override header `x-pii-override-reason` — caller
    // takes audit responsibility for the send. Reason is logged.
    let piiWarning: { hits: any[] } | null = null
    try {
      const outboundText: string =
        (typeof text === 'string' && text) ||
        (typeof caption === 'string' && caption) ||
        (interactive?.body?.text && String(interactive.body.text)) ||
        ''
      if (outboundText) {
        const { getTenantPiiConfig, detectOutboundPii } = await import('./routes/pii')
        const cfg = await getTenantPiiConfig(supabase, tenantId)
        const { hits, action } = detectOutboundPii(outboundText, cfg)
        if (hits.length > 0) {
          const overrideReason = req.header('x-pii-override-reason')
          if (action === 'block' && !overrideReason) {
            return {
              status: 400,
              body: {
                error: 'pii_outbound_blocked',
                detected_fields: hits.map(h => ({ field_type: h.field_type, start: h.start, end: h.end })),
                hint: 'Remove the highlighted fields and resend. Pass x-pii-override-reason header to bypass (audit-logged).',
              },
            }
          }
          // Warn path OR block-with-override — record alert so audit
          // can show "the agent was warned about Aadhaar in this msg".
          await supabase.from('audit_log').insert({
            tenant_id: tenantId,
            actor_user_id: (req as any).user?.id ?? null,
            event_type: 'pii_outbound_alert',
            payload: {
              channel,
              recipient_phone: cleanPhone,
              detected: hits.map(h => ({ field_type: h.field_type, value_hash: h.value_hash })),
              action,
              override_reason: overrideReason ?? null,
            },
          }).then(() => {}, () => {}) // best-effort; audit_log may not exist on older tenants
          piiWarning = { hits: hits.map(h => ({ field_type: h.field_type, start: h.start, end: h.end })) }
        }
      }
    } catch (e: any) {
      // PII check failure must NEVER prevent a send — we already had a
      // hard-fail on inbound PII (refusal). Outbound is best-effort.
      // eslint-disable-next-line no-console
      console.warn('[inbox.send] pii outbound check failed', e?.message ?? e)
    }

    try {
      if (channel === 'whatsapp') {
        const { data: tenant } = await supabase.from('tenants').select('*').eq('id', tenantId).single()
        if (!tenant?.access_token) return { status: 404, body: { error: 'WhatsApp not connected for this tenant' } }
        if (type === 'text')              await sendTextMessage(tenant, cleanPhone, text, reply_to_platform_message_id ?? null)
        else if (type === 'template')     await sendTemplateMessage(tenant, cleanPhone, template_name, template_language ?? 'en_US', template_params ?? [])
        else if (type === 'media')        await sendWAMedia(tenant, cleanPhone, media_kind, media_url, caption, filename)
        else if (type === 'interactive')  await sendInteractiveMessage(tenant, cleanPhone, interactive)
      } else if (channel === 'telegram') {
        const { data: bot } = await supabase.from('tg_bots').select('*').eq('tenant_id', tenantId).maybeSingle()
        if (!bot?.bot_token) return { status: 404, body: { error: 'Telegram bot not connected for this tenant' } }
        const { decrypt } = await import('./crypto')
        const token = decrypt(bot.bot_token)
        if (type === 'text') {
          // Capture Telegram's message_id so inbound reactions can resolve
          // the parent row. Without this, a user tapping ❤️ on the bot's
          // message hits our webhook, we lookup by platform_message_id —
          // but the row was inserted with NULL because we discarded the
          // tgSend response. Reaction silently dropped, inbox never updates.
          const sendRes = await tgSend(token, 'sendMessage', { chat_id: cleanPhone, text })
          const pmid = sendRes?.result?.message_id ? String(sendRes.result.message_id) : null
          await supabase.from('messages').insert({
            tenant_id: tenantId, channel: 'telegram', direction: 'outbound',
            contact_phone: cleanPhone, content: { type: 'text', text },
            platform_message_id: pmid, status: 'sent',
          })
        } else if (type === 'media') {
          const method = ({ image: 'sendPhoto', video: 'sendVideo', audio: 'sendAudio', document: 'sendDocument' } as any)[media_kind!]
          const fieldKey = ({ image: 'photo', video: 'video', audio: 'audio', document: 'document' } as any)[media_kind!]
          const sendRes = await tgSend(token, method, { chat_id: cleanPhone, [fieldKey]: media_url, caption: caption ?? undefined })
          const pmid = sendRes?.result?.message_id ? String(sendRes.result.message_id) : null
          await supabase.from('messages').insert({
            tenant_id: tenantId, channel: 'telegram', direction: 'outbound',
            contact_phone: cleanPhone, content: { type: media_kind, url: media_url, caption, filename },
            platform_message_id: pmid, status: 'sent',
          })
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
      return { status: 200, body: { success: true, ...(piiWarning ? { pii_warning: piiWarning } : {}) } }
    } catch (err: any) {
      return { status: 500, body: { error: err.message } }
    }
  })
})

// ──────────────────────────────────────────────────────────────────────────
// POST /api/inbox/react — emoji-react to a specific message (migration 127)
//
// FE passes the LOCAL messages.id (uuid). We resolve the parent's
// platform_message_id under RLS, then send Meta a `type: 'reaction'`
// payload. Empty emoji means un-react (Meta's contract).
//
// WhatsApp-only today. Instagram has a similar reaction API but with
// different shape — wiring that in is left to a follow-up so we don't
// silently send the wrong payload shape on the wrong channel.
// ──────────────────────────────────────────────────────────────────────────
app.post('/api/inbox/react', requireAuth, identifyTenant, checkPermission('inbox', 'edit'), validateBody(InboxReactSchema), async (req, res) => {
  const tenantId = (req as any).tenantId
  const { message_id, emoji } = req.body as { message_id: string; emoji: string }

  // Lookup parent message under tenant scope. anon-key client wouldn't
  // pass RLS, but we use the service-role `supabase` here — so we
  // enforce the tenant boundary explicitly in the WHERE clause.
  const { data: parent } = await supabase
    .from('messages')
    .select('id, tenant_id, channel, contact_phone, platform_message_id')
    .eq('id', message_id)
    .eq('tenant_id', tenantId)
    .maybeSingle()
  if (!parent) {
    res.status(404).json({ error: 'message not found' }); return
  }
  if (parent.channel !== 'whatsapp' && parent.channel !== 'telegram') {
    res.status(400).json({ error: `reactions not supported on channel: ${parent.channel}` }); return
  }
  if (!parent.platform_message_id) {
    res.status(400).json({ error: 'parent message has no platform_message_id (was it sent?)' }); return
  }

  // Telegram branch — bot reacts to the user's message via setMessageReaction.
  // Empty emoji = un-react (Telegram contract: send empty `reaction` array).
  // chat_id is the contact_phone we stored on the parent row (raw chat id,
  // no "tg:" prefix). Telegram supports only a fixed list of emoji for
  // free accounts; our 6-pack (👍 ❤️ 😂 😮 😢 🙏) is in the standard set
  // so all toolbar taps are valid.
  if (parent.channel === 'telegram') {
    const { data: bot } = await supabase.from('tg_bots').select('bot_token').eq('tenant_id', tenantId).maybeSingle()
    if (!bot?.bot_token) {
      res.status(404).json({ error: 'Telegram bot not connected for this tenant' }); return
    }
    const { decrypt } = await import('./crypto')
    const token = decrypt(bot.bot_token)
    const chatId = String(parent.contact_phone).replace(/^tg:/i, '')
    const reaction = emoji === '' ? [] : [{ type: 'emoji', emoji }]
    try {
      const r = await fetch(`https://api.telegram.org/bot${token}/setMessageReaction`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          message_id: Number(parent.platform_message_id),
          reaction,
        }),
      })
      const data = await r.json() as any
      if (!r.ok || !data.ok) {
        res.status(502).json({ error: data?.description ?? `TG reaction failed (${r.status})` }); return
      }
      if (emoji === '') {
        await supabase.from('message_reactions')
          .delete()
          .eq('message_id', parent.id)
          .eq('contact_phone', parent.contact_phone)
          .eq('direction', 'outbound')
      } else {
        await supabase.from('message_reactions').upsert({
          tenant_id:     tenantId,
          message_id:    parent.id,
          contact_phone: parent.contact_phone,
          direction:     'outbound',
          emoji,
        }, { onConflict: 'message_id,contact_phone,direction' })
      }
      res.json({ success: true })
      return
    } catch (err: any) {
      res.status(500).json({ error: err.message }); return
    }
  }

  // WhatsApp branch (unchanged)
  const { data: tenant } = await supabase.from('tenants').select('*').eq('id', tenantId).single()
  if (!tenant?.access_token) {
    res.status(404).json({ error: 'WhatsApp not connected for this tenant' }); return
  }

  // Call Meta. Empty emoji = un-react. Both shapes use the same endpoint.
  const payload = {
    messaging_product: 'whatsapp',
    to: String(parent.contact_phone).replace(/^\+/, ''),
    type: 'reaction',
    reaction: { message_id: parent.platform_message_id, emoji },
  }
  try {
    const r = await fetch(`${GRAPH}/${tenant.phone_number_id}/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tenant.access_token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
    const data = await r.json() as any
    if (!r.ok || data.error) {
      const detail = mapMetaError(data, `WA reaction failed (${r.status})`)
      res.status(502).json({ error: detail }); return
    }
    const platformReactionId: string | undefined = data.messages?.[0]?.id

    // Persist locally. Outbound reaction always carries the AGENT's
    // tenant identity; contact_phone is whose conversation we're
    // reacting in (the customer). emoji='' deletes the row to mirror
    // Meta's un-react semantics.
    if (emoji === '') {
      await supabase.from('message_reactions')
        .delete()
        .eq('message_id', parent.id)
        .eq('contact_phone', parent.contact_phone)
        .eq('direction', 'outbound')
    } else {
      await supabase.from('message_reactions').upsert({
        tenant_id:            tenantId,
        message_id:           parent.id,
        contact_phone:        parent.contact_phone,
        direction:            'outbound',
        emoji,
        platform_reaction_id: platformReactionId ?? null,
      }, { onConflict: 'message_id,contact_phone,direction' })
    }
    res.json({ success: true })
  } catch (err: any) {
    res.status(500).json({ error: err.message })
  }
})

/**
 * Map a Meta Cloud API error response to an operator-actionable string.
 *
 * Meta's raw error messages frequently obscure the actual fix the tenant
 * needs to take. The biggest offender is `(#200) You do not have the
 * necessary permissions to send messages on behalf of this WhatsApp
 * Business Account` — this is what Meta returns when the access_token
 * is a USER token (issued via Embedded Signup) rather than a System
 * User token. User tokens carry `whatsapp_business_messaging` scope at
 * the user level but NOT bound to a specific WABA, so messaging API
 * calls are rejected. The only fix is for the tenant to generate a
 * System User permanent token in business.facebook.com → Business
 * Settings → System Users, assign the WABA to the system user, and
 * paste the new token via the manual /apps WhatsApp connect form.
 */
function mapMetaError(data: any, fallback: string): string {
  const code = data?.error?.code
  const sub = data?.error?.error_subcode
  const raw = data?.error?.message ?? ''
  // #200 + "necessary permissions" → user-token-vs-system-token issue.
  if (code === 200 && /necessary permissions/i.test(raw)) {
    return 'Meta rejected the send: this connection is using a personal user token, not a System User token. ' +
           'Go to business.facebook.com → Business Settings → Users → System Users → create one + assign the WABA + ' +
           'generate a permanent access_token with whatsapp_business_messaging, then re-connect via /apps WhatsApp → ' +
           '"Use a token instead". (Meta: ' + raw + ')'
  }
  // 131009 — parameter invalid (often phone number not in test-recipient list while app in Dev mode)
  if (code === 131009 || sub === 2494010) {
    return `Recipient not allowed: ${raw}. While the Meta app is in Development mode, only phone numbers added under App Roles → Testers can receive messages.`
  }
  // 131047 — outside 24h customer service window (need an approved template)
  if (code === 131047) {
    return `Outside 24h session window: ${raw}. Free-form text can only be sent within 24h of the customer's last inbound. Send an approved template instead.`
  }
  // 131049 — marketing template frequency capping (real ecosystem signal)
  if (code === 131049) {
    return `Marketing template throttled by Meta: ${raw}. Send a UTILITY template (or wait for the recipient's marketing-engagement window to reset).`
  }
  // 131005 — "Access denied" on a successful template flow.
  //   Meta returns this when the token has whatsapp_business_messaging
  //   granted but WITHOUT a target_ids binding to the specific WABA, so
  //   templates (which travel through whatsapp_business_management — the
  //   scope WITH target_ids) succeed, but free-form text fails. Common
  //   on manually-issued 24h temp tokens. Embedded Signup tokens get the
  //   binding automatically; System User tokens get it via the assigned-
  //   asset list. Surface this clearly so the operator doesn't chase a
  //   "session window expired" rabbit hole.
  if (code === 131005) {
    return `Meta rejected the text send: token lacks whatsapp_business_messaging binding to this WABA. ` +
           `Templates may still work (they route through whatsapp_business_management). ` +
           `To enable free-form text replies, either (a) reconnect WhatsApp via Embedded Signup so the new ` +
           `token gets WABA-bound messaging permission, or (b) generate a System User access token from ` +
           `business.facebook.com → Business Settings → Users → System Users with the WABA assigned. ` +
           `(Meta: ${raw})`
  }
  // 132001 — "Template name does not exist in the translation".
  // This fires when the template name+language combo isn't registered on
  // the WABA we're sending FROM. Two common causes:
  //   1. The tenant's connected WABA differs from the one the template was
  //      created on (e.g. tenant switched between Meta's test WABA and the
  //      real one — our wa_templates rows are from the OTHER WABA).
  //   2. The language code on the template row doesn't match what's
  //      registered on Meta (`en` vs `en_US` mismatch — Meta treats them
  //      as separate translations).
  // Both are operator-config issues, not retryable; surface them clearly
  // so the operator knows to either re-create the template on this WABA
  // or pick the right language.
  if (code === 132001) {
    return `Template not on this WhatsApp Business Account: ${raw}. ` +
           `The template name + language must be registered on the WABA you're sending from. ` +
           `Check: (a) the connected WABA matches the one the template was created on, ` +
           `and (b) the language code matches Meta's registration ('en' vs 'en_US' are different translations). ` +
           `Sync templates from /apps WhatsApp → Refresh.`
  }
  return raw ? `${raw}${sub ? ` (subcode ${sub})` : ''}` : fallback
}

// WhatsApp Cloud API media send — image / video / audio / document.
async function sendWAMedia(tenant: any, to: string, kind: 'image'|'video'|'audio'|'document', url: string, caption?: string | null, filename?: string) {
  const payload: any = { messaging_product: 'whatsapp', to, type: kind }
  payload[kind] = { link: url }
  if (caption && (kind === 'image' || kind === 'video' || kind === 'document')) payload[kind].caption = caption
  if (filename && kind === 'document') payload[kind].filename = filename
  // Pre-insert (see sendTextMessage for race-fix rationale).
  const { data: row } = await supabase.from('messages').insert({
    tenant_id: tenant.id, channel: 'whatsapp', direction: 'outbound',
    contact_phone: to, content: payload, status: 'queued',
  }).select('id').single()

  const r = await fetch(`${GRAPH}/${tenant.phone_number_id}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${tenant.access_token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
  const data = await r.json() as any
  if (!r.ok || data.error) {
    const detail = mapMetaError(data, `WA media send failed (${r.status})`)
    if (row?.id) {
      await supabase.from('messages').update({
        status: 'failed', content: { ...payload, error: detail },
      }).eq('id', row.id)
    }
    throw new Error(detail)
  }
  if (row?.id && data.messages?.[0]?.id) {
    await supabase.from('messages').update({
      platform_message_id: data.messages[0].id, status: 'sent',
    }).eq('id', row.id)
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
  if (error) { res.status((error as any).code === 'PGRST116' ? 404 : 500).json({ error: (error as any).code === 'PGRST116' ? 'not found' : error.message }); return }
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
  const { name, description, tags, workflow_json } = req.body ?? {}
  // Defensive validation — name + workflow_json are NOT NULL on
  // workflow_skills; without these the insert 500s on the DB constraint.
  if (typeof name !== 'string' || name.trim().length === 0) {
    res.status(400).json({ error: 'name is required' })
    return
  }
  if (!workflow_json || typeof workflow_json !== 'object') {
    res.status(400).json({ error: 'workflow_json is required (object)' })
    return
  }
  const { data, error } = await supabase.from('workflow_skills')
    .insert({
      tenant_id: tenantId,
      user_id: user.id,           // attribution only — scope is tenant_id
      name, description, tags: tags ?? [], workflow_json,
      is_global: false,
    })
    .select().single()
  if (error) { res.status((error as any).code === 'PGRST116' ? 404 : 500).json({ error: (error as any).code === 'PGRST116' ? 'not found' : error.message }); return }
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

  // ── Webhook queue handoff (migration 064) ────────────────────────────
  // With WEBHOOK_QUEUE_ENABLED=1 the route enqueues the verified payload
  // and ACKs immediately. The worker (workers/webhook-retry.ts) does the
  // DB writes with 5-attempt exponential backoff + DLQ. Default OFF so
  // existing behaviour is preserved until we flip the switch in prod.
  if (process.env.WEBHOOK_QUEUE_ENABLED === '1') {
    try {
      const { enqueueWebhookInbound } = await import('./queue')
      await enqueueWebhookInbound({
        source:     'meta_whatsapp',
        rawBodyB64: rawBody.toString('base64'),
        receivedAt: new Date().toISOString(),
      })
      res.sendStatus(200)
      return
    } catch (e: any) {
      // Redis down → fall through to inline path so we don't lose the
      // delivery. Meta retries on >2s timeout, so the failover is the
      // safer default vs returning 5xx.
      console.warn(`[wa-webhook] queue enqueue failed, running inline: ${e?.message ?? e}`)
    }
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
        // Monotonic status precedence — higher wins. Webhook order isn't
        // guaranteed (delivered can arrive after read in rare cases), so
        // we read the current status and only overwrite when the new
        // value is strictly forward. `failed` is terminal — once set,
        // never revert. Also persists Meta error payload onto content
        // so the operator can see WHY delivery failed (P2-16).
        const RANK: Record<string, number> = {
          queued: 0, sent: 1, delivered: 2, read: 3, failed: 4,
        }
        for (const status of value.statuses ?? []) {
          if (status.status === 'failed') {
            console.error(`[webhook] STATUS FAILED platform_message_id=${status.id} errors=${JSON.stringify(status.errors)}`)
          }
          // Race fix: Meta's webhook can arrive in the brief window between
          // the outbound send-call returning and our post-fetch PATCH
          // landing. Retry once after 500ms before declaring orphan.
          const tryApply = async () => {
            const { data: rows } = await supabase
              .from('messages')
              .select('id, status, content')
              .eq('platform_message_id', status.id)
              .eq('tenant_id', tenant.id)
              .limit(1)
            if (!rows || rows.length === 0) return { matched: 0 }
            const row = rows[0] as any
            const currentRank = RANK[row.status ?? 'queued'] ?? 0
            const incoming    = RANK[status.status]         ?? 0
            // Monotonic forward — never downgrade. `failed` is sticky.
            if (incoming <= currentRank && row.status !== 'failed') {
              return { matched: 1, skipped: true }
            }
            const update: any = { status: status.status }
            if (status.status === 'failed' && status.errors?.length) {
              // Merge Meta error metadata into existing content (don't
              // wipe payload). content.errors is what the inbox tooltip
              // reads to render the Meta reason next to the red icon.
              update.content = {
                ...(row.content ?? {}),
                errors: status.errors,
                error: status.errors?.[0]?.message ?? status.errors?.[0]?.title ?? 'Delivery failed',
              }
            }
            const { error: upErr } = await supabase.from('messages')
              .update(update)
              .eq('id', row.id)
            return { matched: 1, skipped: false, error: upErr }
          }
          let result = await tryApply()
          if (result.matched === 0) {
            await new Promise(r => setTimeout(r, 500))
            result = await tryApply()
          }
          if (result.matched === 0) {
            console.warn(`[webhook] status update orphan tenant=${tenant.id} msg=${status.id} status=${status.status} — outbound row not found after retry`)
          } else if ((result as any).error) {
            console.error(`[webhook] status update failed tenant=${tenant.id} msg=${status.id}:`, (result as any).error?.message)
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

  // ── Reactions (migration 127) ──────────────────────────────────────────
  // A reaction is NOT a message. Persisting it as a row in `messages`
  // would distort unread counts, workflow triggers, analytics, and
  // conversation "latest text" rendering — exactly the bug wacrm 0.1.1
  // fixed in their codebase. Branch early: write to message_reactions,
  // skip the rest of the inbound pipeline (no workflow re-trigger, no
  // CTWA attribution — those already fired on the parent message).
  if (msg.type === 'reaction' && msg.reaction?.message_id) {
    const parentWamid = msg.reaction.message_id as string
    const emoji       = String(msg.reaction.emoji ?? '')
    const { data: parent } = await supabase
      .from('messages')
      .select('id')
      .eq('tenant_id', tenant.id)
      .eq('platform_message_id', parentWamid)
      .limit(1)
      .maybeSingle()
    if (!parent) {
      console.warn(`[wa-webhook] reaction parent not found tenant=${tenant.id} parent_wamid=${parentWamid}`)
      return
    }
    if (emoji === '') {
      // Meta sends emoji='' to un-react. Mirror by deleting our row.
      await supabase.from('message_reactions')
        .delete()
        .eq('message_id', parent.id)
        .eq('contact_phone', phone)
        .eq('direction', 'inbound')
    } else {
      await supabase.from('message_reactions').upsert({
        tenant_id:            tenant.id,
        message_id:           parent.id,
        contact_phone:        phone,
        direction:            'inbound',
        emoji,
        platform_reaction_id: msg.id ?? null,
      }, { onConflict: 'message_id,contact_phone,direction' })
    }
    return
  }

  // Reply-to context (migration 127). When the customer taps "Reply" on
  // a previous message, Meta attaches `context.id` = the parent wamid.
  // We store it as text — the UI joins client-side against the loaded
  // message set, falling back to "(message)" if the parent isn't loaded.
  const replyToPlatformMessageId: string | null = msg.context?.id ?? null

  // UPSERT (was INSERT) so Meta's aggressive retry policy can't produce
  // duplicate inbound rows. Meta retries any webhook that returns >5s
  // OR that they can't reach — under any handler stall, the same
  // platform_message_id is delivered N times. Without ON CONFLICT,
  // those N inserts ALL succeed → duplicate inbox rows → duplicate
  // workflow triggers → duplicate auto-replies. The unique partial
  // index `messages_tenant_platform_id` (migration 122) backs this.
  const { error: insertErr } = await supabase.from('messages').upsert({
    tenant_id: tenant.id,
    channel: 'whatsapp',
    direction: 'inbound',
    contact_phone: phone,
    platform_message_id: msg.id,
    content: msg,
    reply_to_platform_message_id: replyToPlatformMessageId,
  }, { onConflict: 'tenant_id,platform_message_id', ignoreDuplicates: true })
  if (insertErr) {
    console.warn(`[webhook] inbound upsert failed tenant=${tenant.id} msg=${msg.id}: ${insertErr.message}`)
  }

  // Upsert contact (tenant-scoped — fixes the user_id vs tenant_id leak from 008)
  // Capture whether this was a new insert so we can write the implicit
  // DPDPA opt-in consent_events row (migration 072) only on first contact.
  const { data: existingContact } = await supabase.from('contacts')
    .select('id, created_at').eq('tenant_id', tenant.id).eq('phone', `+${phone}`).maybeSingle()
  const isNewContact = !existingContact

  const { data: contactRow } = await supabase.from('contacts').upsert({
    tenant_id: tenant.id,
    user_id:   tenant.user_id,            // kept for legacy RLS policies
    phone:     `+${phone}`,
    name:      contact?.profile?.name ?? `+${phone}`,
  }, { onConflict: 'tenant_id,phone' }).select('id').maybeSingle()

  // ── Implicit DPDPA opt-in on first inbound message (P0.7) ─────────────
  // When a contact initiates a conversation, DPDPA treats that as consent
  // for SERVICE_UPDATES + TRANSACTIONAL processing under "necessary
  // processing for a stated purpose" (§4(2)(b)). We do NOT auto-opt-in
  // for marketing — the tenant must capture explicit marketing consent
  // via POST /api/contacts/:id/consent. Fail-soft so the inbound flow
  // never breaks because of a missing migration.
  if (isNewContact && contactRow?.id) {
    try {
      const snippet = String(text ?? '').slice(0, 200)
      const proofText = snippet
        ? `Initiated conversation by sending: ${snippet}`
        : 'Initiated conversation via WhatsApp'
      // Two rows: service_updates + transactional. Both come from the
      // same inbound message; the trigger materializes per-purpose state.
      await supabase.from('consent_events').insert([
        {
          tenant_id: tenant.id,
          contact_id: contactRow.id,
          channel: 'whatsapp',
          event_type: 'opt_in',
          purpose: 'service_updates',
          source: 'whatsapp_inbound',
          source_detail: { wa_message_id: msg.id, wa_profile_name: contact?.profile?.name ?? null },
          proof_text: proofText,
        },
        {
          tenant_id: tenant.id,
          contact_id: contactRow.id,
          channel: 'whatsapp',
          event_type: 'opt_in',
          purpose: 'transactional',
          source: 'whatsapp_inbound',
          source_detail: { wa_message_id: msg.id, wa_profile_name: contact?.profile?.name ?? null },
          proof_text: proofText,
        },
      ])
    } catch (e: any) {
      console.warn(`[wa-webhook] consent_events seed failed (non-fatal): ${e?.message ?? e}`)
    }
  }

  // ── CTWA attribution (P0.6 — Indian SMB Omnichannel Wedge) ────────────
  // Meta passes a `referral` object on the first inbound message of any
  // Click-to-WhatsApp ad conversation. We capture it once per ctwa_clid
  // (deduped by the unique index on tenant_id+ctwa_clid) so analytics can
  // attribute the resulting revenue back to the ad-set later. Fail-soft —
  // if the insert errors (RLS, schema drift), the WA flow continues
  // unimpaired. Done inline so we don't lose the referral if the engine
  // chain fails downstream.
  const referral = msg.referral
  if (referral && (referral.source_id || referral.ctwa_clid)) {
    try {
      await supabase.from('ctwa_attribution').upsert({
        tenant_id:           tenant.id,
        contact_id:          contactRow?.id ?? null,
        meta_ad_id:          referral.source_id ?? referral.ad_id ?? null,
        // Meta sends adset/campaign IDs under variable keys depending on
        // referral source. Probe the most common shapes; defaults to null.
        meta_adset_id:       referral.adgroup_id ?? referral.adset_id ?? null,
        meta_campaign_id:    referral.campaign_id ?? null,
        ctwa_clid:           referral.ctwa_clid ?? null,
        referral_headline:   referral.headline ?? null,
        referral_body:       referral.body ?? null,
        source_url:          referral.source_url ?? null,
        image_url:           referral.image?.link ?? referral.image_url ?? null,
        referral_source_type: referral.source_type ?? null,
        first_message_at:    new Date().toISOString(),
        raw_referral:        referral,
      }, { onConflict: 'tenant_id,ctwa_clid', ignoreDuplicates: true })
    } catch (e: any) {
      console.warn(`[wa-webhook] CTWA attribution insert failed (non-fatal): ${e?.message ?? e}`)
    }
  }

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

async function sendTextMessage(tenant: any, to: string, text: string, replyToPlatformMessageId?: string | null) {
  const payload: any = { messaging_product: 'whatsapp', to, type: 'text', text: { body: text } }
  // Reply-to (migration 127). Meta's WA Cloud API takes `context.message_id`
  // on the send payload and renders a quoted bubble on the customer's
  // side. We also persist the parent wamid locally so our own inbox
  // bubble shows the quote on the agent side.
  if (replyToPlatformMessageId) {
    payload.context = { message_id: replyToPlatformMessageId }
  }
  // Pre-insert pattern: INSERT row BEFORE the Meta call (status='queued')
  // so the webhook's status update can find it by id when Meta sends
  // 'sent'/'delivered'/'read' microseconds later. Without this, Meta's
  // status webhook arrives, queries by platform_message_id, finds 0
  // rows (because our INSERT hadn't happened yet) — status stays at
  // 'sent' forever and delivery telemetry is lost.
  const { data: row } = await supabase.from('messages').insert({
    tenant_id: tenant.id, channel: 'whatsapp', direction: 'outbound',
    contact_phone: to, content: payload, status: 'queued',
    reply_to_platform_message_id: replyToPlatformMessageId ?? null,
  }).select('id').single()

  const r = await fetch(`${GRAPH}/${tenant.phone_number_id}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${tenant.access_token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  })
  const data = await r.json() as any
  if (!r.ok || data.error) {
    const detail = mapMetaError(data, `WA text send failed (${r.status})`)
    if (row?.id) {
      await supabase.from('messages').update({
        status: 'failed', content: { ...payload, error: detail },
      }).eq('id', row.id)
    }
    throw new Error(detail)
  }
  if (row?.id && data.messages?.[0]?.id) {
    await supabase.from('messages').update({
      platform_message_id: data.messages[0].id, status: 'sent',
    }).eq('id', row.id)
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
  // Pre-insert (see sendTextMessage for race-fix rationale).
  const { data: row } = await supabase.from('messages').insert({
    tenant_id: tenant.id, channel: 'whatsapp', direction: 'outbound',
    contact_phone: to, content: payload, status: 'queued',
  }).select('id').single()

  const r = await fetch(`${GRAPH}/${tenant.phone_number_id}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${tenant.access_token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  })
  const data = await r.json() as any
  if (!r.ok || data.error) {
    const detail = mapMetaError(data, `WA template send failed (${r.status})`)
    if (row?.id) {
      await supabase.from('messages').update({
        status: 'failed', content: { ...payload, error: detail },
      }).eq('id', row.id)
    }
    throw new Error(detail)
  }
  if (row?.id && data.messages?.[0]?.id) {
    await supabase.from('messages').update({
      platform_message_id: data.messages[0].id, status: 'sent',
    }).eq('id', row.id)
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
        // Preserve user-supplied button.id when present — earlier code
        // unconditionally rewrote to `btn_${i}` which broke routing of
        // button reply payloads back to the trigger that issued them.
        buttons: (config.buttons ?? []).slice(0, 3).map((b: any, i: number) => ({
          type: 'reply',
          reply: { id: String(b.id ?? `btn_${i}`), title: String(b.text ?? b ?? '') },
        }))
      }
    }
  }
  // Pre-insert (see sendTextMessage for race-fix rationale).
  const { data: row } = await supabase.from('messages').insert({
    tenant_id: tenant.id, channel: 'whatsapp', direction: 'outbound',
    contact_phone: to, content: payload, status: 'queued',
  }).select('id').single()

  const r = await fetch(`${GRAPH}/${tenant.phone_number_id}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${tenant.access_token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  })
  const data = await r.json() as any
  if (!r.ok || data.error) {
    const detail = mapMetaError(data, `WA interactive send failed (${r.status})`)
    if (row?.id) {
      await supabase.from('messages').update({
        status: 'failed', content: { ...payload, error: detail },
      }).eq('id', row.id)
    }
    throw new Error(detail)
  }
  if (row?.id && data.messages?.[0]?.id) {
    await supabase.from('messages').update({
      platform_message_id: data.messages[0].id, status: 'sent',
    }).eq('id', row.id)
  }
  return data
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
  if (error) { res.status((error as any).code === 'PGRST116' ? 404 : 500).json({ error: (error as any).code === 'PGRST116' ? 'not found' : error.message }); return }
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
  if (error) { res.status((error as any).code === 'PGRST116' ? 404 : 500).json({ error: (error as any).code === 'PGRST116' ? 'not found' : error.message }); return }
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

// ── Google Sheets + Calendar capability handlers ─────────────────────────────
// REST surface for the connector registry capabilities. The workflow engine
// has its own internal `update_sheet` / `create_calendar_event` paths; these
// endpoints expose the same Google operations as one-shot REST calls so the
// AppsModal capability page (and any user-facing "test run" surface) can drive
// them directly with the same OAuth token + auto-refresh helper.
//
// All five handlers reuse `getValidToken`-backed helpers from ../google.ts —
// they read tokens off the tenants row, refresh via oauth2.googleapis.com/token
// if expired, and persist the new access_token back to the row.

// Body shape mirrors registry.GOOGLE_SHEETS.capabilities[].inputSchema.fields.
// `values` accepts either a JSON-encoded string (FE textarea, same pattern as
// WhatsApp template_params) or an already-parsed array — both forms are
// normalised before hitting Google.
const GoogleSheetsAppendSchema = z.object({
  spreadsheet_id: z.string().min(1, 'spreadsheet_id is required'),
  sheet_name:     z.string().min(1, 'sheet_name is required'),
  values:         z.union([z.string(), z.array(z.any())]),
}).strict()

const GoogleSheetsUpdateSchema = z.object({
  spreadsheet_id: z.string().min(1, 'spreadsheet_id is required'),
  range:          z.string().min(1, 'range is required'),  // e.g. 'Sheet1!B5:D5'
  values:         z.union([z.string(), z.array(z.any())]),
}).strict()

const GoogleCalendarEventSchema = z.object({
  calendar_id: z.string().min(1).default('primary'),
  summary:     z.string().min(1, 'summary is required'),
  description: z.string().optional(),
  location:    z.string().optional(),
  start:       z.string().min(1, 'start is required'),  // ISO 8601 dateTime
  end:         z.string().min(1, 'end is required'),    // ISO 8601 dateTime
  time_zone:   z.string().optional(),
  attendees:   z.union([z.string(), z.array(z.string())]).optional(),
}).strict()

// Coerce FE-friendly inputs (JSON string / CSV / nested array) into the
// shape the Google helper expects. Throws a typed Error on malformed input
// so the route can return a clean 400.
function coerceSheetValuesFlat(raw: unknown): string[] {
  if (Array.isArray(raw)) {
    // Single-row array OR a [[…]] 2D — flatten if FE handed in [["a","b"]]
    if (raw.length === 1 && Array.isArray(raw[0])) return (raw[0] as any[]).map(String)
    return (raw as any[]).map(String)
  }
  if (typeof raw === 'string') {
    const trimmed = raw.trim()
    if (!trimmed) throw new Error('values is required')
    if (trimmed.startsWith('[')) {
      let parsed: any
      try { parsed = JSON.parse(trimmed) } catch { throw new Error('values: invalid JSON') }
      return coerceSheetValuesFlat(parsed)
    }
    // Fallback: comma-separated. Quoted tokens are unquoted so '"A","B"' → ['A','B'].
    return trimmed.split(',').map(s => s.trim().replace(/^["']|["']$/g, ''))
  }
  throw new Error('values must be an array or string')
}

function coerceSheetValues2D(raw: unknown): string[][] {
  if (Array.isArray(raw)) {
    if (raw.length === 0) return []
    // Already 2D
    if (Array.isArray(raw[0])) return (raw as any[][]).map(row => row.map(String))
    // 1D → wrap as single row
    return [(raw as any[]).map(String)]
  }
  if (typeof raw === 'string') {
    const trimmed = raw.trim()
    if (!trimmed) throw new Error('values is required')
    if (trimmed.startsWith('[')) {
      let parsed: any
      try { parsed = JSON.parse(trimmed) } catch { throw new Error('values: invalid JSON') }
      return coerceSheetValues2D(parsed)
    }
    return [trimmed.split(',').map(s => s.trim().replace(/^["']|["']$/g, ''))]
  }
  throw new Error('values must be an array or string')
}

// 1) Append row → POST /api/google/sheets/append
app.post('/api/google/sheets/append',
  requireAuth, identifyTenant, checkPermission('google_sheets', 'edit'),
  validateBody(GoogleSheetsAppendSchema),
  async (req, res) => {
    const tenantId = (req as any).tenantId
    const { data: tenant } = await supabase.from('tenants').select('*').eq('id', tenantId).maybeSingle()
    if (!tenant || !tenant.google_access_token) {
      res.status(400).json({ error: 'Google account not connected' }); return
    }
    let row: string[]
    try { row = coerceSheetValuesFlat((req.body as any).values) }
    catch (err: any) { res.status(400).json({ error: err.message }); return }

    // Range form for append: 'SheetName!A:Z' — the helper URL-encodes for us.
    const range = `${(req.body as any).sheet_name}!A:Z`
    try {
      const data = await sheetsAppendRow(tenant, String((req.body as any).spreadsheet_id), range, row)
      res.json(data)  // { spreadsheetId, tableRange, updates: { updatedRange, updatedRows, … } }
    } catch (err: any) { res.status(502).json({ error: err.message }) }
  })

// 2) Update range → POST /api/google/sheets/update
app.post('/api/google/sheets/update',
  requireAuth, identifyTenant, checkPermission('google_sheets', 'edit'),
  validateBody(GoogleSheetsUpdateSchema),
  async (req, res) => {
    const tenantId = (req as any).tenantId
    const { data: tenant } = await supabase.from('tenants').select('*').eq('id', tenantId).maybeSingle()
    if (!tenant || !tenant.google_access_token) {
      res.status(400).json({ error: 'Google account not connected' }); return
    }
    let rows: string[][]
    try { rows = coerceSheetValues2D((req.body as any).values) }
    catch (err: any) { res.status(400).json({ error: err.message }); return }

    try {
      const data = await sheetsUpdateRange(
        tenant,
        String((req.body as any).spreadsheet_id),
        String((req.body as any).range),
        rows,
      )
      res.json(data)  // { spreadsheetId, updatedRange, updatedRows, updatedColumns, updatedCells }
    } catch (err: any) { res.status(502).json({ error: err.message }) }
  })

// 3) Read range → GET /api/google/sheets/read?spreadsheet_id=…&range=Sheet1!A1:D10
app.get('/api/google/sheets/read',
  requireAuth, identifyTenant, checkPermission('google_sheets', 'view'),
  async (req, res) => {
    const spreadsheetId = String(req.query.spreadsheet_id ?? '').trim()
    const range = String(req.query.range ?? '').trim()
    if (!spreadsheetId || !range) {
      res.status(400).json({ error: 'spreadsheet_id and range query params are required' }); return
    }
    const tenantId = (req as any).tenantId
    const { data: tenant } = await supabase.from('tenants').select('*').eq('id', tenantId).maybeSingle()
    if (!tenant || !tenant.google_access_token) {
      res.status(400).json({ error: 'Google account not connected' }); return
    }
    // The existing helper strips the {range, majorDimension} envelope, so call
    // Google directly here to preserve the full registry-declared output shape.
    try {
      const token = await getValidGoogleToken(tenant)
      const url = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(range)}`
      const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } })
      const data = await r.json() as any
      if (data.error) { res.status(502).json({ error: data.error.message }); return }
      res.json({
        range:          data.range,
        majorDimension: data.majorDimension,
        values:         data.values ?? [],
      })
    } catch (err: any) { res.status(502).json({ error: err.message }) }
  })

// 4) Create calendar event → POST /api/google/calendar/events
app.post('/api/google/calendar/events',
  requireAuth, identifyTenant, checkPermission('google_calendar', 'edit'),
  validateBody(GoogleCalendarEventSchema),
  async (req, res) => {
    const tenantId = (req as any).tenantId
    const { data: tenant } = await supabase.from('tenants').select('*').eq('id', tenantId).maybeSingle()
    if (!tenant || !tenant.google_access_token) {
      res.status(400).json({ error: 'Google account not connected' }); return
    }
    const body = req.body as any
    // Normalise attendees: accept JSON string, comma-separated string, or array
    let attendeeEmails: string[] | undefined
    if (body.attendees != null) {
      if (Array.isArray(body.attendees)) {
        attendeeEmails = body.attendees.map(String).filter(Boolean)
      } else if (typeof body.attendees === 'string') {
        const s: string = body.attendees.trim()
        if (s.startsWith('[')) {
          try { attendeeEmails = (JSON.parse(s) as any[]).map(String) }
          catch { res.status(400).json({ error: 'attendees: invalid JSON' }); return }
        } else if (s.length > 0) {
          attendeeEmails = s.split(',').map((x: string) => x.trim()).filter(Boolean)
        }
      }
    }
    try {
      const data = await calendarCreateEvent(tenant, body.calendar_id || 'primary', {
        summary:        body.summary,
        description:    body.description,
        location:       body.location,
        startTime:      body.start,
        endTime:        body.end,
        timeZone:       body.time_zone,
        attendeeEmails,
      })
      res.json(data)  // { id, htmlLink, status, summary, start: {dateTime}, end: {dateTime}, … }
    } catch (err: any) { res.status(502).json({ error: err.message }) }
  })

// 5) Check availability → GET /api/google/calendar/availability?calendar_id=…&time_min=…&time_max=…
app.get('/api/google/calendar/availability',
  requireAuth, identifyTenant, checkPermission('google_calendar', 'view'),
  async (req, res) => {
    const calendarId = String(req.query.calendar_id ?? 'primary').trim() || 'primary'
    const timeMin = String(req.query.time_min ?? '').trim()
    const timeMax = String(req.query.time_max ?? '').trim()
    if (!timeMin || !timeMax) {
      res.status(400).json({ error: 'time_min and time_max query params are required (ISO 8601)' }); return
    }
    const tenantId = (req as any).tenantId
    const { data: tenant } = await supabase.from('tenants').select('*').eq('id', tenantId).maybeSingle()
    if (!tenant || !tenant.google_access_token) {
      res.status(400).json({ error: 'Google account not connected' }); return
    }
    // calendarCheckAvailability() helper collapses to a single boolean — for
    // the REST surface we want the raw freebusy response (per-calendar busy
    // arrays), so call Google directly. Same OAuth refresh path via the
    // shared getValidGoogleToken wrapper.
    try {
      const token = await getValidGoogleToken(tenant)
      const r = await fetch('https://www.googleapis.com/calendar/v3/freeBusy', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ timeMin, timeMax, items: [{ id: calendarId }] }),
      })
      const data = await r.json() as any
      if (data.error) { res.status(502).json({ error: data.error.message }); return }
      res.json({
        timeMin:   data.timeMin,
        timeMax:   data.timeMax,
        calendars: data.calendars ?? {},
      })
    } catch (err: any) { res.status(502).json({ error: err.message }) }
  })

// ── Google capability handlers (added 2026-05) ───────────────────────────────
// 6) Create new spreadsheet → POST /api/google/drive/spreadsheets
// Drive files.create with the Sheets MIME type creates an empty Sheet in My
// Drive. Response includes webViewLink so the user can open it immediately,
// then come back to import it into Tables via the mirror_sheet flow.
// Docs: https://developers.google.com/drive/api/reference/rest/v3/files/create
const GoogleDriveCreateSpreadsheetSchema = z.object({
  name: z.string().min(1, 'name is required').max(255, 'name is too long'),
}).strict()

app.post('/api/google/drive/spreadsheets',
  requireAuth, identifyTenant, checkPermission('google_sheets', 'edit'),
  validateBody(GoogleDriveCreateSpreadsheetSchema),
  async (req, res) => {
    const tenantId = (req as any).tenantId
    const { data: tenant } = await supabase.from('tenants').select('*').eq('id', tenantId).maybeSingle()
    if (!tenant || !tenant.google_access_token) {
      res.status(400).json({ error: 'Google account not connected' }); return
    }
    try {
      const token = await getValidGoogleToken(tenant)
      const name = String((req.body as any).name)
      // `fields` query param tells Drive which File-resource fields to return —
      // by default the response is sparse (id, name, mimeType only). Request
      // the ones our registry advertises in outputSchema.
      const url = `https://www.googleapis.com/drive/v3/files?fields=${encodeURIComponent('id,name,mimeType,webViewLink,createdTime')}`
      const r = await fetch(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, mimeType: 'application/vnd.google-apps.spreadsheet' }),
      })
      const data = await r.json() as any
      if (!r.ok || data.error) {
        res.status(502).json({ error: data.error?.message ?? 'Google Drive returned an error' }); return
      }
      res.json({
        id:           data.id,
        name:         data.name,
        webViewLink:  data.webViewLink,
        createdTime:  data.createdTime,
      })
    } catch (err: any) { res.status(502).json({ error: err.message }) }
  })

// 7) List calendar events → GET /api/google/calendar/events
// Read-side complement to create_event. Default window: now → +7 days.
// Docs: https://developers.google.com/calendar/api/v3/reference/events/list
app.get('/api/google/calendar/events',
  requireAuth, identifyTenant, checkPermission('google_calendar', 'view'),
  async (req, res) => {
    const tenantId = (req as any).tenantId
    const { data: tenant } = await supabase.from('tenants').select('*').eq('id', tenantId).maybeSingle()
    if (!tenant || !tenant.google_access_token) {
      res.status(400).json({ error: 'Google account not connected' }); return
    }
    const calendarId = String(req.query.calendar_id ?? 'primary').trim() || 'primary'
    const now = new Date()
    const sevenDays = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000)
    const timeMin = String(req.query.time_min ?? now.toISOString()).trim()
    const timeMax = String(req.query.time_max ?? sevenDays.toISOString()).trim()
    const maxRaw = Number(req.query.max_results ?? 25)
    const maxResults = Number.isFinite(maxRaw) && maxRaw > 0 ? Math.min(Math.floor(maxRaw), 250) : 25
    const q = String(req.query.q ?? '').trim()

    try {
      const token = await getValidGoogleToken(tenant)
      const params = new URLSearchParams({
        timeMin,
        timeMax,
        maxResults: String(maxResults),
        singleEvents: 'true',  // expand recurring events into instances
        orderBy: 'startTime',  // only valid when singleEvents=true
      })
      if (q) params.set('q', q)
      const url = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events?${params.toString()}`
      const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } })
      const data = await r.json() as any
      if (!r.ok || data.error) {
        res.status(502).json({ error: data.error?.message ?? 'Google Calendar returned an error' }); return
      }
      res.json({
        items:         data.items ?? [],
        nextPageToken: data.nextPageToken,
        timeZone:      data.timeZone,
      })
    } catch (err: any) { res.status(502).json({ error: err.message }) }
  })

// 8) Quick add event → POST /api/google/calendar/quick-add
// Natural-language event creator. Google parses the text into a structured
// event (best for "Lunch with Priya tomorrow at 1pm"-style input).
// Docs: https://developers.google.com/calendar/api/v3/reference/events/quickAdd
const GoogleCalendarQuickAddSchema = z.object({
  calendar_id: z.string().min(1).default('primary'),
  text:        z.string().min(1, 'text is required').max(1024, 'text is too long'),
}).strict()

app.post('/api/google/calendar/quick-add',
  requireAuth, identifyTenant, checkPermission('google_calendar', 'edit'),
  validateBody(GoogleCalendarQuickAddSchema),
  async (req, res) => {
    const tenantId = (req as any).tenantId
    const { data: tenant } = await supabase.from('tenants').select('*').eq('id', tenantId).maybeSingle()
    if (!tenant || !tenant.google_access_token) {
      res.status(400).json({ error: 'Google account not connected' }); return
    }
    const body = req.body as any
    const calendarId = (body.calendar_id || 'primary').toString().trim() || 'primary'
    const text = String(body.text)
    try {
      const token = await getValidGoogleToken(tenant)
      const url = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events/quickAdd?text=${encodeURIComponent(text)}`
      const r = await fetch(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      })
      const data = await r.json() as any
      if (!r.ok || data.error) {
        res.status(502).json({ error: data.error?.message ?? 'Google Calendar quickAdd returned an error' }); return
      }
      res.json(data)  // { id, htmlLink, status, summary, start, end, … }
    } catch (err: any) { res.status(502).json({ error: err.message }) }
  })

// 9) Send Gmail message → POST /api/google/gmail/send
// Builds an RFC 2822 MIME message and base64url-encodes it into the `raw`
// field of users.messages.send. The From is always the connected Gmail —
// Gmail API enforces this regardless of what header we set.
// Docs: https://developers.google.com/gmail/api/reference/rest/v1/users.messages/send
const GoogleGmailSendSchema = z.object({
  to:        z.string().min(1, 'to is required'),
  subject:   z.string().min(1, 'subject is required').max(998, 'subject is too long for RFC 2822'),
  body_html: z.string().optional(),
  body_text: z.string().optional(),
  cc:        z.string().optional(),
  bcc:       z.string().optional(),
  reply_to:  z.string().optional(),
}).strict().refine(
  (v) => Boolean((v.body_html && v.body_html.length > 0) || (v.body_text && v.body_text.length > 0)),
  { message: 'body_html or body_text is required' },
)

// Encode a header value that may contain non-ASCII (per RFC 2047) so we don't
// silently drop Unicode characters when building the MIME envelope. Plain
// ASCII passes through unchanged for readability.
function encodeMimeHeader(value: string): string {
  // eslint-disable-next-line no-control-regex
  if (/^[\x00-\x7F]*$/.test(value)) return value
  return `=?utf-8?B?${Buffer.from(value, 'utf8').toString('base64')}?=`
}

app.post('/api/google/gmail/send',
  requireAuth, identifyTenant, checkPermission('google_gmail', 'edit'),
  validateBody(GoogleGmailSendSchema),
  async (req, res) => {
    const tenantId = (req as any).tenantId
    const { data: tenant } = await supabase.from('tenants').select('*').eq('id', tenantId).maybeSingle()
    if (!tenant || !tenant.google_access_token) {
      res.status(400).json({ error: 'Google account not connected' }); return
    }
    const body = req.body as any
    const fromAddress = tenant.google_email as string | null
    if (!fromAddress) {
      res.status(400).json({ error: 'Connected Google account is missing an email address' }); return
    }

    // Build RFC 2822 MIME. Prefer multipart/alternative when both html + text
    // are provided so clients can fall back to plain-text. Single-part
    // otherwise — keeps the wire small and the envelope simple.
    const headers: string[] = [
      `From: ${fromAddress}`,
      `To: ${body.to}`,
    ]
    if (body.cc)       headers.push(`Cc: ${body.cc}`)
    if (body.bcc)      headers.push(`Bcc: ${body.bcc}`)
    if (body.reply_to) headers.push(`Reply-To: ${body.reply_to}`)
    headers.push(`Subject: ${encodeMimeHeader(String(body.subject))}`)
    headers.push('MIME-Version: 1.0')

    let mimeBody: string
    if (body.body_html && body.body_text) {
      const boundary = `frequency_${crypto.randomBytes(12).toString('hex')}`
      headers.push(`Content-Type: multipart/alternative; boundary="${boundary}"`)
      mimeBody = [
        '',
        `--${boundary}`,
        'Content-Type: text/plain; charset=utf-8',
        'Content-Transfer-Encoding: 7bit',
        '',
        body.body_text,
        `--${boundary}`,
        'Content-Type: text/html; charset=utf-8',
        'Content-Transfer-Encoding: 7bit',
        '',
        body.body_html,
        `--${boundary}--`,
      ].join('\r\n')
    } else if (body.body_html) {
      headers.push('Content-Type: text/html; charset=utf-8')
      mimeBody = '\r\n' + body.body_html
    } else {
      headers.push('Content-Type: text/plain; charset=utf-8')
      mimeBody = '\r\n' + body.body_text
    }

    const mime = headers.join('\r\n') + mimeBody
    const raw = Buffer.from(mime, 'utf8')
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '')

    try {
      const token = await getValidGoogleToken(tenant)
      const r = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ raw }),
      })
      const data = await r.json() as any
      if (!r.ok || data.error) {
        res.status(502).json({ error: data.error?.message ?? 'Gmail returned an error' }); return
      }
      res.json({
        id:       data.id,
        threadId: data.threadId,
        labelIds: data.labelIds ?? [],
        from:     fromAddress,
      })
    } catch (err: any) { res.status(502).json({ error: err.message }) }
  })

// Suppress unused-import warning when the registry-side gmail helper isn't
// referenced elsewhere. We build the MIME inline above so we get full envelope
// control (cc/bcc/reply_to + multipart fallback) — the legacy helper supports
// only `to/subject/body`. Keep it around for the workflow engine.
void gmailSendEmail

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
  const { role, feature, can_view, can_edit, can_delete } = req.body ?? {}

  // Defensive validation — empty body would otherwise upsert null into
  // role + feature (both NOT NULL on role_permissions) and 500. Caught
  // by the behavioral smoke harness as a coverage-probe panic.
  if (typeof role !== 'string' || role.trim().length === 0) {
    res.status(400).json({ error: 'role is required' })
    return
  }
  if (typeof feature !== 'string' || feature.trim().length === 0) {
    res.status(400).json({ error: 'feature is required' })
    return
  }

  const { error } = await supabase.from('role_permissions').upsert({
    tenant_id: tenantId,
    role,
    feature,
    can_view:   typeof can_view === 'boolean'   ? can_view   : false,
    can_edit:   typeof can_edit === 'boolean'   ? can_edit   : false,
    can_delete: typeof can_delete === 'boolean' ? can_delete : false,
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
  const { email, role } = req.body ?? {}
  // Defensive validation — inviteUserByEmail(undefined) throws inside the
  // supabase admin SDK with an unhelpful 500. Caller must supply email + role.
  if (typeof email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    res.status(400).json({ error: 'valid email is required' })
    return
  }
  if (typeof role !== 'string' || role.trim().length === 0) {
    res.status(400).json({ error: 'role is required' })
    return
  }

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

// ── Public waitlist (apex landing page signups, no auth) ────────────────────
// Mounted at /api/waitlist. Per-IP rate limit lives inside the router.
app.use('/api/waitlist', createWaitlistRouter({ supabase }))

// ── Public status (no auth) ──────────────────────────────────────────────────
// Powers the public /status page. Three endpoints under /api/public/:
//   GET /uptime?days=N · /response-time?days=N · /incidents?days=N
// Per-IP rate limit + 30s edge cache live inside the router. Safe to
// deploy before migration 067_public_incidents.sql is applied — the
// incidents handler treats a missing table as "no incidents" rather
// than 500ing.
app.use('/api/public', createPublicStatusRouter({ supabase }))

// ── P2 #19 — Broadcast short-link redirect (public, no auth) ────────────────
// Mounted at /r/:token. The recipient clicks a short link in a broadcast,
// we resolve it to the original URL via service-role Supabase + 302. Click
// is logged async after the response; never blocks the redirect.
app.use(createRedirectRouter({ supabase }))

// ── P2 #19 — Broadcast click analytics (tenant-scoped, auth required) ───────
// Read-only rollups over broadcast_links + broadcast_link_clicks. Powers
// the "Click analytics" section on BroadcastsPage.
app.use(createBroadcastLinkAnalyticsRouter({ supabase, requireAuth, identifyTenant }))

// ── P2 #22 — Sales CRM Lite (tenant-scoped, auth required) ──────────────────
// Pipeline view tied to conversations. Stages + deals + append-only events.
// Migration 087_sales_crm_lite.sql.
app.use(createCrmRouter({ supabase, requireAuth, identifyTenant }))
// Quick Replies + Internal Notes (Phase 1A — migration 093). Stage-aware
// composer suggestions reuse the CRM tables crm_deals + crm_stages, so
// this mount must come AFTER createCrmRouter to keep dependency order
// readable (functionally independent at runtime).
app.use(createComposerToolsRouter({ supabase, requireAuth, identifyTenant }))
// PII masking (Phase 1B — migration 094). Independent surface; mount
// order doesn't matter beyond being after the standard auth chain
// init above.
app.use(createPiiRouter({ supabase, requireAuth, identifyTenant }))
// SLA tracking (Phase 3 — migration 095).
app.use(createSlaRouter({ supabase, requireAuth, identifyTenant }))

// ── Billing (Razorpay subscriptions + webhook) ───────────────────────────────
// NOTE: the webhook route inside this router uses express.raw() to bypass the
// global JSON parser — needed for HMAC signature verification on raw bytes.
app.use(createBillingRouter({ supabase, requireAuth, identifyTenant, checkPermission }))

// ── CTWA → WhatsApp attribution analytics ───────────────────────────────────
// Reads from ctwa_attribution (written by the WA inbound webhook above when a
// referral object is present) and meta_ad_campaigns. Powers the new Analytics
// tab that shows ROAS per ad-set + funnel totals (P0.6).
app.use(createCtwaAnalyticsRouter({ supabase, requireAuth, identifyTenant }))

// ── Channel-specific feature endpoints (omnichannel) ─────────────────────────
app.use(createWaFeaturesRouter({ supabase, requireAuth, identifyTenant, checkPermission, redis: redisConnection }))
// Template Approval Assistant (P1 #15) — policy-check + rejection-explainer +
// resubmit-draft. Mounts /api/wa-templates/policy-check, /api/wa-templates/
// :name/explain-rejection, /api/wa-templates/:name/resubmit-draft alongside
// the inline GET/POST/DELETE /api/wa-templates routes above.
app.use(createWaTemplatesRouter({ supabase, requireAuth, identifyTenant, checkPermission }))
app.use(createTelegramRouter({ supabase, requireAuth, identifyTenant, checkPermission }))
app.use(createInstagramRouter({ supabase, requireAuth, identifyTenant, checkPermission }))
app.use(createMetaAdsRouter({ supabase, requireAuth, identifyTenant, checkPermission }))

// ── Shopify (P1 #11) ────────────────────────────────────────────────────────
// Three routers, deliberately split so the signature-verified write paths
// can never be reached by a logged-in tenant crafting an OAuth replay or by
// a generic POST without HMAC headers:
//   - shopify-oauth:   /api/shopify/install (requireAuth) + /api/shopify/callback (public, state+HMAC verified)
//   - shopify-webhook: /api/webhooks/shopify (public, per-store HMAC verified, always-200)
//   - shopify:         /api/shopify/stores, /api/shopify/orders/recent, disconnect, fulfill (tenant-auth)
app.use(createShopifyOAuthRouter({ supabase, requireAuth, identifyTenant }))
app.use(createShopifyWebhookRouter({ supabase }))
app.use(createShopifyRouter({ supabase, requireAuth, identifyTenant, checkPermission }))

// P1 #12 — Agency white-label routes. requireAuth only (no identifyTenant)
// because agency routes are cross-tenant by definition — the handler resolves
// the agency via :id and gates on agency_members membership + role.
app.use(createAgencyRouter({ supabase, requireAuth }))

// ── P1 #18 — Bulk contact import + saved segments (migration 084) ─────────
// Two routers:
//   contact-import: /api/contacts/import* — async job lifecycle (POST/cancel/commit/status/dry-run).
//   segments:       /api/segments*        — saved filter CRUD + count/preview evaluation.
// The contact-import router enqueues to BullMQ via enqueueContactImport so
// parsing happens off the request thread; the worker writes per-contact
// consent_events rows for DPDPA provenance.
app.use(createContactImportRouter({
  supabase, requireAuth, identifyTenant, checkPermission,
  enqueueImport: enqueueContactImport,
}))
app.use(createSegmentsRouter({ supabase, requireAuth, identifyTenant, checkPermission }))

// ── Super-admin API (platform-level operations) ──────────────────────────────
app.use(createSuperAdminRouter({ supabase, requireAuth }))

// ── Tenant team management (RBAC) ────────────────────────────────────────────
app.use(createTeamsRouter({ supabase, requireAuth, identifyTenant }))

// ── Tenant audit log (per-tenant immutable log, populated by WA-calling +
//    other DPDP-compliance writers; read-side for the AuditLogPage FE) ───────
app.use(createTenantAuditRouter({ supabase, requireAuth, identifyTenant, checkPermission }))

// ── Notifications (in-app bell + preferences) ────────────────────────────────
app.use(createNotificationsRouter({ supabase, requireAuth, identifyTenant }))
app.use(createFormsRouter({ supabase, requireAuth, identifyTenant, checkPermission }))
app.use(createSitesRouter({ supabase, requireAuth, identifyTenant, checkPermission }))

// ── Inbox agent-collision presence audit (P1 #16) ───────────────────────────
// Live "Agent X is already replying" toast is driven by Supabase Realtime
// presence + broadcast channels keyed by conversation_key. This router only
// persists an append-only audit trail (inbox_agent_activity, migration 083)
// so we can post-incident answer "who handled this thread". Fire-and-forget
// from the FE; advisory only, never gates a send.
app.use(createInboxPresenceRouter({ supabase, requireAuth, identifyTenant }))

// ── P2 #20 — Voice note transcripts (read + retry) ──────────────────────────
// GET /api/messages/:id/transcript and POST /api/messages/:id/retry-transcript.
// Read powers the inbox audio-bubble "Show transcript" toggle; retry powers
// the "Transcription unavailable" → Try again affordance. The transcription
// itself runs async in workers/voice-note-transcribe.ts (BullMQ).
app.use(createVoiceTranscriptsRouter({ supabase, requireAuth, identifyTenant }))

// ── Mobile push device registration (P0.10) ──────────────────────────────────
// The mobile app POSTs an Expo push token after sign-in fire-and-forget.
// Stored under (user_id, expo_push_token) with RLS so users can only manage
// their own device tokens. sendExpoPush() in src/lib/expo-push.ts reads
// from this table to fan out new-message / broadcast notifications.
app.use(createDevicesRouter({ supabase, requireAuth, identifyTenant }))

// ── Per-tenant usage / quota inspection ──────────────────────────────────────
// Live token-bucket counters (the same numbers checkAndConsumeQuota gates
// against). Powers the billing-page rate-limit bars + the "previous warnings"
// panel on /settings/billing.
app.use(createUsageRouter({ supabase, redis: redisConnection, requireAuth, identifyTenant, checkPermission }))

// ── Wedge surface — markup-saved card, SLA badge, consent capture audit,
// campaign auto-resume. All read-side dashboards or single-row writes;
// no quota / Meta calls. Mounted alongside usage because the FE consumes
// them from the same component layer.
app.use(createWedgeSurfaceRouter({ supabase, requireAuth, identifyTenant, checkPermission }))

// ── DPDPA-ready consent layer (P0.7) ─────────────────────────────────────────
// Three sibling routers, all gated by RLS at the table level (migration 072):
//   - DSR (Data Subject Rights) — erasure / access / portability / rectification
//   - Breach notifications — super-admin write, tenant read for affected breaches
//   - Data residency — IN / EU / US tenant flag (informational today)
// PrivacyCenterPage on the FE consumes all three.
app.use(createDsrRouter({ supabase, requireAuth, identifyTenant, checkPermission }))
app.use(createBreachNotificationsRouter({ supabase, requireAuth, identifyTenant, isPlatformUser }))
app.use(createDataResidencyRouter({ supabase, requireAuth, identifyTenant }))
// Privacy Center adapters — short paths the FE PrivacyCenterPage consumes
// (POST /api/contacts/:id/dsr, GET /api/me/dsr-requests, GET /api/dsr/:id/download,
// GET+PATCH /api/me/residency, GET /api/admin/breach, PATCH /api/admin/breach/:id).
app.use(createPrivacyCenterRouter({ supabase, requireAuth, identifyTenant, checkPermission, isPlatformUser }))

// ── Approval requests (broadcast >threshold, bulk delete, etc.) ──────────────
app.use(createApprovalsRouter({ supabase, requireAuth, identifyTenant, checkPermission }))

// ── Workflow recommendations (AI-generated once, cached forever) ─────────────
app.use(createWorkflowRecosRouter({ supabase, requireAuth, identifyTenant }))

// ── Workflow insights (per-workflow optimization analysis) ───────────────────
// POST /api/workflows/:id/analyze + GET /api/workflows/:id/insights — feeds
// execution stats from workflow_sessions+messages+workflow_executions to
// Claude, returns ranked actionable insights. Cached in workflow_insights.
app.use(createWorkflowInsightsRouter({ supabase, requireAuth, identifyTenant }))

// ── Workflow template library (P1 #13) ───────────────────────────────────────
// Public catalog of pre-authored playbooks (D2C abandoned cart, EdTech course
// launch, clinic appointment reminder, real-estate site-visit pack). List +
// detail are anon-readable (catalog is curated public content); only the
// /clone route requires auth + tenant context.
app.use(createWorkflowTemplatesRouter({ supabase, requireAuth, identifyTenant }))

// ── Workflow versions / publish-preview / revert / explain / trace ──────────
// P1 #14 — chat-driven AI workflow author v1 improvements. NO visual canvas.
// Diffs are rendered plain-English-first on the FE with a collapsible JSON
// fallback. Versions table is append-only (migration 081).
app.use(createWorkflowVersionsRouter({ supabase, requireAuth, identifyTenant, checkPermission }))

// ── n8n import — deterministic parse + draft create ─────────────────────────
// POST /api/workflows/import-n8n (preview) + /import-n8n/commit (persist).
// Split into one Frequency draft per n8n trigger. Pairs with the FE
// "Import from n8n" modal on /workflows. See src/lib/n8n-import.ts for the
// parser; this router only owns request validation + persistence.
app.use(createN8nImportRouter({ supabase, requireAuth, identifyTenant, checkPermission }))

// ── Integration onboarding requests ─────────────────────────────────────────
// POST /api/integration-requests — captures user asks for apps we don't
// natively support yet. Persists a row in integration_requests + fires a
// transactional email to developers@frequency.app via Resend. Reused beyond
// n8n import: any "request this app" CTA can hit this endpoint.
app.use(createIntegrationRequestsRouter({ supabase, requireAuth, identifyTenant }))

// ── AI Responder — opt-in auto-reply with per-tenant knowledge (RAG) ─────────
// Settings + QA wizard + knowledge browser + test endpoint. The
// `run_ai_responder` workflow node consumes the same per-tenant settings +
// chunks. Strict tenant isolation: every helper in lib/ai-knowledge.ts
// takes tenantId as the first filter on every read/write.
app.use(createAiResponderRouter({ supabase, requireAuth, identifyTenant, checkPermission }))

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
