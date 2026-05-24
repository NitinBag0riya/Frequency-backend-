import 'dotenv/config'
import { createClient } from '@supabase/supabase-js'

const sb = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false } },
)

const ACME_SLUG = 'acme'
const WORKFLOW_ID = '541e5aa2-9885-477a-b363-9d4e5b50f96f'
const NITIN_RAW = '917877427709'

async function main() {
  const { data: tenant } = await sb.from('tenants').select('id').eq('slug', ACME_SLUG).single()
  if (!tenant) {
    console.error('Tenant not found')
    return
  }

  console.log('Inserting test session...')
  const insertPayload = {
    tenant_id: tenant.id,
    workflow_id: WORKFLOW_ID,
    contact_phone: NITIN_RAW,
    channel: 'whatsapp',
    current_node_id: 'n_reply',
    variables: {},
    status: 'active',
  }

  const { data, error } = await sb.from('workflow_sessions')
    .insert(insertPayload)
    .select('id')
    .maybeSingle()

  if (error) {
    console.error('INSERT ERROR:', error)
  } else {
    console.log('INSERT SUCCESS:', data)
  }
}

main().catch(console.error)
