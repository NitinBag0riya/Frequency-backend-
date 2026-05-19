/**
 * Worker: sla-monitor (singleton repeatable, runs every 30s)
 *
 * Phase 3 of the post-deploy roadmap. Scans open conversations across
 * all tenants every tick; emits sla_breaches rows when first_response
 * or resolution thresholds cross AND closes existing open breaches
 * when the agent finally replies.
 *
 * ─── Algorithm per tick ───────────────────────────────────────────────────
 *
 * For each tenant that has at least one sla_configs row:
 *   1. Pull the tenant's active config rows (channel-specific + the 'any' fallback).
 *   2. Pull the recent inbound + outbound messages (LOOKBACK_DAYS window).
 *   3. Group by (conversation_phone, conversation_channel) → compute:
 *        - last_outbound_at
 *        - first_inbound_after_last_outbound_at + its message id
 *          (this is the "earliest UNANSWERED inbound" — the message
 *           that opened the SLA clock)
 *        - last_inbound_at (only used for resolution-lifecycle staleness)
 *   4. For each conversation:
 *        - If first_unanswered_inbound_at exists:
 *            target = config.first_response_seconds
 *            secondsWaiting = now - first_unanswered_inbound_at
 *            if secondsWaiting > target → insert sla_breaches row
 *              (ON CONFLICT DO NOTHING via the partial unique index)
 *        - Else (agent has replied since the last inbound):
 *            → find any open first_response breach for this conv,
 *              UPDATE resolved_at = now,
 *              actual_seconds = (first_outbound_after_breach - breached_at)
 *              (we approximate as last_outbound_at - breached_at because
 *               the breach row already pins the "breached_at" timestamp)
 *        - If conversation has not been outbound-replied AND the first
 *          inbound is > resolution_seconds old, emit type='resolution'.
 *          Resolves when an outbound lands OR the conversation goes
 *          fully idle for LOOKBACK_DAYS (we close stale breaches in a
 *          janitor sweep at the end of each tick).
 *
 * ─── Idempotency ──────────────────────────────────────────────────────────
 *
 * The partial unique index ux_sla_breaches_active_per_conv guarantees
 * one OPEN row per (tenant, conversation, type). Concurrent ticks ON
 * CONFLICT DO NOTHING → no duplicate breaches.
 *
 * ─── Failure handling ────────────────────────────────────────────────────
 *
 * Per-tenant errors don't abort the tick — we log + continue to the
 * next tenant. Top-level config-query failures THROW so BullMQ logs the
 * failure as a job error instead of silently swallowing an outage.
 */

import '../env'
import { Worker, type Job } from 'bullmq'
import { createClient } from '@supabase/supabase-js'
import { Q, connection, cronQueue } from '../queue'
import { logger } from '../lib/logger'

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://yiicpndeggaedxobyopu.supabase.co'
const supabase = createClient(SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY!)

const TICK_INTERVAL_MS = Number(process.env.SLA_MONITOR_INTERVAL_MS ?? 30_000)
// Lookback for the message scan. 7 days is enough for the common
// "customer pinged Friday, agent ghost over the weekend" pattern.
// Beyond that we treat the conversation as abandoned (janitor sweep
// resolves any orphaned breaches that fall off the lookback window).
const LOOKBACK_DAYS = 7
// Resolution janitor: anything still open after this many days gets
// auto-resolved (with resolved_at set, actual_seconds NULL) so the
// active-breaches widget doesn't accumulate dead rows from abandoned
// conversations.
const STALE_BREACH_DAYS = 14

interface WorkingHoursSpec {
  tz?: string
  mon?: Array<{ start: string; end: string }>
  tue?: Array<{ start: string; end: string }>
  wed?: Array<{ start: string; end: string }>
  thu?: Array<{ start: string; end: string }>
  fri?: Array<{ start: string; end: string }>
  sat?: Array<{ start: string; end: string }>
  sun?: Array<{ start: string; end: string }>
}

interface SlaConfig {
  id: string
  tenant_id: string
  team_id: string | null
  channel: 'any' | 'whatsapp' | 'instagram' | 'telegram'
  first_response_seconds: number
  resolution_seconds: number
  paused: boolean
  working_hours_json: WorkingHoursSpec | null
}

// Count only seconds that fall inside the tenant's configured business
// hours. Conservative: when working_hours_json is missing/empty, we
// fall back to 24×7 (= raw seconds, current behaviour).
//
// Pure JS implementation — uses Intl.DateTimeFormat with the configured
// timezone to bucket each minute. We walk the window in 1-minute steps;
// at 30s tick frequency and typical resolution thresholds (< 24h) this
// is a few hundred iterations per breach candidate, fine.
const DAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const
type DayKey = typeof DAY_KEYS[number]

function inBusinessSeconds(
  startMs: number,
  endMs: number,
  spec: WorkingHoursSpec | null | undefined,
): number {
  const total = Math.max(0, Math.floor((endMs - startMs) / 1000))
  if (!spec || !Object.keys(spec).some(k => k !== 'tz' && Array.isArray((spec as any)[k]))) {
    return total
  }
  const tz = spec.tz || 'Asia/Kolkata'
  // Pre-parse the day → windows map. Each window is HH:MM-HH:MM in minutes-of-day.
  const dayWindows = new Map<DayKey, Array<{ s: number; e: number }>>()
  for (const day of DAY_KEYS) {
    const arr = (spec as any)[day] as Array<{ start: string; end: string }> | undefined
    if (!arr) continue
    const parsed = arr.map(w => {
      const [sh, sm] = w.start.split(':').map(n => parseInt(n, 10))
      const [eh, em] = w.end.split(':').map(n => parseInt(n, 10))
      return { s: (sh || 0) * 60 + (sm || 0), e: (eh || 0) * 60 + (em || 0) }
    }).filter(w => Number.isFinite(w.s) && Number.isFinite(w.e) && w.e > w.s)
    if (parsed.length) dayWindows.set(day, parsed)
  }
  if (dayWindows.size === 0) return total
  // Walk minute-by-minute. Cap the walk at 30 days so a pathological
  // breached_at way in the past doesn't melt CPU.
  const STEP_MS = 60_000
  const CAP_MS = 30 * 86400 * 1000
  let cursor = startMs
  const stop = Math.min(endMs, startMs + CAP_MS)
  let counted = 0
  // Intl format extracts the tz-aware weekday + hour:minute in one shot.
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    weekday: 'short',
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
  })
  while (cursor < stop) {
    const parts = fmt.formatToParts(new Date(cursor))
    const wd = parts.find(p => p.type === 'weekday')?.value?.toLowerCase() as string | undefined
    const hh = parseInt(parts.find(p => p.type === 'hour')?.value ?? '0', 10)
    const mm = parseInt(parts.find(p => p.type === 'minute')?.value ?? '0', 10)
    const minOfDay = hh * 60 + mm
    const wdMap: Record<string, DayKey> = { sun: 'sun', mon: 'mon', tue: 'tue', wed: 'wed', thu: 'thu', fri: 'fri', sat: 'sat' }
    const dk = wd ? wdMap[wd] : undefined
    const windows = dk ? dayWindows.get(dk) : undefined
    if (windows && windows.some(w => minOfDay >= w.s && minOfDay < w.e)) {
      counted += 60
    }
    cursor += STEP_MS
  }
  return counted
}

interface ConvAgg {
  tenant_id: string
  phone: string
  channel: string
  last_inbound_at: number | null
  last_outbound_at: number | null
  first_inbound_at: number | null
  // The first inbound AFTER the last outbound — the message that
  // currently has the SLA clock running on it. NULL if the customer
  // hasn't pinged since the last agent reply.
  first_unanswered_inbound_at: number | null
  first_unanswered_message_id: string | null
}

export async function startSlaMonitorWorker() {
  await cronQueue.add(
    'sla-monitor',
    {},
    {
      jobId: 'singleton-sla-monitor',
      repeat: { every: TICK_INTERVAL_MS },
      removeOnComplete: { count: 50 },
      removeOnFail:     { count: 50 },
    },
  )

  const worker = new Worker(
    Q.cron,
    async (job: Job) => {
      if (job.name !== 'sla-monitor') return { skipped: 'not for me' }
      return runTick()
    },
    { connection, concurrency: 1 },
  )

  worker.on('failed', (job, err) => {
    if (job?.name === 'sla-monitor') {
      logger.warn(`[sla-monitor] tick failed: ${err.message}`)
    }
  })

  console.log(`[worker:sla-monitor] started, interval=${TICK_INTERVAL_MS}ms`)
  return worker
}

async function runTick(): Promise<{ tenants: number; breaches_opened: number; breaches_resolved: number }> {
  const started = Date.now()
  let breachesOpened = 0
  let breachesResolved = 0

  // 1. List tenants that have at least one active sla_configs row.
  const { data: cfgRows, error: cfgErr } = await supabase
    .from('sla_configs')
    .select('id, tenant_id, team_id, channel, first_response_seconds, resolution_seconds, paused, working_hours_json')
    .eq('paused', false)
  // Throw so BullMQ surfaces the failure (instead of silently no-op'ing
  // through a Supabase outage). The worker.on('failed') handler logs it,
  // and ops can wire an alert on consecutive failures.
  if (cfgErr) throw new Error(`sla_configs query failed: ${cfgErr.message}`)
  if (!cfgRows || cfgRows.length === 0) return { tenants: 0, breaches_opened: 0, breaches_resolved: 0 }

  const tenantIds = Array.from(new Set(cfgRows.map(c => c.tenant_id)))
  const configsByTenant: Record<string, SlaConfig[]> = {}
  for (const c of cfgRows as SlaConfig[]) {
    ;(configsByTenant[c.tenant_id] = configsByTenant[c.tenant_id] ?? []).push(c)
  }

  for (const tenantId of tenantIds) {
    try {
      const opened = await processTenant(tenantId, configsByTenant[tenantId])
      breachesOpened   += opened.opened
      breachesResolved += opened.resolved
    } catch (e: any) {
      logger.warn(`[sla-monitor] tenant=${tenantId} failed: ${e?.message ?? e}`)
    }
  }

  // Janitor sweep — close orphaned breaches whose conversations have
  // fallen out of the LOOKBACK window. Bounded by STALE_BREACH_DAYS so
  // we don't repeatedly touch the same row.
  try {
    const cutoff = new Date(Date.now() - STALE_BREACH_DAYS * 86400 * 1000).toISOString()
    const { data: stale } = await supabase
      .from('sla_breaches')
      .select('id')
      .is('resolved_at', null)
      .lt('breached_at', cutoff)
      .limit(500)
    if (stale && stale.length) {
      const ids = stale.map((r: any) => r.id)
      await supabase.from('sla_breaches')
        .update({ resolved_at: new Date().toISOString() })
        .in('id', ids)
      breachesResolved += ids.length
    }
  } catch (e: any) {
    logger.warn(`[sla-monitor] janitor sweep failed: ${e?.message ?? e}`)
  }

  const ms = Date.now() - started
  logger.info(`[sla-monitor] tick done — tenants=${tenantIds.length} opened=${breachesOpened} resolved=${breachesResolved} ${ms}ms`)
  return { tenants: tenantIds.length, breaches_opened: breachesOpened, breaches_resolved: breachesResolved }
}

async function processTenant(tenantId: string, configs: SlaConfig[]): Promise<{ opened: number; resolved: number }> {
  let opened = 0
  let resolved = 0
  const since = new Date(Date.now() - LOOKBACK_DAYS * 86400 * 1000).toISOString()

  // 2. Pull recent messages for this tenant.
  const { data: msgs } = await supabase.from('messages')
    .select('id, contact_phone, channel, direction, created_at')
    .eq('tenant_id', tenantId)
    .gte('created_at', since)
    .order('created_at', { ascending: true })
    .limit(50_000)
  if (!msgs || msgs.length === 0) return { opened: 0, resolved: 0 }

  // 3. Aggregate per (phone, channel).
  const aggs = new Map<string, ConvAgg>()
  for (const m of msgs as any[]) {
    const key = `${m.channel}|${m.contact_phone}`
    let a = aggs.get(key)
    if (!a) {
      a = {
        tenant_id: tenantId,
        phone:     m.contact_phone,
        channel:   m.channel,
        last_inbound_at:  null,
        last_outbound_at: null,
        first_inbound_at: null,
        first_unanswered_inbound_at: null,
        first_unanswered_message_id: null,
      }
      aggs.set(key, a)
    }
    const t = new Date(m.created_at).getTime()
    if (m.direction === 'inbound') {
      a.last_inbound_at = Math.max(a.last_inbound_at ?? 0, t)
      if (a.first_inbound_at === null) a.first_inbound_at = t
      // Earliest unanswered inbound: only set if there's been NO outbound
      // since OR if this is the first such inbound after the last outbound.
      if (a.first_unanswered_inbound_at === null
          || (a.last_outbound_at !== null && t > a.last_outbound_at && a.first_unanswered_inbound_at <= (a.last_outbound_at ?? 0))) {
        a.first_unanswered_inbound_at = t
        a.first_unanswered_message_id = m.id
      }
    } else {
      a.last_outbound_at = Math.max(a.last_outbound_at ?? 0, t)
      // An outbound clears any pending unanswered-inbound state — the
      // next inbound is now the start of a fresh SLA cycle.
      a.first_unanswered_inbound_at = null
      a.first_unanswered_message_id = null
    }
  }

  // Look up contact names in one round-trip so breach rows have human-
  // readable labels in the manager dashboard.
  const phoneList = Array.from(new Set(Array.from(aggs.values()).map(a => a.phone)))
  let nameByPhone: Map<string, string> = new Map()
  if (phoneList.length) {
    const { data: contacts } = await supabase.from('contacts')
      .select('phone, name')
      .eq('tenant_id', tenantId)
      .in('phone', phoneList)
      .limit(phoneList.length)
    if (contacts) {
      for (const c of contacts as any[]) {
        if (c.phone && c.name) nameByPhone.set(c.phone, c.name)
      }
    }
  }

  const now = Date.now()

  // 4. Score each conversation against the matching config row.
  for (const a of aggs.values()) {
    const cfg = pickConfigForChannel(configs, a.channel)
    if (!cfg) continue

    // ── first_response breach lifecycle ─────────────────────────────────
    if (a.first_unanswered_inbound_at !== null) {
      // Working-hours masking — when the rule has working_hours_json set,
      // only count seconds inside business hours. So "Friday 9pm ping →
      // breach at Monday 11am" reads as a real breach only if the inbound
      // was answered after Mon-9am+threshold, not the raw wall-clock
      // weekend hours.
      const secondsWaiting = inBusinessSeconds(a.first_unanswered_inbound_at, now, cfg.working_hours_json)
      if (secondsWaiting > cfg.first_response_seconds) {
        // Try to open a new breach row. If one already exists for this
        // (tenant, phone, channel, type) AND is unresolved, the
        // partial unique index makes this a no-op.
        const { error: insErr } = await supabase.from('sla_breaches').insert({
          tenant_id: tenantId,
          conversation_phone: a.phone,
          conversation_channel: a.channel,
          type: 'first_response',
          target_seconds: cfg.first_response_seconds,
          source_message_id: a.first_unanswered_message_id ?? null,
          contact_name: nameByPhone.get(a.phone) ?? null,
        })
        if (!insErr) opened++
      }
    } else if (a.last_outbound_at && a.last_inbound_at) {
      // Agent has replied — resolve any open first_response breach.
      // Measure actual response time from the breach's source-message
      // (the inbound that started the clock) to the first outbound
      // after it. We don't have that exact outbound timestamp without
      // a second scan, so we approximate with last_outbound_at — fine
      // for the common single-reply case; slightly optimistic on
      // multi-reply threads but never lies in the wrong direction.
      const { data: existing } = await supabase.from('sla_breaches')
        .select('id, breached_at')
        .eq('tenant_id', tenantId)
        .eq('conversation_phone', a.phone)
        .eq('conversation_channel', a.channel)
        .eq('type', 'first_response')
        .is('resolved_at', null)
        .maybeSingle()
      if (existing) {
        const breachedAt = new Date(existing.breached_at).getTime()
        // actual_seconds also respects working-hours masking so the
        // dashboard's "resolved in N hours" matches the policy that
        // opened the breach in the first place.
        const actualSecs = inBusinessSeconds(breachedAt, a.last_outbound_at, cfg.working_hours_json)
        await supabase.from('sla_breaches')
          .update({
            resolved_at: new Date().toISOString(),
            actual_seconds: actualSecs,
          })
          .eq('id', existing.id)
        resolved++
      }
    }

    // ── resolution breach lifecycle ─────────────────────────────────────
    // A conversation breaches resolution if it has been open for longer
    // than resolution_seconds and is still waiting on the agent (no
    // outbound after the first inbound, OR the customer pinged again
    // after the last outbound and that's still unanswered past the
    // threshold).
    if (a.first_inbound_at) {
      // Same business-hours masking applied here so a weekend doesn't
      // count against a 24h resolution SLA.
      const ageSecs = inBusinessSeconds(a.first_inbound_at, now, cfg.working_hours_json)
      const stillWaiting = a.first_unanswered_inbound_at !== null
      if (ageSecs > cfg.resolution_seconds && stillWaiting) {
        const { error: insErr } = await supabase.from('sla_breaches').insert({
          tenant_id: tenantId,
          conversation_phone: a.phone,
          conversation_channel: a.channel,
          type: 'resolution',
          target_seconds: cfg.resolution_seconds,
          source_message_id: a.first_unanswered_message_id ?? null,
          contact_name: nameByPhone.get(a.phone) ?? null,
        })
        if (!insErr) opened++
      } else if (!stillWaiting && a.last_outbound_at) {
        // Resolve any open resolution breach the same way as first_response.
        const { data: existing } = await supabase.from('sla_breaches')
          .select('id, breached_at')
          .eq('tenant_id', tenantId)
          .eq('conversation_phone', a.phone)
          .eq('conversation_channel', a.channel)
          .eq('type', 'resolution')
          .is('resolved_at', null)
          .maybeSingle()
        if (existing) {
          const breachedAt = new Date(existing.breached_at).getTime()
          const actualSecs = inBusinessSeconds(breachedAt, a.last_outbound_at, cfg.working_hours_json)
          await supabase.from('sla_breaches')
            .update({
              resolved_at: new Date().toISOString(),
              actual_seconds: actualSecs,
            })
            .eq('id', existing.id)
          resolved++
        }
      }
    }
  }

  return { opened, resolved }
}

/** Channel-specific config wins; else the 'any' fallback; else first row. */
function pickConfigForChannel(configs: SlaConfig[], channel: string): SlaConfig | null {
  return configs.find(c => c.channel === channel)
      ?? configs.find(c => c.channel === 'any')
      ?? configs[0]
      ?? null
}
