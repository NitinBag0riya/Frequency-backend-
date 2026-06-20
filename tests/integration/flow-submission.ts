/**
 * Integration test for WhatsApp Flow submission routing (the Meta-gap closure).
 * Exercises routeFlowSubmission: resume-a-waiting-session vs fire
 * trigger_flow_response vs flow_id scoping vs bot_paused gate, plus that
 * wa_flow_responses accepts an unlinked (null flow_id) submission.
 *
 * Uses the real (staging) Redis the .env points at, so trigger/resume enqueue
 * for real — the throwaway tenant has fake WABA creds and a harmless add_tag
 * action, so any worker pickup is a no-op on disposable data. Self-cleans.
 *
 *   npx tsx tests/integration/flow-submission.ts
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { randomUUID } from 'crypto'
import '../../src/env'
import { routeFlowSubmission } from '../../src/engine/inbound-router'

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://yiicpndeggaedxobyopu.supabase.co'
const SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!SERVICE_ROLE) { console.error('SUPABASE_SERVICE_ROLE_KEY required'); process.exit(2) }
const sb: SupabaseClient = createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { persistSession: false } })

let pass = 0, fail = 0
function check(name: string, cond: boolean, detail = '') {
  if (cond) { pass++; console.log(`  ✓ ${name}`) }
  else { fail++; console.log(`  ✗ ${name} ${detail}`) }
}

async function main() {
  const stamp = Date.now() + Math.floor(Math.random() * 1000)
  const phone = `1888${String(stamp).slice(-7)}`          // contactId (no +)
  const { data: u, error: uErr } = await sb.auth.admin.createUser({
    email: `flow-int+${stamp}@frequency-test.local`, password: `Flw${stamp}!_${randomUUID().slice(0, 8)}`, email_confirm: true,
  })
  if (uErr || !u?.user) throw new Error(`create user: ${uErr?.message}`)
  const userId = u.user.id
  const { data: t, error: tErr } = await sb.from('tenants').insert({
    user_id: userId, business_name: `Flow Int ${stamp}`,
    waba_id: `flow-waba-${stamp}-${randomUUID().slice(0, 8)}`,
    phone_number_id: `flow-pn-${stamp}`, access_token: 'flow-fake', status: 'active',
    slug: `flow-${stamp}-${randomUUID().slice(0, 6)}`.toLowerCase(),
  }).select('id').single()
  if (tErr || !t) throw new Error(`create tenant: ${tErr?.message}`)
  const tenant = { id: t.id, user_id: userId }
  await sb.from('user_roles').insert({ user_id: userId, tenant_id: tenant.id, role: 'owner' })

  const sessionsFor = async () => {
    const { data } = await sb.from('workflow_sessions').select('id')
      .eq('tenant_id', tenant.id).eq('contact_phone', phone).eq('status', 'active')
    return data ?? []
  }
  const clearSessions = async () => { await sb.from('workflow_sessions').delete().eq('tenant_id', tenant.id) }

  let flowId: string | null = null, wfId: string | null = null
  try {
    await sb.from('contacts').insert({ tenant_id: tenant.id, phone: `+${phone}`, name: 'Flow Tester', status: 'active' })
    const { data: flow } = await sb.from('wa_flows').insert({
      tenant_id: tenant.id, name: `Booking ${stamp}`, status: 'PUBLISHED', definition: {},
    }).select('id').single()
    flowId = flow!.id
    const { data: wf } = await sb.from('workflows').insert({
      tenant_id: tenant.id, name: `Flow WF ${stamp}`, status: 'live',
      nodes: [
        { id: 't1', type: 'trigger_flow_response', config: {} },
        { id: 'a1', type: 'add_tag', config: { tag: 'flow-done' } },
      ],
    }).select('id').single()
    wfId = wf!.id
    const flowData = { name: 'Asha', bhk: '2BHK', flow_token: flowId }

    // ── A. No active session → fires trigger_flow_response (starts a session) ──
    await clearSessions()
    const rA = await routeFlowSubmission(sb, tenant, 'whatsapp', phone, flowData, {}, { flow_id: flowId, flow_name: `Booking ${stamp}` })
    const aSessions = await sessionsFor()
    check('no session → triggered', rA.triggered === true && rA.resumed === false, JSON.stringify(rA))
    check('trigger started exactly one session', aSessions.length === 1, `got ${aSessions.length}`)

    // ── B. Active session waiting → RESUMES it, does NOT start another ──
    // (Session from A is still active.) Submit again → resume, no new session.
    const rB = await routeFlowSubmission(sb, tenant, 'whatsapp', phone, flowData, {}, { flow_id: flowId })
    const bSessions = await sessionsFor()
    check('active session → resumed, not triggered', rB.resumed === true && rB.triggered === false, JSON.stringify(rB))
    check('resume did not create a new session', bSessions.length === 1, `got ${bSessions.length}`)

    // ── B2. Session stored as +E.164 (lead/order/payment-triggered) resumes
    //        even though the WhatsApp webhook gives a bare phone (fix #1) ──
    await clearSessions()
    await sb.from('workflow_sessions').insert({
      tenant_id: tenant.id, workflow_id: wfId, contact_phone: `+${phone}`,
      channel: 'whatsapp', current_node_id: 'a1', variables: {}, status: 'active',
    })
    const rB2 = await routeFlowSubmission(sb, tenant, 'whatsapp', phone, flowData, {}, { flow_id: flowId })
    check('resumes a +E.164 session when webhook gives a bare phone', rB2.resumed === true && rB2.triggered === false, JSON.stringify(rB2))

    // ── C. bot_paused take-over gate → does nothing ──
    await clearSessions()
    await sb.from('contacts').update({ bot_paused: true }).eq('tenant_id', tenant.id).eq('phone', `+${phone}`)
    const rC = await routeFlowSubmission(sb, tenant, 'whatsapp', phone, flowData, {}, { flow_id: flowId })
    check('bot_paused → neither resumed nor triggered', rC.resumed === false && rC.triggered === false, JSON.stringify(rC))
    check('bot_paused started no session', (await sessionsFor()).length === 0)
    await sb.from('contacts').update({ bot_paused: false }).eq('tenant_id', tenant.id).eq('phone', `+${phone}`)

    // ── D. flow_id scoping: trigger scoped to a DIFFERENT flow → no fire ──
    await clearSessions()
    await sb.from('workflows').update({
      nodes: [
        { id: 't1', type: 'trigger_flow_response', config: { flow_id: randomUUID() } },
        { id: 'a1', type: 'add_tag', config: { tag: 'flow-done' } },
      ],
    }).eq('id', wfId)
    const rD = await routeFlowSubmission(sb, tenant, 'whatsapp', phone, flowData, {}, { flow_id: flowId })
    check('scoped to a different flow → not triggered', rD.triggered === false, JSON.stringify(rD))
    check('scoped mismatch started no session', (await sessionsFor()).length === 0)

    // ── E. wa_flow_responses accepts an unlinked (null flow_id) submission ──
    const { error: rErr } = await sb.from('wa_flow_responses').insert({
      flow_id: null, tenant_id: tenant.id, contact_phone: `+${phone}`, response_data: flowData,
    })
    check('wa_flow_responses stores unlinked submission (null flow_id)', !rErr, rErr?.message ?? '')
  } finally {
    await sb.from('wa_flow_responses').delete().eq('tenant_id', tenant.id)
    await sb.from('workflow_sessions').delete().eq('tenant_id', tenant.id)
    if (wfId) await sb.from('workflows').delete().eq('id', wfId)
    if (flowId) await sb.from('wa_flows').delete().eq('id', flowId)
    await sb.from('contacts').delete().eq('tenant_id', tenant.id)
    await sb.from('user_roles').delete().eq('tenant_id', tenant.id)
    await sb.from('tenants').delete().eq('id', tenant.id)
    await sb.auth.admin.deleteUser(userId)
  }

  console.log(`\nflow-submission: ${pass} passed, ${fail} failed`)
  process.exit(fail ? 1 : 0)
}

main().catch(e => { console.error('FATAL', e); process.exit(2) })
