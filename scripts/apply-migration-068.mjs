#!/usr/bin/env node
/**
 * apply-migration-068.mjs — one-shot applier for migration 068.
 *
 * Reads the SQL from supabase/migrations/068_wa_templates_reclassification.sql
 * and executes it against the Supabase Postgres instance.
 *
 * Uses the Supabase REST API's pg-meta /rest/v1/rpc/exec_sql shape via a
 * SECURITY-DEFINER `exec_sql` function we expect to exist in the DB (it
 * was added by an earlier migration for the deploy script). If that
 * function isn't there, falls back to PostgREST's direct DDL submit via
 * the SQL editor endpoint with the service-role key.
 *
 * Idempotent: every statement in 068 uses IF NOT EXISTS / ON CONFLICT,
 * so re-running is harmless.
 */

import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import 'dotenv/config'

const __dirname = dirname(fileURLToPath(import.meta.url))
const MIGRATION_PATH = resolve(__dirname, '..', 'supabase', 'migrations', '068_wa_templates_reclassification.sql')

const SUPABASE_URL = process.env.SUPABASE_URL
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in env')
  process.exit(1)
}

const sql = readFileSync(MIGRATION_PATH, 'utf-8')
console.log(`▶ applying ${MIGRATION_PATH.split('/').pop()} (${sql.length} bytes)`)

// Try the SQL editor admin endpoint first (works on Supabase hosted).
// Project ref derived from the URL: https://<ref>.supabase.co
const projectRef = new URL(SUPABASE_URL).hostname.split('.')[0]
const adminUrl = `${SUPABASE_URL}/rest/v1/rpc/exec_sql`

async function tryExecRpc() {
  const res = await fetch(adminUrl, {
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

const rpcResult = await tryExecRpc()
if (rpcResult.ok) {
  console.log('✓ migration applied via exec_sql RPC')
  console.log('  response:', rpcResult.body.slice(0, 200))
  process.exit(0)
}

console.warn(`exec_sql RPC unavailable (${rpcResult.status}): ${rpcResult.body.slice(0, 200)}`)
console.warn('Falling back to per-statement pg client. Install `pg` first if not present.')

// Fallback: split on `;` at line boundaries (a real parser would handle
// dollar-quoted blocks, but 068 has none — only DDL + a single INSERT).
const statements = sql
  .split(/;\s*\n/)
  .map(s => s.trim())
  .filter(s => s && !s.startsWith('--'))

let pg
try {
  const mod = await import('pg')
  pg = mod.default ?? mod
} catch {
  console.error('pg client not installed. Run: npm install --no-save pg')
  console.error('Then re-run: node scripts/apply-migration-068.mjs')
  process.exit(2)
}

// Connection: prefer DATABASE_URL if present; else build from Supabase
// pooler conventions. The pooler password is the DB password (not the
// service-role JWT).
const dbUrl = process.env.DATABASE_URL || process.env.SUPABASE_DB_URL
if (!dbUrl) {
  console.error('No DATABASE_URL / SUPABASE_DB_URL in env. Cannot apply via pg.')
  console.error('Either set DATABASE_URL or create the exec_sql() RPC on the DB.')
  console.error('Migration SQL is at:', MIGRATION_PATH)
  console.error('Apply it manually via the Supabase SQL Editor.')
  process.exit(3)
}

const client = new pg.Client({ connectionString: dbUrl })
await client.connect()
try {
  for (const stmt of statements) {
    process.stdout.write(`  · ${stmt.slice(0, 60).replace(/\s+/g, ' ')}… `)
    await client.query(stmt)
    console.log('ok')
  }
  console.log('✓ migration applied via pg client')
} finally {
  await client.end()
}
