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
      .or(`phone.eq.+${contactId},phone.eq.${contactId},telegram_id.eq.${contactId},instagram_id.eq.${contactId}`)
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
  // multiple tenants.
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

    const keywords: string[] = trigger.config?.keywords ?? []
    if (keywords.some((kw: string) => text.toLowerCase().includes(kw.toLowerCase()))) {
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

  // Load contact properties to seed session variables (P0.5 / P0.7)
  const phoneVal = `+${contactId}`.replace(/^\+\++/, '+')
  const { data: contact } = await supabase.from('contacts')
    .select('name, phone, tags, attributes')
    .eq('tenant_id', tenant.id)
    .or(`phone.eq.${phoneVal},phone.eq.${contactId},telegram_id.eq.${contactId},instagram_id.eq.${contactId}`)
    .limit(1)
    .maybeSingle()

  const seedVars: Record<string, any> = {}
  if (contact) {
    seedVars.contact = {
      name: contact.name ?? '',
      phone: contact.phone ?? '',
      tags: contact.tags ?? [],
      ...(contact.attributes ?? {}),
    }
  }
  if (triggerPayload) {
    seedVars.trigger = triggerPayload
  }

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
