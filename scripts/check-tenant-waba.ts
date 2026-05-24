import 'dotenv/config'
import { createClient } from '@supabase/supabase-js'

const sb = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false } },
)

const ACME_SLUG = 'acme'

async function main() {
  const { data: tenant, error } = await sb.from('tenants')
    .select('id, business_name, slug, waba_id, phone_number_id, access_token, status')
    .eq('slug', ACME_SLUG).single()
  if (error) {
    console.error('Error fetching tenant:', error.message)
    return
  }
  console.log('Tenant details:')
  console.log(JSON.stringify(tenant, null, 2))
}

main().catch(console.error)
