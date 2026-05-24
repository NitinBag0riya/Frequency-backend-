/**
 * List every stage tenant + owner so we can pick which one gets the WA wiring
 * for the Nitin test. Read-only.
 */
import { createClient } from '@supabase/supabase-js'
import 'dotenv/config'

const sb = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false } },
)

async function main() {
  const { data: tenants, error } = await sb.from('tenants')
    .select('id, name, slug, phone_number_id, access_token, user_id, created_at')
    .order('created_at', { ascending: false })
  if (error) throw error
  console.log(`\nTotal tenants: ${tenants?.length ?? 0}\n`)

  for (const t of tenants ?? []) {
    let ownerEmail = '(unknown)'
    if (t.user_id) {
      const { data: u } = await (sb as any).auth.admin.getUserById(t.user_id)
      ownerEmail = u?.user?.email ?? '(no email)'
    }
    console.log(`  slug=${t.slug ?? '-'}`)
    console.log(`    id=${t.id}`)
    console.log(`    name=${t.name}`)
    console.log(`    owner=${ownerEmail}`)
    console.log(`    pn_id=${t.phone_number_id ?? '-'}   token=${t.access_token ? 'set' : '-'}`)
    console.log(`    created=${t.created_at}`)
    console.log('')
  }
}

main().catch(e => { console.error(e); process.exit(1) })
