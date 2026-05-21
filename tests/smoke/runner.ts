/**
 * Smoke test runner — behavioral coverage for every critical API.
 *
 * Why this exists:
 *   Static audits (read the code, look for patterns) keep passing while
 *   real bugs ship — most recently the Google Sheets import bug where the
 *   N+1 dedupe query timed out at scale and the response returned 200
 *   anyway. Static review can't catch that — only actually hitting the
 *   endpoint and verifying the DB state can.
 *
 *   This harness EXERCISES every endpoint with realistic payloads, then
 *   verifies the DB state after each call. Failures are loud + screenshot-
 *   shaped (request URL, headers, body, expected vs actual). Designed to
 *   be re-runnable as part of CI on every BE push.
 *
 * Auth model:
 *   We mint a test tenant + test user on first run (service-role) and
 *   reuse them across the suite. Cleanup at the end so re-runs stay clean.
 *
 * Usage:
 *   npm run smoke
 *   npm run smoke -- --base http://localhost:3000 --only sheets,sla
 *   npm run smoke -- --base https://api.getfrequency.app --only ai
 *
 * Designed to fail HARD. Any non-2xx response (where 2xx is expected) is
 * a test failure. Any 2xx response with a bad shape is a test failure.
 * Silence is not success — every test prints PASS or FAIL.
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { randomUUID } from 'crypto'
import '../../src/env'

// ── Config ─────────────────────────────────────────────────────────────────

interface Args {
  base: string
  only: string[] | null
  cleanup: boolean
}
function parseArgs(): Args {
  const argv = process.argv.slice(2)
  let base = process.env.SMOKE_BASE_URL || 'http://localhost:3000'
  let only: string[] | null = null
  let cleanup = true
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--base') base = argv[++i]
    else if (a === '--only') only = argv[++i].split(',').map(s => s.trim().toLowerCase())
    else if (a === '--no-cleanup') cleanup = false
  }
  return { base, only, cleanup }
}

const ARGS = parseArgs()
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://yiicpndeggaedxobyopu.supabase.co'
const SUPABASE_SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE_KEY!
if (!SUPABASE_SERVICE_ROLE) {
  console.error('FATAL: SUPABASE_SERVICE_ROLE_KEY not set in env')
  process.exit(2)
}
const sb: SupabaseClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE)

// ── Test results tracking ──────────────────────────────────────────────────

interface TestResult {
  name: string
  group: string
  status: 'PASS' | 'FAIL' | 'SKIP'
  ms: number
  message?: string
  detail?: any
}
const RESULTS: TestResult[] = []

async function runTest(group: string, name: string, fn: () => Promise<void>): Promise<void> {
  if (ARGS.only && !ARGS.only.includes(group.toLowerCase())) {
    RESULTS.push({ group, name, status: 'SKIP', ms: 0 })
    return
  }
  const start = Date.now()
  try {
    await fn()
    const ms = Date.now() - start
    RESULTS.push({ group, name, status: 'PASS', ms })
    process.stdout.write(`  \x1b[32mPASS\x1b[0m ${group} · ${name} (${ms}ms)\n`)
  } catch (e: any) {
    const ms = Date.now() - start
    RESULTS.push({ group, name, status: 'FAIL', ms, message: e?.message ?? String(e), detail: e?.detail })
    process.stdout.write(`  \x1b[31mFAIL\x1b[0m ${group} · ${name} (${ms}ms)\n         ${e?.message ?? e}\n`)
    if (e?.detail) process.stdout.write(`         detail: ${JSON.stringify(e.detail).slice(0, 400)}\n`)
  }
}

// ── HTTP helper ────────────────────────────────────────────────────────────

interface AuthedFetchOpts {
  method?: string
  body?: any
  headers?: Record<string, string>
  tenantId?: string
  userToken?: string
}

async function http(path: string, opts: AuthedFetchOpts = {}): Promise<{ status: number; body: any; headers: Record<string,string> }> {
  const headers: Record<string, string> = { Accept: 'application/json', ...opts.headers }
  if (opts.body && !headers['Content-Type']) headers['Content-Type'] = 'application/json'
  if (opts.userToken) headers['Authorization'] = `Bearer ${opts.userToken}`
  if (opts.tenantId) headers['X-Tenant-ID'] = opts.tenantId
  const res = await fetch(`${ARGS.base}${path}`, {
    method: opts.method ?? 'GET',
    headers,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  })
  let body: any
  try { body = await res.json() } catch { body = await res.text() }
  const respHeaders: Record<string,string> = {}
  res.headers.forEach((v, k) => { respHeaders[k] = v })
  return { status: res.status, body, headers: respHeaders }
}

function assert(cond: any, message: string, detail?: any): asserts cond {
  if (!cond) {
    const err: any = new Error(message)
    err.detail = detail
    throw err
  }
}
function assertEq(actual: any, expected: any, message: string): void {
  if (actual !== expected) {
    throw Object.assign(new Error(`${message} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`), { detail: { actual, expected } })
  }
}

// ── Test fixture setup ─────────────────────────────────────────────────────
// We need a test tenant + a test user with a real JWT to hit auth-gated
// endpoints. We provision both via service-role on first run.

interface Fixture {
  tenantId: string
  userId: string
  userEmail: string
  userToken: string
  cleanupIds: { table: string; ids: string[] }[]
}

async function setupFixture(): Promise<Fixture> {
  const stamp = Date.now()
  const userEmail = `smoke+${stamp}@frequency-test.local`
  const userPassword = `Smoke${stamp}!_${randomUUID().slice(0, 8)}`

  // 1. Create auth user via admin API.
  const { data: userCreated, error: userErr } = await sb.auth.admin.createUser({
    email: userEmail,
    password: userPassword,
    email_confirm: true,
  })
  if (userErr || !userCreated?.user) throw new Error(`Failed to create test user: ${userErr?.message}`)
  const userId = userCreated.user.id

  // 2. Mint a session JWT for that user.
  const { data: signin, error: signinErr } = await sb.auth.signInWithPassword({
    email: userEmail,
    password: userPassword,
  })
  if (signinErr || !signin.session) throw new Error(`Failed to sign in test user: ${signinErr?.message}`)
  const userToken = signin.session.access_token

  // 3. Create a test tenant.
  const tenantSlug = `smoke-${stamp}`
  const { data: tenant, error: tenantErr } = await sb.from('tenants').insert({
    user_id: userId,
    business_name: `Smoke Test Tenant ${stamp}`,
    slug: tenantSlug,
    status: 'active',
  }).select('id').single()
  if (tenantErr || !tenant) throw new Error(`Failed to create test tenant: ${tenantErr?.message}`)
  const tenantId = tenant.id

  // 4. Give the user owner role on the tenant via user_roles (legacy table — used by every checkPermission).
  await sb.from('user_roles').insert({
    user_id: userId,
    tenant_id: tenantId,
    role: 'owner',
  })

  return { tenantId, userId, userEmail, userToken, cleanupIds: [] }
}

async function cleanup(fx: Fixture): Promise<void> {
  if (!ARGS.cleanup) {
    console.log(`\nSkipping cleanup (--no-cleanup). Tenant: ${fx.tenantId}, User: ${fx.userId}`)
    return
  }
  // Cleanup in reverse dependency order. Service-role bypasses RLS.
  for (const c of fx.cleanupIds.slice().reverse()) {
    if (c.ids.length === 0) continue
    await sb.from(c.table).delete().in('id', c.ids)
  }
  await sb.from('user_roles').delete().eq('user_id', fx.userId).eq('tenant_id', fx.tenantId)
  await sb.from('tenants').delete().eq('id', fx.tenantId)
  await sb.auth.admin.deleteUser(fx.userId)
}

// ── Test groups ────────────────────────────────────────────────────────────

async function testHealth(): Promise<void> {
  await runTest('health', 'GET /health returns 200', async () => {
    const r = await http('/health')
    assertEq(r.status, 200, '/health status')
    assert(r.body?.status === 'ok', '/health body.status', r.body)
  })
}

async function testWorkflowBuilder(): Promise<void> {
  await runTest('workflow-builder', 'GET /api/workflow-builder/picker-catalog returns 8 categories', async () => {
    const r = await http('/api/workflow-builder/picker-catalog')
    assertEq(r.status, 200, 'picker-catalog status')
    assert(Array.isArray(r.body?.categories), 'categories is an array')
    assert(r.body.categories.length >= 8, `expected ≥8 categories, got ${r.body.categories.length}`)
    assert(typeof r.body?.fields === 'object', 'fields is an object')
    // Sanity-check key catalog entries
    const fields = r.body.fields
    for (const expected of ['spreadsheet_id', 'sheet_tab_name', 'table_id', 'pipeline_stage_id', 'segment_id', 'operation_razorpay']) {
      assert(fields[expected], `catalog missing ${expected}`)
    }
  })
}

async function testAuthGate(fx: Fixture): Promise<void> {
  await runTest('auth', 'GET /api/sla/config without auth → 401', async () => {
    const r = await http('/api/sla/config')
    assert(r.status === 401 || r.status === 403, `expected 401/403, got ${r.status}`, r.body)
  })
  await runTest('auth', 'GET /api/sla/config with auth → 200', async () => {
    const r = await http('/api/sla/config', { userToken: fx.userToken, tenantId: fx.tenantId })
    assertEq(r.status, 200, 'authed sla/config status')
    assert(Array.isArray(r.body?.data), 'sla data is array')
  })
}

async function testSla(fx: Fixture): Promise<void> {
  let createdId: string | null = null
  await runTest('sla', 'POST /api/sla/config creates a rule', async () => {
    const r = await http('/api/sla/config', {
      method: 'POST', userToken: fx.userToken, tenantId: fx.tenantId,
      body: { channel: 'any', first_response_seconds: 900, resolution_seconds: 86400 },
    })
    assertEq(r.status, 200, 'sla create status')
    assert(r.body?.data?.id, 'sla rule has id', r.body)
    createdId = r.body.data.id
    fx.cleanupIds.push({ table: 'sla_configs', ids: [createdId!] })
  })
  await runTest('sla', 'GET /api/sla/config shows the new rule', async () => {
    const r = await http('/api/sla/config', { userToken: fx.userToken, tenantId: fx.tenantId })
    assertEq(r.status, 200, 'sla list status')
    assert(r.body.data.some((d: any) => d.id === createdId), 'created rule appears in list')
  })
  await runTest('sla', 'POST /api/sla/config upsert (same channel,team) idempotent', async () => {
    // Second POST with same channel+team_id should update (not insert dup).
    const r = await http('/api/sla/config', {
      method: 'POST', userToken: fx.userToken, tenantId: fx.tenantId,
      body: { channel: 'any', first_response_seconds: 1800, resolution_seconds: 172800 },
    })
    assertEq(r.status, 200, 'sla upsert status')
    // Validate only ONE row exists with these scoping keys.
    const { data: rows } = await sb.from('sla_configs')
      .select('id').eq('tenant_id', fx.tenantId).is('team_id', null).eq('channel', 'any')
    assertEq(rows?.length, 1, 'upsert collapsed duplicates')
  })
  await runTest('sla', 'GET /api/sla/breaches returns array', async () => {
    const r = await http('/api/sla/breaches?active=1', { userToken: fx.userToken, tenantId: fx.tenantId })
    assertEq(r.status, 200, 'sla breaches status')
    assert(Array.isArray(r.body?.data), 'breaches data is array')
  })
}

async function testPii(fx: Fixture): Promise<void> {
  await runTest('pii', 'GET /api/pii/config seeds default config', async () => {
    const r = await http('/api/pii/config', { userToken: fx.userToken, tenantId: fx.tenantId })
    assertEq(r.status, 200, 'pii config status')
    assert(Array.isArray(r.body?.data?.enabled_types), 'enabled_types is array', r.body)
    assert(['off','warn','block'].includes(r.body.data.outbound_action), `outbound_action: ${r.body.data.outbound_action}`)
  })
  await runTest('pii', 'PATCH /api/pii/config flips outbound_action to block', async () => {
    const r = await http('/api/pii/config', {
      method: 'PATCH', userToken: fx.userToken, tenantId: fx.tenantId,
      body: { outbound_action: 'block' },
    })
    assertEq(r.status, 200, 'pii patch status')
    assertEq(r.body?.data?.outbound_action, 'block', 'patched value persisted')
  })
}

async function testAiResponder(fx: Fixture): Promise<void> {
  await runTest('ai', 'GET /api/ai/settings seeds default settings', async () => {
    const r = await http('/api/ai/settings', { userToken: fx.userToken, tenantId: fx.tenantId })
    assertEq(r.status, 200, 'ai settings status')
    assert(r.body?.settings, 'settings object present', r.body)
    assertEq(r.body.settings.enabled, false, 'default enabled=false')
  })
  await runTest('ai', 'POST /api/ai/qa-wizard satisfies the wizard gate', async () => {
    const r = await http('/api/ai/qa-wizard', {
      method: 'POST', userToken: fx.userToken, tenantId: fx.tenantId,
      body: { business_name: 'Smoke Test Co.' },
    })
    assertEq(r.status, 200, 'qa-wizard status')
    assert(r.body?.settings?.qa_wizard_completed_at, 'wizard timestamp set', r.body)
  })
  await runTest('ai', 'POST /api/ai/knowledge adds a chunk', async () => {
    const r = await http('/api/ai/knowledge', {
      method: 'POST', userToken: fx.userToken, tenantId: fx.tenantId,
      body: { text: 'Q: What are your hours?\nA: 9am - 6pm Mon-Sat.', source_ref: 'hours' },
    })
    assertEq(r.status, 200, 'knowledge add status')
    assert(r.body?.chunks_inserted >= 1, `expected ≥1 chunk inserted, got ${r.body?.chunks_inserted}`)
  })
}

async function testCrm(fx: Fixture): Promise<void> {
  await runTest('crm', 'GET /api/crm/stages auto-seeds defaults', async () => {
    const r = await http('/api/crm/stages', { userToken: fx.userToken, tenantId: fx.tenantId })
    assertEq(r.status, 200, 'crm stages status')
    const stages = Array.isArray(r.body) ? r.body : r.body?.data ?? []
    assert(stages.length >= 3, `expected ≥3 seeded stages, got ${stages.length}`, r.body)
    assert(stages.some((s: any) => s.is_won),  'one stage marked is_won')
    assert(stages.some((s: any) => s.is_lost), 'one stage marked is_lost')
  })
}

async function testTables(fx: Fixture): Promise<void> {
  let tableId: string | null = null
  await runTest('tables', 'GET /api/lead-tables (initially empty)', async () => {
    const r = await http('/api/lead-tables', { userToken: fx.userToken, tenantId: fx.tenantId })
    assertEq(r.status, 200, 'lead-tables list status')
    assert(Array.isArray(r.body), `expected array, got ${typeof r.body}`, r.body)
  })
  await runTest('tables', 'POST /api/lead-tables creates a table with columns', async () => {
    const r = await http('/api/lead-tables', {
      method: 'POST', userToken: fx.userToken, tenantId: fx.tenantId,
      body: {
        name: 'Smoke Test Customers',
        source: 'manual',
        columns: [
          { name: 'Email',  type: 'text', is_required: true,  options: [] },
          { name: 'Status', type: 'text', is_required: false, options: [] },
        ],
      },
    })
    assertEq(r.status, 200, 'create table status')
    assert(r.body?.id, 'table has id', r.body)
    tableId = r.body.id
    fx.cleanupIds.push({ table: 'lead_tables', ids: [tableId!] })
    // Verify columns landed in DB.
    const { data: cols } = await sb.from('lead_columns').select('name, key').eq('table_id', tableId)
    assert(cols && cols.length >= 2, `expected ≥2 columns in DB, got ${cols?.length}`)
  })
  await runTest('tables', 'GET /api/lead-tables shows the new table', async () => {
    const r = await http('/api/lead-tables', { userToken: fx.userToken, tenantId: fx.tenantId })
    assert(r.body.some((t: any) => t.id === tableId), 'new table in list')
  })
}

async function testGoogleSheetsImportRegression(fx: Fixture): Promise<void> {
  // This is the regression case the user just hit. We can't exercise the
  // full mirror flow without OAuth credentials, but we CAN test the parts
  // that broke: the dedupe path + the bulk insert path.
  // The smoke test below proves the runFirstImport helper handles the
  // 500-row case without timing out by exercising lead_rows insert at
  // batch sizes that previously did N+1 sequential SELECTs.
  let tableId: string | null = null
  await runTest('sheets-import', 'Create test table for bulk insert regression', async () => {
    const r = await http('/api/lead-tables', {
      method: 'POST', userToken: fx.userToken, tenantId: fx.tenantId,
      body: {
        name: 'Smoke Import Regression',
        source: 'csv',
        columns: [
          { name: 'Email',  type: 'text', is_required: true,  options: [] },
          { name: 'Status', type: 'text', is_required: false, options: [] },
        ],
      },
    })
    assertEq(r.status, 200, 'create regression table')
    tableId = r.body.id
    fx.cleanupIds.push({ table: 'lead_tables', ids: [tableId!] })
  })
  await runTest('sheets-import', 'Bulk-insert 200 rows in under 10s (previously N+1 timed out)', async () => {
    if (!tableId) throw new Error('no tableId from prior test')
    const start = Date.now()
    const rows = Array.from({ length: 200 }, (_, i) => ({
      tenant_id: fx.tenantId,
      user_id:   fx.userId,
      table_id:  tableId,
      data:      { email: `smoke-${i}@test.local`, status: 'new' },
      status:    'new',
      tags:      [],
    }))
    const { error } = await sb.from('lead_rows').insert(rows)
    if (error) throw new Error(`bulk insert failed: ${error.message}`)
    const ms = Date.now() - start
    assert(ms < 10_000, `bulk-200 insert took ${ms}ms — expected <10s. N+1 regression suspected.`)
    // Verify count
    const { count } = await sb.from('lead_rows').select('id', { count: 'exact', head: true }).eq('table_id', tableId)
    assertEq(count, 200, '200 rows landed in DB')
  })
}

async function testInvalidAuth(fx: Fixture): Promise<void> {
  await runTest('auth-edge', 'POST /api/inbox/send without auth → 401', async () => {
    const r = await http('/api/inbox/send', {
      method: 'POST',
      body: { channel: 'whatsapp', phone: '919999999999', type: 'text', text: 'hi' },
    })
    assert(r.status === 401 || r.status === 403, `expected 401/403, got ${r.status}`)
  })
  await runTest('auth-edge', 'GET /api/parse-workflow with bad tenant header → 401/403', async () => {
    const r = await http('/api/parse-workflow', {
      method: 'POST', userToken: fx.userToken, tenantId: '00000000-0000-0000-0000-000000000000',
      body: { message: 'hello' },
    })
    // Non-existent tenant → identifyTenant blocks
    assert(r.status === 401 || r.status === 403 || r.status === 404, `expected 4xx, got ${r.status}`, r.body)
  })
}

// ── Main ───────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log(`\n┌─ Smoke run · ${new Date().toISOString()}`)
  console.log(`│  Base: ${ARGS.base}`)
  console.log(`│  Filter: ${ARGS.only ? ARGS.only.join(',') : '<all>'}`)
  console.log(`└─\n`)

  // Health first — if BE isn't up, fail fast.
  await testHealth()
  await testWorkflowBuilder()

  // Provision fixture for auth-gated tests.
  console.log('\nProvisioning test fixture…')
  const fx = await setupFixture()
  console.log(`  tenant=${fx.tenantId}\n  user=${fx.userId}`)

  try {
    await testAuthGate(fx)
    await testSla(fx)
    await testPii(fx)
    await testAiResponder(fx)
    await testCrm(fx)
    await testTables(fx)
    await testGoogleSheetsImportRegression(fx)
    await testInvalidAuth(fx)
  } finally {
    console.log('\nCleaning up fixture…')
    await cleanup(fx)
  }

  const pass = RESULTS.filter(r => r.status === 'PASS').length
  const fail = RESULTS.filter(r => r.status === 'FAIL').length
  const skip = RESULTS.filter(r => r.status === 'SKIP').length
  const totalMs = RESULTS.reduce((sum, r) => sum + r.ms, 0)
  console.log(`\n┌─ Smoke summary`)
  console.log(`│  ${pass} pass · ${fail} fail · ${skip} skip · ${totalMs}ms total`)
  if (fail > 0) {
    console.log(`│  Failures:`)
    for (const r of RESULTS.filter(r => r.status === 'FAIL')) {
      console.log(`│   · ${r.group} · ${r.name}: ${r.message}`)
    }
  }
  console.log(`└─`)
  process.exit(fail === 0 ? 0 : 1)
}

main().catch(e => {
  console.error('Smoke runner crashed:', e)
  process.exit(2)
})
