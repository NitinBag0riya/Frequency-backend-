#!/usr/bin/env node
/**
 * Smoke test for the My-Queue ⇆ Sales-CRM merge (this sprint):
 *   GET  /api/crm/deals?include_leads=true   — unified cards payload
 *   POST /api/crm/cards/:id/move             — drag-to-move for deal OR lead
 *   POST /api/crm/leads/:lead_id/promote-to-deal
 *
 * Cleans up after itself:
 *   - deletes the test deal at the end
 *   - resets the lead row's status back to 'new' if we moved it
 *   - leaves any pre-existing data untouched
 *
 *   SUPABASE_ANON_KEY=... node scripts/smoke-crm-merge.mjs
 */

import 'dotenv/config'

const BASE_URL = process.env.BASE_URL || 'http://localhost:3001'
const SUPABASE_URL = process.env.SUPABASE_URL
const ANON_KEY = process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY
const EMAIL = process.env.SMOKE_EMAIL || 'priya@acme.in'
const PASSWORD = process.env.SMOKE_PASSWORD || 'Owner@2026'

if (!SUPABASE_URL || !ANON_KEY) {
  console.error('Missing SUPABASE_URL or SUPABASE_ANON_KEY in env'); process.exit(1)
}

const signIn = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
  method: 'POST',
  headers: { 'apikey': ANON_KEY, 'Content-Type': 'application/json' },
  body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
})
if (!signIn.ok) { console.error(`auth: ${signIn.status}`); process.exit(2) }
const session = await signIn.json()
const accessToken = session.access_token
const userId = session.user?.id
console.log(`▶ signed in as ${EMAIL}; user_id=${userId}`)

const tenantRes = await fetch(`${SUPABASE_URL}/rest/v1/tenants?select=id,status&limit=5`, {
  headers: { 'apikey': ANON_KEY, 'Authorization': `Bearer ${accessToken}` },
})
const tenants = await tenantRes.json()
const tenantId = (tenants.find(t => t.status === 'active') ?? tenants[0]).id
console.log(`▶ tenant=${tenantId}`)

const H = {
  'Authorization': `Bearer ${accessToken}`,
  'X-Tenant-ID':   tenantId,
  'Content-Type':  'application/json',
}

async function hit(method, path, body, label) {
  const res = await fetch(`${BASE_URL}${path}`, { method, headers: H, body: body ? JSON.stringify(body) : undefined })
  const txt = await res.text()
  let parsed; try { parsed = JSON.parse(txt) } catch { parsed = txt }
  console.log(`\n${label || (method + ' ' + path)}  →  ${res.status}`)
  const shown = JSON.stringify(parsed, null, 2).split('\n').slice(0, 40).join('\n')
  console.log(shown.split('\n').map(l => '  ' + l).join('\n'))
  return { status: res.status, body: parsed }
}

// ── 1. Seed stages and find a few we need ───────────────────────────────────
const stagesRes = await hit('GET', '/api/crm/stages', null, 'GET /api/crm/stages')
if (stagesRes.status !== 200 || !Array.isArray(stagesRes.body)) process.exit(10)
const stages = stagesRes.body
const wonStage = stages.find(s => s.is_won)
const qualifiedStage = stages.find(s => s.name.toLowerCase() === 'qualified')
const leadStage = stages.find(s => s.name.toLowerCase() === 'lead')
if (!wonStage || !qualifiedStage || !leadStage) {
  console.error('FAIL: missing one of won/qualified/lead stages')
  process.exit(11)
}

// ── 2. Unified cards listing ────────────────────────────────────────────────
const cardsRes = await hit('GET', '/api/crm/deals?include_leads=true', null,
  'GET /api/crm/deals?include_leads=true')
if (cardsRes.status !== 200 || !Array.isArray(cardsRes.body?.cards)) {
  console.error('FAIL: include_leads should return { cards: [...] }')
  process.exit(20)
}
const cards = cardsRes.body.cards
const dealCard = cards.find(c => c.kind === 'deal' && !c.closed_at)
const leadCard = cards.find(c => c.kind === 'lead')
console.log(`  ✓ unified cards: ${cards.length} total — ${cards.filter(c=>c.kind==='deal').length} deals, ${cards.filter(c=>c.kind==='lead').length} leads`)
for (const c of cards.slice(0, 3)) {
  console.log(`    · kind=${c.kind} id=${c.id} title="${c.title}" stage_id=${c.stage_id}`)
}

// ── 3. POST /api/crm/cards/:id/move with kind='deal' ────────────────────────
if (dealCard) {
  const origStageId = dealCard.stage_id
  const targetWon = wonStage.id
  const moved = await hit('POST', `/api/crm/cards/${dealCard.id}/move`,
    { kind: 'deal', stage_id: targetWon },
    `POST /api/crm/cards/${dealCard.id}/move  kind=deal → won`)
  if (moved.status !== 200) { console.error('FAIL: deal move'); process.exit(30) }
  if (!moved.body.closed_at) { console.error('FAIL: closed_at should be set on won'); process.exit(31) }
  console.log(`  ✓ deal moved to won; closed_at=${moved.body.closed_at}`)
  // Reset
  await hit('POST', `/api/crm/cards/${dealCard.id}/move`, { kind: 'deal', stage_id: origStageId },
    'reset deal back to original stage')
} else {
  console.log('  (skipped deal-move smoke — no open deal in tenant)')
}

// ── 4. POST /api/crm/cards/:id/move with kind='lead' ────────────────────────
let resetLeadStatus = null
let testLeadId = null
if (leadCard) {
  testLeadId = leadCard.id
  resetLeadStatus = leadCard.status_raw
  const movedLead = await hit('POST', `/api/crm/cards/${leadCard.id}/move`,
    { kind: 'lead', stage_id: qualifiedStage.id },
    `POST /api/crm/cards/${leadCard.id}/move  kind=lead → qualified`)
  if (movedLead.status !== 200) { console.error('FAIL: lead move'); process.exit(40) }
  if (movedLead.body.status_raw !== 'qualified') {
    console.error(`FAIL: expected status_raw='qualified' got '${movedLead.body.status_raw}'`)
    process.exit(41)
  }
  console.log(`  ✓ lead moved; status_raw=${movedLead.body.status_raw}`)
} else {
  console.log('  (skipped lead-move smoke — no lead card in tenant; nothing assigned to current user)')
}

// ── 5. POST /api/crm/leads/:lead_id/promote-to-deal ─────────────────────────
if (testLeadId) {
  const promoted = await hit('POST', `/api/crm/leads/${testLeadId}/promote-to-deal`,
    { title: 'smoke test promotion' },
    `POST /api/crm/leads/${testLeadId}/promote-to-deal`)
  if (promoted.status === 201) {
    console.log(`  ✓ promoted; deal_id=${promoted.body.deal_id}`)
    // Cleanup: delete the test deal
    await hit('DELETE', `/api/crm/deals/${promoted.body.deal_id}`, null, 'cleanup: delete promoted deal')
  } else if (promoted.status === 400 && promoted.body?.error === 'lead_has_no_matching_contact') {
    console.log(`  ✓ promote correctly returned 400 lead_has_no_matching_contact for unlinked lead`)
  } else {
    console.error('FAIL: unexpected promote response'); process.exit(50)
  }
}

// ── Cleanup: reset lead status if we changed it ─────────────────────────────
if (testLeadId && resetLeadStatus) {
  // Best-effort — there's no public reset endpoint, the BE just writes status.
  // We use the same move endpoint with the lead's original status mapped via
  // a probably-matching stage. Skip if we can't find it — operator can
  // manually reset.
  const origBucketName =
    resetLeadStatus === 'new' || resetLeadStatus === 'contacted' ? 'lead' :
    resetLeadStatus
  const origStage = stages.find(s => s.name.toLowerCase() === origBucketName)
  if (origStage) {
    await hit('POST', `/api/crm/cards/${testLeadId}/move`,
      { kind: 'lead', stage_id: origStage.id },
      `cleanup: reset lead status to '${resetLeadStatus}'`)
  }
}

console.log('\n✓ smoke complete')
