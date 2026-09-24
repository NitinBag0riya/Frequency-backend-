/**
 * Runnable self-check for the impersonation server-side enforcement
 * (impersonation-tenant-view §BE-01). No DB, no express server — the gate
 * and resolver are pure enough to drive with mock req/res.
 * Run:  npx tsx src/lib/platform-impersonation.selfcheck.ts
 */
import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import {
  mintImpersonationToken,
  impersonationGate,
  resolveImpersonatedTenant,
} from './platform-impersonation'

process.env.IMPERSONATION_HMAC_SECRET = 'selfcheck-secret-at-least-32-characters-long'

/** Build an already-expired token — mintImpersonationToken ignores ttlMinutes<=0. */
function forgeExpiredToken(): string {
  const payload = { typ: 'imp', actor: 'platform-1', tenant_id: 'tenant-a', exp: Date.now() - 1000, read_only: true }
  const data = Buffer.from(JSON.stringify(payload)).toString('base64url')
  const sig = createHmac('sha256', process.env.IMPERSONATION_HMAC_SECRET!).update(data).digest('base64url')
  return `${data}.${sig}`
}

function mockRes() {
  const res: any = { statusCode: 200, body: undefined }
  res.status = (code: number) => { res.statusCode = code; return res }
  res.json = (body: unknown) => { res.body = body; return res }
  return res
}

function mockReq(opts: { method: string; path: string; token?: string; tenantIdHeader?: string }) {
  const headers: Record<string, string> = {}
  if (opts.token) headers['x-impersonate-token'] = opts.token
  if (opts.tenantIdHeader) headers['x-tenant-id'] = opts.tenantIdHeader
  return { method: opts.method, path: opts.path, headers } as any
}

function runGate(req: any) {
  const res = mockRes()
  let calledNext = false
  impersonationGate(req, res, () => { calledNext = true })
  return { req, res, calledNext }
}

// 1. No header → pass-through, byte-identical (no res call, next called).
{
  const req = mockReq({ method: 'POST', path: '/api/contacts' })
  const { res, calledNext } = runGate(req)
  assert.equal(calledNext, true)
  assert.equal(res.body, undefined)
  assert.equal(req.impersonatorId, undefined)
}

// 2. Forged signature → 401 invalid.
{
  const req = mockReq({ method: 'GET', path: '/api/contacts', token: 'ZmFrZQ.forgedsig' })
  const { res, calledNext } = runGate(req)
  assert.equal(calledNext, false)
  assert.equal(res.statusCode, 401)
  assert.equal(res.body.code, 'impersonation_token_invalid')
}

// 3. Expired token → 401 expired.
{
  const req = mockReq({ method: 'GET', path: '/api/contacts', token: forgeExpiredToken() })
  const { res, calledNext } = runGate(req)
  assert.equal(calledNext, false)
  assert.equal(res.statusCode, 401)
  assert.equal(res.body.code, 'impersonation_token_expired')
}

// Happy-path token reused below.
const live = mintImpersonationToken({ actor: 'platform-1', tenant_id: 'tenant-a', reason: 'support' })

// 4. Read-only POST → 403 impersonation_read_only.
{
  const req = mockReq({ method: 'POST', path: '/api/contacts', token: live.token })
  const { res, calledNext } = runGate(req)
  assert.equal(calledNext, false)
  assert.equal(res.statusCode, 403)
  assert.equal(res.body.code, 'impersonation_read_only')
}

// 5. GET passes.
{
  const req = mockReq({ method: 'GET', path: '/api/contacts', token: live.token })
  const { res, calledNext } = runGate(req)
  assert.equal(calledNext, true)
  assert.equal(res.body, undefined)
  assert.equal(req.impersonatorId, 'platform-1')
  assert.equal(req.impersonatedTenantId, 'tenant-a')
  assert.equal(req.impersonationReadOnly, true)
}

// 6. Stop endpoint is exempt even though it's a POST.
{
  const req = mockReq({ method: 'POST', path: '/api/super-admin/impersonate/stop', token: live.token })
  const { res, calledNext } = runGate(req)
  assert.equal(calledNext, true)
  assert.equal(res.body, undefined)
}

// 7. Missing secret → 503, not 401 (fail loud, distinguish misconfiguration).
{
  delete process.env.IMPERSONATION_HMAC_SECRET
  const req = mockReq({ method: 'GET', path: '/api/contacts', token: live.token })
  const { res, calledNext } = runGate(req)
  assert.equal(calledNext, false)
  assert.equal(res.statusCode, 503)
  process.env.IMPERSONATION_HMAC_SECRET = 'selfcheck-secret-at-least-32-characters-long'
}

// ── resolveImpersonatedTenant (the identifyTenant branch) ─────────────────

// 8. Non-platform caller (token forged/replayed onto a regular account) → 403.
assert.deepEqual(
  resolveImpersonatedTenant({ isPlatform: false, userId: 'u1', impersonatorId: 'u1', impersonatedTenantId: 't-a' }),
  { ok: false, status: 403, code: 'impersonation_not_platform' },
)

// 9. Actor mismatch — token minted for a different platform user → 403.
assert.deepEqual(
  resolveImpersonatedTenant({ isPlatform: true, userId: 'u2', impersonatorId: 'u1', impersonatedTenantId: 't-a' }),
  { ok: false, status: 403, code: 'impersonation_actor_mismatch' },
)

// 10. Caller still sent X-Tenant-ID and it disagrees with the token → 403.
assert.deepEqual(
  resolveImpersonatedTenant({
    isPlatform: true, userId: 'u1', impersonatorId: 'u1', impersonatedTenantId: 't-a', headerTenantId: 't-b',
  }),
  { ok: false, status: 403, code: 'impersonation_tenant_mismatch' },
)

// 11. Happy path — platform actor matches, no conflicting header → pinned to the token tenant.
assert.deepEqual(
  resolveImpersonatedTenant({ isPlatform: true, userId: 'u1', impersonatorId: 'u1', impersonatedTenantId: 't-a' }),
  { ok: true, tenantId: 't-a' },
)

// 12. Happy path — header present but agrees with the token → still fine.
assert.deepEqual(
  resolveImpersonatedTenant({
    isPlatform: true, userId: 'u1', impersonatorId: 'u1', impersonatedTenantId: 't-a', headerTenantId: 't-a',
  }),
  { ok: true, tenantId: 't-a' },
)

console.log('platform-impersonation.selfcheck: OK')
