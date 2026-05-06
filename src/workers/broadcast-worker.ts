/**
 * Worker: broadcast.batch
 *
 * Fans one broadcast out into N per-contact `message.send` jobs.
 *
 * Why a queue and not an inline for-loop?
 *   - Survives API-process restarts mid-broadcast (BullMQ persists jobs).
 *   - Per-message retries (5 attempts) handled uniformly by message-sender.
 *   - Tenant-scoped rate limiting in message-sender prevents Meta 429s.
 *   - Bull Board shows progress + failures live.
 *
 * Template variable mapping (roadmap §2.5):
 *   broadcasts.variable_map is a JSONB like:
 *     { "1": "name", "2": "attributes.city", "3": "phone" }
 *   For each contact, this resolves dotted paths and produces the ordered
 *   parameter array Meta expects.
 */

import '../env'
import { Worker, Job } from 'bullmq'
import { createClient } from '@supabase/supabase-js'
import { Q, BroadcastBatchJob, connection, enqueueMessageSend } from '../queue'

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://yiicpndeggaedxobyopu.supabase.co'
const supabase = createClient(SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY!)

export function startBroadcastWorker() {
  const worker = new Worker<BroadcastBatchJob>(
    Q.broadcast,
    async (job: Job<BroadcastBatchJob>) => {
      const { broadcastId } = job.data

      // 1. Load broadcast + tenant in one trip
      const { data: broadcast, error: bErr } = await supabase
        .from('broadcasts')
        .select('id, tenant_id, template_name, audience, variable_map, language, status')
        .eq('id', broadcastId)
        .maybeSingle()
      if (bErr) throw new Error(`load broadcast: ${bErr.message}`)
      if (!broadcast) throw new Error(`broadcast ${broadcastId} not found`)
      if (broadcast.status === 'sent' || broadcast.status === 'failed') {
        return { skipped: `status=${broadcast.status}` }
      }

      const { data: tenant } = await supabase.from('tenants')
        .select('id, access_token, phone_number_id')
        .eq('id', broadcast.tenant_id).maybeSingle()
      if (!tenant?.access_token) {
        await markFailed(broadcast.id, 'tenant has no WhatsApp credentials')
        throw new Error('tenant has no WhatsApp credentials')
      }

      // 2. Resolve audience → contact list
      let q = supabase.from('contacts')
        .select('id, phone, name, email, attributes, tags')
        .eq('tenant_id', broadcast.tenant_id)
        .eq('status', 'active')
      const audience = (broadcast.audience ?? {}) as any
      if (audience.tags?.length)        q = q.overlaps('tags', audience.tags)
      if (audience.exclude_tags?.length) q = q.not('tags', 'ov', `{${audience.exclude_tags.join(',')}}`)

      const { data: contacts, error: cErr } = await q
      if (cErr) throw new Error(`load contacts: ${cErr.message}`)
      if (!contacts || contacts.length === 0) {
        await markFailed(broadcast.id, 'no contacts match audience')
        return { recipients: 0 }
      }

      // 3. Mark sending + record planned recipient count
      await supabase.from('broadcasts').update({
        status: 'sending',
        sent_at: new Date().toISOString(),
        stats: { queued: contacts.length, sent: 0, delivered: 0, read: 0, replied: 0, failed: 0 },
      }).eq('id', broadcast.id)

      // 4. Fan out — one message.send job per contact.
      //    BullMQ accepts bulk add for efficiency.
      const language = broadcast.language ?? 'en_US'
      const varMap = (broadcast.variable_map ?? {}) as Record<string, string>
      let enqueued = 0
      for (const contact of contacts) {
        const params = buildTemplateParams(varMap, contact)
        try {
          await enqueueMessageSend({
            tenantId: broadcast.tenant_id,
            to: contact.phone.replace(/^\+/, ''),
            channel: 'whatsapp',
            kind: 'template',
            template: { name: broadcast.template_name!, language, parameters: params },
            broadcastId: broadcast.id,
            sessionId: null,
          })
          enqueued++
        } catch (err: any) {
          console.warn(`[broadcast] failed to enqueue contact=${contact.id}: ${err.message}`)
        }
      }

      console.log(`[broadcast] ${broadcast.id} fanned out ${enqueued}/${contacts.length}`)
      return { broadcastId: broadcast.id, enqueued, totalContacts: contacts.length }
    },
    {
      connection,
      concurrency: Number(process.env.BROADCAST_CONCURRENCY ?? 3),
    }
  )

  worker.on('failed', (job, err) => {
    console.warn(`[worker:broadcast] ✗ job=${job?.id} — ${err.message}`)
  })
  console.log('[worker:broadcast] started')
  return worker
}

// ── helpers ──────────────────────────────────────────────────────────────────
async function markFailed(broadcastId: string, reason: string) {
  await supabase.from('broadcasts').update({
    status: 'failed',
    stats: { error: reason },
  }).eq('id', broadcastId)
}

/**
 * variable_map = { "1": "name", "2": "attributes.city", "3": "phone" }
 * → returns ['Rahul', 'Mumbai', '+919876543210'] in that order.
 *
 * Numeric keys are sorted; missing values become empty string so Meta
 * doesn't reject the template for missing params.
 */
function buildTemplateParams(varMap: Record<string, string>, contact: any): string[] {
  const numericKeys = Object.keys(varMap)
    .filter(k => /^\d+$/.test(k))
    .sort((a, b) => Number(a) - Number(b))
  return numericKeys.map(k => {
    const path = varMap[k]
    if (!path) return ''
    const val = resolvePath(contact, path)
    return val == null ? '' : String(val)
  })
}

function resolvePath(obj: any, path: string): any {
  return path.split('.').reduce((acc, part) => (acc == null ? acc : acc[part]), obj)
}
