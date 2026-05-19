#!/usr/bin/env node
/**
 * Live smoke test for the wedge-surface endpoints:
 *   GET  /api/me/markup-saved
 *   GET  /api/me/sla-today
 *   POST /api/contacts/:id/consent
 *   POST /api/campaigns/:id/resume   (will 404/409 if no paused campaign)
 *
 * Authenticates as priya@acme.in (the seeded tenant owner). Run from
 * a worktree where the BE server is up at $BASE_URL (default 3001):
 *
 *   node scripts/smoke-wedge-surface.mjs
 *   BASE_URL=https://api.beta.getfrequency.app node scripts/smoke-wedge-surface.mjs
 */

import 'dotenv/config'

const BASE_URL = process.env.BASE_URL || 'http://localhost:3001'
const SUPABASE_URL = process.env.SUPABASE_URL
const ANON_KEY = process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY
const EMAIL = process.env.SMOKE_EMAIL || 'priya@acme.in'
const PASSWORD = process.env.SMOKE_PASSWORD || 'Owner@2026'

if (!SUPABASE_URL || !ANON_KEY) {
  console.error('Missing SUPABASE_URL or SUPABASE_ANON_KEY in env')
  process.exit(1)
}

// Sign in via Supabase Auth REST API to get a JWT.
const signInRes = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
  method: 'POST',
  headers: { 'apikey': ANON_KEY, 'Content-Type': 'application/json' },
  body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
})
if (!signInRes.ok) {
  console.error(`auth failed: ${signInRes.status} ${await signInRes.text()}`)
  process.exit(2)
}
const session = await signInRes.json()
const accessToken = session.access_token

// Resolve the tenant id — pick the first tenant visible to this user via
// RLS. `tenants` doesn't have a `name` column on this schema (business
// label lives elsewhere); we just grab the id + status.
const tenantRes = await fetch(`${SUPABASE_URL}/rest/v1/tenants?select=id,status&limit=5`, {
  headers: { 'apikey': ANON_KEY, 'Authorization': `Bearer ${accessToken}` },
})
const tenants = await tenantRes.json()
if (!Array.isArray(tenants) || tenants.length === 0) {
  console.error('no tenants visible for', EMAIL, '— RLS or empty seed?')
  console.error('raw response:', JSON.stringify(tenants))
  process.exit(3)
}
const active = tenants.find(t => t.status === 'active') ?? tenants[0]
const tenantId = active.id
console.log(`▶ tenant=${tenantId} status=${active.status}`)

const headers = {
  'Authorization': `Bearer ${accessToken}`,
  'X-Tenant-ID':   tenantId,
  'Content-Type':  'application/json',
}

async function hit(path, label, opts = {}) {
  const res = await fetch(`${BASE_URL}${path}`, { headers, ...opts })
  const txt = await res.text()
  let body
  try { body = JSON.parse(txt) } catch { body = txt }
  console.log(`\n${label}  →  ${res.status}`)
  console.log(JSON.stringify(body, null, 2).split('\n').map(l => '  ' + l).join('\n'))
  return { status: res.status, body }
}

await hit('/api/me/markup-saved', 'GET /api/me/markup-saved (default vs=wati)')
await hit('/api/me/markup-saved?vs=interakt', 'GET /api/me/markup-saved?vs=interakt')
await hit('/api/me/markup-saved?vs=aisensy', 'GET /api/me/markup-saved?vs=aisensy')
await hit('/api/me/sla-today', 'GET /api/me/sla-today')

// Best-effort consent capture against the first contact in this tenant
// (only if any exist).
const cRes = await fetch(`${SUPABASE_URL}/rest/v1/contacts?select=id&limit=1`, {
  headers: { 'apikey': ANON_KEY, 'Authorization': `Bearer ${accessToken}` },
})
const cRows = await cRes.json()
if (Array.isArray(cRows) && cRows.length > 0) {
  await hit(`/api/contacts/${cRows[0].id}/consent`,
    `POST /api/contacts/${cRows[0].id}/consent`,
    { method: 'POST', body: JSON.stringify({ source: 'smoke_test', method: 'inline' }) })
} else {
  console.log('\n(no contacts to smoke consent against — skipping)')
}

// Resume attempt — will 404/409 normally because no campaign is paused
// in seed data. Just exercising the route.
const camRes = await fetch(`${SUPABASE_URL}/rest/v1/campaigns?select=id,status&limit=1`, {
  headers: { 'apikey': ANON_KEY, 'Authorization': `Bearer ${accessToken}` },
})
const camRows = await camRes.json()
if (Array.isArray(camRows) && camRows.length > 0) {
  await hit(`/api/campaigns/${camRows[0].id}/resume`,
    `POST /api/campaigns/${camRows[0].id}/resume (expected 409 unless paused)`,
    { method: 'POST', body: '{}' })
}

console.log('\n✓ smoke done')
