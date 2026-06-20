/**
 * Integration test for the trigger_schedule AUDIENCE fan-out (the gap closed in
 * 2026-06: a schedule with no contact_id now resolves a segment / tag audience
 * and fans out one workflow session per contact, instead of firing once against
 * a sentinel fake contact).
 *
 * Infra-free by design: it exercises resolveScheduleAudience (DB-reads only — no
 * BullMQ/Redis, no workflow sessions), so it runs anywhere the service-role key
 * is present. The fan-out loop + poller wiring that consumes this list is
 * straightforward and covered by tsc.
 *
 *   npx tsx tests/integration/schedule-audience.ts
 *
 * Self-cleans the throwaway tenant + rows on exit (even on failure).
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { randomUUID } from 'crypto'
import '../../src/env'
import { resolveScheduleAudience } from '../../src/engine/inbound-router'

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
  // ── Setup: throwaway user + tenant ──
  const email = `sched-int+${stamp}@frequency-test.local`
  const { data: u, error: uErr } = await sb.auth.admin.createUser({
    email, password: `Sch${stamp}!_${randomUUID().slice(0, 8)}`, email_confirm: true,
  })
  if (uErr || !u?.user) throw new Error(`create user: ${uErr?.message}`)
  const userId = u.user.id
  const { data: t, error: tErr } = await sb.from('tenants').insert({
    user_id: userId,
    business_name: `Sched Int ${stamp}`,
    waba_id: `sched-int-waba-${stamp}-${randomUUID().slice(0, 8)}`,
    phone_number_id: `sched-int-pn-${stamp}`,
    access_token: 'sched-int-fake-token',
    status: 'active',
    slug: `sched-int-${stamp}-${randomUUID().slice(0, 6)}`.toLowerCase(),
  }).select('id').single()
  if (tErr || !t) throw new Error(`create tenant: ${tErr?.message}`)
  const tenantId = t.id
  await sb.from('user_roles').insert({ user_id: userId, tenant_id: tenantId, role: 'owner' })

  let segmentId: string | null = null
  try {
    // ── Seed contacts: 2 active VIP, 1 active non-VIP, 1 inactive VIP ──
    const { error: cErr } = await sb.from('contacts').insert([
      { tenant_id: tenantId, phone: `+1999${stamp}001`, name: 'VIP A',   status: 'active',   tags: ['vip'] },
      { tenant_id: tenantId, phone: `+1999${stamp}002`, name: 'VIP B',   status: 'active',   tags: ['vip', 'hot'] },
      { tenant_id: tenantId, phone: `+1999${stamp}003`, name: 'Plain',   status: 'active',   tags: ['cold'] },
      { tenant_id: tenantId, phone: `+1999${stamp}004`, name: 'VIP Off', status: 'opted_out', tags: ['vip'] },
    ])
    if (cErr) throw new Error(`seed contacts: ${cErr.message}`)

    // ── 1. Tag audience: {tags:['vip']} → 2 active VIPs (inactive excluded) ──
    const byTag = await resolveScheduleAudience(sb, tenantId, { audience: { tags: ['vip'] } })
    check('tag audience matches 2 active VIPs (opted_out excluded)', byTag.length === 2, `got ${byTag.length}`)
    check('tag audience rows carry phone', byTag.every(r => !!r.phone))

    // ── 2. exclude_tags removes 'hot' ──
    const byTagExcl = await resolveScheduleAudience(sb, tenantId, { audience: { tags: ['vip'], exclude_tags: ['hot'] } })
    check('exclude_tags drops the hot VIP → 1', byTagExcl.length === 1, `got ${byTagExcl.length}`)

    // ── 3. Unscoped schedule (no segment, no tags) → refuses (0) ──
    const unscoped = await resolveScheduleAudience(sb, tenantId, {})
    check('unscoped schedule refuses fan-out (0, never blasts all)', unscoped.length === 0, `got ${unscoped.length}`)

    // ── 4. Saved segment with filters {tags:['vip']} → 2 ──
    const { data: seg, error: sErr } = await sb.from('contact_segments').insert({
      tenant_id: tenantId, name: `VIP seg ${stamp}`, filters: { tags: ['vip'] },
    }).select('id').single()
    if (sErr || !seg) throw new Error(`create segment: ${sErr?.message}`)
    segmentId = seg.id
    const bySeg = await resolveScheduleAudience(sb, tenantId, { segment_id: segmentId })
    check('segment audience matches 2 active VIPs', bySeg.length === 2, `got ${bySeg.length}`)

    // ── 5. Missing/archived segment → 0 (safe) ──
    const ghost = await resolveScheduleAudience(sb, tenantId, { segment_id: randomUUID() })
    check('missing segment → 0 (no crash, no blast)', ghost.length === 0, `got ${ghost.length}`)
  } finally {
    // ── Cleanup (reverse dependency order) ──
    if (segmentId) await sb.from('contact_segments').delete().eq('id', segmentId)
    await sb.from('contacts').delete().eq('tenant_id', tenantId)
    await sb.from('user_roles').delete().eq('tenant_id', tenantId)
    await sb.from('tenants').delete().eq('id', tenantId)
    await sb.auth.admin.deleteUser(userId)
  }

  console.log(`\nschedule-audience: ${pass} passed, ${fail} failed`)
  process.exit(fail ? 1 : 0)
}

main().catch(e => { console.error('FATAL', e); process.exit(2) })
