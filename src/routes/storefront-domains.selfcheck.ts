/**
 * Self-check for T0.3 — the /api/storefront/admin/pos/* proxy must 403 a
 * tenant lacking the `pos` entitlement, on top of (not instead of) the
 * existing checks. Boots the REAL router (createStorefrontDomainsRouter) on a
 * scratch localhost port with a fake Supabase client + a stubbed upstream
 * fetch (no real DB, no real storefront-api process needed).
 *
 *   npx tsx src/routes/storefront-domains.selfcheck.ts
 *
 * Proven to FAIL on the pre-T0.3 code (no entitlement guard → 200 through the
 * proxy for a tenant without `pos`); passes once the guard is added.
 */
import assert from 'node:assert'
import http, { type Server } from 'node:http'
import express from 'express'
import { createStorefrontDomainsRouter } from './storefront-domains'
import { invalidateFeaturesCache } from '../lib/entitlements'

// A plain node:http client for driving the test server — deliberately NOT
// `fetch`, because the route handler under test also calls the bare `fetch`
// identifier (to reach the upstream storefront-api) and we stub THAT global
// below. Sharing one client would make our own request loop back into the
// stub instead of hitting the server.
function request(url: string, opts: { method: string; body?: any }): Promise<{ status: number; json: any }> {
  return new Promise((resolve, reject) => {
    const payload = opts.body ? JSON.stringify(opts.body) : undefined
    const req = http.request(url, { method: opts.method, headers: { 'Content-Type': 'application/json' } }, (res) => {
      let raw = ''
      res.on('data', (d) => (raw += d))
      res.on('end', () => {
        let json: any = null
        try { json = JSON.parse(raw) } catch { /* non-JSON body */ }
        resolve({ status: res.statusCode || 0, json })
      })
    })
    req.on('error', reject)
    if (payload) req.write(payload)
    req.end()
  })
}

const TENANT_ID = 't-maplemortar'

// ── Fake Supabase: just enough of the chainable builder for the tables this
// route + hasFeature() touch (tenants, tenant_subscriptions, features,
// feature_flags, tenant_entitlements). One row per table, no real DB. ────────
function fakeSupabase(opts: { posEnabled: boolean }) {
  const featureRow = { key: 'pos', verticals: ['horeca'], default_enabled: opts.posEnabled, gate_style: 'hidden' }
  function chain(table: string): any {
    const c: any = {}
    c.select = () => c
    c.eq = () => c
    c.order = () => c
    c.limit = () => c
    c.not = () => c
    c.maybeSingle = () => {
      if (table === 'tenants') return Promise.resolve({ data: { slug: 'maplemortar', business_type: 'restaurant' }, error: null })
      if (table === 'tenant_subscriptions') return Promise.resolve({ data: { plan_id: null, status: null }, error: null })
      return Promise.resolve({ data: null, error: null }) // tenant_entitlements override / plan_features → none
    }
    // features / feature_flags are awaited directly off .select()/.eq() (no maybeSingle)
    c.then = (resolve: any, reject: any) => {
      const data = table === 'features' ? [featureRow] : []
      return Promise.resolve({ data }).then(resolve, reject)
    }
    return c
  }
  return { from: (table: string) => chain(table) } as any
}

async function boot(posEnabled: boolean): Promise<{ url: string; close: () => Promise<void> }> {
  // hasFeature() caches the features table for 60s at module scope — each fake
  // supabase in this file is a fresh in-memory fixture, so drop the cache
  // between boots or a later "true" fixture would read the earlier "false" row.
  invalidateFeaturesCache()
  const app = express()
  app.use(express.json())
  const supabase = fakeSupabase({ posEnabled })
  const requireAuth = (req: any, _res: any, next: any) => { req.user = { id: 'op1', email: 'op@maplemortar.test' }; next() }
  const identifyTenant = (req: any, _res: any, next: any) => { req.tenantId = TENANT_ID; next() }
  app.use(createStorefrontDomainsRouter({ supabase, requireAuth, identifyTenant }))
  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s))
  })
  const addr = server.address()
  const port = typeof addr === 'object' && addr ? addr.port : 0
  return { url: `http://127.0.0.1:${port}`, close: () => new Promise((r) => server.close(() => r())) }
}

async function main() {
  const origFetch = globalThis.fetch
  // Stub the upstream storefront-api hop — an ALLOWED request must not need a
  // real storefront-api process; we're proving the GUARD, not the proxy's
  // happy-path forwarding.
  globalThis.fetch = (async () => new Response(JSON.stringify({ ok: true }), { status: 200 })) as any

  try {
    // ── tenant WITHOUT `pos` entitlement → 403 on /admin/pos/* ────────────────
    {
      const { url, close } = await boot(false)
      try {
        const r = await request(`${url}/api/storefront/admin/pos/order/o1/settle`, {
          method: 'POST', body: { paymentMethod: 'cash' },
        })
        assert.equal(r.status, 403, 'tenant WITHOUT pos entitlement must get 403 on /admin/pos/*')
        assert.ok(/pos/i.test(r.json?.error || ''), 'error message explains the block')
      } finally { await close() }
    }

    // ── tenant WITH `pos` entitlement → passes through to upstream ───────────
    {
      const { url, close } = await boot(true)
      try {
        const r = await request(`${url}/api/storefront/admin/pos/order/o1/settle`, {
          method: 'POST', body: { paymentMethod: 'cash' },
        })
        assert.equal(r.status, 200, 'tenant WITH pos entitlement passes through to upstream')
      } finally { await close() }
    }

    // ── a non-/admin/pos/* admin path is untouched by this guard (additive) ──
    {
      const { url, close } = await boot(false)
      try {
        const r = await request(`${url}/api/storefront/admin/menu`, { method: 'GET' })
        assert.equal(r.status, 200, 'non-pos admin paths are not gated by the pos entitlement')
      } finally { await close() }
    }
  } finally {
    globalThis.fetch = origFetch
  }

  console.log('storefront-domains (T0.3 pos entitlement guard) self-check: OK')
}

main().catch((e) => { console.error(e); process.exit(1) })
