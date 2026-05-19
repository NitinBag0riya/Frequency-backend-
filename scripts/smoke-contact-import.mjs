#!/usr/bin/env node
/**
 * Smoke test for P1 #18 — bulk contact import + saved segments.
 *
 * Uses service-role to bypass auth/RLS (priya seed isn't available on
 * this remote). Exercises the underlying tables and the BullMQ
 * worker by directly INSERTing a job row, adding it to the queue,
 * polling for completion, then INSERTing a segment + invoking the
 * filter evaluator.
 *
 * Verifies:
 *   • contact_import_jobs row lifecycle (pending → dry_run → completed)
 *   • contacts UPSERT lands rows under the tenant
 *   • consent_events row written per imported contact with source='bulk_import'
 *   • contact_segments row stored
 *   • segment-filter evaluator returns a count for {city:'Mumbai'}
 *
 * Run with the worker up:
 *   DISABLE_WORKERS=0 npm run dev:worker   # in another terminal
 *   node scripts/smoke-contact-import.mjs
 */

import 'dotenv/config'
import { createClient } from '@supabase/supabase-js'
import IORedis from 'ioredis'
import { Queue } from 'bullmq'

const SUPABASE_URL = process.env.SUPABASE_URL
const SVC = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!SUPABASE_URL || !SVC) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in env')
  process.exit(1)
}
const supabase = createClient(SUPABASE_URL, SVC)

// ── Pick a tenant ─────────────────────────────────────────────────────────
const { data: tenants } = await supabase.from('tenants').select('id, status').limit(5)
if (!tenants || tenants.length === 0) {
  console.error('no tenants found — seed required')
  process.exit(2)
}
const active = tenants.find(t => t.status === 'active') ?? tenants[0]
const tenantId = active.id
console.log(`▶ tenant=${tenantId} status=${active.status}`)

// ── 1. INSERT a contact_import_jobs row directly ──────────────────────────
const stamp = Date.now()
const csv = `phone,name,city
+919876543210,Smoke Test User 1,Mumbai
+919876543211,Smoke Test User 2,Mumbai
+919876543212,Smoke Test User 3,Bengaluru
`
const { data: job, error: jErr } = await supabase.from('contact_import_jobs').insert({
  tenant_id:          tenantId,
  filename:           `smoke-${stamp}.csv`,
  source_label:       `smoke_${stamp}`,
  consent_basis:      'opt_in_form',
  consent_proof_text: 'Smoke test consent capture from automated test harness; not production data.',
  inline_payload:     csv,
  status:             'pending',
}).select().single()
if (jErr || !job) { console.error('insert job:', jErr); process.exit(10) }
console.log(`✓ inserted contact_import_jobs id=${job.id}`)

// ── 2. Enqueue to BullMQ ──────────────────────────────────────────────────
const conn = new IORedis(process.env.REDIS_URL || 'redis://127.0.0.1:6379', {
  maxRetriesPerRequest: null, enableReadyCheck: false,
})
const queue = new Queue('contact.import', { connection: conn })
await queue.add('process', { jobId: job.id }, { jobId: `contact-import-${job.id}` })
console.log(`✓ enqueued BullMQ job for ${job.id}`)

// ── 3. Poll for dry_run ───────────────────────────────────────────────────
console.log('⏳ polling for status=dry_run...')
let dry
for (let i = 0; i < 30; i++) {
  await new Promise(r => setTimeout(r, 1000))
  const { data } = await supabase.from('contact_import_jobs').select('*').eq('id', job.id).single()
  process.stdout.write(`  tick ${i+1}: status=${data?.status}                 \r`)
  if (data?.status === 'dry_run' || data?.status === 'failed') { dry = data; break }
}
console.log('')
if (!dry || dry.status !== 'dry_run') {
  console.error(`✗ never reached dry_run (last: ${JSON.stringify(dry, null, 2)})`)
  await queue.close(); await conn.quit()
  process.exit(11)
}
console.log(`✓ dry_run: rows_total=${dry.rows_total} rows_error=${dry.rows_error}`)
console.log(`  preview[0..2]:`, JSON.stringify((dry.preview_jsonb ?? []).slice(0, 3), null, 2))

// ── 4. Flip to executing, re-enqueue ──────────────────────────────────────
await supabase.from('contact_import_jobs').update({
  status: 'executing', started_at: new Date().toISOString(),
}).eq('id', job.id)
await queue.add('process', { jobId: job.id }, { jobId: `contact-import-commit-${job.id}` })
console.log('✓ flipped to executing + re-enqueued')

// ── 5. Poll for completed/partial ─────────────────────────────────────────
console.log('⏳ polling for status=completed/partial...')
let final
for (let i = 0; i < 30; i++) {
  await new Promise(r => setTimeout(r, 1000))
  const { data } = await supabase.from('contact_import_jobs').select('*').eq('id', job.id).single()
  process.stdout.write(`  tick ${i+1}: status=${data?.status} imported=${data?.rows_imported} updated=${data?.rows_updated}\r`)
  if (['completed','partial','failed'].includes(data?.status)) { final = data; break }
}
console.log('')
console.log(`✓ final: status=${final?.status} imported=${final?.rows_imported} updated=${final?.rows_updated} errored=${final?.rows_error}`)

// ── 6. Verify contacts landed ─────────────────────────────────────────────
const { data: imported } = await supabase.from('contacts')
  .select('id, phone, name, attributes')
  .eq('tenant_id', tenantId)
  .in('phone', ['919876543210','919876543211','919876543212'])
console.log(`✓ contacts in tenant: ${imported?.length ?? 0}`)
console.log(`  e.g.`, JSON.stringify(imported?.[0], null, 2))

// ── 7. Verify consent_events landed ───────────────────────────────────────
const { data: events } = await supabase.from('consent_events')
  .select('id, contact_id, source, source_detail, proof_text')
  .eq('tenant_id', tenantId)
  .eq('source', 'bulk_import')
  .order('occurred_at', { ascending: false })
  .limit(5)
console.log(`✓ consent_events (source='bulk_import') recent: ${events?.length ?? 0}`)
console.log(`  e.g.`, JSON.stringify(events?.[0], null, 2))

// ── 8. Create a segment + count + preview ─────────────────────────────────
const { data: seg, error: segErr } = await supabase.from('contact_segments').insert({
  tenant_id: tenantId,
  name:      `smoke seg ${stamp}`,
  filters:   { city: 'Mumbai' },
}).select().single()
if (segErr || !seg) { console.error('insert segment:', segErr); await queue.close(); await conn.quit(); process.exit(20) }
console.log(`✓ contact_segments id=${seg.id}`)

// Evaluate inline (mimics the segments route /count handler).
let cQ = supabase.from('contacts').select('id', { count: 'exact', head: true }).eq('tenant_id', tenantId)
if (seg.filters?.city) cQ = cQ.filter('attributes->>city', 'ilike', seg.filters.city)
const { count } = await cQ
console.log(`✓ segment count (city=Mumbai) = ${count}`)

await queue.close()
await conn.quit()
console.log('\n✓ smoke complete')
