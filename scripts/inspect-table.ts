import 'dotenv/config'
import { createClient } from '@supabase/supabase-js'

const sb = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false } },
)

async function main() {
  const { data, error } = await sb.rpc('inspect_table_columns', { table_name: 'messages' })
  if (error) {
    // If RPC doesn't exist, try querying postgres system tables directly
    console.log('RPC failed, falling back to direct query...')
    const { data: cols, error: cErr } = await sb.from('pg_attribute')
      .select('attname')
      .eq('attrelid', 'messages' as any) // this might fail if not cast/structured right, so let's use a simpler query:
    console.error('RPC Error:', error.message)
  } else {
    console.log('Columns:', data)
  }

  // Let's run a query to get columns using a generic postgres query if we can, or select 1 row to see keys
  const { data: rows, error: rErr } = await sb.from('messages').select('*').limit(1)
  if (rErr) {
    console.error('Row query error:', rErr.message)
  } else if (rows && rows.length > 0) {
    console.log('Keys on a message row:', Object.keys(rows[0]))
  } else {
    console.log('No rows in messages table, or empty.')
  }
}

main().catch(console.error)
