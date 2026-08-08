/**
 * READ-ONLY verification of resolveEntitlementsDetailed against real tenant data.
 * Proves the cockpit matrix endpoint: resolved state + source labels + the HARD
 * vertical gate. No writes. Run: npx tsx scripts/verify-entitlement-matrix.ts
 */
import 'dotenv/config'
import { createClient } from '@supabase/supabase-js'
import { resolveEntitlementsDetailed } from '../src/lib/entitlements'

const sb = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
  auth: { persistSession: false },
})

async function main() {
  const { data: tenants } = await sb
    .from('tenants')
    .select('id, business_name, business_type, status')
    .not('business_type', 'is', null)
    .limit(50)

  // One tenant per vertical group so we can eyeball the gate.
  const seen = new Set<string>()
  const picks: any[] = []
  for (const t of tenants ?? []) {
    const g = t.business_type
    if (!seen.has(g)) { seen.add(g); picks.push(t) }
    if (picks.length >= 4) break
  }
  if (picks.length === 0 && (tenants ?? []).length) picks.push(tenants![0])

  for (const t of picks) {
    const m = await resolveEntitlementsDetailed(sb, t.id)
    const offered = m.features.filter(f => !f.vertical_locked)
    const locked = m.features.filter(f => f.vertical_locked)
    const bySource = m.features.reduce<Record<string, number>>((a, f) => (a[f.source] = (a[f.source] ?? 0) + 1, a), {})
    console.log('\n━━━', t.business_name, `[${t.business_type} → ${m.business_group}]`, 'plan:', m.plan_id ?? 'none', t.status ?? '')
    console.log('  features:', m.features.length, '| enabled(offered):', offered.filter(f => f.resolved).length + '/' + offered.length,
      '| vertical-locked:', locked.length, '| sources:', JSON.stringify(bySource))
    // Show a few gated rows to prove the hard gate (e.g. HoReCa-only pos/kot for a non-HoReCa tenant).
    const sample = locked.slice(0, 4).map(f => `${f.key}(${f.verticals.join('|')})`).join(', ')
    if (sample) console.log('  locked sample:', sample)
    const ov = m.features.filter(f => f.source === 'override').map(f => `${f.key}=${f.resolved ? 'on' : 'off'}`)
    if (ov.length) console.log('  overrides:', ov.join(', '))
    // Invariant: a vertical-locked feature must never resolve true.
    const leak = m.features.find(f => f.vertical_locked && f.resolved)
    if (leak) { console.error('  ✗ GATE LEAK:', leak.key); process.exitCode = 1 }
  }
  console.log('\nmatrix verify: OK (read-only)')
}
main().catch(e => { console.error(e); process.exit(1) })
