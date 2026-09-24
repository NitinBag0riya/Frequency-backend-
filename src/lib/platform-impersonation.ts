/**
 * Impersonation model (spec Part I §1.2).
 *
 * Rules encoded here:
 *   - reason REQUIRED (enforced at the start endpoint),
 *   - TTL default 30 min (DEFAULT_IMPERSONATION_TTL_MIN; overridable via the
 *     `impersonation_ttl_minutes` feature flag),
 *   - READ-ONLY by default (write-mode needs owner approval / an approval rule),
 *   - audit on start AND end (recorded by the endpoints via platform-audit).
 *
 * This is the canonical home for the token mint/verify + the request guards.
 * The signed-token format is unchanged from the inline impl in super-admin.ts /
 * wa-calling.ts, so it interoperates with tokens already minted.
 *
 * WIRE(naruto):
 *   - super-admin.ts POST /tenants/:id/impersonate should mint via
 *     `mintImpersonationToken()` instead of its inline HMAC (behaviour identical).
 *   - Any platform/tenant route that a support session can reach should chain
 *     `attachImpersonation` (populate req.impersonator*) then
 *     `impersonationWriteGuard` on its MUTATION handlers so a read-only session
 *     cannot write. wa-calling.ts already has a local copy — migrate it to import
 *     from here to kill the duplication.
 *   - The persistent banner UI is the shell agent's job. Expose the current
 *     session to the FE via ImpersonationSession (see FE lib/impersonation.ts
 *     ImpToken — same fields) and render start/reason/expiry/read-only from it.
 */
import type express from 'express'
import { createHmac, timingSafeEqual } from 'crypto'

export const DEFAULT_IMPERSONATION_TTL_MIN = 30

/** Persisted/handed-off impersonation state — the shape the banner renders. */
export interface ImpersonationSession {
  actor: string          // platform user id doing the impersonation
  tenant_id: string      // tenant being acted as
  expires_at: string     // ISO — banner counts down to this
  read_only: boolean     // true by default; false only with approval
  reason: string         // why (required)
  started_at: string     // ISO
}

interface ImpersonationTokenPayload {
  typ: 'imp'
  actor: string
  tenant_id: string
  exp: number            // epoch ms
  read_only: boolean
}

/** Dedicated HMAC secret; falls back to the legacy var for deploy overlap. */
export function impersonationSecret(): string | null {
  const s = process.env.IMPERSONATION_HMAC_SECRET ?? process.env.GOOGLE_TOKEN_SECRET
  return s && s.length >= 32 ? s : null
}

/**
 * Mint a signed, short-lived impersonation token. read-only unless explicitly
 * opted out (which the caller must gate behind owner approval).
 */
export function mintImpersonationToken(args: {
  actor: string; tenant_id: string; reason: string; ttlMinutes?: number; readOnly?: boolean
}): { token: string; expires_at: string; session: ImpersonationSession } {
  const secret = impersonationSecret()
  if (!secret) throw new Error('IMPERSONATION_HMAC_SECRET missing or <32 chars')
  const ttl = args.ttlMinutes && args.ttlMinutes > 0 ? args.ttlMinutes : DEFAULT_IMPERSONATION_TTL_MIN
  const readOnly = args.readOnly !== true ? true : false   // default read-only
  const exp = Date.now() + ttl * 60 * 1000
  const payload: ImpersonationTokenPayload = {
    typ: 'imp', actor: args.actor, tenant_id: args.tenant_id, exp, read_only: readOnly,
  }
  const data = Buffer.from(JSON.stringify(payload)).toString('base64url')
  const sig = createHmac('sha256', secret).update(data).digest('base64url')
  const startedAt = new Date().toISOString()
  const expiresAt = new Date(exp).toISOString()
  return {
    token: `${data}.${sig}`,
    expires_at: expiresAt,
    session: {
      actor: args.actor, tenant_id: args.tenant_id, expires_at: expiresAt,
      read_only: readOnly, reason: args.reason, started_at: startedAt,
    },
  }
}

/**
 * Verify a raw `X-Impersonate-Token`. Returns the payload on success, or a
 * reason code on failure. Pure — no express, timing-safe signature compare.
 */
export function verifyImpersonationToken(raw: string):
  | { ok: true; payload: ImpersonationTokenPayload }
  | { ok: false; code: 'invalid' | 'expired' | 'misconfigured' } {
  const secret = impersonationSecret()
  if (!secret) return { ok: false, code: 'misconfigured' }
  const [data, sig] = raw.split('.')
  if (!data || !sig) return { ok: false, code: 'invalid' }
  const expected = createHmac('sha256', secret).update(data).digest('base64url')
  let sigOk = false
  if (sig.length === expected.length) {
    try { sigOk = timingSafeEqual(Buffer.from(sig, 'utf8'), Buffer.from(expected, 'utf8')) } catch { sigOk = false }
  }
  if (!sigOk) return { ok: false, code: 'invalid' }
  let payload: any
  try { payload = JSON.parse(Buffer.from(data, 'base64url').toString('utf8')) } catch { return { ok: false, code: 'invalid' } }
  if (payload?.typ !== 'imp' || !payload?.actor || !payload?.tenant_id) return { ok: false, code: 'invalid' }
  if (typeof payload.exp === 'number' && payload.exp < Date.now()) return { ok: false, code: 'expired' }
  return { ok: true, payload: payload as ImpersonationTokenPayload }
}

/**
 * Middleware: if an `X-Impersonate-Token` is present, verify it and populate
 * req.impersonatorId / req.impersonatedTenantId / req.impersonationReadOnly.
 * Absent → no-op. Malformed/expired → 401 (never silently fall through to the
 * platform user's own scope). Canonical replacement for the wa-calling copy.
 */
export function attachImpersonation(req: express.Request, res: express.Response, next: express.NextFunction) {
  const raw = req.headers['x-impersonate-token'] as string | undefined
  if (!raw) { next(); return }
  const v = verifyImpersonationToken(raw)
  if (!v.ok) {
    const status = v.code === 'misconfigured' ? 503 : 401
    res.status(status).json({ error: `impersonation_token_${v.code}`, code: `impersonation_token_${v.code}` })
    return
  }
  ;(req as any).impersonatorId        = String(v.payload.actor)
  ;(req as any).impersonatedTenantId  = String(v.payload.tenant_id)
  ;(req as any).impersonationReadOnly = v.payload.read_only !== false
  next()
}

/**
 * Middleware: block writes while impersonating read-only. Chain AFTER
 * attachImpersonation on mutation handlers. A non-impersonated request passes
 * straight through (this guard only fires when an impersonation token is active).
 */
export function impersonationWriteGuard(req: express.Request, res: express.Response, next: express.NextFunction) {
  if ((req as any).impersonatorId && (req as any).impersonationReadOnly) {
    res.status(403).json({
      error: 'Read-only impersonation session — writes are blocked. Elevate to write-mode (owner approval) first.',
      code: 'impersonation_read_only',
    })
    return
  }
  next()
}

/**
 * The one path exempt from the global write block: ending the session must
 * work even though the session is read-only (impersonation-tenant-view §BE-01).
 */
const IMPERSONATION_STOP_PATH = '/api/super-admin/impersonate/stop'
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])

/**
 * Global gate — mount with `app.use(impersonationGate)` ahead of every route.
 * No `X-Impersonate-Token` header: no-op, byte-identical behaviour for every
 * existing caller. A present header is verified (invalid → 401, expired →
 * 401, no HMAC secret configured → 503) and, if it verifies, the request is
 * pinned read-only: any method other than GET/HEAD/OPTIONS is refused with
 * 403 `impersonation_read_only`, except the stop endpoint itself (a session
 * must be able to end itself). This is the server-side enforcement that
 * `attachImpersonation` alone does not provide (it populates the flags but
 * never consulted the HTTP method).
 */
export function impersonationGate(req: express.Request, res: express.Response, next: express.NextFunction) {
  const raw = req.headers['x-impersonate-token'] as string | undefined
  if (!raw) { next(); return }
  const v = verifyImpersonationToken(raw)
  if (!v.ok) {
    const status = v.code === 'misconfigured' ? 503 : 401
    res.status(status).json({ error: `impersonation_token_${v.code}`, code: `impersonation_token_${v.code}` })
    return
  }
  ;(req as any).impersonatorId        = String(v.payload.actor)
  ;(req as any).impersonatedTenantId  = String(v.payload.tenant_id)
  ;(req as any).impersonationReadOnly = v.payload.read_only !== false

  const isStop = req.method === 'POST' && req.path === IMPERSONATION_STOP_PATH
  if ((req as any).impersonationReadOnly && !SAFE_METHODS.has(req.method) && !isStop) {
    res.status(403).json({
      error: 'Read-only impersonation session — writes are blocked.',
      code: 'impersonation_read_only',
    })
    return
  }
  next()
}

/** Result of pinning an impersonated request to its tenant — see resolveImpersonatedTenant. */
export type ImpersonatedTenantResolution =
  | { ok: true; tenantId: string }
  | { ok: false; status: number; code: string }

/**
 * Pure resolver for `identifyTenant`'s impersonation branch. No express, no
 * DB — the caller passes in what it already looked up so this stays testable
 * without mocking Supabase. Three ways to fail closed, checked in order:
 *   1. the caller must actually be a platform user (`isPlatform`) — a support
 *      session can never inherit impersonation privileges for a non-platform
 *      account,
 *   2. the token's `actor` must be the signed-in caller (`userId`) — stops a
 *      stolen/leaked token being replayed by a different platform account,
 *   3. an explicit `X-Tenant-ID` header, if the client still sent one, must
 *      agree with the token's tenant — never silently prefer one over the
 *      other.
 * On success the token's tenant wins outright — impersonation always pins to
 * exactly the tenant it was minted for.
 */
export function resolveImpersonatedTenant(args: {
  isPlatform: boolean
  userId: string
  impersonatorId: string
  impersonatedTenantId: string
  headerTenantId?: string
}): ImpersonatedTenantResolution {
  if (!args.isPlatform) return { ok: false, status: 403, code: 'impersonation_not_platform' }
  if (args.impersonatorId !== args.userId) return { ok: false, status: 403, code: 'impersonation_actor_mismatch' }
  if (args.headerTenantId && args.headerTenantId !== args.impersonatedTenantId) {
    return { ok: false, status: 403, code: 'impersonation_tenant_mismatch' }
  }
  return { ok: true, tenantId: args.impersonatedTenantId }
}
