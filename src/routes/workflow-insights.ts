/**
 * Workflow insights — AI-generated optimization analysis for a single workflow.
 *
 *   GET  /api/workflows/:id/insights
 *
 *   Returns the cached row from `workflow_insights` (one per workflow). Cheap
 *   call — the FE shows the panel based on this without burning tokens.
 *
 *   POST /api/workflows/:id/analyze
 *
 *   Aggregates the workflow's last 30d execution stats from workflow_sessions
 *   + messages + workflow_executions, runs a few heuristic checks, then either:
 *     • returns { status: 'insufficient_data', needed, current, retry_after }
 *       if there aren't enough sessions or messages to draw conclusions, OR
 *     • feeds the stats to Claude with a structured-output prompt and persists
 *       up to 5 ranked insights ({ type, severity, title, body, evidence,
 *       suggestion }) in `workflow_insights`.
 *
 * Cache: one row per workflow_id (upsert on each analyze call). FE may want
 * to debounce — a 24h client-side TTL is fine; users hitting "Refresh
 * insights" should always re-run.
 *
 * Insight types (so the FE can icon/colour them consistently):
 *   - 'send_time'        — outbound timing tweaks
 *   - 'drop_off'         — session abandonment at a specific node
 *   - 'reply_rate'       — low/high response-rate observations
 *   - 'delivery_health'  — delivery / read / failure patterns
 *   - 'keyword_coverage' — missed inbound keyword triggers
 *   - 'channel_mix'      — per-channel performance
 *   - 'general'          — anything else
 *
 * Why a real AI call and not pure heuristics: the user wanted contextual
 * recommendations ("send at 8-9PM because…"), not boilerplate. Heuristics
 * compute the SIGNAL; the model writes the human-readable narrative + the
 * specific suggested change.
 */

import express from 'express'
import { SupabaseClient } from '@supabase/supabase-js'
import Anthropic from '@anthropic-ai/sdk'

type Middleware = (req: express.Request, res: express.Response, next: express.NextFunction) => void | Promise<void>

interface Deps {
  supabase: SupabaseClient
  requireAuth: Middleware
  identifyTenant: Middleware
}

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY ?? '' })

// Minimum data to draw real conclusions. These thresholds are deliberately
// modest so insights kick in soon after launch — but high enough that the
// model isn't hallucinating from a single session. Tune as we get feedback.
const MIN_SESSIONS_FOR_ANALYSIS  = 10
const MIN_OUTBOUND_FOR_ANALYSIS  = 25
const ANALYSIS_WINDOW_DAYS       = 30

export function createWorkflowInsightsRouter(deps: Deps): express.Router {
  const { supabase, requireAuth, identifyTenant } = deps
  const r = express.Router()

  // ── GET cached insights ─────────────────────────────────────────────────
  r.get('/api/workflows/:id/insights', requireAuth, identifyTenant, async (req, res) => {
    const tenantId = (req as any).tenantId
    const workflowId = String(req.params.id)

    // Ownership guard — make sure this workflow belongs to the caller's tenant
    const { data: wf } = await supabase.from('workflows')
      .select('id, tenant_id')
      .eq('id', workflowId).maybeSingle()
    if (!wf || wf.tenant_id !== tenantId) {
      return res.status(404).json({ error: 'Workflow not found' })
    }

    const { data: insight } = await supabase.from('workflow_insights')
      .select('*')
      .eq('workflow_id', workflowId)
      .maybeSingle()

    if (!insight) {
      // No analysis ever run. FE renders the "click Analyze" CTA.
      return res.json({ status: 'never_run' })
    }
    res.json(insight)
  })

  // ── POST analyze ────────────────────────────────────────────────────────
  r.post('/api/workflows/:id/analyze', requireAuth, identifyTenant, async (req, res) => {
    const tenantId = (req as any).tenantId
    const workflowId = String(req.params.id)

    const { data: wf } = await supabase.from('workflows')
      .select('id, tenant_id, name, nodes, status, created_at')
      .eq('id', workflowId).maybeSingle()
    if (!wf || wf.tenant_id !== tenantId) {
      return res.status(404).json({ error: 'Workflow not found' })
    }

    try {
      const stats = await aggregateStats(supabase, tenantId, workflowId)

      // ── Insufficient data path ────────────────────────────────────────
      if (
        stats.session_count   < MIN_SESSIONS_FOR_ANALYSIS ||
        stats.outbound_count  < MIN_OUTBOUND_FOR_ANALYSIS
      ) {
        const sessionsNeeded = Math.max(0, MIN_SESSIONS_FOR_ANALYSIS - stats.session_count)
        const outboundNeeded = Math.max(0, MIN_OUTBOUND_FOR_ANALYSIS - stats.outbound_count)
        // Estimate retry window from the workflow's current activity rate.
        // If the workflow has been running 7d and sees 1 session/day, suggest
        // checking back when they'd reasonably have hit the threshold.
        const ageDays = Math.max(
          1,
          (Date.now() - new Date(wf.created_at).getTime()) / 86400000,
        )
        const sessionsPerDay = stats.session_count / ageDays
        const daysToThreshold = sessionsPerDay > 0
          ? Math.ceil(sessionsNeeded / sessionsPerDay)
          : 7
        const nextCheckAt = new Date(Date.now() + Math.min(daysToThreshold, 14) * 86400000).toISOString()

        const snapshot = {
          needed: {
            sessions: MIN_SESSIONS_FOR_ANALYSIS,
            outbound_messages: MIN_OUTBOUND_FOR_ANALYSIS,
          },
          current: {
            sessions: stats.session_count,
            outbound_messages: stats.outbound_count,
            window_days: ANALYSIS_WINDOW_DAYS,
            workflow_age_days: Math.round(ageDays),
          },
          sessions_needed:  sessionsNeeded,
          outbound_needed:  outboundNeeded,
          days_to_threshold: daysToThreshold,
        }

        const row = await upsertInsight(supabase, tenantId, workflowId, {
          status: 'insufficient_data',
          insights: [],
          metrics_snapshot: snapshot,
          next_check_at: nextCheckAt,
        })
        return res.json(row)
      }

      // ── AI generation path ────────────────────────────────────────────
      const insights = await generateInsightsWithAI(wf, stats)
      const row = await upsertInsight(supabase, tenantId, workflowId, {
        status: 'ready',
        insights,
        metrics_snapshot: stats,
        next_check_at: null,
      })

      // Per-tenant token accounting (fire-and-forget — same pattern as
      // workflow-recos).
      try {
        const { recordAiUsage } = await import('../lib/ai-usage')
        await recordAiUsage(supabase, tenantId, (insights as any)._usage, 'workflow_insights', 'claude-sonnet-4-6')
      } catch { /* noop */ }

      res.json(row)
    } catch (err: any) {
      console.error('[workflow-insights] analyze failed:', err.message)
      const row = await upsertInsight(supabase, tenantId, workflowId, {
        status: 'error',
        insights: [],
        metrics_snapshot: { error: err.message ?? 'Unknown' },
        next_check_at: null,
      })
      res.status(500).json(row)
    }
  })

  return r
}

// ── Stats aggregation ────────────────────────────────────────────────────────

interface WorkflowStats {
  window_days: number
  session_count:   number
  session_completed: number
  session_active:    number
  session_failed:    number
  outbound_count:  number
  inbound_count:   number
  // Hour-of-day buckets (0-23). Counts are total outbound messages sent
  // during that hour (across the whole window). Helps the model spot when
  // the workflow is shouting into a bucket where nobody's reading.
  outbound_by_hour: Record<string, { sent: number; delivered: number; read: number; failed: number }>
  // Per-node session terminations — how many sessions ended at each node.
  drop_off_by_node: Array<{ node_id: string; node_type: string; count: number }>
  // Top inbound texts that triggered new sessions (helps spot keyword gaps)
  top_inbound_texts: Array<{ text: string; count: number }>
  // Per-channel summary
  channel_mix: Record<string, { sessions: number; outbound: number }>
}

async function aggregateStats(
  supabase: SupabaseClient,
  tenantId: string,
  workflowId: string,
): Promise<WorkflowStats> {
  const sinceIso = new Date(Date.now() - ANALYSIS_WINDOW_DAYS * 86400000).toISOString()

  // Sessions for this workflow in window
  const { data: sessions } = await supabase.from('workflow_sessions')
    .select('id, status, started_at, current_node_id, channel')
    .eq('tenant_id', tenantId)
    .eq('workflow_id', workflowId)
    .gte('started_at', sinceIso)
    .limit(5000)

  const sessionList = sessions ?? []
  const sessionIds = sessionList.map(s => s.id)

  // Messages tied to those sessions (one round-trip per 1000 ids — keep
  // batched so we don't blow the URL limit on huge workflows).
  type MsgRow = { id: string; session_id: string | null; direction: string; status: string; created_at: string; content: any; channel: string | null }
  const messages: MsgRow[] = []
  for (let i = 0; i < sessionIds.length; i += 500) {
    const slice = sessionIds.slice(i, i + 500)
    if (slice.length === 0) break
    const { data } = await supabase.from('messages')
      .select('id, session_id, direction, status, created_at, content, channel')
      .in('session_id', slice)
      .gte('created_at', sinceIso)
    if (data) messages.push(...(data as MsgRow[]))
  }

  // Node-execution drop-off — group sessions by their terminating current_node_id
  // (status='completed' means they finished; non-completed means they stopped
  // somewhere). Failed sessions are reported separately.
  const dropOff = new Map<string, number>()
  for (const s of sessionList) {
    if (s.status === 'completed') continue
    if (!s.current_node_id) continue
    dropOff.set(s.current_node_id, (dropOff.get(s.current_node_id) ?? 0) + 1)
  }
  // Look up node_type for each terminated node
  const { data: execs } = sessionIds.length > 0
    ? await supabase.from('workflow_executions')
        .select('node_id, node_type')
        .in('session_id', sessionIds.slice(0, 1000))
    : { data: [] as Array<{ node_id: string; node_type: string }> }
  const nodeTypeByNodeId = new Map<string, string>()
  for (const e of execs ?? []) {
    if (!nodeTypeByNodeId.has(e.node_id)) nodeTypeByNodeId.set(e.node_id, e.node_type)
  }
  const drop_off_by_node = [...dropOff.entries()]
    .map(([node_id, count]) => ({ node_id, node_type: nodeTypeByNodeId.get(node_id) ?? 'unknown', count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 5)

  // Hour-of-day buckets for outbound messages
  const outbound_by_hour: WorkflowStats['outbound_by_hour'] = {}
  for (let h = 0; h < 24; h++) outbound_by_hour[String(h)] = { sent: 0, delivered: 0, read: 0, failed: 0 }
  let outboundCount = 0, inboundCount = 0
  for (const m of messages) {
    if (m.direction === 'outbound') {
      outboundCount++
      const hour = String(new Date(m.created_at).getUTCHours())
      const b = outbound_by_hour[hour]
      if (b) {
        if (m.status === 'failed')               b.failed++
        else if (m.status === 'read')            b.read++
        else if (m.status === 'delivered')       b.delivered++
        else                                     b.sent++
      }
    } else if (m.direction === 'inbound') {
      inboundCount++
    }
  }

  // Top inbound texts (only first 60 chars to keep snapshot small)
  const inboundTextCounts = new Map<string, number>()
  for (const m of messages) {
    if (m.direction !== 'inbound') continue
    const t = extractInboundText(m.content)?.trim().toLowerCase().slice(0, 60)
    if (!t) continue
    inboundTextCounts.set(t, (inboundTextCounts.get(t) ?? 0) + 1)
  }
  const top_inbound_texts = [...inboundTextCounts.entries()]
    .map(([text, count]) => ({ text, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 10)

  // Channel mix
  const channel_mix: WorkflowStats['channel_mix'] = {}
  for (const s of sessionList) {
    const ch = s.channel ?? 'unknown'
    channel_mix[ch] ??= { sessions: 0, outbound: 0 }
    channel_mix[ch].sessions++
  }
  for (const m of messages) {
    if (m.direction !== 'outbound') continue
    const ch = m.channel ?? 'unknown'
    channel_mix[ch] ??= { sessions: 0, outbound: 0 }
    channel_mix[ch].outbound++
  }

  return {
    window_days: ANALYSIS_WINDOW_DAYS,
    session_count:     sessionList.length,
    session_completed: sessionList.filter(s => s.status === 'completed').length,
    session_active:    sessionList.filter(s => s.status === 'active').length,
    session_failed:    sessionList.filter(s => s.status === 'failed').length,
    outbound_count: outboundCount,
    inbound_count:  inboundCount,
    outbound_by_hour,
    drop_off_by_node,
    top_inbound_texts,
    channel_mix,
  }
}

function extractInboundText(content: any): string | null {
  if (!content) return null
  if (typeof content === 'string') return content
  if (typeof content === 'object') {
    // common payload shapes used across whatsapp/instagram/telegram inbound
    return content.text?.body
        ?? content.text
        ?? content.button?.text
        ?? content.interactive?.button_reply?.title
        ?? content.message?.text
        ?? null
  }
  return null
}

// ── AI generation ────────────────────────────────────────────────────────────

async function generateInsightsWithAI(
  wf: { name: string; nodes: any; status: string },
  stats: WorkflowStats,
): Promise<any[]> {
  const SYSTEM_PROMPT = `You are an automation-workflow analyst for Frequency (Indian SMB SaaS for WhatsApp / Instagram / Telegram automation).

Given a workflow's execution stats over the last ${ANALYSIS_WINDOW_DAYS} days, output up to 5 RANKED, ACTIONABLE insights. Each insight MUST be grounded in a specific number from the stats — never invent numbers or generalize.

Each insight JSON:
  {
    "type": "send_time" | "drop_off" | "reply_rate" | "delivery_health" | "keyword_coverage" | "channel_mix" | "general",
    "severity": "high" | "medium" | "low",
    "title": "One-line headline (<= 60 chars)",
    "body":  "2-3 sentence explanation referencing the specific number",
    "evidence": "the exact stat you used (e.g. '62% read rate at 19:00 UTC vs 8% at 11:00 UTC')",
    "suggestion": "concrete change the user can make (be specific — e.g. 'Add a wait_delay node before send_template to fire at 19:30 IST instead of 11:00')"
  }

Focus on what would actually MOVE the number — send-time shifts when there's a clear hour-of-day winner, dropping unused nodes when sessions die there repeatedly, adding keyword variations when top_inbound_texts include obvious misses, switching channels when the mix is lopsided.

If a stat doesn't merit an insight (e.g. send-time is already optimal), don't fabricate one. 5 is a MAX, not a target. Output exactly: {"insights": [...]}. No markdown, no commentary.`

  const userPrompt = JSON.stringify({
    workflow_name: wf.name,
    workflow_status: wf.status,
    node_count: Array.isArray(wf.nodes) ? wf.nodes.length : 0,
    node_types: Array.isArray(wf.nodes) ? wf.nodes.map((n: any) => n?.type).filter(Boolean) : [],
    stats,
  }, null, 2)

  const completion = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 2500,
    system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }] as any,
    messages: [{ role: 'user', content: userPrompt }],
  })
  const text = (completion.content.find(c => c.type === 'text') as any)?.text ?? '{}'
  const cleaned = text.replace(/^```json\s*|\s*```$/g, '').trim()
  let parsed: any
  try {
    parsed = JSON.parse(cleaned)
  } catch {
    parsed = { insights: [] }
  }
  const insights = Array.isArray(parsed.insights) ? parsed.insights.slice(0, 5) : []
  ;(insights as any)._usage = completion.usage   // smuggle for ai-usage record
  return insights
}

// ── Upsert helper ────────────────────────────────────────────────────────────

async function upsertInsight(
  supabase: SupabaseClient,
  tenantId: string,
  workflowId: string,
  patch: {
    status: 'ready' | 'insufficient_data' | 'error'
    insights: any[]
    metrics_snapshot: any
    next_check_at: string | null
  },
): Promise<any> {
  const { data, error } = await supabase.from('workflow_insights')
    .upsert({
      tenant_id:        tenantId,
      workflow_id:      workflowId,
      status:           patch.status,
      insights:         patch.insights,
      metrics_snapshot: patch.metrics_snapshot,
      next_check_at:    patch.next_check_at,
      generated_at:     new Date().toISOString(),
    }, { onConflict: 'workflow_id' as any })
    .select()
    .single()
  if (error) throw error
  return data
}
