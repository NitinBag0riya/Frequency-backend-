/**
 * Integration test for the check-before-create dedupe guard (lib/dedupe-guard).
 * Proves the "look at what we already have before making another" behavior:
 * case-insensitive same-name match, scoped by tenant + channel/language, and the
 * confirm-to-override check. Infra-free (DB reads/writes only). Self-cleans.
 *
 *   npx tsx tests/integration/dedupe-guard.ts
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { randomUUID } from 'crypto'
import '../../src/env'
import { findDuplicateByName, isConfirmedCreate, duplicateResponse } from '../../src/lib/dedupe-guard'

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
  const email = `dedupe-int+${stamp}@frequency-test.local`
  const { data: u, error: uErr } = await sb.auth.admin.createUser({
    email, password: `Ddp${stamp}!_${randomUUID().slice(0, 8)}`, email_confirm: true,
  })
  if (uErr || !u?.user) throw new Error(`create user: ${uErr?.message}`)
  const userId = u.user.id
  const { data: t, error: tErr } = await sb.from('tenants').insert({
    user_id: userId, business_name: `Dedupe Int ${stamp}`,
    waba_id: `dedupe-waba-${stamp}-${randomUUID().slice(0, 8)}`,
    phone_number_id: `dedupe-pn-${stamp}`, access_token: 'dedupe-fake', status: 'active',
    slug: `dedupe-${stamp}-${randomUUID().slice(0, 6)}`.toLowerCase(),
  }).select('id').single()
  if (tErr || !t) throw new Error(`create tenant: ${tErr?.message}`)
  const tenantId = t.id
  await sb.from('user_roles').insert({ user_id: userId, tenant_id: tenantId, role: 'owner' })

  try {
    // ── Seed an existing WhatsApp broadcast + a Telegram broadcast + a flow + a template ──
    await sb.from('broadcasts').insert([
      { tenant_id: tenantId, channel: 'whatsapp', name: `Diwali Sale ${stamp}`, status: 'draft' },
      { tenant_id: tenantId, channel: 'telegram', name: `TG Promo ${stamp}`, status: 'draft' },
    ])
    await sb.from('wa_flows').insert({ tenant_id: tenantId, name: `Booking ${stamp}`, status: 'DRAFT', definition: {} })
    await sb.from('wa_templates').insert({ tenant_id: tenantId, name: `welcome_${stamp}`, language: 'en_US', category: 'utility', status: 'approved', body: 'hi' })

    // ── 1. Exact + case-insensitive name match on the right channel ──
    const wExact = await findDuplicateByName(sb, 'broadcasts', tenantId, `Diwali Sale ${stamp}`, { channel: 'whatsapp' })
    check('whatsapp broadcast exact name → duplicate found', !!wExact, `got ${wExact}`)
    const wCase = await findDuplicateByName(sb, 'broadcasts', tenantId, `diwali sale ${stamp}`.toUpperCase(), { channel: 'whatsapp' })
    check('case-insensitive name → duplicate found', !!wCase)

    // ── 2. Same name, different channel → NOT a duplicate ──
    const wWrongChannel = await findDuplicateByName(sb, 'broadcasts', tenantId, `Diwali Sale ${stamp}`, { channel: 'telegram' })
    check('same name, different channel → no duplicate', wWrongChannel === null, `got ${wWrongChannel}`)

    // ── 3. Different name → no duplicate ──
    const wMiss = await findDuplicateByName(sb, 'broadcasts', tenantId, `Holi Sale ${stamp}`, { channel: 'whatsapp' })
    check('different name → no duplicate', wMiss === null)

    // ── 4. Telegram broadcast match by channel ──
    const tgHit = await findDuplicateByName(sb, 'broadcasts', tenantId, `TG Promo ${stamp}`, { channel: 'telegram' })
    check('telegram broadcast → duplicate found', !!tgHit)

    // ── 5. WA Flow + template ──
    const flowHit = await findDuplicateByName(sb, 'wa_flows', tenantId, `booking ${stamp}`)
    check('wa_flow case-insensitive → duplicate found', !!flowHit)
    const tplHit = await findDuplicateByName(sb, 'wa_templates', tenantId, `welcome_${stamp}`, { language: 'en_US' })
    check('wa_template name+language → duplicate found', !!tplHit)
    const tplWrongLang = await findDuplicateByName(sb, 'wa_templates', tenantId, `welcome_${stamp}`, { language: 'hi' })
    check('wa_template wrong language → no duplicate', tplWrongLang === null)

    // ── 5b. ilike metacharacters are escaped (fix #2): a name of "%" must NOT
    //        match every row, and a literal "%" name still matches itself ──
    const wildcard = await findDuplicateByName(sb, 'broadcasts', tenantId, '%', { channel: 'whatsapp' })
    check('"%" does NOT wildcard-match existing rows', wildcard === null, `got ${wildcard?.name}`)
    await sb.from('broadcasts').insert({ tenant_id: tenantId, channel: 'whatsapp', name: `50% off ${stamp}`, status: 'draft' })
    const pctExact = await findDuplicateByName(sb, 'broadcasts', tenantId, `50% off ${stamp}`, { channel: 'whatsapp' })
    check('literal "%"-containing name still matches itself', !!pctExact)
    const pctMiss = await findDuplicateByName(sb, 'broadcasts', tenantId, `50X off ${stamp}`, { channel: 'whatsapp' })
    check('"%" is not a wildcard for a different name', pctMiss === null, `got ${pctMiss?.name}`)

    // ── 6. Cross-tenant isolation: a different tenant id never matches ──
    const otherTenant = await findDuplicateByName(sb, 'broadcasts', randomUUID(), `Diwali Sale ${stamp}`, { channel: 'whatsapp' })
    check('cross-tenant → no duplicate', otherTenant === null)

    // ── 7. confirm override detection (query + body) ──
    check('isConfirmedCreate ?confirm=true', isConfirmedCreate({ query: { confirm: 'true' }, body: {} } as any))
    check('isConfirmedCreate body confirm:true', isConfirmedCreate({ query: {}, body: { confirm: true } } as any))
    check('isConfirmedCreate default false', !isConfirmedCreate({ query: {}, body: {} } as any))

    // ── 8. duplicateResponse shape ──
    const resp = duplicateResponse('broadcast', wExact!)
    check('duplicateResponse marks duplicate + carries existing', resp.duplicate === true && resp.existing.id === wExact!.id)
  } finally {
    await sb.from('wa_templates').delete().eq('tenant_id', tenantId)
    await sb.from('wa_flows').delete().eq('tenant_id', tenantId)
    await sb.from('broadcasts').delete().eq('tenant_id', tenantId)
    await sb.from('user_roles').delete().eq('tenant_id', tenantId)
    await sb.from('tenants').delete().eq('id', tenantId)
    await sb.auth.admin.deleteUser(userId)
  }

  console.log(`\ndedupe-guard: ${pass} passed, ${fail} failed`)
  process.exit(fail ? 1 : 0)
}

main().catch(e => { console.error('FATAL', e); process.exit(2) })
