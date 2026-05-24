import 'dotenv/config'

const SUPABASE_URL = process.env.SUPABASE_URL!
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!

async function runSql(sql: string) {
  const adminUrl = `${SUPABASE_URL}/rest/v1/rpc/exec_sql`
  const res = await fetch(adminUrl, {
    method: 'POST',
    headers: {
      'apikey':        SUPABASE_SERVICE_ROLE_KEY,
      'Authorization': `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type':  'application/json',
    },
    body: JSON.stringify({ query: sql }),
  })
  const text = await res.text()
  if (!res.ok) {
    throw new Error(`SQL exec failed (${res.status}): ${text}`)
  }
  try {
    return JSON.parse(text)
  } catch {
    return text;
  }
}

async function main() {
  const sqlInspect = `
    SELECT column_name, data_type 
    FROM information_schema.columns 
    WHERE table_schema = 'public' AND table_name = 'workflow_sessions';
  `
  try {
    console.log('Querying columns of workflow_sessions table...')
    const cols = await runSql(sqlInspect)
    console.log('Columns in DB:', cols)
  } catch (e: any) {
    console.error('Failed to query catalog:', e.message)
  }

  try {
    console.log('\nTriggering schema cache reload via NOTIFY pgrst...')
    const notifyRes = await runSql("NOTIFY pgrst, 'reload schema';")
    console.log('Notify response:', notifyRes)
  } catch (e: any) {
    console.error('Failed to notify pgrst:', e.message)
  }
}

main().catch(console.error)
