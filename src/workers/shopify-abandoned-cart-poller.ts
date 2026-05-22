/**
 * Worker: shopify-abandoned-cart-poller (singleton repeatable, every 5 min)
 *
 * The Shopify `checkouts/create` + `checkouts/update` webhooks tell us a
 * cart exists, but we wait 10 minutes before nudging the customer — most
 * "abandonments" are actually 30-second pauses while the merchant fetches
 * their wallet. This worker runs the eligibility query:
 *
 *   abandoned_at < now() - 10 min
 *   AND recovered_at IS NULL
 *   AND nudge_sent_at IS NULL
 *   AND customer_phone IS NOT NULL
 *
 * For each row, fires the `shopify_abandoned_cart` workflow trigger
 * (variables.trigger.{checkout_url, contact_phone, total_inr_paise, …}),
 * then stamps `nudge_sent_at = now()` so we don't double-nudge on the next
 * tick. Workflow authoring is chat-driven — the tenant pre-creates a workflow
 * with `shopify_abandoned_cart` as the entry trigger and the recovery flow
 * (WhatsApp template / Telegram / IG DM) as the body.
 *
 * Singleton via cronQueue + jobId, same pattern as consent-expiry-sweep.
 * Idempotent because the eligibility filter excludes rows we've already
 * nudged. Errors per row are logged + swallowed so one bad row doesn't
 * starve the rest of the batch.
 */

import '../env'
import { Worker, Job } from 'bullmq'
import { createClient } from '@supabase/supabase-js'
import { Q, connection, cronQueue } from '../queue'
import { fireShopifyTrigger } from '../engine/shopify-triggers'
import { isPollerEnabled, cleanRepeatablesByName, STUB_WORKER, logGate, pollIntervalMs } from '../lib/poller-gate'

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://yiicpndeggaedxobyopu.supabase.co'
const supabase = createClient(SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY!)

// 5 min prod · 30 min dev.
const TICK_INTERVAL_MS = pollIntervalMs('SHOPIFY_CART_POLLER_INTERVAL_MS', { prod: 5 * 60_000, dev: 30 * 60_000 })
const NUDGE_DELAY_MIN  = Number(process.env.SHOPIFY_CART_NUDGE_DELAY_MIN ?? 10)
const BATCH_SIZE       = 200

export async function startShopifyAbandonedCartPollerWorker() {
  const enabled = isPollerEnabled('SHOPIFY_CART_POLLER')
  logGate('SHOPIFY_CART_POLLER', enabled)
  if (!enabled) {
    await cleanRepeatablesByName(cronQueue, 'shopify-abandoned-cart-poller')
    return STUB_WORKER
  }

  await cronQueue.add(
    'shopify-abandoned-cart-poller',
    {},
    {
      jobId: 'singleton-shopify-abandoned-cart-poller',
      repeat: { every: TICK_INTERVAL_MS },
      removeOnComplete: { count: 50 },
      removeOnFail:     { count: 50 },
    },
  )

  const worker = new Worker(
    Q.cron,
    async (job: Job) => {
      if (job.name !== 'shopify-abandoned-cart-poller') return { skipped: 'not for me' }
      return runTick()
    },
    { connection, concurrency: 1 },
  )

  worker.on('failed', (job, err) => {
    if (job?.name === 'shopify-abandoned-cart-poller') {
      console.warn(`[shopify-abandoned-cart-poller] tick failed: ${err.message}`)
    }
  })

  console.log(`[worker:shopify-abandoned-cart-poller] started, interval=${TICK_INTERVAL_MS}ms, nudge-delay=${NUDGE_DELAY_MIN}m`)
  return worker
}

async function runTick(): Promise<{ nudged: number; eligible: number }> {
  const startedAt = Date.now()
  const horizon = new Date(Date.now() - NUDGE_DELAY_MIN * 60 * 1000).toISOString()

  const { data: rows, error } = await supabase
    .from('shopify_abandoned_checkouts')
    .select('id, tenant_id, store_id, shopify_checkout_id, checkout_url, customer_phone, customer_email, customer_first_name, total_inr_paise, abandoned_at')
    .is('recovered_at', null)
    .is('nudge_sent_at', null)
    .not('customer_phone', 'is', null)
    .lt('abandoned_at', horizon)
    .limit(BATCH_SIZE)

  if (error) {
    console.warn(`[shopify-abandoned-cart-poller] query failed: ${error.message}`)
    return { nudged: 0, eligible: 0 }
  }
  if (!rows || rows.length === 0) {
    return { nudged: 0, eligible: 0 }
  }

  let nudged = 0
  for (const row of rows) {
    try {
      await fireShopifyTrigger(supabase, row.tenant_id, 'shopify_abandoned_cart', {
        contactId:        row.customer_phone!,
        contactPhone:     row.customer_phone,
        contactEmail:     row.customer_email,
        checkout_id:      row.shopify_checkout_id,
        checkout_url:     row.checkout_url,
        first_name:       row.customer_first_name,
        total_inr_paise:  row.total_inr_paise,
        abandoned_at:     row.abandoned_at,
      })
      const { error: upErr } = await supabase.from('shopify_abandoned_checkouts')
        .update({ nudge_sent_at: new Date().toISOString() })
        .eq('id', row.id)
      if (upErr) {
        console.warn(`[shopify-abandoned-cart-poller] stamp nudge_sent_at failed row=${row.id}: ${upErr.message}`)
        continue
      }
      nudged++
    } catch (err: any) {
      console.warn(`[shopify-abandoned-cart-poller] row ${row.id} failed: ${err?.message ?? err}`)
    }
  }

  const ms = Date.now() - startedAt
  console.log(`[shopify-abandoned-cart-poller] tick done — nudged=${nudged}/${rows.length} ${ms}ms`)
  return { nudged, eligible: rows.length }
}
