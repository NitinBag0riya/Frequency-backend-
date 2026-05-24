import 'dotenv/config'
import { createClient } from '@supabase/supabase-js'

const sb = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false } },
)

const ACME_SLUG = 'acme'

async function main() {
  const { data: tenant, error: tErr } = await sb.from('tenants')
    .select('waba_id, access_token')
    .eq('slug', ACME_SLUG).single()
  if (tErr || !tenant) throw new Error(`tenant not found: ${tErr?.message}`)

  console.log(`Querying templates for WABA ID: ${tenant.waba_id}...`)
  const url = `https://graph.facebook.com/v21.0/${tenant.waba_id}/message_templates?limit=100`
  const resp = await fetch(url, {
    headers: {
      Authorization: `Bearer ${tenant.access_token}`,
    },
  })
  const body = await resp.json() as any
  if (!resp.ok) {
    console.error('Failed to fetch templates:', body)
    return
  }

  console.log(`\nFound ${body.data?.length ?? 0} templates:`)
  for (const t of body.data ?? []) {
    console.log(`- Name: ${t.name}`)
    console.log(`  Category: ${t.category}`)
    console.log(`  Status: ${t.status}`)
    console.log(`  Language: ${t.language}`)
    console.log(`  Components:`, JSON.stringify(t.components, null, 2))
    console.log('----------------------------------------------------')
  }
}

main().catch(console.error)
