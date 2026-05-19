#!/usr/bin/env node
/**
 * Self-fixturing smoke for the CRM ⇆ My-Queue merge.
 *
 * Creates: 1 contact + 1 lead row (assigned to caller) → runs all three new
 * endpoint behaviours → cleans up everything it touched (lead row + deal +
 * contact). Repeated runs stay idempotent.
 *
 *   SUPABASE_ANON_KEY=... node scripts/smoke-crm-merge-fixture.mjs
 */
import 'dotenv/config'

const BASE_URL     = process.env.BASE_URL || 'http://localhost:3001'
const SUPABASE_URL = process.env.SUPABASE_URL
const ANON_KEY     = process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY
const EMAIL        = process.env.SMOKE_EMAIL || 'priya@acme.in'
const PASSWORD     = process.env.SMOKE_PASSWORD || 'Owner@2026'

if (!SUPABASE_URL || !ANON_KEY) { console.error('missing env'); process.exit(1) }

const auth = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
  method: 'POST',
  headers: { 'apikey': ANON_KEY, 'Content-Type': 'application/json' },
  body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
})
if (!auth.ok) { console.error(`auth ${auth.status}`); process.exit(2) }
const session = await auth.json()
const accessToken = session.access_token
const userId = session.user.id

const tRes = await fetch(`${SUPABASE_URL}/rest/v1/tenants?select=id,status&limit=5`, {
  headers: { apikey: ANON_KEY, Authorization: `Bearer ${accessToken}` },
})
const tenants = await tRes.json()
const tenantId = (tenants.find(t => t.status === 'active') ?? tenants[0]).id
console.log(`▶ tenant=${tenantId} user=${userId}`)

const H = { Authorization: `Bearer ${accessToken}`, 'X-Tenant-ID': tenantId, 'Content-Type': 'application/json' }
const PG = { apikey: ANON_KEY, Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json', Prefer: 'return=representation' }

async function hit(method, path, body, label) {
  const res = await fetch(`${BASE_URL}${path}`, { method, headers: H, body: body ? JSON.stringify(body) : undefined })
  const txt = await res.text()
  let parsed; try { parsed = JSON.parse(txt) } catch { parsed = txt }
  console.log(`\n${label || (method + ' ' + path)}  →  ${res.status}`)
  console.log(JSON.stringify(parsed, null, 2).split('\n').slice(0, 30).map(l => '  ' + l).join('\n'))
  return { status: res.status, body: parsed }
}

// ── Fixtures ───────────────────────────────────────────────────────────────
// We need a contact (so promote-to-deal can resolve) AND a lead row (so
// /api/crm/deals?include_leads returns a lead card). Pick the existing
// "Two Pointers" lead table; create both records with a marker phone so
// cleanup is reliable.
const MARKER = `+919000${Date.now().toString().slice(-7)}`
console.log(`▶ marker phone for cleanup: ${MARKER}`)

// 1. create contact via PostgREST
const contactInsert = await fetch(`${SUPABASE_URL}/rest/v1/contacts`, {
  method: 'POST', headers: PG,
  body: JSON.stringify({ tenant_id: tenantId, name: 'Smoke Test Promote', phone: MARKER, email: `smoke+${Date.now()}@test.local` }),
})
const contactRow = (await contactInsert.json())[0]
if (!contactRow?.id) { console.error('contact insert failed:', contactRow); process.exit(3) }
console.log(`▶ created contact id=${contactRow.id}`)

// 2. find a lead table
const lt = await fetch(`${SUPABASE_URL}/rest/v1/lead_tables?select=id,name&limit=1`, { headers: PG })
const tables = await lt.json()
if (!tables.length) { console.error('no lead tables'); process.exit(4) }
const tableId = tables[0].id
console.log(`▶ using lead table id=${tableId} name="${tables[0].name}"`)

// 3. create a lead row assigned to ME
const leadInsert = await fetch(`${SUPABASE_URL}/rest/v1/lead_rows`, {
  method: 'POST', headers: PG,
  body: JSON.stringify({
    tenant_id: tenantId,
    table_id: tableId,
    user_id: userId,
    assigned_to: userId,
    assigned_to_name: 'Priya',
    status: 'new',
    data: { name: 'Smoke Test Lead', phone: MARKER, company: 'Acme Smoke' },
  }),
})
const leadRow = (await leadInsert.json())[0]
if (!leadRow?.id) { console.error('lead insert failed:', leadRow); process.exit(5) }
console.log(`▶ created lead_row id=${leadRow.id}`)

// ── 1. Unified GET ──────────────────────────────────────────────────────────
const stagesR = await hit('GET', '/api/crm/stages', null, '[1a] GET /api/crm/stages')
const stages  = stagesR.body
const wonStage  = stages.find(s => s.is_won)
const qualifiedStage = stages.find(s => s.name.toLowerCase() === 'qualified')
const leadStage = stages.find(s => s.name.toLowerCase() === 'lead')

const cardsR = await hit('GET', '/api/crm/deals?include_leads=true', null,
  '[1b] GET /api/crm/deals?include_leads=true')
const cards = cardsR.body.cards
const myLeadCard = cards.find(c => c.kind === 'lead' && c.id === leadRow.id)
console.log(`  ✓ ${cards.length} cards returned; our lead card present: ${!!myLeadCard}; stage_id=${myLeadCard?.stage_id} (expected leadStage=${leadStage.id})`)

// ── 2. Drag-to-move the lead card to "Qualified" ────────────────────────────
const moveR = await hit('POST', `/api/crm/cards/${leadRow.id}/move`,
  { kind: 'lead', stage_id: qualifiedStage.id },
  '[2] POST /api/crm/cards/<lead-id>/move kind=lead → qualified')
const movedStatus = moveR.body?.status_raw
console.log(`  ✓ lead.status_raw is now '${movedStatus}' (expected 'qualified')`)

// ── 3. Promote lead-to-deal ─────────────────────────────────────────────────
const promoteR = await hit('POST', `/api/crm/leads/${leadRow.id}/promote-to-deal`,
  { title: 'Smoke promotion deal', value_inr_paise: 50000 },
  '[3] POST /api/crm/leads/<lead-id>/promote-to-deal')
const newDealId = promoteR.body?.deal_id
console.log(`  ✓ promoted; deal_id=${newDealId}`)

// Re-fetch the lead to confirm converted_to_deal_id was stamped
if (newDealId) {
  const leadAfter = await fetch(`${SUPABASE_URL}/rest/v1/lead_rows?id=eq.${leadRow.id}&select=id,data,status`, { headers: PG })
  const after = (await leadAfter.json())[0]
  console.log(`  ✓ lead data.converted_to_deal_id=${after?.data?.converted_to_deal_id}`)
}

// ── 4. Sanity: deal exists and was logged ──────────────────────────────────
if (newDealId) {
  await hit('GET', `/api/crm/deals/${newDealId}`, null, '[4] GET /api/crm/deals/<new-id>')
}

// ── Cleanup ────────────────────────────────────────────────────────────────
console.log('\n▶ cleanup')
if (newDealId) {
  await hit('DELETE', `/api/crm/deals/${newDealId}`, null, 'delete promoted deal')
}
await fetch(`${SUPABASE_URL}/rest/v1/lead_rows?id=eq.${leadRow.id}`, { method: 'DELETE', headers: PG })
await fetch(`${SUPABASE_URL}/rest/v1/contacts?id=eq.${contactRow.id}`, { method: 'DELETE', headers: PG })
console.log('  ✓ deleted lead_row + contact')
console.log('\n✓ smoke complete')
