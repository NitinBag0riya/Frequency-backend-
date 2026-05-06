/**
 * Worker: template-sync (singleton repeatable, every 15 min)
 *
 * Polls Meta's WhatsApp Business Account templates endpoint per active tenant
 * and reconciles `public.wa_templates.status` so the UI shows up-to-date
 * approval state (was: "PENDING" forever once submitted).
 *
 * Meta returns one of: APPROVED | PENDING | REJECTED | DELETED | IN_APPEAL | PAUSED
 * → mapped to lowercase to match the wa_templates.status CHECK constraint
 *   (expanded in migration 011).
 *
 * Hot-path notes:
 *   - We page through with limit=100; tenants typically have <50 templates.
 *   - Failed tenants don't block other tenants — each is wrapped in try/catch.
 *   - This is a separate queue (system.cron) so a slow Meta API doesn't stall
 *     workflow execution.
 */

import '../env'
import { Worker, Job } from 'bullmq'
import { createClient } from '@supabase/supabase-js'
import { Q, connection, cronQueue } from '../queue'

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://yiicpndeggaedxobyopu.supabase.co'
const supabase = createClient(SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY!)

const GRAPH = 'https://graph.facebook.com/v18.0'
const SYNC_INTERVAL_MS = Number(process.env.TEMPLATE_SYNC_INTERVAL_MS ?? 15 * 60 * 1000)

export async function startTemplateSyncWorker() {
  // Schedule the singleton repeatable tick on the same cron queue.
  await cronQueue.add(
    'template-sync',
    { task: 'template-sync' },
    {
      jobId: 'singleton-template-sync',
      repeat: { every: SYNC_INTERVAL_MS },
      removeOnComplete: { count: 50 },
      removeOnFail:     { count: 50 },
    }
  )

  // Worker that handles only template-sync jobs from system.cron.
  // (The schedule-poller worker on the same queue ignores this job kind via name filter.)
  const worker = new Worker(
    Q.cron,
    async (job: Job) => {
      // Only process the template-sync job; let other workers handle other names.
      if (job.name !== 'template-sync') return { skipped: 'not template-sync' }
      return runSync()
    },
    {
      connection,
      concurrency: 1,
    }
  )

  worker.on('failed', (job, err) => {
    if (job?.name === 'template-sync') {
      console.warn(`[template-sync] tick failed: ${err.message}`)
    }
  })

  console.log(`[worker:template-sync] started, interval=${SYNC_INTERVAL_MS}ms`)
  return worker
}

async function runSync() {
  const startedAt = Date.now()
  const { data: tenants, error } = await supabase
    .from('tenants')
    .select('id, waba_id, access_token')
    .eq('status', 'active')
    .not('access_token', 'is', null)
  if (error) throw new Error(`load tenants: ${error.message}`)
  if (!tenants || tenants.length === 0) return { tenants: 0 }

  let totalTemplates = 0
  let updated = 0
  let failedTenants = 0

  for (const tenant of tenants) {
    if (!tenant.waba_id || !tenant.access_token) continue
    try {
      const templates = await fetchTemplates(tenant.waba_id, tenant.access_token)
      totalTemplates += templates.length
      for (const t of templates) {
        const status = mapStatus(t.status)
        const { error: upErr } = await supabase.from('wa_templates').update({
          status,
          meta_template_id: t.id,
          rejection_reason: t.rejected_reason ?? null,
          last_synced_at: new Date().toISOString(),
        })
        .eq('tenant_id', tenant.id)
        .eq('name', t.name)
        .eq('language', t.language)
        if (!upErr) updated++
      }
    } catch (err: any) {
      failedTenants++
      console.warn(`[template-sync] tenant=${tenant.id} failed: ${err.message}`)
    }
  }

  const duration = Date.now() - startedAt
  console.log(`[template-sync] tenants=${tenants.length} fetched=${totalTemplates} updated=${updated} failed=${failedTenants} ${duration}ms`)
  return { tenants: tenants.length, fetched: totalTemplates, updated, failedTenants, durationMs: duration }
}

async function fetchTemplates(wabaId: string, accessToken: string) {
  // Meta returns 25 by default; bump to 100 to cover most tenants in 1 page.
  const url = `${GRAPH}/${wabaId}/message_templates?limit=100&fields=id,name,language,status,category,rejected_reason`
  const out: any[] = []
  let next: string | null = url
  let pages = 0
  while (next && pages < 5) {  // hard cap pages so a runaway Meta response can't loop forever
    const r = await fetch(next, { headers: { Authorization: `Bearer ${accessToken}` } })
    if (!r.ok) {
      const txt = await r.text()
      throw new Error(`Meta ${r.status}: ${txt.slice(0, 200)}`)
    }
    const body = await r.json() as any
    if (Array.isArray(body.data)) out.push(...body.data)
    next = body.paging?.next ?? null
    pages++
  }
  return out
}

function mapStatus(metaStatus: string): string {
  const s = (metaStatus ?? '').toLowerCase()
  // Meta's `IN_APPEAL` → `in_appeal`, `DELETED` → `deleted`, etc.
  return s.replace(/[^a-z_]/g, '_') || 'pending'
}
