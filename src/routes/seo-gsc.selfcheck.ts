/**
 * Self-check for the pure logic behind Connect Google Search Console (no DB/network).
 * Run with:  npx tsx src/routes/seo-gsc.selfcheck.ts
 * Covers: signed-state sign/verify (valid, tampered, expired), site-URL resolution,
 * and META verification-token extraction.
 */
import assert from 'node:assert'
import crypto from 'node:crypto'

// A known secret so oauth-state's HMAC is deterministic for this run.
process.env.OAUTH_STATE_SECRET = 'selfcheck-oauth-state-secret-0123456789abcdef'

import { signOauthState, verifyOauthState } from '../lib/oauth-state'
import { resolveSiteUrl, extractMetaToken, gscConfigured, type TenantDomain } from './seo-gsc'

// ── State: valid ───────────────────────────────────────────────────────────────
{
  const state = signOauthState({ userId: 'u1', tenantId: 'T1', connectorKey: 'gsc' })
  const p = verifyOauthState(state)
  assert.ok(p, 'valid state verifies')
  assert.equal(p!.u, 'u1')
  assert.equal(p!.t, 'T1')
  assert.equal(p!.k, 'gsc', 'connector key round-trips (callback checks k===gsc)')
}

// ── State: naruto source round-trips (callback returns the operator to /naruto) ──
{
  const state = signOauthState({ userId: 'op1', tenantId: 'T9', connectorKey: 'gsc', src: 'naruto' })
  const p = verifyOauthState(state)
  assert.ok(p, 'naruto-sourced state verifies')
  assert.equal(p!.s, 'naruto', 'src round-trips → callback redirects to /naruto/onboarding/storefront')
  assert.equal(p!.t, 'T9', 'tenant from the super-admin URL param travels in the state')
  // The plain tenant flow must NOT carry a source (keeps the /settings/storefront redirect).
  const plain = verifyOauthState(signOauthState({ userId: 'u1', tenantId: 'T1', connectorKey: 'gsc' }))
  assert.equal(plain!.s, undefined, 'tenant flow has no src')
}

// ── State: tampered → rejected ──────────────────────────────────────────────────
{
  const state = signOauthState({ userId: 'u1', tenantId: 'T1', connectorKey: 'gsc' })
  const flipped = state.slice(0, -2) + (state.endsWith('aa') ? 'bb' : 'aa')
  assert.equal(verifyOauthState(flipped), null, 'tampered signature rejected')
  assert.equal(verifyOauthState('garbage'), null, 'malformed state rejected')
}

// ── State: expired → rejected (forge an already-past expiry with the same secret) ─
{
  const body = { u: 'u1', t: 'T1', n: 'nonce', e: Date.now() - 1_000, k: 'gsc' }
  const blob = Buffer.from(JSON.stringify(body), 'utf8').toString('base64url')
  const sig = crypto.createHmac('sha256', process.env.OAUTH_STATE_SECRET!).update(blob).digest('base64url')
  assert.equal(verifyOauthState(`${blob}.${sig}`), null, 'expired state rejected even with a valid signature')
}

// ── Site-URL resolution ──────────────────────────────────────────────────────────
{
  // No domains → path-based default on order.getfrequency.app.
  const a = resolveSiteUrl('acme', [])
  assert.equal(a.siteUrl, 'https://order.getfrequency.app/acme/')
  assert.equal(a.sitemapUrl, 'https://order.getfrequency.app/acme/sitemap.xml')

  // Verified custom domain wins over the slug default.
  const domains: TenantDomain[] = [
    { hostname: 'unverified.shop', kind: 'custom', verified: false },
    { hostname: 'Shop.Example.COM', kind: 'custom', verified: true },
  ]
  const b = resolveSiteUrl('acme', domains)
  assert.equal(b.siteUrl, 'https://shop.example.com/', 'verified custom domain, lowercased, trailing slash')
  assert.equal(b.sitemapUrl, 'https://shop.example.com/sitemap.xml')

  // A verified 'dashboard' white-label domain must NOT be chosen as the storefront property.
  const c = resolveSiteUrl('acme', [{ hostname: 'admin.example.com', kind: 'dashboard', verified: true }])
  assert.equal(c.siteUrl, 'https://order.getfrequency.app/acme/', 'dashboard-kind domain ignored')
}

// ── META token extraction (getToken responses come in several shapes) ────────────
{
  assert.equal(
    extractMetaToken('<meta name="google-site-verification" content="AbC-123_xyz" />'),
    'AbC-123_xyz', 'full meta tag → content value')
  assert.equal(extractMetaToken('google-site-verification: AbC-123_xyz'), 'AbC-123_xyz', 'colon form')
  assert.equal(extractMetaToken('google-site-verification=AbC-123_xyz'), 'AbC-123_xyz', 'equals form')
  assert.equal(extractMetaToken('AbC-123_xyz'), 'AbC-123_xyz', 'bare token passes through')
  assert.equal(extractMetaToken(''), '', 'empty → empty')
  assert.equal(extractMetaToken(null), '', 'null → empty')
  assert.equal(extractMetaToken('<meta name="other" >'), '', 'no usable token → empty')
}

// ── Dormant switch ────────────────────────────────────────────────────────────────
{
  const savedId = process.env.GOOGLE_OAUTH_CLIENT_ID
  const savedSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET
  delete process.env.GOOGLE_OAUTH_CLIENT_ID
  delete process.env.GOOGLE_OAUTH_CLIENT_SECRET
  assert.equal(gscConfigured(), false, 'dormant when creds unset')
  process.env.GOOGLE_OAUTH_CLIENT_ID = 'id'; process.env.GOOGLE_OAUTH_CLIENT_SECRET = 'secret'
  assert.equal(gscConfigured(), true, 'live when both creds set')
  if (savedId === undefined) delete process.env.GOOGLE_OAUTH_CLIENT_ID; else process.env.GOOGLE_OAUTH_CLIENT_ID = savedId
  if (savedSecret === undefined) delete process.env.GOOGLE_OAUTH_CLIENT_SECRET; else process.env.GOOGLE_OAUTH_CLIENT_SECRET = savedSecret
}

console.log('seo-gsc.selfcheck: OK')
