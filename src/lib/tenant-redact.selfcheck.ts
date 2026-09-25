/**
 * Self-check for toAdminTenant — the shared redactor for every tenant row
 * that reaches a platform-console browser. This is the fix for a LIVE PROD
 * secret leak (super-admin.ts:255/:351, admin.ts:39, naruto-tenants.ts:219
 * were shipping raw WhatsApp/Google/GBP tokens + the WA webhook auth token).
 *
 *   1. Every secret column, present on the fixture, must be gone from the
 *      output — not just absent as a key, but absent from the *value* too
 *      (JSON.stringify check catches nesting/aliasing).
 *   2. An invented FUTURE secret column must also be dropped. This is what
 *      proves it's an allowlist, not a denylist — a later migration that
 *      adds `some_new_api_secret` can't leak by construction.
 *   3. The has_* presence booleans must reflect the raw row without leaking
 *      the value itself.
 *   4. Source-pin: super-admin.ts, admin.ts, naruto-tenants.ts must each
 *      call `toAdminTenant(` in source. Stops a later refactor from quietly
 *      reverting to the raw row.
 *
 * Run: npx tsx src/lib/tenant-redact.selfcheck.ts
 */
import assert from 'assert'
import fs from 'fs'
import path from 'path'
import { toAdminTenant, SECRET_KEYS, ADMIN_TENANT_FIELDS } from './tenant-redact'

// ── 1/2/3. Full fixture: every secret set, plus an invented future secret ──
const SECRET_VALUES: Record<string, string> = {
  access_token: 'EAAG-wa-secret-token-abc123',
  google_access_token: 'ya29-google-access-secret',
  google_refresh_token: '1//google-refresh-secret',
  google_token_expiry: '2099-01-01T00:00:00.000Z',
  gbp_refresh_token: 'gbp-refresh-secret-xyz',
  wa_app_secret_enc: 'enc:wa-app-secret-payload',
  wa_webhook_token: 'whk_super-secret-webhook-token',
}
assert.deepStrictEqual(Object.keys(SECRET_VALUES).sort(), [...SECRET_KEYS].sort(),
  'SECRET_VALUES fixture drifted from SECRET_KEYS — keep them in lockstep')

const fixture = {
  id: 't1', slug: 'acme', business_name: 'Acme Co', business_type: 'horeca',
  status: 'active', lifecycle_state: 'live', state_entered_at: '2026-01-01',
  display_phone: '+911234567890', waba_id: 'waba_1', user_id: 'u1',
  created_at: '2026-01-01', deleted_at: null, last_active_at: '2026-09-01',
  timezone: 'Asia/Kolkata', currency: 'INR', gstin: 'GSTIN123',
  billing_email: 'b@acme.example', billing_address: '221B Baker St',
  google_email: 'ops@acme.example',
  tenant_subscriptions: [{ plan_id: 'p1' }],
  tenant_entitlements: [{ feature: 'loyalty', is_enabled: true }],
  gmail_history_id: 'drop-me-not-in-allowlist', // dropped: not secret, just not needed
  billing_pincode: '400001',                    // dropped: same
  zz_future_api_secret: 'a-secret-column-that-does-not-exist-yet',
  ...SECRET_VALUES,
}

const out = toAdminTenant(fixture)
assert.ok(out, 'toAdminTenant(fixture) must not be null')

// No secret key survives.
for (const k of SECRET_KEYS) {
  assert.ok(!(k in (out as any)), `secret key "${k}" leaked into output keys`)
}
// The invented future secret is gone too — proves allowlist, not denylist.
assert.ok(!('zz_future_api_secret' in (out as any)), 'unknown future column leaked — this must be an allowlist')
// Non-essential, non-secret columns not in the allowlist are dropped too.
assert.ok(!('gmail_history_id' in (out as any)))
assert.ok(!('billing_pincode' in (out as any)))

// Every surviving key is either an allowlisted field or a has_* flag.
const allowedKeys = new Set([...ADMIN_TENANT_FIELDS, 'has_wa_token', 'has_google_token', 'has_gbp_token', 'wa_byo_configured'])
for (const k of Object.keys(out as any)) {
  assert.ok(allowedKeys.has(k as any), `unexpected key "${k}" in toAdminTenant output`)
}

// Nesting/aliasing check: no secret VALUE anywhere in the serialized output.
const serialized = JSON.stringify(out)
for (const [k, v] of Object.entries(SECRET_VALUES)) {
  assert.ok(!serialized.includes(v), `secret value for "${k}" found in JSON.stringify(toAdminTenant(...))`)
}
assert.ok(!serialized.includes(fixture.zz_future_api_secret))

// Presence booleans reflect the raw row.
assert.strictEqual((out as any).has_wa_token, true)
assert.strictEqual((out as any).has_google_token, true)
assert.strictEqual((out as any).has_gbp_token, true)
assert.strictEqual((out as any).wa_byo_configured, true)

// ── 4. Bare-minimum row: booleans flip false, non-secret allowlist fields absent-but-safe.
const bare = toAdminTenant({ id: 't2' })
assert.ok(bare)
assert.strictEqual((bare as any).id, 't2')
assert.strictEqual((bare as any).has_wa_token, false)
assert.strictEqual((bare as any).has_google_token, false)
assert.strictEqual((bare as any).has_gbp_token, false)
assert.strictEqual((bare as any).wa_byo_configured, false)

// null in, null out.
assert.strictEqual(toAdminTenant(null), null)
assert.strictEqual(toAdminTenant(undefined), null)

// ── 5. Source-pin: pin the call COUNT per file, not just presence. A file
// that drops one of two call sites (e.g. the export wrap) still "contains"
// the string once, so presence alone would miss a partial revert.
// super-admin.ts needs 2 (detail :255 + export :351), the other two need 1.
const root = path.join(__dirname, '..')
const mustCall: Array<[string, number]> = [
  ['routes/super-admin.ts', 2],
  ['admin.ts', 1],
  ['routes/naruto-tenants.ts', 1],
]
for (const [rel, minCalls] of mustCall) {
  const src = fs.readFileSync(path.join(root, rel), 'utf8')
  const calls = (src.match(/toAdminTenant\(/g) ?? []).length
  assert.ok(calls >= minCalls,
    `${rel} calls toAdminTenant( only ${calls}x, need >=${minCalls} — secret leak regression (partial revert?)`)
}

console.log('tenant-redact.selfcheck: OK')
