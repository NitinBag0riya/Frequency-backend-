/**
 * Worker: agency-payout-aggregator (in-process daily scheduler, ~24h cadence)
 *
 * Once per day, on the 1st of the month, sweep last month's accrued
 * revshare entries and emit one agency_payouts row per agency.
 *
 * On all other days the tick is a no-op (cheap idempotency check + return).
 *
 * Idempotency anchor: agency_payouts(agency_id, period_start, period_end)
 * has a unique index, so the upsert on rerun is a no-op. We deliberately
 * DO NOT flip agency_revshare_entries.status from 'accrued' to 'paid'
 * here — that happens at the actual Razorpay payout step (or via
 * super-admin reconciliation). This worker only produces the aggregate;
 * the ledger stays append-only and the FE shows pending vs paid via JOIN.
 *
 * Migrated off BullMQ — see daily-scheduler.ts header for the rationale.
 */

import '../env'
import { createClient } from '@supabase/supabase-js'
import { isPollerEnabled, logGate } from '../lib/poller-gate'
import { scheduleDaily, SCHEDULE_STUB, type ScheduleHandle } from '../lib/daily-scheduler'

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://yiicpndeggaedxobyopu.supabase.co'
const supabase = createClient(SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY!)

// Default cadence = 24h. The date-of-month guard inside runTick() makes
// every other tick a no-op, so this interval is more "how often do we
// check the date" than "how often do we do work".
const TICK_INTERVAL_MS = Number(process.env.AGENCY_PAYOUT_AGG_INTERVAL_MS ?? 24 * 60 * 60 * 1000)

export async function startAgencyPayoutAggregatorWorker(): Promise<ScheduleHandle> {
  const enabled = isPollerEnabled('AGENCY_PAYOUT_AGGREGATOR')
  logGate('AGENCY_PAYOUT_AGGREGATOR', enabled)
  if (!enabled) return SCHEDULE_STUB
  return scheduleDaily('agency-payout-aggregator', TICK_INTERVAL_MS, runTick)
}

/**
 * One tick. Cheap no-op except on the 1st of the month. We compute the
 * previous-month window in UTC (Supabase stores in UTC) — operators in
 * IST will see the boundary as "last day of last month 05:30 IST → today
 * 05:30 IST" but the aggregate covers a whole calendar month either way.
 */
async function runTick(): Promise<{ agencies: number; total_paise: number; skipped?: string }> {
  const startedAt = Date.now()
  const now = new Date()
  // Only fire on the 1st of the month. Force-runs can override the gate via
  // AGENCY_PAYOUT_AGG_FORCE=1 (handy for backfilling / manual reruns).
  if (now.getUTCDate() !== 1 && process.env.AGENCY_PAYOUT_AGG_FORCE !== '1') {
    return { agencies: 0, total_paise: 0, skipped: 'not first-of-month' }
  }

  // Previous month window: first second of last month → last second of last month.
  const periodStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1, 0, 0, 0))
  const periodEnd   = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(),     1, 0, 0, 0) - 1)

  // Sum accrued entries per agency that were *captured* during last month.
  //
  // We anchor on `created_at` (the moment we recorded the revshare from a
  // Razorpay invoice.paid webhook), NOT on the invoice's billing window.
  // Reason: tenant subscription billing cycles rarely align with calendar
  // months — an invoice with `period_start=Apr 18 → period_end=May 18` is
  // logically one month of service, but a containment query on the invoice
  // window (`period_start ≥ Apr 1 AND period_end ≤ Apr 30`) would silently
  // drop it on every payout run. Anchoring on accrual time fixes that and
  // gives a clean "all the revshare we recorded during this calendar month"
  // semantics, which is how revshare programs are actually accounted for.
  //
  // We DON'T flip status here — that happens when the payout itself is
  // marked paid (out-of-scope for the aggregator).
  const { data: rows, error } = await supabase.from('agency_revshare_entries')
    .select('agency_id, revshare_amount_inr_paise')
    .eq('status', 'accrued')
    .gte('created_at', periodStart.toISOString())
    .lte('created_at', periodEnd.toISOString())
  if (error) {
    console.warn(`[agency-payout-aggregator] query failed: ${error.message}`)
    return { agencies: 0, total_paise: 0 }
  }
  if (!rows || rows.length === 0) {
    console.log('[agency-payout-aggregator] no accrued entries for last month')
    return { agencies: 0, total_paise: 0 }
  }

  const totals = new Map<string, number>()
  for (const row of rows as any[]) {
    totals.set(row.agency_id, (totals.get(row.agency_id) ?? 0) + Number(row.revshare_amount_inr_paise ?? 0))
  }

  let agenciesEmitted = 0
  let totalPaise = 0
  for (const [agencyId, amount] of totals.entries()) {
    if (amount <= 0) continue
    const { error: upErr } = await supabase.from('agency_payouts').upsert({
      agency_id:        agencyId,
      period_start:     periodStart.toISOString(),
      period_end:       periodEnd.toISOString(),
      amount_inr_paise: amount,
      status:           'pending',
    }, { onConflict: 'agency_id,period_start,period_end', ignoreDuplicates: false })
    if (upErr) {
      console.warn(`[agency-payout-aggregator] upsert agency=${agencyId} failed: ${upErr.message}`)
      continue
    }
    agenciesEmitted += 1
    totalPaise += amount
  }

  const ms = Date.now() - startedAt
  console.log(`[agency-payout-aggregator] tick done — agencies=${agenciesEmitted} total_paise=${totalPaise} ${ms}ms`)
  return { agencies: agenciesEmitted, total_paise: totalPaise }
}
