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
      await startWorkflow(supabase, tenant, wf, contactId, channel)
      break  // first match wins; matches mental model of priority by workflow order
    }
  }
}

async function startWorkflow(
  supabase: SupabaseClient,
  tenant: any,
  workflow: any,
  contactId: string,
  channel: InboundChannel,
): Promise<void> {
  const nodes: any[] = workflow.nodes ?? []
  // Skip trigger_* nodes — they're entry markers, not actions to execute.
  const firstAction = nodes.find((n: any) => !n.type?.startsWith('trigger_'))
  if (!firstAction) return

  const { data: session } = await supabase.from('workflow_sessions').insert({
    tenant_id:       tenant.id,
    workflow_id:     workflow.id,
    contact_phone:   contactId,
    channel,                          // migration 031 added this column
    current_node_id: firstAction.id,
    variables:       {},
    status:          'active',
  }).select('id').single()

  if (session) {
    await enqueueWorkflowExecution({ sessionId: session.id, nodeId: firstAction.id })
  }
}
