/**
 * Channel-agnostic inbound router.
 *
 * Every channel webhook (whatsapp, instagram, telegram) calls into this
 * module after it has logged the inbound message + upserted the contact.
 * The router does the actual workflow work:
 *
 *   1. RESUME — if there's an active workflow_sessions row for this
 *      (tenant, channel, contact), enqueue execution of the current node
 *      with the reply payload. Worker handles condition branching +
 *      variable assignment.
 *   2. TRIGGER — otherwise, scan live workflows for a
 *      `trigger_inbound_keyword` whose keyword set matches the inbound
 *      text (and whose optional `channels` filter allows this channel).
 *      Start that workflow with `channel` stamped on the session row so
 *      the executor's reply sends route back through the same channel.
 *
 * `contactId` is the channel-specific identifier:
 *   - whatsapp:   "919876543210" (digits only, no leading +)
 *   - telegram:   chat_id as string ("123456789")
 *   - instagram:  sender PSID (page-scoped user id)
 *
 * The `workflow_sessions.channel` column was added in migration 031;
 * without it this module would mis-resume sessions across channels (e.g.
 * a Telegram chat_id "919876543210" colliding with a WhatsApp phone with
 * the same digits).
 *
 * Centralising this logic kills three nasty failure modes that existed
 * when each channel webhook had its own copy:
 *   - WhatsApp got new keyword-match logic; IG/TG quietly fell behind.
 *   - Cross-channel session collisions (same numeric id, different channel).
 *   - The executor's send-reply path didn't know which channel to use.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { enqueueWorkflowExecution } from '../queue'

export type InboundChannel = 'whatsapp' | 'instagram' | 'telegram'

// PostgREST `.or()` takes a RAW filter string that supabase-js does NOT encode, so a
// channel identifier containing `,` `(` `)` `*` would inject extra OR predicates
// (e.g. a Telegram `fromId` of `1,bot_paused.eq.true`). Channel ids are phone numbers
// / numeric platform ids, so strip only those filter metacharacters before
// interpolating — `:`/`.`/`+` are kept so synthetic `order:channel:id` ids and phone
// `+` prefixes still match. See lib/safe-key.ts which documents this class.
const orSafe = (v: string): string => String(v).replace(/[,()*]/g, '').slice(0, 80)

export async function routeInboundToWorkflow(
  supabase: SupabaseClient,
  tenant: any,
  channel: InboundChannel,
  contactId: string,
  text: string,
  rawMsg: any,
): Promise<void> {
  // 0. Fan out a mobile push to this tenant's agents (P0.10).
  //    Best-effort, fully isolated — a failure in the push pipeline
  //    must NEVER block workflow routing. Fire-and-forget so we don't
  //    add an http round-trip to Expo on the inbound critical path.
  //    We don't await; the surrounding try/catch swallows everything.
  void notifyMobileAgents(supabase, tenant, channel, contactId, text).catch(e => {
    console.warn(`[inbound-push] notifyMobileAgents threw (non-fatal): ${e?.message ?? e}`)
  })

  // Take-over gate (covers BOTH the resume path AND the keyword-trigger path):
  // when an agent clicks "Take over" in the inbox we set contacts.bot_paused=
  // true. Honour it here so the bot stops auto-replying and the human owns the
  // conversation. (Previously bot_paused was set + shown in the UI but never
  // read on inbound, so "Take over" didn't actually pause the bot.)
  const { data: pausedContact } = await supabase.from('contacts')
    .select('bot_paused')
    .eq('tenant_id', tenant.id)
    .or(`phone.eq.+${orSafe(contactId)},phone.eq.${orSafe(contactId)},telegram_id.eq.${orSafe(contactId)},instagram_id.eq.${orSafe(contactId)}`)
    .limit(1)
    .maybeSingle()
  if (pausedContact?.bot_paused) return

  // 1. Active workflow session for this (tenant, channel, contact)?
  // The composite filter prevents cross-channel collisions when two
  // different channels happen to use the same numeric identifier.
  const { data: session } = await supabase.from('workflow_sessions')
    .select('id, current_node_id')
    .eq('tenant_id',     tenant.id)
    .eq('channel',       channel)
    .eq('contact_phone', contactId)
    .eq('status',        'active')
    .order('started_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (session) {
    await enqueueWorkflowExecution({
      sessionId: session.id,
      nodeId:    session.current_node_id,
      reply:     { text, raw: rawMsg },
    })
    return
  }

  // 2. No active session → keyword-trigger scan.
  await checkKeywordTriggers(supabase, tenant, contactId, text, channel)
}

/**
 * Route a WhatsApp Flow SUBMISSION (nfm_reply). Two outcomes, mirroring the
 * inbound router:
 *   - if a workflow session is already waiting for this contact (it sent the
 *     flow via send_flow and parked on wait_input), RESUME it — the submitted
 *     fields arrive as the reply (raw = flowData), readable downstream.
 *   - otherwise FIRE trigger_flow_response so a workflow can START on the
 *     submission, with the fields in scope as {{trigger.*}}.
 * Honours the bot_paused take-over gate. Returns what it did (for tests/logging).
 */
export async function routeFlowSubmission(
  supabase: SupabaseClient,
  tenant: any,
  channel: InboundChannel,
  contactId: string,
  flowData: Record<string, any>,
  rawMsg: any,
  meta: { flow_id?: string | null; flow_name?: string | null } = {},
): Promise<{ resumed: boolean; triggered: boolean }> {
  const { data: pausedContact } = await supabase.from('contacts')
    .select('bot_paused')
    .eq('tenant_id', tenant.id)
    .or(`phone.eq.+${orSafe(contactId)},phone.eq.${orSafe(contactId)},telegram_id.eq.${orSafe(contactId)},instagram_id.eq.${orSafe(contactId)}`)
    .limit(1).maybeSingle()
  if (pausedContact?.bot_paused) return { resumed: false, triggered: false }

  // A session waiting on send_flow's wait_input → resume it with the answers.
  // Match BOTH phone formats: the WhatsApp webhook gives a bare number while a
  // session started by a lead/order/payment/schedule trigger may have stored
  // +E.164 — a strict eq would miss those and hang the session forever. Mirrors
  // the bot_paused lookup above.
  const { data: session } = await supabase.from('workflow_sessions')
    .select('id, current_node_id')
    .eq('tenant_id', tenant.id).eq('channel', channel)
    .or(`contact_phone.eq.+${orSafe(contactId)},contact_phone.eq.${orSafe(contactId)}`)
    .eq('status', 'active')
    .order('started_at', { ascending: false }).limit(1).maybeSingle()
  if (session) {
    await enqueueWorkflowExecution({
      sessionId: session.id,
      nodeId:    session.current_node_id,
      reply:     { text: summarizeFlow(flowData), raw: { ...rawMsg, flow: flowData } },
    })
    return { resumed: true, triggered: false }
  }

  // No session waiting → start any workflow whose entry is trigger_flow_response,
  // optionally scoped to a specific flow_id.
  let started = 0
  await fireWorkflowTrigger(supabase, tenant.id, 'trigger_flow_response', {
    contactId, channel,
    payload: { ...flowData, flow_id: meta.flow_id ?? null, flow_name: meta.flow_name ?? null },
    match: (cfg) => {
      const want = String(cfg?.flow_id ?? '').trim()
      if (want && want !== String(meta.flow_id ?? '')) return false
      started++
      return true
    },
  })
  return { resumed: false, triggered: started > 0 }
}

/** Compact human-readable summary of submitted flow fields (for the reply text
 *  + inbox preview). Keeps it short; full data lives in raw.flow + the response row. */
function summarizeFlow(flowData: Record<string, any>): string {
  const parts = Object.entries(flowData)
    .filter(([k]) => k !== 'flow_token' && !k.startsWith('_'))
    .slice(0, 6)
    .map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : String(v)}`)
  return parts.length ? `Flow submitted — ${parts.join(', ')}`.slice(0, 300) : 'Flow submitted'
}

/**
 * Best-effort mobile push fan-out for new inbound messages (P0.10).
 *
 * We notify every user who has an active role assignment on the tenant —
 * that's the realistic "could see this inbox row" set today (no
 * conversation-level assignment table exists yet; if it lands later,
 * we'd narrow the targets here). RLS on push_devices already ensures
 * each user only sees their own tokens, but sendExpoPush runs with the
 * service-role client passed in, so we explicitly filter by user_id.
 *
 * Failure here must never break the inbound flow — wrap everything,
 * log, swallow.
 */
async function notifyMobileAgents(
  supabase: SupabaseClient,
  tenant: any,
  channel: InboundChannel,
  contactId: string,
  text: string,
): Promise<void> {
  try {
    // Resolve who should get the push. Tenant team members (active
    // assignments) + tenant owner. We dedupe at the Set boundary.
    const userIds = new Set<string>()

    // Owner from tenants.user_id (legacy + always present).
    if (tenant?.user_id) userIds.add(String(tenant.user_id))

    // Active team members from the new RBAC table. `disabled_at is null`
    // matches the gate the rest of the codebase uses for "this user
    // currently has access".
    const { data: assignments } = await supabase.from('user_role_assignments')
      .select('user_id, disabled_at')
      .eq('tenant_id', tenant.id)
      .is('disabled_at', null)
    for (const a of assignments ?? []) {
      if (a.user_id) userIds.add(String(a.user_id))
    }

    if (userIds.size === 0) return

    // Resolve a display name for the push title. Falls back to the
    // channel-specific identifier (phone / chat_id / IG psid) if no
    // contact row exists yet.
    let displayName = contactId
    const { data: contactRow } = await supabase.from('contacts')
      .select('name, phone')
      .eq('tenant_id', tenant.id)
      .or(`phone.eq.+${orSafe(contactId)},phone.eq.${orSafe(contactId)},telegram_id.eq.${orSafe(contactId)},instagram_id.eq.${orSafe(contactId)}`)
      .limit(1)
      .maybeSingle()
    if (contactRow?.name) displayName = contactRow.name
    else if (contactRow?.phone) displayName = contactRow.phone

    const title = `New ${channel} message from ${displayName}`
    const body  = String(text ?? '').slice(0, 140) || '(no text)'

    const { sendExpoPush } = await import('../lib/expo-push')
    await Promise.all([...userIds].map(uid =>
      sendExpoPush(supabase, uid, {
        title,
        body,
        data:    { tenant_id: tenant.id, channel, contact_id: contactId },
        channel: 'inbox',
      }).catch(e => {
        console.warn(`[inbound-push] sendExpoPush failed for user=${uid}: ${e?.message ?? e}`)
        return { sent: 0, failed: 0 }
      })
    ))
  } catch (e: any) {
    console.warn(`[inbound-push] notifyMobileAgents outer failure: ${e?.message ?? e}`)
  }
}

async function checkKeywordTriggers(
  supabase: SupabaseClient,
  tenant: any,
  contactId: string,
  text: string,
  channel: InboundChannel,
): Promise<void> {
  // Tenant-scoped — was user_id-scoped before; broken once a user owned
  // multiple tenants. (Take-over / bot_paused is gated upstream in
  // routeInboundToWorkflow so it covers both resume + keyword paths.)
  const { data: workflows } = await supabase.from('workflows')
    .select('id, nodes')
    .eq('tenant_id', tenant.id)
    .eq('status', 'live')

  for (const wf of workflows ?? []) {
    const trigger = (wf.nodes as any[])?.find((n: any) => n.type === 'trigger_inbound_keyword')
    if (!trigger) continue

    // Optional per-trigger channel filter. `channels: ['whatsapp', 'telegram']`
    // restricts firing to those channels. Empty/missing array = match any
    // channel (back-compat with workflows authored before multi-channel).
    const allowedChannels: string[] | undefined = trigger.config?.channels
    if (allowedChannels && allowedChannels.length > 0 && !allowedChannels.includes(channel)) continue

    // `match_all: true` (or a '*' keyword) fires on EVERY inbound on the
    // allowed channel — used for an always-on AI chatbot that answers any
    // message, not just keyword hits. Otherwise match when the text contains
    // any configured keyword.
    const keywords: string[] = trigger.config?.keywords ?? []
    const matchAll = trigger.config?.match_all === true || keywords.includes('*')
    if (matchAll || keywords.some((kw: string) => text.toLowerCase().includes(kw.toLowerCase()))) {
      await startWorkflow(supabase, tenant, wf, contactId, channel, { text })
      break  // first match wins; matches mental model of priority by workflow order
    }
  }
}

/**
 * P0.9 — Instagram-unique trigger fan-out.
 *
 * The keyword router above only matches text against `trigger_inbound_keyword`
 * nodes. Instagram has three event types that don't carry a text body at
 * all (or carry text that isn't keyword-matched) but should still trigger
 * a workflow:
 *
 *   - 'instagram_story_reply'  → user replied to one of our stories
 *   - 'instagram_comment'      → new comment on one of our posts
 *   - 'instagram_mention'      → @brand mentioned on someone else's media
 *
 * We model these as separate trigger node types on workflows. Authors set
 * one of them as the entry point in the chat-driven builder; we resolve the
 * matching workflows here and start a session with `channel='instagram'`
 * stamped so downstream replies route back through the IG send pipeline.
 *
 * Multiple workflows can subscribe to the same trigger — all matches fire
 * (no first-match-wins for events, unlike keyword triggers). Per-trigger
 * config can narrow further (e.g. only fire on comments containing X).
 */
export type IgTriggerType =
  | 'instagram_story_reply'
  | 'instagram_comment'
  | 'instagram_mention'

export interface IgTriggerPayload {
  contactId: string
  text?: string
  [key: string]: any
}

export async function fireIgEventTrigger(
  supabase: SupabaseClient,
  tenant: any,
  triggerType: IgTriggerType,
  payload: IgTriggerPayload,
): Promise<void> {
  const { data: workflows } = await supabase.from('workflows')
    .select('id, nodes')
    .eq('tenant_id', tenant.id)
    .eq('status', 'live')

  for (const wf of workflows ?? []) {
    const trigger = ((wf as any).nodes as any[])?.find((n: any) => n.type === triggerType)
    if (!trigger) continue

    // Optional in-trigger keyword filter (e.g. only fire on comments
    // containing 'price'). Empty list = fire on every event.
    const requiredKeywords: string[] = trigger.config?.keywords ?? []
    if (requiredKeywords.length > 0) {
      const t = String(payload.text ?? '').toLowerCase()
      if (!requiredKeywords.some(kw => t.includes(String(kw).toLowerCase()))) continue
    }

    await startWorkflow(supabase, tenant, wf, payload.contactId, 'instagram', payload)
  }
}

// Phone aliases seen across lead-form / webhook payloads (mirrors the dedup
// keys in src/leads.ts). The workflow messages the lead, so a phone is required.
const LEAD_PHONE_KEYS = ['phone', 'Phone', 'PHONE', 'phone_number', 'phoneNumber', 'mobile', 'Mobile', 'contact', 'tel', 'telephone']

/**
 * New-lead trigger fan-out. Called right after a SINGLE lead lands — webhook
 * intake (JustDial / 99acres / FB Lead Ads / …) or a row created in one of our
 * Leads tables. Finds live workflows whose `trigger_new_lead` entry matches this
 * table/source (and optional column filter) and starts a session per match with
 * the lead's fields in scope as {{trigger.lead.*}}.
 *
 * NOT called from bulk/CSV import paths on purpose — mass-firing one workflow
 * per imported row would be a footgun.
 */
export async function fireNewLeadTrigger(
  supabase: SupabaseClient,
  tenantId: string,
  lead: { tableId: string; source?: string | null; row: { id?: string; data?: Record<string, any> } },
): Promise<void> {
  const data = lead.row?.data ?? {}
  let phone: string | undefined
  for (const k of LEAD_PHONE_KEYS) { const v = (data as any)[k]; if (v != null && String(v).trim()) { phone = String(v).trim(); break } }
  if (!phone) return   // no contactable phone → nothing a workflow could message

  const { data: workflows } = await supabase.from('workflows')
    .select('id, nodes').eq('tenant_id', tenantId).eq('status', 'live')

  for (const wf of workflows ?? []) {
    const trigger = ((wf as any).nodes as any[])?.find((n: any) => n.type === 'trigger_new_lead')
    if (!trigger) continue
    const cfg = trigger.config ?? {}
    // Match by table and/or source; an unset filter means "any".
    if (cfg.table_id && String(cfg.table_id) !== String(lead.tableId)) continue
    if (cfg.source && lead.source && String(cfg.source) !== String(lead.source)) continue
    // Optional single-column filter (e.g. only fire when status = 'new').
    if (cfg.filter_column) {
      const actual = String((data as any)[cfg.filter_column] ?? '').toLowerCase()
      if (cfg.filter_value != null && actual !== String(cfg.filter_value).toLowerCase()) continue
    }
    await startWorkflow(supabase, { id: tenantId }, wf, phone, 'whatsapp', {
      lead: data, row: data, source: lead.source ?? null, lead_row_id: lead.row?.id ?? null,
    })
  }
}

/**
 * Order trigger fan-out. Called when a single order lands or changes state on
 * any commerce channel (storefront mini-app, Zomato, Shopify, WooCommerce).
 * `trigger_new_order` fires on a fresh order; `trigger_order_status` fires on a
 * status change (ready / cancelled / …). Workflows match by channel and/or
 * status. The order is in scope downstream as {{trigger.order.*}}.
 */
export async function fireOrderTrigger(
  supabase: SupabaseClient,
  tenantId: string,
  evt: {
    kind: 'new_order' | 'order_status'
    channel: string                       // storefront | zomato | shopify | woocommerce
    status?: string | null                // for order_status events
    contactPhone?: string | null          // customer phone if the channel exposes it
    orderId: string
    order: Record<string, any>
  },
): Promise<void> {
  const triggerType = evt.kind === 'new_order' ? 'trigger_new_order' : 'trigger_order_status'
  // Orders may have no customer phone (Zomato masks it) — a unique session key
  // is still needed, so fall back to the order id. Workflows that message the
  // customer should guard on a real phone; staff-notify flows don't need one.
  const contactId = (evt.contactPhone && String(evt.contactPhone).trim()) || `order:${evt.channel}:${evt.orderId}`

  const { data: workflows } = await supabase.from('workflows')
    .select('id, nodes').eq('tenant_id', tenantId).eq('status', 'live')

  for (const wf of workflows ?? []) {
    const trigger = ((wf as any).nodes as any[])?.find((n: any) => n.type === triggerType)
    if (!trigger) continue
    const cfg = trigger.config ?? {}
    if (cfg.channel && String(cfg.channel) !== String(evt.channel)) continue
    if (evt.kind === 'order_status' && cfg.status && evt.status && String(cfg.status) !== String(evt.status)) continue
    await startWorkflow(supabase, { id: tenantId }, wf, contactId, 'whatsapp', {
      order: evt.order, channel: evt.channel, status: evt.status ?? null, order_id: evt.orderId,
    })
  }
}

/**
 * Generic event-trigger fan-out — the reusable core behind every event-driven
 * trigger (payment, CRM stage, missed call, message status, …). Finds live
 * workflows whose entry node is `triggerType`, applies an optional config
 * match, and starts a session per match with `payload` in scope as
 * {{trigger.*}}. Each new trigger source is now a one-liner that calls this.
 */
export async function fireWorkflowTrigger(
  supabase: SupabaseClient,
  tenantId: string,
  triggerType: string,
  opts: { contactId: string; channel?: InboundChannel; payload?: Record<string, any>; match?: (cfg: any) => boolean },
): Promise<void> {
  const { data: workflows } = await supabase.from('workflows')
    .select('id, nodes').eq('tenant_id', tenantId).eq('status', 'live')
  for (const wf of workflows ?? []) {
    const trigger = ((wf as any).nodes as any[])?.find((n: any) => n.type === triggerType)
    if (!trigger) continue
    if (opts.match && !opts.match(trigger.config ?? {})) continue
    await startWorkflow(supabase, { id: tenantId }, wf, opts.contactId, opts.channel ?? 'whatsapp', opts.payload ?? {})
  }
}

/**
 * Start ONE specific workflow by id — the entry point for the schedule poller
 * (trigger_schedule). Unlike fireWorkflowTrigger this does not fan out across
 * all live workflows; the scheduled_jobs row already names the workflow. Re-checks
 * that it's still live and still owns a trigger_schedule node so a paused/edited/
 * deleted workflow simply stops (the caller skips re-enqueue when this returns
 * false → the recurring chain self-cleans). Returns whether a session was started.
 */
/** Cost guard for audience schedules — a single "message my segment" run fans
 *  out one workflow session per contact, so bound it. Excess is logged, never
 *  silently dropped. Raise per-tenant later if a plan needs it. */
const MAX_SCHEDULE_AUDIENCE = 1000

export async function fireScheduledWorkflow(
  supabase: SupabaseClient,
  tenantId: string,
  opts: { workflowId: string; contactId?: string | null; payload?: Record<string, any> },
): Promise<boolean> {
  const { data: wf } = await supabase.from('workflows')
    .select('id, nodes, status').eq('tenant_id', tenantId).eq('id', opts.workflowId).maybeSingle()
  if (!wf || (wf as any).status !== 'live') return false
  const scheduleNode = ((wf as any).nodes as any[] | undefined)?.find(n => n?.type === 'trigger_schedule')
  if (!scheduleNode) return false

  // 1:1 reminder — a specific contact is named on the schedule.
  if (opts.contactId) {
    await startWorkflow(supabase, { id: tenantId }, wf, opts.contactId, 'whatsapp', opts.payload ?? {})
    return true
  }

  // Audience schedule — no specific contact, so resolve the segment/tags on the
  // trigger_schedule node and fan out one session per matching contact. Returns
  // true (still schedulable) even when zero match this run, so the recurring
  // chain keeps parking next occurrences.
  const contacts = await resolveScheduleAudience(supabase, tenantId, scheduleNode.config ?? {})
  if (contacts.length === 0) {
    console.log(`[schedule] wf=${opts.workflowId} audience matched 0 contacts this run`)
    return true
  }
  let started = 0
  for (const c of contacts) {
    const addr = c.phone
    if (!addr) continue
    try {
      await startWorkflow(supabase, { id: tenantId }, wf, addr, 'whatsapp',
        { ...(opts.payload ?? {}), audience: true })
      started++
    } catch (e) {
      console.warn(`[schedule] wf=${opts.workflowId} start failed for contact ${c.id}:`, e)
    }
  }
  console.log(`[schedule] wf=${opts.workflowId} fanned out to ${started}/${contacts.length} contacts`)
  return true
}

/** Resolve a trigger_schedule node's audience → contact rows. Supports
 *  cfg.segment_id (saved segment, via the shared evaluator) or cfg.audience
 *  {tags, exclude_tags}. Refuses an unscoped schedule (no segment, no tags) so a
 *  schedule can never implicitly blast every contact. Caps at
 *  MAX_SCHEDULE_AUDIENCE and logs when more matched. Exported for integration
 *  testing (tests/integration/schedule-audience.ts). */
export async function resolveScheduleAudience(
  supabase: SupabaseClient,
  tenantId: string,
  cfg: any,
): Promise<Array<{ id: string; phone: string | null }>> {
  const aud = cfg?.audience ?? {}
  if (!cfg?.segment_id && !(Array.isArray(aud.tags) && aud.tags.length)) {
    console.warn(`[schedule] audience schedule has no segment_id or tags — skipping fan-out (refusing to message all contacts)`)
    return []
  }

  let q: any
  if (cfg.segment_id) {
    const { data: seg } = await supabase.from('contact_segments')
      .select('id, filters, archived_at').eq('id', cfg.segment_id).eq('tenant_id', tenantId).maybeSingle()
    if (!seg || (seg as any).archived_at) {
      console.warn(`[schedule] segment ${cfg.segment_id} missing/archived — skipping fan-out`)
      return []
    }
    const { buildSegmentQuery } = await import('../lib/segment-filter')
    const built = await buildSegmentQuery(supabase, tenantId, (seg as any).filters)
    q = built.query.select('id, phone').eq('status', 'active')
  } else {
    q = supabase.from('contacts').select('id, phone')
      .eq('tenant_id', tenantId).eq('status', 'active')
      .overlaps('tags', aud.tags)
    if (Array.isArray(aud.exclude_tags) && aud.exclude_tags.length) {
      q = q.not('tags', 'ov', `{${aud.exclude_tags.join(',')}}`)
    }
  }
  q = q.limit(MAX_SCHEDULE_AUDIENCE + 1)
  const { data, error } = await q
  if (error) { console.warn(`[schedule] audience query failed: ${error.message}`); return [] }
  const rows = (data ?? []) as Array<{ id: string; phone: string | null }>
  if (rows.length > MAX_SCHEDULE_AUDIENCE) {
    console.warn(`[schedule] audience matched ${rows.length} (> cap ${MAX_SCHEDULE_AUDIENCE}); messaging first ${MAX_SCHEDULE_AUDIENCE} this run`)
    return rows.slice(0, MAX_SCHEDULE_AUDIENCE)
  }
  return rows
}

async function startWorkflow(
  supabase: SupabaseClient,
  tenant: any,
  workflow: any,
  contactId: string,
  channel: InboundChannel,
  triggerPayload?: Record<string, any>,
): Promise<void> {
  const nodes: any[] = workflow.nodes ?? []
  // Skip trigger_* nodes — they're entry markers, not actions to execute.
  const firstAction = nodes.find((n: any) => !n.type?.startsWith('trigger_'))
  if (!firstAction) return

  // Build the canonical {trigger, contact} bag via the shared seeder.
  // See engine/seed-vars.ts — guarantees contact is always populated
  // (so {{contact.name}} doesn't leak to recipients as a literal token).
  const { seedSessionVars } = await import('./seed-vars')
  const seedVars = await seedSessionVars(supabase, tenant.id, contactId, triggerPayload)

  const { data: session } = await supabase.from('workflow_sessions').insert({
    tenant_id:       tenant.id,
    workflow_id:     workflow.id,
    contact_phone:   contactId,
    channel,                          // migration 031 added this column
    current_node_id: firstAction.id,
    variables:       seedVars,
    status:          'active',
  }).select('id').single()

  if (session) {
    await enqueueWorkflowExecution({ sessionId: session.id, nodeId: firstAction.id })
  }
}
