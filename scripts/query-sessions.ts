import 'dotenv/config'
import { createClient } from '@supabase/supabase-js'

const sb = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false } },
)

async function main() {
  const { data: sRows } = await sb.from('workflow_sessions').select('*').limit(1)
  if (sRows && sRows.length > 0) {
    console.log('workflow_sessions keys:', Object.keys(sRows[0]))
  }

  const { data: eRows } = await sb.from('workflow_executions').select('*').limit(1)
  if (eRows && eRows.length > 0) {
    console.log('workflow_executions keys:', Object.keys(eRows[0]))
  }

  console.log('\nQuerying latest workflow sessions...')
  const { data: sessions, error: sErr } = await sb.from('workflow_sessions')
    .select('id, workflow_id, contact_phone, status, current_node_id, variables')
    .order('started_at', { ascending: false })
    .limit(10)
  if (sErr) {
    console.error('Session query error:', sErr.message)
    return
  }

  console.log(`\nFound ${sessions?.length ?? 0} sessions:`)
  for (const s of sessions ?? []) {
    console.log(`- Session ID: ${s.id}`)
    console.log(`  Workflow ID: ${s.workflow_id}`)
    console.log(`  Contact Phone: ${s.contact_phone}`)
    console.log(`  Status: ${s.status}`)
    console.log(`  Current Node: ${s.current_node_id}`)
    console.log(`  Variables:`, JSON.stringify(s.variables))
    console.log('----------------------------------------------------')
  }

  console.log('\nQuerying latest workflow executions...')
  const { data: execs, error: eErr } = await sb.from('workflow_executions')
    .select('id, session_id, workflow_id, node_id, node_type, status, error')
    .limit(10)
  if (eErr) {
    console.error('Execution query error:', eErr.message)
    return
  }

  console.log(`\nFound ${execs?.length ?? 0} executions:`)
  for (const e of execs ?? []) {
    console.log(`- Exec ID: ${e.id}`)
    console.log(`  Session ID: ${e.session_id}`)
    console.log(`  Node ID: ${e.node_id}`)
    console.log(`  Node Type: ${e.node_type}`)
    console.log(`  Status: ${e.status}`)
    console.log(`  Error: ${e.error}`)
    console.log('----------------------------------------------------')
  }
}

main().catch(console.error)
