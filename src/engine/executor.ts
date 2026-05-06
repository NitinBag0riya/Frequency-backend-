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

      // ── AI Responder (Claude) ───────────────────────────────────────────────
      case 'run_ai_responder': {
        if (!anthropic) return { kind: 'advance', nextNodeId: pickDefault(node), output: { skipped: 'no ANTHROPIC_API_KEY' } }
        const systemPrompt = interpolate(cfg.system_prompt ?? 'You are a helpful WhatsApp assistant. Reply concisely.', vars)
        const userMsg = interpolate(cfg.user_message ?? ctx.reply?.text ?? '', vars)
        const resp = await anthropic.messages.create({
          model: cfg.model ?? 'claude-haiku-4-5',
          max_tokens: cfg.max_tokens ?? 400,
          system: systemPrompt,
          messages: [{ role: 'user', content: userMsg }],
        })
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

      // ── Email ───────────────────────────────────────────────────────────────
      case 'send_email':
      case 'forward_email': {
        await enqueueMessageSend({
          tenantId: ctx.tenant.id,
          to: interpolate(cfg.to_email, vars),
          channel: 'email',
          email: {
            to:       interpolate(cfg.to_email, vars),
            subject:  interpolate(cfg.subject ?? '(no subject)', vars),
            body:     interpolate(cfg.body_template ?? cfg.body ?? '', vars),
            provider: cfg.smtp_provider ?? 'smtp',
          },
          sessionId: ctx.session.id,
        })
        return advance(node)
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

function buildSendJob(ctx: ExecCtx, partial: Partial<MessageSendJob>): MessageSendJob {
  return {
    tenantId: ctx.tenant.id,
    to: ctx.session.contact_phone,
    channel: 'whatsapp',
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
