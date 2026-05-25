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
  enqueueWebhookOutbound,
  connection as redisConnection,
} from '../queue'
import { interpolate, interpolateDeep } from './interpolator'
import {
  sheetsAppendRow, sheetsUpdateRange,
  calendarCreateEvent, calendarCheckAvailability,
} from '../google'
import {
  simulatedConnectorOutput, simulatedNodeOutput, wouldHaveDoneFor,
} from './simulate'

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
  /**
   * Simulation mode flag.
   *
   * When true, every side-effecting branch in this dispatcher short-circuits
   * BEFORE the actual HTTP / DB / queue / payment / AI call is made and
   * instead returns a synthetic output derived from the connector registry's
   * outputSchema.fields[*].sample values (see engine/simulate.ts).
   *
   * Logic that is purely CONTROL FLOW — variable mutations, conditions,
   * wait_delay sleep amounts, follow-the-default-edge — still runs normally
   * so the simulation reflects the workflow's actual routing on the user's
   * trigger input.
   *
   * For nodes that have no clean dry-run fallback (start_workflow chain
   * dispatch, wait_input halts), simulation behaves deterministically:
   * start_workflow advances without spawning a child session, wait_input
   * is treated as 'end' so the trace doesn't hang forever waiting for an
   * inbound that will never come.
   */
  simulate?: boolean
  /**
   * When simulating, the runner injects this callback so each side-effect
   * branch can append a "would have done X" line to the trace alongside the
   * synthetic output. The runner stores these lines on the simulation_run
   * step entry. No-op when simulate=false.
   */
  recordWouldHaveDone?: (line: string) => void
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

/**
 * Helper: are we in simulate mode? Centralised so future per-node opt-outs
 * (e.g. "always run this validator even in simulate") have one knob to flip.
 */
function isSim(ctx: ExecCtx): boolean {
  return ctx.simulate === true
}

/**
 * Record a "would have done" line + return a synthetic NodeResult for the
 * common "advance with sample output" pattern. Used by every side-effecting
 * case when ctx.simulate is true.
 */
function simAdvance(
  ctx: ExecCtx,
  node: any,
  args: Record<string, any>,
  opts?: { variableUpdates?: Record<string, any>; output?: Record<string, any> },
): NodeResult {
  const line = wouldHaveDoneFor(node.type, args)
  ctx.recordWouldHaveDone?.(line)
  const output = opts?.output ?? simulatedNodeOutput(node.type)
  return {
    kind: 'advance',
    nextNodeId: pickDefault(node),
    output,
    variableUpdates: opts?.variableUpdates,
  }
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
        if (isSim(ctx)) {
          // Pass `to` so the trace line shows the resolved recipient.
          return simAdvance(ctx, node, { text, to: ctx.session.contact_phone })
        }
        await enqueueMessageSend(buildSendJob(ctx, { kind: 'text', text }))
        return advance(node)
      }

      case 'send_template': {
        // Interpolate every author-visible field. Previously
        // `cfg.template_name` and `cfg.language` were used raw, so a
        // workflow like `send_template name="welcome_{{plan}}"` would
        // ship the literal `welcome_{{plan}}` to Meta and Meta would
        // 404 — workflow author couldn't dynamically pick a template
        // per session. Parameters are interpolated against the same
        // vars bag so `{{contact.name}}` etc resolve consistently.
        const templateName = interpolate(cfg.template_name, vars)
        const language     = interpolate(cfg.language ?? 'en_US', vars) || 'en_US'
        const params: string[] = (cfg.parameters ?? []).map((p: string) => interpolate(p, vars))
        if (isSim(ctx)) {
          return simAdvance(ctx, node, {
            template_name: templateName,
            parameters: params,
            language,
            to: ctx.session.contact_phone,
          })
        }
        await enqueueMessageSend(buildSendJob(ctx, {
          kind: 'template',
          template: {
            name: templateName,
            language,
            parameters: params,
          },
        }))
        return advance(node)
      }

      case 'send_interactive': {
        if (isSim(ctx)) {
          return simAdvance(ctx, node, { to: ctx.session.contact_phone, ...interpolateDeep(cfg, vars) })
        }
        await enqueueMessageSend(buildSendJob(ctx, {
          kind: 'interactive',
          interactive: interpolateDeep(cfg, vars),
        }))
        return advance(node)
      }

      // ── Input (halt, wait for inbound) ──────────────────────────────────────
      case 'collect_input': {
        if (isSim(ctx)) {
          // Simulation can't actually wait for human input. Surface the
          // prompt in the trace and treat the wait as a terminal step so
          // the run ends cleanly instead of hanging.
          const promptText = cfg.prompt ? interpolate(cfg.prompt, vars) : '(no prompt configured)'
          ctx.recordWouldHaveDone?.(`would have sent prompt "${promptText.slice(0, 80)}" and waited for inbound reply (simulation ends here — no real user input)`)
          return { kind: 'end', output: { simulated: true, halted_at: 'collect_input', prompt: promptText } }
        }
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
        if (isSim(ctx)) {
          // Don't actually sleep in simulation — that would block the runner
          // for hours on a real "wait 24h" node. Note the planned delay in
          // the trace and skip straight to the next node.
          ctx.recordWouldHaveDone?.(`would have waited ${minutes}m ${seconds}s (skipped in simulation)`)
          return { kind: 'advance', nextNodeId: next, output: { simulated: true, would_have_waited_ms: delayMs } }
        }
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
        if (isSim(ctx)) {
          return simAdvance(ctx, node, { tag })
        }
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
        if (isSim(ctx)) {
          return simAdvance(ctx, node, { agent_user_id: agentId, agent: agentId })
        }
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
      // Two modes:
      //   - Default (response_variable set OR fire_and_forget=false):
      //       sync fetch + capture response into workflow variable. We can't
      //       move this to the queue without breaking workflow flow.
      //   - Fire-and-forget (cfg.fire_and_forget === true and no
      //       response_variable): route through webhook.outbound queue so
      //       a flaky external endpoint can't stall workflow execution and
      //       failures land in webhook_dead_letter for super-admin replay.
      //       This covers the "POST to a tenant-configured Zapier URL"
      //       pattern that previously had zero retry visibility.
      case 'http_request': {
        const url = interpolate(cfg.url, vars)
        const method = (cfg.method ?? 'GET').toUpperCase() as 'GET'|'POST'|'PUT'|'PATCH'|'DELETE'
        const headers = interpolateDeep(cfg.headers ?? {}, vars)
        const bodyTemplate = cfg.body
        const body = bodyTemplate
          ? (typeof bodyTemplate === 'string' ? interpolate(bodyTemplate, vars) : JSON.stringify(interpolateDeep(bodyTemplate, vars)))
          : undefined
        if (!url) return { kind: 'error', error: 'http_request: missing url' }

        if (isSim(ctx)) {
          // No network — return a synthetic 200 + the interpolated request shape.
          // If the workflow stores the response into a variable, seed it with
          // `{ simulated: true }` so downstream variable-condition nodes can
          // branch deterministically (they just need _something_ truthy).
          const synthBody = { simulated: true, status: 200, url, method }
          const updates: Record<string, any> = {}
          if (cfg.response_variable) updates[cfg.response_variable] = synthBody
          updates[`${node.id}_status`] = 200
          return simAdvance(ctx, node, { url, method, headers, body }, {
            variableUpdates: updates,
            output: { simulated: true, status: 200, method, url },
          })
        }

        const fireAndForget = cfg.fire_and_forget === true && !cfg.response_variable
        if (fireAndForget) {
          try {
            await enqueueWebhookOutbound({
              tenantId: ctx.tenant.id,
              source:   cfg.webhook_source ?? 'workflow_http',
              url, method, headers, body,
              timeoutMs: cfg.timeout_ms ?? 10_000,
              idempotencyKey: `wf:${ctx.session.id}:${node.id}`,
            })
          } catch (e: any) {
            console.warn(`[executor] webhook.outbound enqueue failed, running inline: ${e?.message ?? e}`)
            // fall through to sync below — better to block one node than to lose the send
          }
          if (cfg.fire_and_forget === true) {
            return { kind: 'advance', nextNodeId: pickDefault(node), output: { queued: true } }
          }
        }

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
        if (isSim(ctx)) {
          return simAdvance(ctx, node, { updates, target: cfg.target, table_id: cfg.table_id })
        }
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
        const interpolated = (values as string[]).map((v: string) => interpolate(v, vars))
        if (isSim(ctx)) {
          return simAdvance(ctx, node, { spreadsheet_id, range, mode, values: interpolated })
        }
        if (!spreadsheet_id || !range || !ctx.tenant.google_access_token) {
          return { kind: 'advance', nextNodeId: pickDefault(node), output: { skipped: 'missing google config' } }
        }
        if (mode === 'update') await sheetsUpdateRange(ctx.tenant, spreadsheet_id, range, [interpolated])
        else                   await sheetsAppendRow(ctx.tenant, spreadsheet_id, range, interpolated)
        return advance(node)
      }

      // ── Google Calendar ─────────────────────────────────────────────────────
      case 'create_calendar_event': {
        if (isSim(ctx)) {
          return simAdvance(ctx, node, {
            summary:    cfg.summary ? interpolate(cfg.summary, vars) : '(none)',
            start_time: cfg.start_time ? interpolate(cfg.start_time, vars) : '(none)',
            end_time:   cfg.end_time   ? interpolate(cfg.end_time,   vars) : '(none)',
          })
        }
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
        if (isSim(ctx)) {
          // Always report "yes" in simulation — that's the deterministic
          // fallback specified in the simulate-mode contract. Downstream
          // condition nodes branching on this will exercise the happy path.
          const startTimeStr = cfg.start_time ? interpolate(cfg.start_time, vars) : '(none)'
          const endTimeStr   = cfg.end_time   ? interpolate(cfg.end_time,   vars) : '(none)'
          ctx.recordWouldHaveDone?.(`would have checked calendar availability ${startTimeStr} → ${endTimeStr} (simulating "yes")`)
          const updates = cfg.variable_name ? { [cfg.variable_name]: 'yes' } : undefined
          return { kind: 'advance', nextNodeId: pickDefault(node), variableUpdates: updates, output: { simulated: true, available: true } }
        }
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

      // ── AI Responder (Frequency AI, powered by Anthropic + per-tenant RAG) ──
      //
      // Behaviour (post-migration-066):
      //   1. Resolve tenant_ai_settings. If enabled=false → skip with
      //      reason='ai_not_enabled'. If qa_wizard_completed_at is null →
      //      skip with reason='qa_wizard_pending'. Workflow branches on
      //      `output.ok` / `output.reason` via downstream condition_variable.
      //   2. Retrieve top-5 chunks from this tenant's tenant_knowledge_chunks
      //      using full-text similarity, ALWAYS filtered by tenant_id first.
      //      Cross-tenant retrieval is impossible — lib/ai-knowledge.ts is the
      //      enforcement layer.
      //   3. Call Anthropic with a system prompt that combines tenant business
      //      context + retrieved chunks + tenant-customisable addon.
      //   4. Cost guardrails: ai_tokens_per_month + ai_dollars_per_month +
      //      the ai_requests_per_day quota from migration 063. Refuses and
      //      optionally escalates to human when exhausted.
      //   5. Save the (question, answer) pair back into the corpus as
      //      source_type='conversation' so the responder learns from real
      //      chats over time.
      //
      // Config knobs (all optional — sensible defaults from settings):
      //   inbound_message_var — defaults to ctx.reply.text
      //   response_variable   — workflow variable to receive reply
      //   send_reply          — whether to enqueue an outbound message
      //                         (default true; FE can set false if the
      //                         workflow wants to inspect the reply first)
      case 'run_ai_responder': {
        const systemPromptPreview = interpolate(cfg.system_prompt ?? '', vars)
        if (isSim(ctx)) {
          // Synthetic AI response — deterministic placeholder so downstream
          // condition_variable nodes branching on the AI output have something
          // to evaluate. Don't burn a real Anthropic call (and Anthropic budget)
          // on a dry-run.
          const synthText = '[simulated AI response — exact content depends on user input + tenant knowledge at runtime]'
          const updates = cfg.response_variable ? { [cfg.response_variable]: synthText } : undefined
          return simAdvance(ctx, node, {
            system_prompt: systemPromptPreview,
            user_message: interpolate(cfg.user_message ?? '', vars),
            model: cfg.model ?? 'claude-opus-4-7',
          }, {
            variableUpdates: updates,
            output: { simulated: true, length: synthText.length, model: cfg.model ?? 'claude-opus-4-7' },
          })
        }

        // `output.skipped` lands in the workflow session inspection UI — keep
        // it brand-neutral. The engineer-facing detail is in the boot log.
        if (!anthropic) return { kind: 'advance', nextNodeId: pickDefault(node), output: { ok: false, reason: 'ai_not_configured', skipped: 'Frequency AI not available' } }

        // ── 1. Opt-in gate (per tenant) ─────────────────────────────────────
        // Settings come from tenant_ai_settings; defaults to disabled + no
        // wizard. The workflow branches on output.ok/output.reason — a
        // condition_variable on `{{<node>_status}}` can route "not enabled"
        // traffic to notify_human or a templated fallback.
        const { getTenantAiSettings, retrieveChunks, insertChunks, looksUncertain } = await import('../lib/ai-knowledge')
        const settings = await getTenantAiSettings(supabase, ctx.tenant.id)
        if (!settings.enabled) {
          return {
            kind: 'advance', nextNodeId: pickDefault(node),
            output: { ok: false, reason: 'ai_not_enabled', escalated_to_human: false },
          }
        }
        if (!settings.qa_wizard_completed_at) {
          return {
            kind: 'advance', nextNodeId: pickDefault(node),
            output: { ok: false, reason: 'qa_wizard_pending', escalated_to_human: false },
          }
        }

        // ── 2. Plan-limit gates ─────────────────────────────────────────────
        // ai_tokens_per_month + ai_dollars_per_month protect against runaway
        // spend. ai_requests_per_day (migration 063) protects against burst
        // abuse. On exhaustion, optionally escalate via notify_human-style
        // contact mutation so a real human can see the inbox.
        const { checkLimit } = await import('../lib/limits')
        const tokenCheck   = await checkLimit(supabase, ctx.tenant.id, 'ai_tokens_per_month')
        if (!tokenCheck.allowed) {
          await maybeEscalateToHuman(ctx, settings.escalate_to_human_on_uncertainty, 'AI token cap reached')
          return { kind: 'advance', nextNodeId: pickDefault(node),
            output: { ok: false, reason: 'token_cap_reached', escalated_to_human: settings.escalate_to_human_on_uncertainty, skipped: `AI token cap reached (${tokenCheck.current}/${tokenCheck.max}). ${tokenCheck.upgrade_to ? `Upgrade to ${tokenCheck.upgrade_to}.` : ''}` } }
        }
        const dollarCheck = await checkLimit(supabase, ctx.tenant.id, 'ai_dollars_per_month')
        if (!dollarCheck.allowed) {
          await maybeEscalateToHuman(ctx, settings.escalate_to_human_on_uncertainty, 'AI spend cap reached')
          return { kind: 'advance', nextNodeId: pickDefault(node),
            output: { ok: false, reason: 'dollar_cap_reached', escalated_to_human: settings.escalate_to_human_on_uncertainty, skipped: `AI spend cap reached ($${dollarCheck.current}/$${dollarCheck.max} this month). ${dollarCheck.upgrade_to ? `Upgrade to ${dollarCheck.upgrade_to}.` : ''}` } }
        }
        // ai_requests_per_day — Redis token bucket from migration 063.
        // checkAndConsumeQuota is the right primitive but we lean on the
        // monthly checks above for the common case; if the daily bucket is
        // exhausted we surface it explicitly.
        try {
          const { checkAndConsumeQuota } = await import('../lib/quota')
          const dailyOk = await checkAndConsumeQuota(
            supabase, redisConnection, ctx.tenant.id, 'ai_requests_per_day', 1,
          )
          if (!dailyOk.allowed) {
            await maybeEscalateToHuman(ctx, settings.escalate_to_human_on_uncertainty, 'Daily AI request cap reached')
            return { kind: 'advance', nextNodeId: pickDefault(node),
              output: { ok: false, reason: 'daily_request_cap_reached', escalated_to_human: settings.escalate_to_human_on_uncertainty, skipped: `Daily AI request cap reached (${dailyOk.current_usage}/${dailyOk.cap}). Resets at ${dailyOk.resets_at}.` } }
          }
        } catch (e: any) {
          // Failing open here is acceptable since the monthly $ cap is the
          // real firewall — daily is a smoothing layer. Redis hiccup
          // shouldn't block the auto-reply.
          console.warn(`[run_ai_responder] ai_requests_per_day check failed (fail-open): ${e?.message ?? e}`)
        }

        // ── 3. RAG retrieval ────────────────────────────────────────────────
        // Resolve the inbound message. Workflow cfg can override the source
        // via `inbound_message_var` / `user_message` interpolation; default
        // is the reply that triggered this resume.
        const inboundText = interpolate(
          cfg.user_message ?? cfg.inbound_message_var ?? '{{trigger.message.text}}',
          { ...vars, trigger: { message: { text: ctx.reply?.text ?? '' }, channel: (ctx.session as any).channel, contact: ctx.session.contact_phone } },
        ) || ctx.reply?.text || ''

        const retrieved = inboundText
          ? await retrieveChunks(supabase, ctx.tenant.id, inboundText, 5)
          : []

        // ── 4. Build prompt + call Anthropic ────────────────────────────────
        const { buildSystemPrompt } = await import('../routes/ai-responder')
        const bizName = (settings.business_context as any)?.business_name || ctx.tenant.business_name || 'our business'
        // Allow cfg.system_prompt to OVERRIDE the per-tenant addon for this
        // specific node (e.g. a workflow that wants a different tone for
        // VIP customers). Falls back to settings.system_prompt_addon.
        const promptAddon = cfg.system_prompt
          ? interpolate(cfg.system_prompt, vars)
          : settings.system_prompt_addon
        const systemPrompt = buildSystemPrompt(bizName, promptAddon, retrieved)
        const model = cfg.model ?? settings.model ?? 'claude-opus-4-7'

        const resp = await anthropic.messages.create({
          model,
          max_tokens:  cfg.max_tokens  ?? settings.max_tokens  ?? 500,
          temperature: cfg.temperature ?? settings.temperature ?? 0.7,
          system: [
            { type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } },
          ] as any,
          messages: [{ role: 'user', content: inboundText }],
        })
        void import('../lib/ai-usage').then(({ recordAiUsage }) =>
          recordAiUsage(supabase, ctx.tenant.id, resp.usage as any, 'ai_responder', model))

        const text = resp.content
          .filter((b: any) => b.type === 'text')
          .map((b: any) => b.text)
          .join('\n')
          .trim()

        const uncertain = looksUncertain(text)
        const shouldEscalate = uncertain && settings.escalate_to_human_on_uncertainty

        if (shouldEscalate) {
          await maybeEscalateToHuman(ctx, true, 'AI uncertain about the answer')
          // Don't send the low-confidence reply when escalating.
          const updates = cfg.response_variable ? { [cfg.response_variable]: text } : undefined
          return {
            kind: 'advance', nextNodeId: pickDefault(node),
            variableUpdates: updates,
            output: { ok: true, reply_text: text, confidence_score: 0.3, escalated_to_human: true, tokens_used: ((resp.usage as any)?.input_tokens ?? 0) + ((resp.usage as any)?.output_tokens ?? 0) },
          }
        }

        // Send the reply (unless the workflow explicitly opted out).
        const sendReply = cfg.send_reply !== false
        if (text && sendReply) {
          await enqueueMessageSend(buildSendJob(ctx, { kind: 'text', text }))
        }

        // ── 5. Learn from the conversation ──────────────────────────────────
        // Save the (question, answer) pair back into the corpus so future
        // similar inbounds retrieve this exchange. Fire-and-forget — workflow
        // continues even if the chunk insert fails. source_ref tied to the
        // session id so we can dedupe and trace back to the original chat.
        if (inboundText && text) {
          void insertChunks(supabase, ctx.tenant.id, [{
            source_type: 'conversation',
            source_ref:  `session:${ctx.session.id}:${node.id}`,
            chunk_text:  `Customer asked: ${inboundText}\nWe answered: ${text}`,
            metadata:    { session_id: ctx.session.id, node_id: node.id, model, ts: new Date().toISOString() },
          }]).catch(e => console.warn(`[run_ai_responder] learn-from-convo insert failed: ${e?.message ?? e}`))
        }

        const updates = cfg.response_variable ? { [cfg.response_variable]: text } : undefined
        return {
          kind: 'advance', nextNodeId: pickDefault(node),
          variableUpdates: updates,
          output: {
            ok: true,
            reply_text: text,
            confidence_score: uncertain ? 0.4 : 0.9,
            escalated_to_human: false,
            tokens_used: ((resp.usage as any)?.input_tokens ?? 0) + ((resp.usage as any)?.output_tokens ?? 0),
            chunks_used: retrieved.length,
          },
        }
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

        // Accept the registry's modern field names (to, body_text, body_html,
        // cc, bcc, reply_to) AND the legacy ones (to_email, body, body_template).
        // FE forms have been migrating to the modern shape; legacy persists in
        // saved workflows.
        const toAddr   = interpolate(String(cfg.to ?? cfg.to_email ?? ''), vars)
        const subject  = interpolate(String(cfg.subject ?? '(no subject)'), vars)
        const bodyText = cfg.body_text ?? cfg.body ?? cfg.body_template
        const bodyHtml = cfg.body_html
        const interpolatedBodyText = bodyText ? interpolate(String(bodyText), vars) : undefined
        const interpolatedBodyHtml = bodyHtml ? interpolate(String(bodyHtml), vars) : undefined
        const cc       = cfg.cc       ? interpolate(String(cfg.cc),       vars) : undefined
        const bcc      = cfg.bcc      ? interpolate(String(cfg.bcc),      vars) : undefined
        const replyTo  = cfg.reply_to ? interpolate(String(cfg.reply_to), vars) : undefined

        if (!toAddr) return { kind: 'error', error: `${node.type}: cfg.to (or cfg.to_email) is required` }

        if (isSim(ctx)) {
          // Skip provider resolution entirely. The Gmail vs Resend split is
          // pure side-effect; the simulation cares about "would email go to X
          // with subject Y" and any downstream variable updates.
          const updates = cfg.response_variable
            ? { [cfg.response_variable]: { simulated: true, message_id: 'sim_msg_…', thread_id: 'sim_thread_…' } }
            : undefined
          return simAdvance(ctx, node, {
            to: toAddr, subject, body_text: interpolatedBodyText, body_html: interpolatedBodyHtml, provider,
          }, {
            variableUpdates: updates,
            output: { simulated: true, ok: true, message_id: 'sim_msg_…', thread_id: 'sim_thread_…', from: '(simulated)' },
          })
        }

        // Resolve "should we Gmail directly?" — true when provider is 'gmail'
        // OR provider is 'auto' AND the tenant has google_access_token. Direct
        // Gmail send is preferred over the queue path for two reasons:
        //   1) returns message_id / thread_id synchronously so the next
        //      workflow node can branch on the result (e.g. log to Sheet)
        //   2) preserves the tenant's "from = my own gmail" guarantee even
        //      when the message-sender worker is backed up
        const wantsGmail =
          provider === 'gmail'
          || (provider === 'auto' && !!ctx.tenant.google_access_token)

        if (wantsGmail) {
          // Hard failure when explicitly requested provider=gmail but Google
          // isn't connected — gracefully advance with output.ok=false so
          // downstream condition_variable nodes can branch on the failure
          // (per spec: "downstream branch nodes can handle gracefully").
          if (!ctx.tenant.google_access_token) {
            return {
              kind: 'advance',
              nextNodeId: pickDefault(node),
              output: { ok: false, error: 'Gmail not connected' },
            }
          }
          try {
            const { gmailSendEmailRich } = await import('../google')
            // gmailSendEmailRich needs at least one of body_text / body_html.
            // If the user only supplied legacy `body`, treat it as text.
            const result = await gmailSendEmailRich(ctx.tenant, {
              to:        toAddr,
              subject,
              body_text: interpolatedBodyText,
              body_html: interpolatedBodyHtml,
              cc, bcc, reply_to: replyTo,
            })
            const updates = cfg.response_variable
              ? { [cfg.response_variable]: { message_id: result.id, thread_id: result.threadId } }
              : undefined
            return {
              kind: 'advance', nextNodeId: pickDefault(node),
              variableUpdates: updates,
              output: {
                ok:         true,
                message_id: result.id,
                thread_id:  result.threadId,
                from:       result.from,
              },
            }
          } catch (err: any) {
            // Surface the error to the workflow execution row but DON'T halt —
            // email failure is rarely a workflow-stopper. The FE inspector
            // shows the failure; downstream branches can check ok=false.
            return {
              kind: 'advance', nextNodeId: pickDefault(node),
              output: { ok: false, error: err?.message ?? String(err) },
            }
          }
        }

        // Fallback: queue-based path (Resend or smtp). Fire-and-forget — the
        // message-sender worker handles delivery + retries.
        await enqueueMessageSend({
          tenantId: ctx.tenant.id,
          to: toAddr,
          channel: 'email',
          email: {
            to:       toAddr,
            subject,
            body:     interpolatedBodyHtml ?? interpolatedBodyText ?? '',
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
        if (isSim(ctx)) {
          return simAdvance(ctx, node, {
            media_type: mediaType, link, media_id: id,
            caption: cfg.caption ? interpolate(cfg.caption, vars) : undefined,
            to: ctx.session.contact_phone,
          })
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
        if (isSim(ctx)) {
          // Synthetic Razorpay payment link — never hits Razorpay's API, never
          // sends a follow-up message. Trace shows the planned amount + desc.
          const link = 'https://rzp.io/i/SIMULATED'
          const updates = cfg.response_variable
            ? { [cfg.response_variable]: { id: 'plink_simulated', link, amount: amountInr, currency: cfg.currency ?? 'INR' } }
            : undefined
          return simAdvance(ctx, node, {
            amount: amountInr, description, currency: cfg.currency ?? 'INR', to: ctx.session.contact_phone,
          }, {
            variableUpdates: updates,
            output: { simulated: true, payment_link_id: 'plink_simulated', short_url: link, amount: amountInr, status: 'created' },
          })
        }
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
        if (isSim(ctx)) {
          return simAdvance(ctx, node, { agent_id: agentId, reason }, {
            output: { simulated: true, paused: true, assigned_to: agentId },
          })
        }
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
        if (isSim(ctx)) {
          return simAdvance(ctx, node, {
            delay_minutes: minutes, delay_seconds: seconds, text,
            to: ctx.session.contact_phone,
          }, {
            output: { simulated: true, scheduled_after_ms: delayMs },
          })
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
        if (isSim(ctx)) {
          // Simulation does NOT recurse into a child workflow — that would
          // explode the trace and require its own simulation_run row. Note
          // the would-have-spawned + advance past this node so the parent's
          // remaining nodes still simulate.
          return simAdvance(ctx, node, { workflow_id: targetId, pass_variables: cfg.pass_variables }, {
            output: { simulated: true, would_have_started_workflow: targetId, note: 'child workflow not simulated' },
          })
        }
        const { data: target } = await supabase.from('workflows')
          .select('id, nodes').eq('id', targetId).eq('tenant_id', ctx.tenant.id).maybeSingle()
        if (!target) return { kind: 'error', error: `start_workflow: target ${targetId} not found` }
        const firstAction = (target.nodes as any[])?.find((n: any) => !n.type?.startsWith('trigger_'))
        if (!firstAction) return { kind: 'error', error: 'start_workflow: target has no actionable nodes' }

        // Child workflow seeds against the SAME contact_phone but must
        // re-seed `contact` (parent might have stale contact data if the
        // row was updated mid-execution) and re-seed `trigger` so chained
        // workflows don't inherit the parent's first inbound. Merge any
        // pass_variables on top so explicit author-configured values win.
        const passVars = interpolateDeep(cfg.pass_variables ?? {}, vars)
        const { seedSessionVars } = await import('./seed-vars')
        const childSeed = await seedSessionVars(
          supabase,
          ctx.tenant.id,
          ctx.session.contact_phone,
          vars.trigger,        // forward parent's trigger payload
          { ...vars, ...passVars },
        )
        const { data: newSession } = await supabase.from('workflow_sessions').insert({
          tenant_id: ctx.tenant.id,
          workflow_id: target.id,
          contact_phone: ctx.session.contact_phone,
          current_node_id: firstAction.id,
          variables: childSeed,
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
      case 'razorpay_create_payment_link':
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

        // razorpay_create_payment_link lineage: attach { run_id, node_id }
        // into Razorpay's `notes` jsonb so the dashboard shows which
        // workflow execution generated each link. Caller-provided notes
        // win — we only fill the keys we own. Notes values MUST be strings
        // per Razorpay's schema, so coerce.
        if (op === 'razorpay.create_payment_link') {
          const existing = ((args as any).notes ?? {}) as Record<string, string>
          ;(args as any).notes = {
            ...existing,
            run_id:  existing.run_id  ?? String(ctx.session.id ?? ''),
            node_id: existing.node_id ?? String(node.id ?? ''),
          }
        }

        if (isSim(ctx)) {
          // Look up the op's registry entry, build a synthetic output from
          // its outputSchema.fields[*].sample values, and advance. No
          // connector creds resolved, no fetch, no DB.
          const synthOutput = simulatedConnectorOutput(op)
          const updates = cfg.response_variable
            ? { [cfg.response_variable]: synthOutput }
            : undefined
          ctx.recordWouldHaveDone?.(`would have called connector op "${op}" with args ${JSON.stringify(args).slice(0, 120)}`)
          return {
            kind: 'advance',
            nextNodeId: pickDefault(node),
            variableUpdates: updates,
            output: { simulated: true, op, ok: true, ...synthOutput },
          }
        }
        try {
          const { dispatchConnectorOp } = await import('./connector-ops')
          const result = await dispatchConnectorOp(supabase, ctx.tenant.id, op, args)
          const updates = cfg.response_variable
            ? { [cfg.response_variable]: result.primary ?? result.output }
            : undefined
          // For ops where the small flat output is itself the value the
          // FE inspector / next node wants to see, surface it directly in
          // node output (e.g. razorpay_create_payment_link returns
          // { payment_link_id, short_url, amount, status }). Other ops
          // return potentially huge bodies (full Airtable record lists,
          // Shopify orders) — keep `output` lean for those and let
          // response_variable carry the body when the workflow needs it.
          const inlineOutput = op === 'razorpay.create_payment_link'
            && result.output && typeof result.output === 'object'
            ? result.output
            : null
          return {
            kind: 'advance', nextNodeId: pickDefault(node),
            variableUpdates: updates,
            output: inlineOutput ? { op, ok: true, ...inlineOutput } : { op, ok: true },
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

/**
 * Mirror of the notify_human node's side effects, callable from inside the
 * AI Responder branch when the LLM is uncertain or a cost cap is hit.
 *
 * Two side effects:
 *   1. Pause the bot for this contact so the next inbound doesn't
 *      re-trigger the same workflow + AI call.
 *   2. Best-effort notification to users with inbox.view permission so
 *      a human sees the conversation needs attention.
 *
 * Never throws — caller must continue the workflow even if this fails.
 * Guarded by the `shouldEscalate` boolean so the caller doesn't have to
 * re-check the per-tenant flag.
 */
async function maybeEscalateToHuman(
  ctx: ExecCtx,
  shouldEscalate: boolean,
  reason: string,
): Promise<void> {
  if (!shouldEscalate) return
  try {
    const phone = `+${ctx.session.contact_phone}`.replace(/^\+\++/, '+')
    const { data: contact } = await supabase.from('contacts')
      .update({ bot_paused: true, updated_at: new Date().toISOString() })
      .eq('tenant_id', ctx.tenant.id).eq('phone', phone)
      .select('id, name').maybeSingle()

    const { emitNotification } = await import('../routes/notifications')
    const { data: roleRows } = await supabase.from('user_role_assignments')
      .select('user_id, role_definitions!inner(permissions)')
      .eq('tenant_id', ctx.tenant.id).is('disabled_at', null)
    const recipients: string[] = []
    for (const rr of (roleRows ?? []) as any[]) {
      const rd = Array.isArray(rr.role_definitions) ? rr.role_definitions[0] : rr.role_definitions
      if (rd?.permissions?.inbox?.view === true && rr.user_id) recipients.push(rr.user_id)
    }
    if (recipients.length > 0) {
      await emitNotification(supabase, {
        tenant_id: ctx.tenant.id,
        event_key: 'inbox.new_message',
        recipient_user_ids: recipients,
        data: { contact_name: contact?.name ?? phone, reason: `AI Responder escalated: ${reason}` },
        link: `/inbox?phone=${encodeURIComponent(phone)}`,
      })
    }
  } catch (e: any) {
    console.warn(`[run_ai_responder] escalate-to-human failed (non-fatal): ${e?.message ?? e}`)
  }
}

export { supabase as engineSupabase }
