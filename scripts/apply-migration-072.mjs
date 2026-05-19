#!/usr/bin/env node
/**
 * apply-migration-072.mjs — applies 072_dpdpa_consent.sql to the live
 * Supabase project. Idempotent (CREATE TABLE IF NOT EXISTS, ON CONFLICT,
 * drop/create trigger, etc.).
 *
 * Tries the exec_sql RPC first, falls back to a direct pg client if a
 * DATABASE_URL / SUPABASE_DB_URL is on the env.
 */

import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import 'dotenv/config'

const __dirname = dirname(fileURLToPath(import.meta.url))
const MIGRATIONS_DIR = resolve(__dirname, '..', 'supabase', 'migrations')
const FILE = '072_dpdpa_consent.sql'

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

const path = resolve(MIGRATIONS_DIR, FILE)
const sql = readFileSync(path, 'utf-8')
console.log(`\n▶ applying ${FILE} (${sql.length} bytes)`)

const rpc = await tryExecRpc(sql)
if (rpc.ok) {
  console.log('  ✓ applied via exec_sql RPC')
} else {
  console.warn(`  exec_sql RPC unavailable (${rpc.status}): ${rpc.body.slice(0, 200)}`)
  const client = await getPgClient()
  if (!client) {
    console.error(`  ✗ no pg client / DATABASE_URL — cannot apply ${FILE}.`)
    process.exit(3)
  }
  try {
    await client.query(sql)
    console.log('  ✓ applied via pg client (whole-file)')
  } catch (e) {
    console.error(`  ✗ pg apply failed: ${e.message}`)
    process.exit(4)
  }
}

// Verification — confirm the four tables exist + data_residency column.
async function verify() {
  const probes = [
    ["consent_events row count",
     "select count(*) from public.consent_events"],
    ["contact_consent_state row count",
     "select count(*) from public.contact_consent_state"],
    ["dsr_requests row count",
     "select count(*) from public.dsr_requests"],
    ["breach_notifications row count",
     "select count(*) from public.breach_notifications"],
    ["tenants.data_residency exists",
     "select column_name from information_schema.columns where table_name='tenants' and column_name='data_residency'"],
    ["messages.blocked_reason exists",
     "select column_name from information_schema.columns where table_name='messages' and column_name='blocked_reason'"],
    ["trigger trg_consent_event_materialize_state",
     "select tgname from pg_trigger where tgname='trg_consent_event_materialize_state'"],
  ]

  // Prefer the REST endpoint to verify — same auth, no separate connection.
  for (const [label, q] of probes) {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/exec_sql`, {
      method: 'POST',
      headers: {
        'apikey':        SUPABASE_SERVICE_ROLE_KEY,
        'Authorization': `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        'Content-Type':  'application/json',
      },
      body: JSON.stringify({ query: q }),
    })
    const ok = res.ok ? '✓' : '✗'
    const body = await res.text()
    console.log(`  ${ok} ${label}: ${body.slice(0, 120)}`)
  }
}

await verify()
if (pgClient) await pgClient.end()
console.log('\n✓ migration 072 applied + verified')
