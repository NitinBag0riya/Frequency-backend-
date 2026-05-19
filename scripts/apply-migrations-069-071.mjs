#!/usr/bin/env node
/**
 * apply-migrations-069-071.mjs — applies the three new migrations for the
 * Indian SMB Omnichannel Wedge P0.4 + P0.6 ship:
 *   069_subscription_billing_period.sql  — quarterly billing column
 *   070_subscription_refund.sql           — refund flow + GST invoice fields
 *   071_ctwa_attribution.sql              — CTWA → revenue attribution
 *
 * All three are idempotent (IF NOT EXISTS / ON CONFLICT throughout) — safe
 * to re-run.
 */

import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import 'dotenv/config'

const __dirname = dirname(fileURLToPath(import.meta.url))
const MIGRATIONS_DIR = resolve(__dirname, '..', 'supabase', 'migrations')
const MIGRATIONS = [
  '069_subscription_billing_period.sql',
  '070_subscription_refund.sql',
  '071_ctwa_attribution.sql',
]

const SUPABASE_URL = process.env.SUPABASE_URL
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in env')
  process.exit(1)
}

async function tryExecRpc(sql) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/exec_sql`, {
    method: 'POST',
    headers: {
      'apikey':        SUPABASE_SERVICE_ROLE_KEY,
      'Authorization': `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type':  'application/json',
    },
    body: JSON.stringify({ query: sql }),
  })
  const txt = await res.text()
  return { ok: res.ok, status: res.status, body: txt }
}

const dbUrl = process.env.DATABASE_URL || process.env.SUPABASE_DB_URL
let pg = null
if (dbUrl) {
  try {
    const mod = await import('pg')
    pg = mod.default ?? mod
  } catch {
    // pg unavailable; will fall back to RPC only
  }
}

let pgClient = null
async function getPgClient() {
  if (!pg || !dbUrl) return null
  if (pgClient) return pgClient
  pgClient = new pg.Client({ connectionString: dbUrl })
  await pgClient.connect()
  return pgClient
}

for (const filename of MIGRATIONS) {
  const path = resolve(MIGRATIONS_DIR, filename)
  const sql = readFileSync(path, 'utf-8')
  console.log(`\n▶ applying ${filename} (${sql.length} bytes)`)

  // Try RPC first.
  const rpc = await tryExecRpc(sql)
  if (rpc.ok) {
    console.log('  ✓ applied via exec_sql RPC')
    continue
  }
  console.warn(`  exec_sql RPC unavailable (${rpc.status}): ${rpc.body.slice(0, 200)}`)

  const client = await getPgClient()
  if (!client) {
    console.error(`  ✗ no pg client / DATABASE_URL — cannot apply ${filename}.`)
    console.error(`  Apply manually: ${path}`)
    process.exit(3)
  }
  // Whole-file submission via pg — handles DO $$ blocks correctly (a naïve
  // split-on-`;` would break them).
  try {
    await client.query(sql)
    console.log('  ✓ applied via pg client (whole-file)')
  } catch (e) {
    console.error(`  ✗ pg apply failed: ${e.message}`)
    process.exit(4)
  }
}

if (pgClient) await pgClient.end()
console.log('\n✓ all three migrations applied successfully')
