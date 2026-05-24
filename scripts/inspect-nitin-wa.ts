/**
 * Read-only inspection for the "send WA buttons to 7877427709" test.
 * Reports DB shape, contact match, and tenant WABA wiring.
 */
import { createClient } from '@supabase/supabase-js'
import 'dotenv/config'

const sb = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false } },
)
const TARGET = '7877427709'

async function main() {
  console.log(`\nSUPABASE_URL = ${process.env.SUPABASE_URL}`)

  const { count: contactsCount } = await sb.from('contacts').select('id', { count: 'exact', head: true })
  const { count: tenantsCount }  = await sb.from('tenants').select('id', { count: 'exact', head: true })
  console.log(`contacts total = ${contactsCount}   tenants total = ${tenantsCount}`)

  const { data: byPhone } = await sb.from('contacts')
    .select('id, name, phone, tenant_id').ilike('phone', `%${TARGET}%`)
  console.log(`\ncontacts.phone matches %${TARGET}%:`, byPhone?.length ?? 0)
  for (const c of byPhone ?? []) console.log(' ', c.name, c.phone, '→ tenant', c.tenant_id)

  const { data: byName } = await sb.from('contacts')
    .select('id, name, phone, tenant_id').ilike('name', '%nitin%').limit(10)
  console.log(`\ncontacts.name ILIKE %nitin%:`, byName?.length ?? 0)
  for (const c of byName ?? []) console.log(' ', c.name, c.phone, '→ tenant', c.tenant_id)

  const { data: tenants } = await sb.from('tenants')
    .select('id, name, slug, phone_number_id, access_token, user_id, created_at')
    .order('created_at', { ascending: false }).limit(10)
  console.log(`\nLatest 10 tenants:`)
  for (const t of tenants ?? []) {
    console.log(`  ${t.slug ?? '(no slug)'} | ${t.name} | pn_id=${t.phone_number_id ? 'set' : '-'} | token=${t.access_token ? 'set' : '-'}`)
  }

  // Check if WABA creds live elsewhere (e.g. connector_oauth, integrations)
  const { data: integrations } = await sb.from('integrations')
    .select('id, tenant_id, provider, connected_at')
    .ilike('provider', '%whats%').limit(20)
  console.log(`\nintegrations.provider LIKE whats%: ${integrations?.length ?? 0}`)
  for (const i of integrations ?? []) console.log(' ', i.provider, 'tenant=', i.tenant_id, 'at', i.connected_at)

  const { data: oauth } = await sb.from('connector_oauth')
    .select('id, tenant_id, provider, scope, expires_at').ilike('provider', '%whats%').limit(20)
  console.log(`\nconnector_oauth.provider LIKE whats%: ${oauth?.length ?? 0}`)
  for (const o of oauth ?? []) console.log(' ', o.provider, 'tenant=', o.tenant_id)
}

main().catch(e => { console.error(e); process.exit(1) })
