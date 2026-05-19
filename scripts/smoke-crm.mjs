#!/usr/bin/env node
/**
 * Live smoke test for the Sales CRM Lite endpoints (P2 #22):
 *   GET    /api/crm/stages            — auto-seeds defaults on first call
 *   POST   /api/crm/deals             — create a deal against an existing contact
 *   PATCH  /api/crm/deals/:id         — move to a won stage; expects 'won' event + closed_at
 *   GET    /api/crm/pipeline-summary  — per-stage counts + tenant totals
 *
 * Cleans up after itself: deletes the test deal at the end so repeated runs
 * stay idempotent and the operator's real board isn't polluted.
 *
 *   node scripts/smoke-crm.mjs
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

const tenantRes = await fetch(`${SUPABASE_URL}/rest/v1/tenants?select=id,status&limit=5`, {
  headers: { 'apikey': ANON_KEY, 'Authorization': `Bearer ${accessToken}` },
})
const tenants = await tenantRes.json()
if (!Array.isArray(tenants) || tenants.length === 0) {
  console.error('no tenants visible for', EMAIL); process.exit(3)
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
  console.log(JSON.stringify(body, null, 2).split('\n').slice(0, 30).map(l => '  ' + l).join('\n'))
  return { status: res.status, body }
}

// ── 1. Stages (auto-seed on first hit) ──────────────────────────────────────
const stagesRes = await hit('/api/crm/stages', 'GET /api/crm/stages (auto-seed)')
if (stagesRes.status !== 200 || !Array.isArray(stagesRes.body) || stagesRes.body.length === 0) {
  console.error('FAIL: stages not seeded')
  process.exit(10)
}
const wonStage = stagesRes.body.find(s => s.is_won)
const firstActive = stagesRes.body.find(s => !s.is_won && !s.is_lost)
if (!wonStage || !firstActive) {
  console.error('FAIL: expected won stage + active stage in seed')
  process.exit(11)
}
console.log(`  ✓ seeded ${stagesRes.body.length} stages; won_stage=${wonStage.name} id=${wonStage.id}`)

// ── 2. Pick a contact in this tenant for the deal ───────────────────────────
const cRes = await fetch(`${SUPABASE_URL}/rest/v1/contacts?select=id,name&limit=1`, {
  headers: { 'apikey': ANON_KEY, 'Authorization': `Bearer ${accessToken}` },
})
const cRows = await cRes.json()
if (!Array.isArray(cRows) || cRows.length === 0) {
  console.error('FAIL: no contacts in tenant to attach a deal to')
  process.exit(12)
}
const contactId = cRows[0].id
console.log(`  ✓ contact=${contactId} (${cRows[0].name})`)

// ── 3. POST /api/crm/deals → 201 ────────────────────────────────────────────
const createRes = await hit('/api/crm/deals', 'POST /api/crm/deals', {
  method: 'POST',
  body: JSON.stringify({
    contact_id: contactId,
    title: 'SMOKE — CRM Lite test deal',
    value_inr_paise: 5_00_000_00, // ₹5,00,000
  }),
})
if (createRes.status !== 201 || !createRes.body?.id) {
  console.error('FAIL: deal not created')
  process.exit(13)
}
const dealId = createRes.body.id
console.log(`  ✓ deal_id=${dealId}`)

// ── 4. PATCH /api/crm/deals/:id → won stage ─────────────────────────────────
const patchRes = await hit(`/api/crm/deals/${dealId}`, `PATCH → won_stage`, {
  method: 'PATCH',
  body: JSON.stringify({ stage_id: wonStage.id }),
})
if (patchRes.status !== 200) {
  console.error('FAIL: PATCH failed')
  process.exit(14)
}
if (!patchRes.body?.closed_at) {
  console.error('FAIL: moving to won stage should set closed_at')
  process.exit(15)
}
console.log(`  ✓ closed_at=${patchRes.body.closed_at}`)

// ── 5. GET /api/crm/deals/:id → check events include 'won' ──────────────────
const detailRes = await hit(`/api/crm/deals/${dealId}`, 'GET /api/crm/deals/:id (events)')
if (detailRes.status !== 200) { console.error('FAIL: detail failed'); process.exit(16) }
const events = detailRes.body?.events ?? []
const wonEvent = events.find(e => e.event_type === 'won')
if (!wonEvent) {
  console.error('FAIL: expected a "won" event in crm_deal_events')
  console.error('  events:', events.map(e => e.event_type).join(', '))
  process.exit(17)
}
console.log(`  ✓ won event logged at ${wonEvent.occurred_at}`)

// ── 6. GET /api/crm/pipeline-summary ────────────────────────────────────────
const sumRes = await hit('/api/crm/pipeline-summary', 'GET /api/crm/pipeline-summary')
if (sumRes.status !== 200) { console.error('FAIL: summary failed'); process.exit(18) }
if (!Array.isArray(sumRes.body?.stages)) {
  console.error('FAIL: summary.stages should be an array')
  process.exit(19)
}
console.log(`  ✓ summary returned ${sumRes.body.stages.length} stages; won_last_30d=${sumRes.body.won_last_30d}`)

// ── 7. Cleanup ──────────────────────────────────────────────────────────────
const delRes = await hit(`/api/crm/deals/${dealId}`, 'DELETE /api/crm/deals/:id (cleanup)', {
  method: 'DELETE',
})
if (delRes.status !== 200) {
  console.warn('  ⚠ cleanup delete returned', delRes.status, '— manual cleanup may be needed')
}

console.log('\n✅ CRM Lite smoke passed.')
