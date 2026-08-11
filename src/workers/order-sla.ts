/**
 * Worker: order-sla (singleton repeatable)
 *
 * Closes the escalation gap in the aggregator order pipeline. The FE re-rings
 * while a browser sits on /orders, but nothing escalated a still-unaccepted
 * order when the dashboard was closed. This worker scans every tick for orders
 * that are still `new` past the acceptance SLA and emits a high-severity
 * `order.late` notification (which reaches the bell + any out-of-band channel),
 * stamping `late_notified_at` so each order escalates exactly once.
 *
 * Idempotency: the `late_notified_at is null` filter + the per-order stamp means
 * concurrent ticks / multiple worker instances never double-escalate.
 */

import '../env'
import { Worker, type Job } from 'bullmq'
import { createClient } from '@supabase/supabase-js'
import { Q, connection, cronQueue } from '../queue'
import { logger } from '../lib/logger'
import { isPollerEnabled, cleanRepeatablesByName, STUB_WORKER, logGate, pollIntervalMs } from '../lib/poller-gate'
import { emitNotification } from '../routes/notifications'
import { runComplaintSlaTick } from './complaint-sla'

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://yiicpndeggaedxobyopu.supabase.co'
const supabase = createClient(SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY!)

const TICK_INTERVAL_MS = pollIntervalMs('ORDER_SLA_INTERVAL_MS', { prod: 60_000, dev: 5 * 60_000 })
// How long an order may sit in `new` before it's escalated as late.
const SLA_SECONDS = Number(process.env.ORDER_SLA_LATE_SECONDS ?? 180)

const CHANNEL_LABEL: Record<string, string> = { zomato: 'Zomato', swiggy: 'Swiggy' }
const CUR: Record<string, string> = { INR: '₹', USD: '$', EUR: '€', GBP: '£' }

async function tenantRecipients(tenantId: string): Promise<string[]> {
  const { data } = await supabase.from('user_role_assignments')
    .select('user_id').eq('tenant_id', tenantId).is('disabled_at', null)
  return Array.from(new Set((data ?? []).map((r: any) => r.user_id).filter(Boolean)))
}

async function runTick(): Promise<{ escalated: number }> {
  // Complaints SLA rides the same tick (no idle worker).
  try { await runComplaintSlaTick(supabase) } catch (e: any) { logger.warn(`[complaint-sla] ${e?.message}`) }
  const cutoff = new Date(Date.now() - SLA_SECONDS * 1000).toISOString()
  // Small candidate set: still-new, not-yet-escalated orders.
  const { data: orders, error } = await supabase.from('aggregator_orders')
    .select('id, tenant_id, channel, external_order_id, item_count, gross_amount, currency, placed_at, created_at')
    .eq('status', 'new').is('late_notified_at', null)
    .limit(500)
  if (error) throw new Error(`order-sla scan failed: ${error.message}`)

  const due = (orders ?? []).filter(o => {
    const t = (o as any).placed_at ?? (o as any).created_at
    return t && new Date(t).getTime() <= new Date(cutoff).getTime()
  })
  if (due.length === 0) return { escalated: 0 }

  // Resolve recipients once per tenant.
  const recipientsByTenant = new Map<string, string[]>()
  let escalated = 0
  for (const o of due) {
    try {
      const tenantId = (o as any).tenant_id
      if (!recipientsByTenant.has(tenantId)) recipientsByTenant.set(tenantId, await tenantRecipients(tenantId))
      const recipients = recipientsByTenant.get(tenantId)!
      const items = (o as any).item_count ?? 0
      const gross = (o as any).gross_amount
      const cur = CUR[(o as any).currency] ?? (o as any).currency ?? '₹'
      const summary = `${items} item${items === 1 ? '' : 's'}${gross != null ? ` · ${cur}${Number(gross).toLocaleString('en-IN')}` : ''} — still not accepted`

      if (recipients.length) {
        await emitNotification(supabase, {
          tenant_id: tenantId,
          event_key: 'order.late',
          recipient_user_ids: recipients,
          link: '/orders',
          data: {
            channel: (o as any).channel, channel_label: CHANNEL_LABEL[(o as any).channel] ?? (o as any).channel,
            order_id: (o as any).external_order_id, summary, priority: 'high',
          },
        })
      }
      // Stamp regardless of recipient count so we don't rescan it forever.
      await supabase.from('aggregator_orders').update({ late_notified_at: new Date().toISOString() }).eq('id', (o as any).id)
      escalated++
    } catch (e: any) {
      logger.warn(`[order-sla] escalation failed for order ${(o as any).id}: ${e?.message}`)
    }
  }
  return { escalated }
}

export async function startOrderSlaWorker() {
  const enabled = isPollerEnabled('ORDER_SLA')
  logGate('ORDER_SLA', enabled)
  if (!enabled) {
    await cleanRepeatablesByName(cronQueue, 'order-sla')
    return STUB_WORKER
  }

  await cronQueue.add(
    'order-sla',
    {},
    {
      jobId: 'singleton-order-sla',
      repeat: { every: TICK_INTERVAL_MS },
      removeOnComplete: { count: 50 },
      removeOnFail:     { count: 50 },
    },
  )

  const worker = new Worker(
    Q.cron,
    async (job: Job) => {
      if (job.name !== 'order-sla') return { skipped: 'not for me' }
      const out = await runTick()
      if (out.escalated) logger.info(`[order-sla] escalated ${out.escalated} late order(s)`)
      return out
    },
    { connection, concurrency: 1 },
  )
  worker.on('failed', (job, err) => {
    if (job?.name === 'order-sla') logger.warn(`[order-sla] tick failed: ${err.message}`)
  })

  console.log(`[worker:order-sla] started, interval=${TICK_INTERVAL_MS}ms, sla=${SLA_SECONDS}s`)
  return worker
}

// Exported for a direct one-shot run in tests/verification.
export { runTick as _orderSlaRunTick }
