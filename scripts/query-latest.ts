import 'dotenv/config'
import { createClient } from '@supabase/supabase-js'

const sb = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false } },
)

const NITIN_PHONE = '+917877427709'
const NITIN_RAW   = '917877427709'

async function main() {
  console.log(`Querying messages for recipient ${NITIN_PHONE} / ${NITIN_RAW}...`)
  const { data: messages, error } = await sb.from('messages')
    .select('id, direction, channel, status, content, contact_phone, created_at')
    .or(`contact_phone.eq.${NITIN_PHONE},contact_phone.eq.${NITIN_RAW}`)
    .order('created_at', { ascending: false })
    .limit(20)
  if (error) {
    console.error('Query error:', error.message)
    return
  }

  console.log(`\nFound ${messages?.length ?? 0} messages:`)
  for (const m of messages ?? []) {
    console.log(`- Time: ${m.created_at}`)
    console.log(`  Direction: ${m.direction}`)
    console.log(`  Status: ${m.status}`)
    console.log(`  Content:`, JSON.stringify(m.content))
    console.log('----------------------------------------------------')
  }
}

main().catch(console.error)
