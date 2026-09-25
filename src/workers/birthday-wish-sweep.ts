/**
 * Worker: birthday-wish-sweep (in-process daily scheduler, ~24h cadence)
 *
 * POS Upgrade Phase 6, 6.2 — revives the `multi-birthday-wish` workflow
 * template (seeded in migration 090, marked status='deprecated' in 091
 * because its `scheduled_per_contact` trigger type had no runtime — see that
 * migration's header). This worker IS that runtime: once a day it scans
 * `contacts.attributes` for a birthday/anniversary matching today's
 * month-day (Asia/Kolkata), restricted to contacts with an `opted_in`
 * marketing/whatsapp consent row, and sends the birthday wish for each
 * match (gated on the Meta template — see below).
 *
 * Pattern copied from workers/consent-expiry-sweep.ts: scheduleDaily +
 * isPollerEnabled, batched, idempotent (re-running the same day just
 * re-matches the same contacts).
 *
 * Selection logic lives in lib/birthday-wish-match.ts (pure, no supabase/
 * queue imports) so it can be self-checked without a live Postgres/Redis
 * connection — see that file's header and birthday-wish-match.selfcheck.ts.
 *
 * ─── DPDPA / MANDATORY correctness rule ──────────────────────────────────────
 * The sweep's own contact_consent_state JOIN — status='opted_in',
 * purpose='marketing', channel='whatsapp' — is the PRIMARY gate: an
 * opted-out or never-consented contact is never selected, birthday match or
 * not. `workers/message-sender.ts`'s checkMarketingConsent is defense in
 * depth only, not relied on here (see docs/state/pos-upgrade.md, Phase 6
 * "KEY CORRECTNESS RULE").
 *
 * ─── META TEMPLATE GATE ───────────────────────────────────────────────────────
 * `birthday_wish` is a MARKETING template (carries a discount code) and is
 * NOT present in code/env today — submitting/approving it at Meta is
 * `BLOCKED: needs research` (never invent a template name/vars — CLAUDE.md
 * rule 3). The sweep runs its FULL consent-correct selection every day
 * regardless, but when WA_BIRTHDAY_WISH_TEMPLATE_NAME is unset it only LOGS
 * "would send" per matching contact and enqueues nothing — inert until an
 * operator sets the env var (which only makes sense once the template is
 * actually approved at Meta and the Storefront → Loyalty "Birthday rewards"
 * switch (6.2 dashboard, default Off) is turned on for a tenant).
 */

import '../env'
import { createClient } from '@supabase/supabase-js'
import { isPollerEnabled, logGate } from '../lib/poller-gate'
import { scheduleDaily, SCHEDULE_STUB, type ScheduleHandle } from '../lib/daily-scheduler'
import { enqueueMessageSend } from '../queue'
import { todayMonthDayIST, selectSweepTargets, type SweepCandidate } from '../lib/birthday-wish-match'

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://yiicpndeggaedxobyopu.supabase.co'
const supabase = createClient(SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY!)

const TICK_INTERVAL_MS = Number(process.env.BIRTHDAY_WISH_SWEEP_INTERVAL_MS ?? 24 * 60 * 60 * 1000)
// ponytail: bounds one tick's scan to keep the query cheap; a tenant base
// north of this needs a real per-tenant cursor, not a global limit — flagged,
// not built (same ceiling consent-expiry-sweep.ts accepts at BATCH_SIZE=500).
const BATCH_SIZE = 2000

// Meta gate — see file header. Empty string = "not approved yet" = inert.
const TEMPLATE_NAME = process.env.WA_BIRTHDAY_WISH_TEMPLATE_NAME || ''
const TEMPLATE_LANG = process.env.WA_BIRTHDAY_WISH_TEMPLATE_LANG || 'en'

export function startBirthdayWishSweepWorker(): ScheduleHandle {
  const enabled = isPollerEnabled('BIRTHDAY_WISH_SWEEP')
  logGate('BIRTHDAY_WISH_SWEEP', enabled)
  if (!enabled) return SCHEDULE_STUB
  return scheduleDaily('birthday-wish-sweep', TICK_INTERVAL_MS, runTick)
}

async function runTick(): Promise<{ wished: number; wouldSend: number; considered: number }> {
  const todayMD = todayMonthDayIST()

  // Marketing-WhatsApp opted-in contacts only — the PRIMARY DPDPA gate,
  // enforced in SQL via the inner join on contact_consent_state. An
  // opted-out or never-consented contact never leaves Postgres.
  const { data: rows, error } = await supabase
    .from('contacts')
    .select('id, tenant_id, phone, name, attributes, contact_consent_state!inner(channel,purpose,status)')
    .eq('status', 'active')
    .eq('contact_consent_state.channel', 'whatsapp')
    .eq('contact_consent_state.purpose', 'marketing')
    .eq('contact_consent_state.status', 'opted_in')
    .limit(BATCH_SIZE)
  if (error) {
    console.warn(`[birthday-wish-sweep] query failed: ${error.message}`)
    return { wished: 0, wouldSend: 0, considered: 0 }
  }

  const targets = selectSweepTargets((rows ?? []) as SweepCandidate[], todayMD)
  let wished = 0, wouldSend = 0

  for (const t of targets) {
    if (!TEMPLATE_NAME) {
      wouldSend++
      console.log(`[birthday-wish-sweep] WOULD SEND ${t.kind} wish — tenant=${t.tenant_id} contact=${t.id} ` +
        `(birthday_wish template not configured — Meta-approval-gated, inert until WA_BIRTHDAY_WISH_TEMPLATE_NAME is set)`)
      continue
    }
    if (!t.phone) { console.warn(`[birthday-wish-sweep] contact=${t.id} matched but has no phone — skipping`); continue }
    try {
      await enqueueMessageSend({
        tenantId: t.tenant_id, to: t.phone, channel: 'whatsapp', kind: 'template',
        template: { name: TEMPLATE_NAME, language: TEMPLATE_LANG, parameters: [t.name || 'there'] },
      })
      wished++
    } catch (e: any) {
      console.warn(`[birthday-wish-sweep] enqueue failed for contact=${t.id}: ${e?.message ?? e}`)
    }
  }

  console.log(`[birthday-wish-sweep] tick done — wished=${wished} wouldSend=${wouldSend} considered=${targets.length}/${(rows ?? []).length}`)
  return { wished, wouldSend, considered: targets.length }
}
