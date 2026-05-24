import 'dotenv/config'
import { createClient } from '@supabase/supabase-js'

const sb = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false } },
)

const ACME_SLUG     = 'acme'
const NITIN_PHONE   = '+917877427709'
const NITIN_DIGITS  = '917877427709'
const TEMPLATE_NAME = 'hello_world'
const TEMPLATE_LANG = 'en_US'

async function main() {
  const { data: tenant, error: tErr } = await sb.from('tenants')
    .select('id, slug, business_name, phone_number_id, access_token')
    .eq('slug', ACME_SLUG).single()
    
  if (tErr || !tenant) throw new Error(`tenant '${ACME_SLUG}' not found: ${tErr?.message}`)
  if (!tenant.access_token) throw new Error('acme has no access_token')
  
  console.log(`✓ tenant: ${tenant.business_name} (${tenant.slug})`)
  
  const body = {
    messaging_product: 'whatsapp',
    to: NITIN_DIGITS,
    type: 'template',
    template: {
      name:     TEMPLATE_NAME,
      language: { code: TEMPLATE_LANG },
    },
  }
  
  console.log(`→ POST graph.facebook.com/v21.0/${tenant.phone_number_id}/messages`)
  const resp = await fetch(
    `https://graph.facebook.com/v21.0/${tenant.phone_number_id}/messages`,
    {
      method:  'POST',
      headers: {
        Authorization:  `Bearer ${tenant.access_token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    },
  )
  
  const text = await resp.text()
  console.log(`← Meta status ${resp.status}`)
  console.log(`  body=${text}`)

  if (!resp.ok) {
    console.error('Meta send failed.')
    return
  }

  const parsed = JSON.parse(text)
  const wamid = parsed.messages?.[0]?.id
  if (!wamid) {
    console.error('No wamid returned.')
    return
  }
  console.log(`✓ Message accepted by Meta. wamid=${wamid}`)

  // Insert outbound message record into database
  console.log('Inserting message record into Supabase for webhook tracking...')
  const { error: insErr } = await sb.from('messages').insert({
    tenant_id: tenant.id,
    direction: 'outbound',
    contact_phone: NITIN_PHONE,
    channel: 'whatsapp',
    platform_message_id: wamid,
    content: body,
    status: 'sent',
  })
  if (insErr) {
    console.error('Failed to insert message into Supabase:', insErr.message)
    return
  }
  console.log('✓ Message record inserted. Polling for webhook updates (will check for 15 seconds)...')

  // Poll for status updates
  for (let i = 0; i < 15; i++) {
    await new Promise(resolve => setTimeout(resolve, 1000))
    const { data: msg, error: qErr } = await sb.from('messages')
      .select('status, created_at, content')
      .eq('platform_message_id', wamid)
      .single()
    if (qErr) {
      console.error('Failed to query message status:', qErr.message)
      break
    }
    console.log(`[Second ${i+1}] Status: ${msg.status}`)
    if (msg.status !== 'sent') {
      console.log('Final Status received!', JSON.stringify(msg, null, 2))
      break
    }
  }
}

main().catch(e => { console.error('FATAL:', e?.message ?? e); process.exit(1) })
