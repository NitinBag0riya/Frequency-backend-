import 'dotenv/config'
import { createClient } from '@supabase/supabase-js'

const sb: any = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false } },
)

async function main() {
  const r = await sb.auth.admin.generateLink({
    type: 'magiclink',
    email: 'priya@acme.in',
  })
  if (r.error) { console.error('ERR', r.error); process.exit(1) }
  console.log(r.data.properties?.email_otp)
}
main().catch(e => { console.error(e); process.exit(1) })
