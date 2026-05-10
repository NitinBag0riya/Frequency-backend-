/**
 * Worker: gmail-poller (singleton repeatable, every 2 minutes by default)
 *
 * Polls each tenant's Gmail (via the OAuth token already stored on the
 * tenants row) for new threads since the last poll. For each new message:
 *   1. Logs to the `messages` table (channel='email', direction='inbound')
 *   2. Routes through engine/inbound-router → workflow trigger or session
 *      resume, identical to how WhatsApp/IG/Telegram inbound flows work.
 *
 * Why polling, not Pub/Sub push:
 *   Gmail's official "new mail" notification path is Cloud Pub/Sub. Setup
 *   per-tenant requires (a) a Google Cloud project, (b) a Pub/Sub topic +
 *   subscription, (c) IAM grants, (d) a stop/restart watch every 7 days.
 *   That's heavy for an SMB-first product where checking inbox every 2min
 *   is plenty for sales/support response time. We can swap in Pub/Sub later
 *   without touching the workflow side — only the worker module changes.
 *
 * State per tenant:
 *   tenants.gmail_history_id  — Gmail's monotonic mailbox version. We pass
 *                               it on each poll to get only changes since
 *                               last tick. First-ever poll uses
 *                               `users.messages.list` with `newer_than: 5m`
 *                               instead and seeds the history_id from the
 *                               most recent message.
 *
 * Triggering: workflows with a node `trigger_inbound_email` fire when an
 * inbound message text matches the trigger's keyword set. Optional config:
 *   trigger.config.from         — only match emails from this address
 *   trigger.config.subject_keywords — substring match on Subject header
 *   trigger.config.keywords     — substring match on body OR subject
 */

import '../env'
import { Worker, Job } from 'bullmq'
import { createClient } from '@supabase/supabase-js'
import { Q, connection, cronQueue } from '../queue'
import { gmailListNewThreads } from '../google'

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://yiicpndeggaedxobyopu.supabase.co'
const supabase = createClient(SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY!)

const TICK_INTERVAL_MS = Number(process.env.GMAIL_POLL_INTERVAL_MS ?? 2 * 60 * 1000)

export async function startGmailPollerWorker() {
  await cronQueue.add(
    'gmail-poller-tick',
    {},
    {
      jobId: 'singleton-gmail-poller',
      repeat: { every: TICK_INTERVAL_MS },
      removeOnComplete: { count: 50 },
      removeOnFail:     { count: 50 },
    },
  )

  const worker = new Worker(
    Q.cron,
    async (job: Job) => {
      if (job.name !== 'gmail-poller-tick') return { skipped: 'not for me' }
      return runTick()
    },
    { connection, concurrency: 1 },
  )

  worker.on('failed', (job, err) => {
    if (job?.name === 'gmail-poller-tick') {
      console.warn(`[gmail-poller] tick failed: ${err.message}`)
    }
  })

  console.log(`[worker:gmail-poller] started, interval=${TICK_INTERVAL_MS}ms`)
  return worker
}

async function runTick() {
  const startedAt = Date.now()
  // Find tenants with Gmail connected AND at least one live workflow that
  // has a trigger_inbound_email node — no point polling if nothing would
  // fire on it. Polling Gmail for tenants with no email triggers wastes
  // their token quota (1B requests/day project-wide, but per-tenant rate
  // limits still apply).
  const { data: candidates } = await supabase.from('tenants')
    // user_id needed for the contacts.upsert below (FK to auth.users via legacy
    // RLS policies). Selecting it here avoids a per-tenant extra round-trip.
    .select('id, user_id, google_access_token, google_refresh_token, google_token_expiry, gmail_history_id, business_name')
    .not('google_access_token', 'is', null)

  if (!candidates || candidates.length === 0) {
    return { polled: 0, fired: 0, skipped_no_token: 0 }
  }

  let polled = 0
  let fired = 0
  let skippedNoTrigger = 0

  for (const tenant of candidates) {
    // Cheap pre-check: any live workflow has a trigger_inbound_email node?
    const { data: workflows } = await supabase.from('workflows')
      .select('id, nodes')
      .eq('tenant_id', tenant.id)
      .eq('status', 'live')
    const hasEmailTrigger = (workflows ?? []).some(wf =>
      (wf.nodes as any[])?.some(n => n.type === 'trigger_inbound_email'),
    )
    if (!hasEmailTrigger) { skippedNoTrigger++; continue }

    polled++
    try {
      // Fetch new messages since last poll. Updates tenant.gmail_history_id
      // as a side effect so the next tick picks up where we left off.
      const newMessages = await gmailListNewThreads(tenant)
      if (newMessages.length === 0) continue

      // Persist new history_id immediately so a crash mid-loop doesn't
      // re-deliver the same messages on next tick.
      const newestHistoryId = newMessages[newMessages.length - 1]?.historyId
      if (newestHistoryId) {
        await supabase.from('tenants')
          .update({ gmail_history_id: newestHistoryId })
          .eq('id', tenant.id)
      }

      const { routeInboundToWorkflow } = await import('../engine/inbound-router')
      for (const m of newMessages) {
        // Skip messages we already logged (idempotent against the rare
        // case where a Gmail history page repeats a message id).
        const { data: existing } = await supabase.from('messages')
          .select('id')
          .eq('tenant_id', tenant.id)
          .eq('platform_message_id', m.id)
          .eq('channel', 'email')
          .maybeSingle()
        if (existing) continue

        await supabase.from('messages').insert({
          tenant_id:           tenant.id,
          channel:             'email',
          direction:           'inbound',
          contact_phone:       m.from,                  // email address fits the contact_phone column
          platform_message_id: m.id,
          content:             { type: 'email', from: m.from, subject: m.subject, body: m.snippet, raw: m },
        })

        // Upsert contact by email — using email-prefixed phone for unique
        // lookup so it doesn't collide with WhatsApp phone numbers.
        await supabase.from('contacts').upsert({
          tenant_id: tenant.id,
          user_id:   tenant.user_id,
          phone:     `email:${m.from}`,
          email:     m.from,
          name:      m.fromName || m.from,
        }, { onConflict: 'tenant_id,phone' })

        // Email triggers go through a dedicated matcher (not the chat
        // inbound-router) because email matching has its own filters
        // (From header, Subject keywords) on top of body text. Email
        // sessions use channel='whatsapp' as a placeholder — the
        // workflow_sessions CHECK enum doesn't include 'email' yet.
        // The trigger_inbound_email node type filter prevents cross-fire
        // with chat triggers. Future: add 'email' to the channel enum
        // and call routeInboundToWorkflow with channel='email'.
        const triggerText = `${m.subject ?? ''}\n${m.snippet ?? ''}`
        await checkEmailKeywordTriggers(tenant, m, triggerText)
        void routeInboundToWorkflow  // referenced for future email-channel migration
        fired++
      }
    } catch (err: any) {
      console.warn(`[gmail-poller] tenant=${tenant.id} failed: ${err?.message ?? err}`)
    }
  }

  const ms = Date.now() - startedAt
  console.log(`[gmail-poller] tick done — polled=${polled} fired=${fired} skipped_no_trigger=${skippedNoTrigger} ${ms}ms`)
  return { polled, fired, skipped_no_trigger: skippedNoTrigger, durationMs: ms }
}

/**
 * Email-specific trigger matcher. Different from the keyword router used
 * by chat channels because we want to match on Subject + From header too,
 * not just body text. Falls back to the generic `keywords` substring set
 * if no email-specific filters are set.
 */
async function checkEmailKeywordTriggers(tenant: any, msg: any, fullText: string) {
  const { data: workflows } = await supabase.from('workflows')
    .select('id, nodes')
    .eq('tenant_id', tenant.id)
    .eq('status', 'live')

  for (const wf of workflows ?? []) {
    const trigger = (wf.nodes as any[])?.find((n: any) => n.type === 'trigger_inbound_email')
    if (!trigger) continue
    const cfg = trigger.config ?? {}

    // Optional From filter
    if (cfg.from && msg.from && !String(msg.from).toLowerCase().includes(String(cfg.from).toLowerCase())) continue
    // Optional Subject keywords
    const subjectKw: string[] = cfg.subject_keywords ?? []
    if (subjectKw.length > 0 && !subjectKw.some(k => String(msg.subject ?? '').toLowerCase().includes(k.toLowerCase()))) continue
    // Generic keywords (body OR subject substring)
    const keywords: string[] = cfg.keywords ?? []
    if (keywords.length > 0 && !keywords.some(k => fullText.toLowerCase().includes(k.toLowerCase()))) continue

    // All filters passed → start the workflow.
    const { enqueueWorkflowExecution } = await import('../queue')
    const firstAction = (wf.nodes as any[])?.find((n: any) => !n.type?.startsWith('trigger_'))
    if (!firstAction) continue
    const { data: session } = await supabase.from('workflow_sessions').insert({
      tenant_id:       tenant.id,
      workflow_id:     wf.id,
      contact_phone:   `email:${msg.from}`,
      // channel must satisfy the migration 031 CHECK constraint
      // (whatsapp|instagram|telegram). Email isn't in the enum yet, so we
      // use 'whatsapp' as a placeholder — the trigger ensures only
      // email-aware workflows fire, and the executor's send nodes use the
      // session.channel to route replies. Email-triggered workflows that
      // want to reply via email use the send_email node directly which
      // bypasses session.channel.
      channel:         'whatsapp',
      current_node_id: firstAction.id,
      variables:       {
        email_from:    msg.from,
        email_subject: msg.subject,
        email_body:    msg.snippet,
      },
      status:          'active',
    }).select('id').single()
    if (session) {
      await enqueueWorkflowExecution({ sessionId: session.id, nodeId: firstAction.id })
      break  // first matching trigger wins
    }
  }
}
