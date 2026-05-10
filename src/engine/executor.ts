/**
 * Workflow node executor + dispatcher.
 *
 * Pure logic — no BullMQ imports. The worker calls executeNode() and acts on
 * the returned NodeResult to either auto-advance, schedule a wait, halt for
 * inbound input, or stop the session.
 *
 * All side-effects on Supabase happen inside this file (logging executions,
 * updating session.variables/current_node_id, scheduling resumes). Outbound
 * messages are *enqueued* to message.send so the message-sender worker can
 * apply rate limiting + retries uniformly.
 */

import { createClient } from '@supabase/supabase-js'
import Anthropic from '@anthropic-ai/sdk'
import {
  enqueueMessageSend, enqueueWorkflowExecution, MessageSendJob,
} from '../queue'
import { interpolate, interpolateDeep } from './interpolator'
import {
  sheetsAppendRow, sheetsUpdateRange,
  calendarCreateEvent, calendarCheckAvailability,
} from '../google'

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://yiicpndeggaedxobyopu.supabase.co'
const supabase = createClient(SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY!)

const anthropic = process.env.ANTHROPIC_API_KEY
  ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
  : null

// ── Types ────────────────────────────────────────────────────────────────────
export interface ExecCtx {
  tenant: any              // row from public.tenants
  session: any             // row from public.workflow_sessions (mutable: variables get merged)
  workflow: any            // row from public.workflows
  reply?: { text: string; raw?: any } | null   // present only when resuming from inbound
}

export interface NodeResult {
  /** What the worker should do next.
   *  - 'advance' → enqueue execution of `nextNodeId`
   *  - 'wait_input' → halt; keep session active; next inbound resumes
   *  - 'wait_delay' → insert scheduled_jobs row; halt
   *  - 'end' → mark session completed
   *  - 'error' → mark execution failed; do not advance
   */
  kind: 'advance' | 'wait_input' | 'wait_delay' | 'end' | 'error'
  nextNodeId?: string | null
  delayMs?: number              // for wait_delay
  output?: any                  // logged in workflow_executions.output
  error?: string
  variableUpdates?: Record<string, any>   // merged into session.variables
}

// ── Top-level dispatcher ─────────────────────────────────────────────────────
export async function executeNode(ctx: ExecCtx, node: any): Promise<NodeResult> {
  const vars = ctx.session.variables ?? {}
  const cfg = node.config ?? {}

  try {
    switch (node.type) {
      // ── Messaging (enqueue, then auto-advance) ──────────────────────────────
      case 'send_text': {
        const text = interpolate(cfg.text, vars)
        await enqueueMessageSend(buildSendJob(ctx, { kind: 'text', text }))
        return advance(node)
      }

      case 'send_template': {
        const params: string[] = (cfg.parameters ?? []).map((p: string) => interpolate(p, vars))
        await enqueueMessageSend(buildSendJob(ctx, {
          kind: 'template',
          template: {
            name: cfg.template_name,
            language: cfg.language ?? 'en_US',
            parameters: params,
          },
        }))
        return advance(node)
      }

      case 'send_interactive': {
        await enqueueMessageSend(buildSendJob(ctx, {
          kind: 'interactive',
          interactive: interpolateDeep(cfg, vars),
        }))
        return advance(node)
      }

      // ── Input (halt, wait for inbound) ──────────────────────────────────────
      case 'collect_input': {
        if (cfg.prompt) {
          await enqueueMessageSend(buildSendJob(ctx, {
            kind: 'text', text: interpolate(cfg.prompt, vars),
          }))
        }
        return { kind: 'wait_input' }
      }

      // ── Wait / delay ────────────────────────────────────────────────────────
      case 'wait_delay': {
        const minutes = Number(cfg.delay_minutes ?? 0)
        const seconds = Number(cfg.delay_seconds ?? 0)
        const delayMs = (minutes * 60 + seconds) * 1000
        const next = pickDefault(node)
        return { kind: 'wait_delay', delayMs, nextNodeId: next }
      }

      // ── Conditions ──────────────────────────────────────────────────────────
      case 'condition_reply':
      case 'condition_button_click': {
        const reply = (ctx.reply?.text ?? '').toLowerCase()
        const branches: Record<string, string> = node.connections ?? {}
        const match = Object.keys(branches).find(k =>
          k !== 'default' && reply.includes(k.toLowerCase())
        )
        return { kind: 'advance', nextNodeId: match ? branches[match] : (branches.default ?? null) }
      }

      case 'condition_variable': {
        // cfg: { variable: 'name', operator: 'equals'|'not_equals'|'contains'|'gt'|'lt'|'exists', value: '...' }
        const varVal = vars[cfg.variable]
        const matches = evalCondition(varVal, cfg.operator, cfg.value)
        const branches: Record<string, string> = node.connections ?? {}
        return { kind: 'advance', nextNodeId: matches ? (branches.true ?? branches.default ?? null) : (branches.false ?? null) }
      }

      // ── Tag / agent / contact mutations ─────────────────────────────────────
      case 'add_tag': {
        const tag = interpolate(cfg.tag, vars)
        if (tag) {
          const phone = `+${ctx.session.contact_phone}`.replace(/^\+\++/, '+')
          const { data: contact } = await supabase
            .from('contacts')
            .select('id, tags')
            .eq('tenant_id', ctx.tenant.id)
            .eq('phone', phone)
            .maybeSingle()
          if (contact && !(contact.tags ?? []).includes(tag)) {
            const tags = Array.from(new Set([...(contact.tags ?? []), tag]))
            await supabase.from('contacts').update({ tags }).eq('id', contact.id)
            // Fire campaign trigger — any campaign with trigger=tag_added matching this tag.
            const { triggerCampaignsByTag } = await import('./triggers')
            await triggerCampaignsByTag(ctx.tenant.id, contact.id, ctx.session.contact_phone, tag)
          }
        }
        return advance(node)
      }

      case 'assign_agent': {
        const agentId = cfg.agent_user_id ?? interpolate(cfg.agent, vars)
        if (agentId) {
          const phone = `+${ctx.session.contact_phone}`.replace(/^\+\++/, '+')
          await supabase.from('contacts')
            .update({ assigned_to: agentId })
            .eq('tenant_id', ctx.tenant.id)
            .eq('phone', phone)
        }
        return advance(node)
      }

      // ── HTTP / external ─────────────────────────────────────────────────────
      case 'http_request': {
        const url = interpolate(cfg.url, vars)
        const method = (cfg.method ?? 'GET').toUpperCase()
        const headers = interpolateDeep(cfg.headers ?? {}, vars)
        const bodyTemplate = cfg.body
        const body = bodyTemplate
          ? (typeof bodyTemplate === 'string' ? interpolate(bodyTemplate, vars) : JSON.stringify(interpolateDeep(bodyTemplate, vars)))
          : undefined
        if (!url) return { kind: 'error', error: 'http_request: missing url' }

        const r = await fetch(url, {
          method,
          headers: { 'Content-Type': 'application/json', ...headers },
          body: method === 'GET' ? undefined : body,
        })
        const respText = await r.text()
        let respJson: any = null
        try { respJson = JSON.parse(respText) } catch {}
        const updates: Record<string, any> = {}
        if (cfg.response_variable) updates[cfg.response_variable] = respJson ?? respText
        updates[`${node.id}_status`] = r.status
        return { kind: 'advance', nextNodeId: pickDefault(node), output: { status: r.status }, variableUpdates: updates }
      }

      // ── CRM / lead update ───────────────────────────────────────────────────
      case 'update_crm': {
        // cfg: { table: 'lead_tables.id', updates: { field: 'value or {{var}}' } }
        const updates = interpolateDeep(cfg.updates ?? {}, vars)
        const phone = `+${ctx.session.contact_phone}`.replace(/^\+\++/, '+')
        if (cfg.target === 'contact' || !cfg.table_id) {
          await supabase.from('contacts').update(updates)
            .eq('tenant_id', ctx.tenant.id).eq('phone', phone)
        } else {
          // Lead row update (best-effort; assumes lead_rows table from leads module)
          await supabase.from('lead_rows').update({ data: updates })
            .eq('table_id', cfg.table_id)
            .eq('data->>phone', phone)
        }
        return advance(node)
      }

      // ── Google Sheets ───────────────────────────────────────────────────────
      case 'update_sheet': {
        const { spreadsheet_id, range, values = [], mode } = cfg
        if (!spreadsheet_id || !range || !ctx.tenant.google_access_token) {
          return { kind: 'advance', nextNodeId: pickDefault(node), output: { skipped: 'missing google config' } }
        }
        const interpolated = (values as string[]).map((v: string) => interpolate(v, vars))
        if (mode === 'update') await sheetsUpdateRange(ctx.tenant, spreadsheet_id, range, [interpolated])
        else                   await sheetsAppendRow(ctx.tenant, spreadsheet_id, range, interpolated)
        return advance(node)
      }

      // ── Google Calendar ─────────────────────────────────────────────────────
      case 'create_calendar_event': {
        if (!ctx.tenant.google_access_token || !cfg.summary) return advance(node)
        await calendarCreateEvent(ctx.tenant, cfg.calendar_id ?? 'primary', {
          summary:        interpolate(cfg.summary, vars),
          description:    cfg.description ? interpolate(cfg.description, vars) : undefined,
          location:       cfg.location    ? interpolate(cfg.location,    vars) : undefined,
          startTime:      interpolate(cfg.start_time, vars),
          endTime:        interpolate(cfg.end_time,   vars),
          timeZone:       cfg.time_zone ?? 'Asia/Kolkata',
          attendeeEmails: cfg.attendee_emails ?? [],
        })
        return advance(node)
      }

      case 'check_calendar_availability': {
        if (!ctx.tenant.google_access_token || !cfg.variable_name) return advance(node)
        const available = await calendarCheckAvailability(
          ctx.tenant,
          cfg.calendar_id ?? 'primary',
          interpolate(cfg.start_time, vars),
          interpolate(cfg.end_time, vars),
        )
        return {
          kind: 'advance', nextNodeId: pickDefault(node),
          variableUpdates: { [cfg.variable_name]: available ? 'yes' : 'no' },
        }
      }

      // ── AI Responder (Frequency AI, powered by Anthropic) ───────────────────
      case 'run_ai_responder': {
        // `output.skipped` lands in the workflow session inspection UI — keep
        // it brand-neutral. The engineer-facing detail is in the boot log.
        if (!anthropic) return { kind: 'advance', nextNodeId: pickDefault(node), output: { skipped: 'Frequency AI not available' } }
        const systemPrompt = interpolate(cfg.system_prompt ?? 'You are a helpful WhatsApp assistant. Reply concisely.', vars)
        const userMsg = interpolate(cfg.user_message ?? ctx.reply?.text ?? '', vars)
        const resp = await anthropic.messages.create({
          model: cfg.model ?? 'claude-haiku-4-5',
          max_tokens: cfg.max_tokens ?? 400,
          system: systemPrompt,
          messages: [{ role: 'user', content: userMsg }],
        })
        // Per-tenant token accounting (lib/ai-usage.ts). Fire-and-forget;
        // workflow execution must not stall on a counter-table write.
        void import('../lib/ai-usage').then(({ recordAiUsage }) =>
          recordAiUsage(supabase, ctx.tenant.id, resp.usage as any, 'ai_responder'))
        const text = resp.content
          .filter((b: any) => b.type === 'text')
          .map((b: any) => b.text)
          .join('\n')
          .trim()
        if (text) {
          await enqueueMessageSend(buildSendJob(ctx, { kind: 'text', text }))
        }
        const updates = cfg.response_variable ? { [cfg.response_variable]: text } : undefined
        return { kind: 'advance', nextNodeId: pickDefault(node), variableUpdates: updates, output: { length: text.length } }
      }

      // ── Email — Gmail-first when tenant has Google connected, Resend fallback ──
      case 'send_email':
      case 'forward_email': {
        // Provider override:
        //   cfg.provider = 'gmail'  → force Gmail (errors if Google not connected)
        //   cfg.provider = 'resend' → force Resend (system / branded mail)
        //   anything else / unset   → 'auto' = Gmail if connected, else Resend
        // We default to 'auto' so a tenant who connected Google sends FROM
        // their own gmail address, not from our Resend domain. The legacy
        // cfg.smtp_provider field is honoured for back-compat.
        const provider = (cfg.provider ?? cfg.smtp_provider ?? 'auto') as
          'auto' | 'gmail' | 'resend' | 'smtp'
        await enqueueMessageSend({
          tenantId: ctx.tenant.id,
          to: interpolate(cfg.to_email, vars),
          channel: 'email',
          email: {
            to:       interpolate(cfg.to_email, vars),
            subject:  interpolate(cfg.subject ?? '(no subject)', vars),
            body:     interpolate(cfg.body_template ?? cfg.body ?? '', vars),
            provider,
          },
          sessionId: ctx.session.id,
        })
        return advance(node)
      }

      // ── Send media (image / video / audio / document) ───────────────────────
      // Channel-aware via buildSendJob (uses session.channel). Either link
      // (public https) or id (pre-uploaded media id) must be set.
      case 'send_media': {
        const mediaType = (cfg.media_type ?? cfg.type ?? 'image') as 'image' | 'video' | 'audio' | 'document'
        const link      = cfg.link ? interpolate(cfg.link, vars) : undefined
        const id        = cfg.media_id ?? cfg.id
        if (!link && !id) {
          return { kind: 'error', error: 'send_media: cfg.link OR cfg.media_id required' }
        }
        await enqueueMessageSend(buildSendJob(ctx, {
          kind: 'media',
          media: {
            type:     mediaType,
            link,
            id,
            caption:  cfg.caption  ? interpolate(cfg.caption, vars)  : undefined,
            filename: cfg.filename ? interpolate(cfg.filename, vars) : undefined,
          },
        }))
        return advance(node)
      }

      // ── Payment — Razorpay payment link sent via current channel ───────────
      // Common SMB pattern: collect payment for an order via WhatsApp.
      // Creates a Razorpay payment link, then sends the URL through the
      // session's channel (WhatsApp/Telegram/Instagram).
      //
      // Required cfg:
      //   amount        — INR amount (rupees, gets ×100 for paise)
      //   description   — short order description
      // Optional cfg:
      //   currency      — default 'INR'
      //   customer      — { name, email, contact }
      //   message_template — message wrapping the link, default
      //                      "Pay {{amount}} {{currency}}: {{link}}"
      //   response_variable — store the payment_link object in session vars
      case 'payment': {
        const amountInr = Number(interpolate(String(cfg.amount ?? ''), vars))
        if (!Number.isFinite(amountInr) || amountInr <= 0) {
          return { kind: 'error', error: 'payment: cfg.amount (INR rupees) required' }
        }
        const description = interpolate(cfg.description ?? 'Order payment', vars)
        // Pull tenant Razorpay credentials. Reuses the connector pattern.
        const { data: row } = await supabase.from('tenant_integrations')
          .select('access_token, refresh_token, metadata')
          .eq('tenant_id', ctx.tenant.id).eq('key', 'razorpay').maybeSingle()
        if (!row?.access_token) {
          return { kind: 'advance', nextNodeId: pickDefault(node), output: { skipped: 'Razorpay not connected for this tenant' } }
        }
        try {
          const { decrypt } = await import('../crypto')
          const keyId  = decrypt(row.access_token)
          const secret = decrypt(row.refresh_token)
          const auth = 'Basic ' + Buffer.from(`${keyId}:${secret}`).toString('base64')
          const r = await fetch('https://api.razorpay.com/v1/payment_links', {
            method: 'POST',
            headers: { Authorization: auth, 'Content-Type': 'application/json' },
            body: JSON.stringify({
              amount:   Math.round(amountInr * 100),  // paise
              currency: cfg.currency ?? 'INR',
              description,
              customer: interpolateDeep(cfg.customer ?? {}, vars),
              notify:   { sms: false, email: false },  // we deliver the link ourselves
            }),
          })
          const body = await r.json() as any
          if (!r.ok || body.error) {
            return { kind: 'error', error: `payment: razorpay ${r.status}: ${body.error?.description ?? 'failed'}` }
          }
          const link = body.short_url ?? body.url
          // Send the link via the session's origin channel.
          const messageTemplate = cfg.message_template ?? `Pay ₹${amountInr} for ${description}: ${link}`
          const text = interpolate(messageTemplate, { ...vars, link, amount: String(amountInr), currency: cfg.currency ?? 'INR' })
          await enqueueMessageSend(buildSendJob(ctx, { kind: 'text', text }))
          const updates = cfg.response_variable
            ? { [cfg.response_variable]: { id: body.id, link, amount: amountInr, currency: cfg.currency ?? 'INR' } }
            : undefined
          return { kind: 'advance', nextNodeId: pickDefault(node), variableUpdates: updates, output: { payment_link_id: body.id } }
        } catch (err: any) {
          return { kind: 'error', error: `payment: ${err?.message ?? err}` }
        }
      }

      // ── Notify human — assign + pause bot + in-app/email notification ──────
      // Hands the conversation off to a human agent. Three side effects:
      //   1. Pause the bot for this contact (next inbound won't trigger workflow)
      //   2. Optionally assign the contact to a specific agent
      //   3. Fire a notification (in_app + email per recipient prefs) so the
      //      assigned agent / billing-eligible roles see the handoff in the bell
      //
      // Optional cfg:
      //   agent_id       — uuid; if set, contact.assigned_to = agent_id
      //   reason         — short string included in the notification body
      //   notify_event_key — defaults to 'inbox.assigned' if agent_id set,
      //                      else 'inbox.new_message'
      case 'notify_human': {
        const agentId = cfg.agent_id ?? null
        const reason  = interpolate(cfg.reason ?? 'Workflow requested human takeover', vars)
        const phone   = `+${ctx.session.contact_phone}`.replace(/^\+\++/, '+')

        // 1. Pause the bot so the next inbound doesn't re-trigger workflows.
        // 2. Optionally assign the agent.
        const update: any = { bot_paused: true, updated_at: new Date().toISOString() }
        if (agentId) update.assigned_to = agentId
        const { data: contact } = await supabase.from('contacts').update(update)
          .eq('tenant_id', ctx.tenant.id).eq('phone', phone).select('id, name').maybeSingle()

        // 3. Fire notification. If a specific agent was assigned, notify them;
        // otherwise notify all users with inbox.view permission.
        try {
          const { emitNotification } = await import('../routes/notifications')
          let recipients: string[] = []
          if (agentId) {
            recipients = [agentId]
          } else {
            const { data: roleRows } = await supabase.from('user_role_assignments')
              .select('user_id, role_definitions!inner(permissions)')
              .eq('tenant_id', ctx.tenant.id).is('disabled_at', null)
            for (const rr of (roleRows ?? []) as any[]) {
              const rd = Array.isArray(rr.role_definitions) ? rr.role_definitions[0] : rr.role_definitions
              if (rd?.permissions?.inbox?.view === true && rr.user_id) recipients.push(rr.user_id)
            }
          }
          if (recipients.length > 0) {
            await emitNotification(supabase, {
              tenant_id: ctx.tenant.id,
              event_key: agentId ? 'inbox.assigned' : 'inbox.new_message',
              recipient_user_ids: recipients,
              data: { contact_name: contact?.name ?? phone, reason },
              link: `/inbox?phone=${encodeURIComponent(phone)}`,
            })
          }
        } catch (e: any) {
          // Non-fatal — workflow continues even if notification dispatch fails.
          console.warn(`[executor:notify_human] notification failed: ${e?.message ?? e}`)
        }
        return { kind: 'advance', nextNodeId: pickDefault(node), output: { paused: true, assigned_to: agentId } }
      }

      // ── Followup — schedule a delayed message via wait_delay + send ───────
      // Convenience wrapper: "send X after Y minutes". Equivalent to a
      // wait_delay node followed by send_text, but cheaper to author from
      // the AI / FE blueprint.
      //
      // Required cfg:
      //   delay_minutes  (or delay_seconds)
      //   text           — message body (interpolated)
      // Optional cfg:
      //   media          — same shape as send_media (link/id/type/caption)
      case 'followup': {
        const minutes = Number(cfg.delay_minutes ?? 0)
        const seconds = Number(cfg.delay_seconds ?? 0)
        const delayMs = (minutes * 60 + seconds) * 1000
        const text    = cfg.text ? interpolate(cfg.text, vars) : null
        if (delayMs <= 0 || (!text && !cfg.media)) {
          return { kind: 'error', error: 'followup: cfg.delay_(minutes|seconds) and cfg.text or cfg.media required' }
        }
        // Synthesise an inline node that the wait_delay scheduler picks up
        // and resumes — but we need a real node id. Simpler: encode the
        // followup payload into a synthetic next node by abusing connections.
        // The cleanest path is to use the wait_delay machinery: schedule the
        // delay, then on resume the executor enqueues the send.
        // For this iteration we keep it simple: schedule a delayed
        // enqueueMessageSend by leveraging BullMQ's built-in delay.
        if (text) {
          const { messageQueue } = await import('../queue')
          await messageQueue.add('send', buildSendJob(ctx, { kind: 'text', text }), { delay: delayMs })
        }
        if (cfg.media) {
          const { messageQueue } = await import('../queue')
          const mediaInterp = interpolateDeep(cfg.media, vars)
          await messageQueue.add('send', buildSendJob(ctx, {
            kind: 'media',
            media: {
              type:     (mediaInterp.type ?? 'image') as any,
              link:     mediaInterp.link,
              id:       mediaInterp.id,
              caption:  mediaInterp.caption,
              filename: mediaInterp.filename,
            },
          }), { delay: delayMs })
        }
        return { kind: 'advance', nextNodeId: pickDefault(node), output: { scheduled_after_ms: delayMs } }
      }

      // ── Workflow chaining ───────────────────────────────────────────────────
      case 'start_workflow': {
        const targetId = cfg.workflow_id
        if (!targetId) return { kind: 'error', error: 'start_workflow: missing workflow_id' }
        const { data: target } = await supabase.from('workflows')
          .select('id, nodes').eq('id', targetId).eq('tenant_id', ctx.tenant.id).maybeSingle()
        if (!target) return { kind: 'error', error: `start_workflow: target ${targetId} not found` }
        const firstAction = (target.nodes as any[])?.find((n: any) => !n.type?.startsWith('trigger_'))
        if (!firstAction) return { kind: 'error', error: 'start_workflow: target has no actionable nodes' }

        const passVars = interpolateDeep(cfg.pass_variables ?? {}, vars)
        const { data: newSession } = await supabase.from('workflow_sessions').insert({
          tenant_id: ctx.tenant.id,
          workflow_id: target.id,
          contact_phone: ctx.session.contact_phone,
          current_node_id: firstAction.id,
          variables: { ...passVars, ...vars },
          status: 'active',
          parent_session_id: ctx.session.id,
        }).select().single()

        if (newSession) {
          await enqueueWorkflowExecution({ sessionId: newSession.id, nodeId: firstAction.id })
        }
        return advance(node)
      }

      // ── Connector calls — generic + semantic shortcuts ─────────────────────
      // Generic: cfg = { op: 'airtable.create_record', args: {...}, response_variable?: 'foo' }
      // Semantic: case 'airtable_create_record' is sugar for op='airtable.create_record'.
      // Both routes go through engine/connector-ops.ts so adding new ops doesn't
      // require new executor cases — one handler in the registry covers both
      // node-type entry points.
      case 'connector_call':
      case 'airtable_list_records':   case 'airtable_create_record':   case 'airtable_update_record':
      case 'shopify_list_orders':     case 'shopify_get_order':         case 'shopify_list_products':   case 'shopify_create_draft_order':
      case 'razorpay_list_payments':  case 'razorpay_get_payment':      case 'razorpay_refund_payment': case 'razorpay_list_subscriptions':
      case 'slack_send_message':
      case 'gmail_send_email': {
        // Resolve op: explicit cfg.op for generic 'connector_call', else
        // derive from the node type by replacing the FIRST underscore with
        // a dot (airtable_create_record → airtable.create_record).
        const op: string = node.type === 'connector_call'
          ? String(cfg.op ?? '')
          : (() => {
              const i = node.type.indexOf('_')
              return i > 0 ? `${node.type.slice(0, i)}.${node.type.slice(i + 1)}` : node.type
            })()
        if (!op || !op.includes('.')) {
          return { kind: 'error', error: `connector_call: invalid op '${op}' (expected 'connector.operation')` }
        }
        const args = interpolateDeep(cfg.args ?? cfg, vars)
        // Strip control fields out of args when the node uses cfg directly
        // (semantic shortcuts pass the whole cfg as args). The dispatcher
        // doesn't care about extras but it's cleaner.
        delete (args as any).op
        delete (args as any).response_variable
        try {
          const { dispatchConnectorOp } = await import('./connector-ops')
          const result = await dispatchConnectorOp(supabase, ctx.tenant.id, op, args)
          const updates = cfg.response_variable
            ? { [cfg.response_variable]: result.primary ?? result.output }
            : undefined
          return {
            kind: 'advance', nextNodeId: pickDefault(node),
            variableUpdates: updates,
            output: { op, ok: true },
          }
        } catch (err: any) {
          return { kind: 'error', error: `${op}: ${err?.message ?? err}` }
        }
      }

      // ── Terminal ────────────────────────────────────────────────────────────
      case 'end_flow':
        return { kind: 'end' }

      // ── Triggers (no-op when reached as actions) ────────────────────────────
      default:
        if (typeof node.type === 'string' && node.type.startsWith('trigger_')) {
          return advance(node)
        }
        return { kind: 'advance', nextNodeId: pickDefault(node), output: { warning: `unknown node type: ${node.type}` } }
    }
  } catch (err: any) {
    return { kind: 'error', error: err?.message ?? String(err) }
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────
function pickDefault(node: any): string | null {
  return node.connections?.default ?? node.connections?.next ?? null
}

function advance(node: any): NodeResult {
  return { kind: 'advance', nextNodeId: pickDefault(node) }
}

/**
 * Build a MessageSendJob for the executor's enqueueMessageSend calls.
 *
 * Channel routing:
 *   1. Explicit `partial.channel` wins (caller knows what they want).
 *   2. Else: use `ctx.session.channel` if set (set when the session was
 *      created from an inbound webhook — IG / Telegram triggers store the
 *      origin channel so reply messages land back in the same channel).
 *   3. Else: fall back to 'whatsapp' for back-compat with older sessions
 *      that predate the channel column on workflow_sessions.
 *
 * `to` for IG/Telegram is the platform-specific id (ig user id /
 * tg chat id), stored in contact_phone for consistency with the existing
 * single-column approach. The sender worker treats the field
 * channel-appropriately.
 */
function buildSendJob(ctx: ExecCtx, partial: Partial<MessageSendJob>): MessageSendJob {
  const channel: MessageSendJob['channel'] =
    partial.channel
    ?? (ctx.session as any).channel
    ?? 'whatsapp'
  return {
    tenantId: ctx.tenant.id,
    to: ctx.session.contact_phone,
    channel,
    sessionId: ctx.session.id,
    ...partial,
  } as MessageSendJob
}

function evalCondition(actual: any, operator: string, expected: any): boolean {
  switch (operator) {
    case 'equals':     return String(actual) === String(expected)
    case 'not_equals': return String(actual) !== String(expected)
    case 'contains':   return String(actual ?? '').toLowerCase().includes(String(expected ?? '').toLowerCase())
    case 'gt':         return Number(actual) >  Number(expected)
    case 'lt':         return Number(actual) <  Number(expected)
    case 'exists':     return actual != null && actual !== ''
    case 'empty':      return actual == null || actual === ''
    default:           return false
  }
}

/** Helper exported for the worker — find a node by id in a workflow.nodes[] */
export function findNode(workflow: any, nodeId: string | null | undefined): any | null {
  if (!nodeId) return null
  const nodes: any[] = workflow?.nodes ?? []
  return nodes.find((n: any) => n.id === nodeId) ?? null
}

export { supabase as engineSupabase }
