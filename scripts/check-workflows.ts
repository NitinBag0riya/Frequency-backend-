import 'dotenv/config'
import { createClient } from '@supabase/supabase-js'

const sb = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false } },
)

const ACME_SLUG = 'acme'

async function main() {
  const { data: tenant } = await sb.from('tenants').select('id').eq('slug', ACME_SLUG).single()
  if (!tenant) {
    console.error('acme tenant not found')
    return
  }
  console.log('Tenant ID:', tenant.id)

  const { data: workflows, error } = await sb.from('workflows')
    .select('id, name, tenant_id, status, nodes, integrations')
    .eq('tenant_id', tenant.id)
  
  if (error) {
    console.error('Error fetching workflows:', error.message)
    return
  }

  console.log(`\nFound ${workflows?.length ?? 0} workflows for acme:`)
  for (const w of workflows ?? []) {
    console.log(`- ID: ${w.id}`)
    console.log(`  Name: ${w.name}`)
    console.log(`  Status: ${w.status}`)
    console.log(`  Integrations:`, w.integrations)
    console.log(`  Nodes:`, JSON.stringify(w.nodes, null, 2))
    console.log('----------------------------------------------------')
  }
}

main().catch(console.error)
