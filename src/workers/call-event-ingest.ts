/**
 * Worker: call.event.ingest
 *
 * Consumes one `call_events` row, runs the state-machine transition on
 * `call_sessions`, publishes Realtime, and (on recording_ready) chains into
 * `call.recording.archive`. Idempotent on (tenant_id, meta_event_id) — the
 * webhook already enforces uniqueness at the DB layer; this worker is the
 * second line of defense against duplicate Meta deliveries.
 *
 * On `connected → completed`, increment both:
 *   - tenants.call_minutes_used_current_period (the hot-path counter)
 *   - usage_counters('call_minutes')           (canonical AI-meter sibling)
 *
 * On `recording_ready` with consent != 'none' → enqueue archive.
 * On `completed` for terminal=missed → emit `call_missed` notification.
 *
 * Concurrency: CALL_EVENT_INGEST_CONCURRENCY (default 50) — events are
 * lightweight DB writes, no outbound HTTP.
 */

import '../env'
import { Worker, Job } from 'bullmq'
import { createClient } from '@supabase/supabase-js'
import {
  Q, CallEventIngestJob, connection,
  enqueueCallRecordingArchive,
  enqueueMessageSend,
} from '../queue'
import { emitNotification } from '../routes/notifications'

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://yiicpndeggaedxobyopu.supabase.co'
const supabase = createClient(SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY!)

// State machine — keep in sync with ADR §4.
type SessionStatus = 'queued'|'dialing'|'ringing'|'connected'|'completed'|'rejected'|'missed'|'failed'|'cancelled'

interface Transition { to: SessionStatus; reason?: string }

/**
 * Map a Meta event type (lower-cased) onto a target status from the current
 * status. Returns undefined when the transition is illegal — we still log
 * the event (call_events.processed_at), but call_sessions stays put.
 */
function resolveTransition(from: SessionStatus, eventType: string): Transition | undefined {
  const et = eventType.toLowerCase()
  // Common shapes — Meta's LA event names vary; we accept several.
  const isConnect    = /(^|\.)connect/.test(et) || et.includes('connected')
  const isTerminate  = /(^|\.)terminate/.test(et) || et.includes('end') || et.includes('hangup')
  const isMissed     = et.includes('missed')
  const isRejected   = et.includes('reject')
  const isFailed     = et.includes('fail')
  const isRinging    = et.includes('ringing') || et.includes('incoming') || et.includes('inbound')

  switch (from) {
    case 'queued':
      if (isRinging)   return { to: 'ringing' }    // inbound first event
      if (isConnect)   return { to: 'connected' }  // outbound fast-connect (rare)
      if (isFailed)    return { to: 'failed' }
      break
    case 'dialing':
      if (isRinging)   return { to: 'ringing' }
      if (isConnect)   return { to: 'connected' }
      if (isFailed)    return { to: 'failed' }
      if (isTerminate) return { to: 'failed', reason: 'terminated_before_connect' }
      break
    case 'ringing':
      if (isConnect)   return { to: 'connected' }
      if (isMissed)    return { to: 'missed' }
      if (isRejected)  return { to: 'rejected' }
      if (isTerminate) return { to: 'missed' }
      if (isFailed)    return { to: 'failed' }
      break
    case 'connected':
      if (isTerminate) return { to: 'completed' }
      if (isFailed)    return { to: 'failed' }
      break
    default:
      // terminal states — no further transitions
      return undefined
  }
  return undefined
}

export function startCallEventIngestWorker() {
  const worker = new Worker<CallEventIngestJob>(
    Q.callEventIngest,
    async (job: Job<CallEventIngestJob>) => {
      const { tenantId, callEventId } = job.data
      const { data: ev } = await supabase
        .from('call_events')
        .select('id, tenant_id, call_session_id, event_type, raw_payload, received_at, processed_at')
        .eq('id', callEventId).eq('tenant_id', tenantId).maybeSingle()
      if (!ev) return { skipped: 'event_not_found' }
      if (ev.processed_at) return { skipped: 'already_processed' }

      const { data: session } = await supabase
        .from('call_sessions')
        .select('id, status, direction, agent_id, contact_id, recording_consent, connected_at')
        .eq('id', ev.call_session_id).eq('tenant_id', tenantId).maybeSingle()
      if (!session) return { skipped: 'session_not_found' }

      const eventType = String(ev.event_type ?? '')
      const fromStatus = session.status as SessionStatus

      // Special-case `recording_ready` — it does not transition state, just
      // chains downstream work.
      if (/recording.?ready|recording.?available/i.test(eventType)) {
        const url = String((ev.raw_payload as any)?.recording_url
                        ?? (ev.raw_payload as any)?.url
                        ?? '')
        const recId = String((ev.raw_payload as any)?.recording_id ?? '')
        if (url && session.recording_consent !== 'none') {
          try {
            await enqueueCallRecordingArchive({
              tenantId,
              callSessionId: session.id as string,
              metaRecordingUrl: url,
              metaRecordingId: recId || undefined,
            })
          } catch (e: any) {
            console.warn(`[worker:call.event.ingest] archive enqueue failed: ${e?.message ?? e}`)
          }
        }
        await markProcessed(ev.id as string, tenantId)
        return { kind: 'recording_ready' }
      }

      const transition = resolveTransition(fromStatus, eventType)
      if (!transition) {
        // Invalid transition — keep audit but don't mutate session.
        await markProcessed(ev.id as string, tenantId)
        console.log(`[worker:call.event.ingest] invalid transition ${fromStatus} ← ${eventType}`)
        return { skipped: 'invalid_transition', from: fromStatus, event: eventType }
      }

      const nowIso = new Date().toISOString()
      const patch: Record<string, any> = {
        status: transition.to,
        updated_at: nowIso,
      }
      if (transition.to === 'ringing'   && !session.connected_at) patch.ringing_at   = nowIso
      if (transition.to === 'connected' && !session.connected_at) patch.connected_at = nowIso
      const isTerminal = ['completed','rejected','missed','failed','cancelled'].includes(transition.to)
      if (isTerminal) patch.ended_at = nowIso
      if (transition.reason) patch.failure_reason = transition.reason

      const { error: updErr } = await supabase
        .from('call_sessions')
        .update(patch)
        .eq('id', session.id).eq('tenant_id', tenantId)
      if (updErr) throw new Error(`session_update: ${updErr.message}`)

      // Billing: connected → completed = bill the minutes.
      if (fromStatus === 'connected' && transition.to === 'completed') {
        await incrementCallMinutes(tenantId, session.id as string, session.connected_at, nowIso)
        // TASK-6 (v1.1): enqueue CSAT template send if tenant has it on
        // and the call lasted at least csat_min_call_seconds. Best-effort
        // — failures here don't roll back the call lifecycle.
        await maybeEnqueueCsat(tenantId, session, nowIso).catch(err => {
          console.warn(`[worker:call.event.ingest] csat enqueue failed (${session.id}): ${err?.message ?? err}`)
        })
      }

      // Notifications
      if (transition.to === 'missed') {
        await emitMissedCall(tenantId, session.id as string, session.contact_id ?? null).catch(() => {})
      }
      if (transition.to === 'ringing' && session.direction === 'inbound') {
        await emitIncomingCall(tenantId, session.id as string, session.contact_id ?? null).catch(() => {})
      }

      // Realtime publish
      await publishCallState(tenantId, {
        type:       'call.state',
        call_id:    session.id,
        status:     transition.to,
        agent_id:   session.agent_id,
        contact_id: session.contact_id,
        direction:  session.direction,
        updated_at: nowIso,
        extras:     transition.reason ? { reason: transition.reason } : undefined,
      }).catch(() => {})

      await markProcessed(ev.id as string, tenantId)
      return { from: fromStatus, to: transition.to }
    },
    {
      connection,
      concurrency: Number(process.env.CALL_EVENT_INGEST_CONCURRENCY ?? 50),
    },
  )

  worker.on('failed', (job, err) => {
    console.warn(`[worker:call.event.ingest] ✗ job=${job?.id} — ${err.message}`)
  })

  /**
   * CSAT post-call template (TASK-6 v1.1). Conditionally enqueues a
   * WhatsApp template send to the customer's phone with a configurable
   * delay. Stores the resulting message_id on call_sessions so the
   * call-log row can later show the rating once the customer replies.
   *
   * Conditions (ALL must be true):
   *   - tenants.csat_enabled = true
   *   - tenants.csat_template_name is non-empty
   *   - call duration >= tenants.csat_min_call_seconds (default 30s)
   *   - direction = outbound OR inbound (both are valid CSAT triggers)
   *   - session has a contact with a usable phone
   *
   * Compliance note: the disclosure greeting played pre-call should
   * include "you may receive a follow-up survey" so the message isn't
   * unsolicited under WhatsApp Business policy.
   */
  async function maybeEnqueueCsat(tenantId: string, session: any, completedAtIso: string) {
    const { data: tenant } = await supabase
      .from('tenants')
      .select('csat_enabled, csat_template_name, csat_delay_minutes, csat_min_call_seconds')
      .eq('id', tenantId).maybeSingle()
    if (!tenant?.csat_enabled || !tenant.csat_template_name) return

    // Compute duration. If connected_at wasn't recorded (transient ringing
    // → completed for missed-but-billable cases), fall back to 0.
    const connectedAt = session.connected_at ? new Date(session.connected_at).getTime() : 0
    const completedAt = new Date(completedAtIso).getTime()
    const durationSec = connectedAt ? Math.floor((completedAt - connectedAt) / 1000) : 0
    if (durationSec < (tenant.csat_min_call_seconds ?? 30)) return

    // Need a phone to send to.
    const contactId = session.contact_id as string | null
    if (!contactId) return
    const { data: contact } = await supabase
      .from('contacts').select('phone').eq('id', contactId).eq('tenant_id', tenantId).maybeSingle()
    if (!contact?.phone) return

    // Use bullmq's delay option so the queue itself holds the job. The
    // message-sender worker will dispatch when the delay expires. No
    // need for our own scheduler.
    const delayMs = Math.max(60_000, (tenant.csat_delay_minutes ?? 5) * 60_000)
    await enqueueMessageSend({
      tenantId,
      to:       String(contact.phone).replace(/[^\d]/g, ''),
      channel:  'whatsapp',
      kind:     'template',
      template: {
        name:       tenant.csat_template_name,
        language:   'en_US',
        // The CSAT template typically has 1 variable for agent_name.
        // Plain string fallback if agent_id isn't resolvable here.
        parameters: [String(session.agent_id ?? 'your agent').slice(0, 64)],
      },
      sessionId: null,
    } as any).catch(err => {
      console.warn(`[csat] enqueueMessageSend failed (${session.id}): ${err?.message ?? err}`)
    })

    // Mark the session so we know a CSAT was sent + can correlate replies.
    // We don't have the message_id here (the send worker creates it).
    // Setting NOW as a sentinel — the message-sender worker can update the
    // real id later if/when we wire that callback. For v1 the boolean
    // "was a CSAT enqueued?" is enough to drive the call-log pill.
    await supabase.from('call_sessions')
      .update({ csat_template_message_id: '00000000-0000-0000-0000-000000000000' /* sentinel: enqueued */ })
      .eq('id', session.id).eq('tenant_id', tenantId)
  }


  console.log('[worker:call.event.ingest] started')
  return worker
}

async function markProcessed(eventId: string, tenantId: string) {
  await supabase.from('call_events')
    .update({ processed_at: new Date().toISOString() })
    .eq('id', eventId).eq('tenant_id', tenantId)
}

async function incrementCallMinutes(tenantId: string, callSessionId: string, connectedAt: string | null, endedAt: string) {
  if (!connectedAt) return
  const ms = new Date(endedAt).getTime() - new Date(connectedAt).getTime()
  if (ms <= 0) return
  const minutes = Math.max(1, Math.ceil(ms / 60000))

  // Hot-path counter on tenants row.
  const { data: t } = await supabase.from('tenants')
    .select('call_minutes_used_current_period').eq('id', tenantId).maybeSingle()
  const newVal = Number(t?.call_minutes_used_current_period ?? 0) + minutes
  await supabase.from('tenants')
    .update({ call_minutes_used_current_period: newVal, updated_at: new Date().toISOString() })
    .eq('id', tenantId)

  // Canonical usage_counters row (period = current IST month boundary).
  const { startIso, endIso } = currentIstMonthBounds()
  const { data: existing } = await supabase.from('usage_counters')
    .select('count').eq('tenant_id', tenantId).eq('metric', 'call_minutes').eq('period_start', startIso).maybeSingle()
  const next = Number(existing?.count ?? 0) + minutes
  await supabase.from('usage_counters').upsert({
    tenant_id: tenantId, metric: 'call_minutes',
    period_start: startIso, period_end: endIso, count: next,
  }, { onConflict: 'tenant_id,metric,period_start' })

  // Stamp billable_seconds for the call row.
  await supabase.from('call_sessions')
    .update({ billable_seconds: Math.ceil(ms / 1000), updated_at: new Date().toISOString() })
    .eq('id', callSessionId).eq('tenant_id', tenantId)
}

function currentIstMonthBounds(): { startIso: string; endIso: string } {
  const IST_OFFSET_MIN = 5 * 60 + 30
  const nowIst = new Date(Date.now() + IST_OFFSET_MIN * 60_000)
  const startUtcMs = Date.UTC(nowIst.getUTCFullYear(), nowIst.getUTCMonth(), 1) - IST_OFFSET_MIN * 60_000
  const endUtcMs   = Date.UTC(nowIst.getUTCFullYear(), nowIst.getUTCMonth() + 1, 1) - IST_OFFSET_MIN * 60_000
  return { startIso: new Date(startUtcMs).toISOString(), endIso: new Date(endUtcMs).toISOString() }
}

async function publishCallState(tenantId: string, payload: Record<string, any>) {
  const channel = supabase.channel(`calls:${tenantId}`, { config: { broadcast: { ack: false } } })
  try {
    await channel.send({ type: 'broadcast', event: payload.type ?? 'call.state', payload })
  } finally {
    await supabase.removeChannel(channel).catch(() => {})
  }
}

async function emitMissedCall(tenantId: string, callSessionId: string, contactId: string | null) {
  // Recipients = tenant's calling agent pool. Best-effort lookup.
  const { data: rule } = await supabase.from('call_routing_rules')
    .select('agent_pool').eq('tenant_id', tenantId).maybeSingle()
  const recipients = Array.isArray(rule?.agent_pool) ? (rule!.agent_pool as string[]) : []
  if (recipients.length === 0) return
  const contactName = contactId
    ? ((await supabase.from('contacts').select('name, phone').eq('id', contactId).maybeSingle()).data) ?? null
    : null
  await emitNotification(supabase, {
    tenant_id: tenantId,
    event_key: 'call.missed',
    recipient_user_ids: recipients,
    data: {
      contact_name: contactName?.name ?? 'Unknown',
      phone:        contactName?.phone ?? '',
      missed_at:    new Date().toISOString(),
      call_id:      callSessionId,
    },
  })
}

async function emitIncomingCall(tenantId: string, callSessionId: string, contactId: string | null) {
  const { data: rule } = await supabase.from('call_routing_rules')
    .select('agent_pool').eq('tenant_id', tenantId).maybeSingle()
  const recipients = Array.isArray(rule?.agent_pool) ? (rule!.agent_pool as string[]) : []
  if (recipients.length === 0) return
  const contactName = contactId
    ? ((await supabase.from('contacts').select('name, phone').eq('id', contactId).maybeSingle()).data) ?? null
    : null
  await emitNotification(supabase, {
    tenant_id: tenantId,
    event_key: 'call.incoming',
    recipient_user_ids: recipients,
    data: {
      contact_name: contactName?.name ?? 'Unknown',
      phone:        contactName?.phone ?? '',
      call_id:      callSessionId,
    },
  })
}
