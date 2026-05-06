import './env'   // must be first — loads .env with override=true
import express from 'express'
import fs from 'fs'
import path from 'path'
import cors from 'cors'
import { createClient } from '@supabase/supabase-js'
import Anthropic from '@anthropic-ai/sdk'
import {
  sheetsAppendRow, sheetsUpdateRange, sheetsReadRange, sheetsGetMetadata, listSpreadsheets,
  calendarCreateEvent, calendarCheckAvailability
} from './google'
import { createLeadsRouter } from './leads'
import { createAdminRouter } from './admin'
import { createPhase3Router } from './routes/phase3'
import { createDataSourcesRouter } from './routes/data-sources'
import { createConnectorsRouter }  from './routes/connectors'
import { enqueueWorkflowExecution, workflowQueue, messageQueue, broadcastQueue, cronQueue, attachDebugListeners } from './queue'
import { createBullBoard } from '@bull-board/api'
import { BullMQAdapter } from '@bull-board/api/bullMQAdapter'
import { ExpressAdapter } from '@bull-board/express'
import {
  validateBody,
  WorkflowCreateSchema, WorkflowPatchSchema,
  BroadcastCreateSchema,
  ContactCreateSchema, ContactPatchSchema,
  RazorpayConnectSchema, InboxSendSchema, CampaignCreateSchema,
} from './validation'

const app = express()
const PORT = process.env.PORT || 3001

app.use(cors({ origin: process.env.FRONTEND_URL || 'http://localhost:5173' }))
app.use(express.json({ limit: '50mb' }))
app.use(express.urlencoded({ limit: '50mb', extended: true }))

function logToFile(msg: string) {
  const line = `[${new Date().toISOString()}] ${msg}\n`
  try { fs.appendFileSync('debug.log', line) } catch(e) {}
}

/** Parse page / pageSize from query params, return offset + limit for Supabase .range() */
function parsePagination(query: Record<string, string>) {
  const page = Math.max(1, parseInt(query.page ?? '1', 10) || 1)
  const pageSize = Math.min(100, Math.max(1, parseInt(query.pageSize ?? '25', 10) || 25))
  const offset = (page - 1) * pageSize
  return { page, pageSize, offset }
}

app.use((req, res, next) => {
  logToFile(`${req.method} ${req.url}`)
  console.log(`[request] ${req.method} ${req.url}`)
  next()
})

app.get('/api/ping', (req, res) => res.json({ pong: true }))

if (!process.env.ANTHROPIC_API_KEY) {
  console.error('[startup] ANTHROPIC_API_KEY is not set — workflow parsing will fail')
}
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://yiicpndeggaedxobyopu.supabase.co'
const supabase = createClient(SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY!)

const META_APP_ID     = process.env.META_APP_ID!
const META_APP_SECRET = process.env.META_APP_SECRET!
const GRAPH           = 'https://graph.facebook.com/v18.0'
const WH_VERIFY_TOKEN = process.env.WH_VERIFY_TOKEN || 'Frequency_webhook_secret'

// ── Auth middleware ───────────────────────────────────────────────────────────
async function requireAuth(req: express.Request, res: express.Response, next: express.NextFunction) {
  const token = req.headers.authorization?.replace('Bearer ', '') || (req.query.token as string)
  if (!token) { res.status(401).json({ error: 'Unauthorized' }); return }

  // Smoke test bypass for local testing
  if (token === 'SMOKE_TEST_TOKEN' && process.env.NODE_ENV !== 'production') {
    ;(req as any).user = { id: 'bfc37cf8-ad1a-4419-a65b-d5b6548abc41' } // demo user id from seed-demo.mjs
    next()
    return
  }

  const { data: { user }, error } = await supabase.auth.getUser(token)
  if (error || !user) { res.status(401).json({ error: 'Invalid token' }); return }
  ;(req as any).user = user
  next()
}

// ── RBAC Middlewares ──────────────────────────────────────────────────────────

async function identifyTenant(req: express.Request, res: express.Response, next: express.NextFunction) {
  const user = (req as any).user
  if (!user) { res.status(401).json({ error: 'Auth required' }); return }

  const headerTenantId = (req.headers['x-tenant-id'] as string) || (req.query.tenant_id as string)
  console.log(`[identifyTenant] user=${user.id}, header_tenant=${headerTenantId || '(none)'}`)

  // 1. If header provides a tenant ID, verify the user has access to it
  if (headerTenantId) {
    // Check via user_roles first
    const { data: roleForHeader } = await supabase
      .from('user_roles')
      .select('role')
      .eq('user_id', user.id)
      .eq('tenant_id', headerTenantId)
      .maybeSingle()
    if (roleForHeader) {
      console.log(`[identifyTenant] resolved via user_roles: tenant=${headerTenantId}, role=${roleForHeader.role}`)
      ;(req as any).tenantId = headerTenantId
      ;(req as any).userRole = roleForHeader.role
      next()
      return
    }
    // Check if user owns the tenant
    const { data: ownedCheck } = await supabase
      .from('tenants')
      .select('id')
      .eq('id', headerTenantId)
      .eq('user_id', user.id)
      .eq('status', 'active')
      .maybeSingle()
    if (ownedCheck) {
      console.log(`[identifyTenant] resolved via tenant ownership: tenant=${headerTenantId}, role=admin`)
      ;(req as any).tenantId = headerTenantId
      ;(req as any).userRole = 'admin'
      next()
      return
    }
    console.log(`[identifyTenant] header tenant ${headerTenantId} not accessible by user, falling through`)
  }

  // 2. Auto-detect: Check user_roles table for an explicit tenant assignment
  const { data: userRole } = await supabase
    .from('user_roles')
    .select('tenant_id, role')
    .eq('user_id', user.id)
    .not('tenant_id', 'is', null)
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle()

  if (userRole?.tenant_id) {
    console.log(`[identifyTenant] resolved via user_roles auto: tenant=${userRole.tenant_id}, role=${userRole.role}`)
    ;(req as any).tenantId = userRole.tenant_id
    ;(req as any).userRole = userRole.role
    next()
    return
  }

  // 3. Fallback: user is the owner of a tenant
  const { data: ownedTenant } = await supabase
    .from('tenants')
    .select('id')
    .eq('user_id', user.id)
    .eq('status', 'active')
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle()
  if (ownedTenant) {
    console.log(`[identifyTenant] resolved via tenant ownership fallback: tenant=${ownedTenant.id}`)
    ;(req as any).tenantId = ownedTenant.id
    ;(req as any).userRole = 'admin'
    next()
    return
  }

  console.log(`[identifyTenant] FAILED for user=${user.id} — no tenant found via any path`)
  res.status(403).json({ error: 'No active tenant found. Please complete onboarding to connect your WhatsApp account.' })
}

function checkPermission(feature: string, action: 'view' | 'edit' | 'delete') {
  return async (req: express.Request, res: express.Response, next: express.NextFunction) => {
    if ((req as any).isSuperAdmin) { next(); return }

    const tenantId = (req as any).tenantId
    const role = (req as any).userRole

    // 1. Entitlement Check (Repeat.works level) — table may not exist yet, treat missing table as "all enabled"
    const { data: entitlement, error: entErr } = await supabase
      .from('tenant_entitlements')
      .select('is_enabled')
      .eq('tenant_id', tenantId)
      .eq('feature', feature)
      .maybeSingle()

    if (!entErr && entitlement && !entitlement.is_enabled) {
      res.status(403).json({ error: `Feature '${feature}' is not enabled for your account plan. Contact support.` })
      return
    }

    // 2. Permission Check (Tenant Admin level)
    const { data: perm } = await supabase
      .from('role_permissions')
      .select(`can_${action}`)
      .eq('tenant_id', tenantId)
      .eq('role', role)
      .eq('feature', feature)
      .maybeSingle()

    if (!perm || !(perm as any)[`can_${action}`]) {
      // Fallback: system defaults
      const { data: sysPerm } = await supabase
        .from('role_permissions')
        .select(`can_${action}`)
        .is('tenant_id', null)
        .eq('role', role)
        .eq('feature', feature)
        .maybeSingle()

      if (!sysPerm || !(sysPerm as any)[`can_${action}`]) {
        res.status(403).json({ error: `Your role (${role}) does not have ${action} access to ${feature}` })
        return
      }
    }

    next()
  }
}

// ── Health ────────────────────────────────────────────────────────────────────
app.get('/health', (_req, res) => res.json({ status: 'ok', service: 'Frequency-server' }))

// ── NLP Parse (streaming) ─────────────────────────────────────────────────────
const SYSTEM_PROMPT = `You are a workflow architect for Frequency — a WhatsApp Business automation platform that also integrates with email, Google Sheets, CRMs, and payment systems.

Parse the user's plain-language automation intent and return ONLY a compact JSON workflow blueprint. No prose, no markdown, no code blocks, no \`\`\`json fences — pure JSON only. Your entire response must start with { and end with }.

CRITICAL RULE — CLARIFYING QUESTIONS:
When key information is missing to build a complete, executable workflow, populate "clarifying_questions" with 2–5 targeted questions. Each targets exactly one unknown. Still build the best-guess workflow skeleton; set config_completion_percent to 20–45 when questions are present. Do NOT invent credentials, emails, or phone numbers.

NODE TYPES (use exact strings):
Triggers:  trigger_form_submit, trigger_webhook, trigger_sheet_row, trigger_inbound_keyword,
           trigger_scheduled, trigger_api, trigger_broadcast_reply, trigger_email_received
Actions:   send_text, send_template, send_interactive, collect_input, send_payment_link,
           update_crm, update_sheet, http_request, run_ai_responder, assign_agent,
           add_tag, wait_delay, send_email, forward_email
Logic:     condition_reply, condition_button_click, condition_variable, condition_time,
           split_ab, end_flow

WHATSAPP RULES (enforce for send_text / send_template / send_interactive nodes):
- Free-form text only valid within 24 h of last inbound message
- Outside 24 h window → approved template required (mark template_required: true)
- Marketing templates require opt-in proof
- Quick reply buttons: max 3; CTA buttons: max 2; never mix types

EMAIL RULES (enforce for trigger_email_received / send_email / forward_email nodes):
- trigger_email_received requires: email_provider (gmail|outlook|smtp), filter_from_email, optional filter_subject
- send_email / forward_email requires: smtp_provider (sendgrid|mailgun|ses|smtp), to_email, subject, body_template
- Always flag missing OAuth / API credentials in missing_config
- forward_email should preserve original sender in the forwarded body when possible

OUTPUT SCHEMA (omit keys with null / empty array values):
{
  "workflow_name": "string",
  "description": "string",
  "trigger_summary": "string",
  "clarifying_questions": [
    {
      "id": "q1",
      "question": "string — specific, friendly, one unknown per question",
      "why": "string — one sentence explaining why this matters",
      "example": "string — a concrete example answer",
      "type": "text|select|multiselect",
      "options": []
    }
  ],
  "nodes": [
    {
      "id": "node_1",
      "type": "string",
      "label": "string",
      "description": "string (≤15 words)",
      "position": 1,
      "config": {},
      "missing_config": [
        {
          "field": "",
          "label": "",
          "type": "text|textarea|select|number|url|email|phone",
          "required": true,
          "placeholder": "",
          "options": []
        }
      ],
      "connections": { "default": "node_2" },
      "template_required": false,
      "compliance_note": null,
      "warnings": []
    }
  ],
  "required_integrations": [{ "key": "", "name": "", "reason": "", "required": true }],
  "template_required": false,
  "templates_needed": [
    {
      "purpose": "",
      "suggested_name": "",
      "category": "MARKETING|UTILITY|AUTHENTICATION",
      "body_preview": "",
      "variables": [],
      "approval_time": "24-72 hours"
    }
  ],
  "compliance_flags": [{ "severity": "error|warning|info", "message": "", "how_to_fix": "" }],
  "missing_info": [],
  "config_completion_percent": 60,
  "overall_status": "ready_to_deploy|needs_config|needs_templates|needs_review",
  "blocking_issues": []
}

COMMON INTENT PATTERNS:
- "forward email from X to Y" → trigger_email_received (filter_from_email=X) → forward_email (to=Y). Ask: email provider, whether to include attachments, any subject filters.
- "when form submitted" → trigger_form_submit → send_template (outside 24 h). Ask: form provider (Typeform/Google Forms/custom), template body.
- "payment received" → trigger_webhook (Razorpay) → send_template (payment confirmation). Ask: webhook secret, template content.
- "every Monday" → trigger_scheduled (cron) → send_template. Ask: target audience/segment, template content.
- "respond to inbound message" → trigger_inbound_keyword → send_text (within 24 h) or send_template. Ask: keywords, reply content.

Be concise. Descriptions ≤15 words, compliance_note ≤20 words. Only include keys with actual values.`

app.post('/api/parse-workflow', requireAuth, async (req, res) => {
  const { message, history = [] } = req.body
  if (!message || typeof message !== 'string') {
    res.status(400).json({ error: 'message (string) required' }); return
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    res.status(500).json({ error: 'ANTHROPIC_API_KEY is not configured on this server' })
    return
  }

  // ── SSE setup ───────────────────────────────────────────────────────────────
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8')
  res.setHeader('Cache-Control', 'no-cache, no-transform')
  res.setHeader('Connection', 'keep-alive')
  res.setHeader('X-Accel-Buffering', 'no')   // disable nginx buffering if behind proxy
  res.flushHeaders()

  // Heartbeat — comment line every 15s. Comments are ignored by EventSource
  // parsers but keep proxy connections alive during long Claude generations.
  const heartbeat = setInterval(() => {
    if (!res.writableEnded) {
      try { res.write(': keepalive\n\n') } catch { /* socket gone */ }
    }
  }, 15_000)

  // Hard timeout — protect against Anthropic API hangs.
  const TIMEOUT_MS = 90_000
  const abortCtl = new AbortController()
  const timeoutId = setTimeout(() => {
    console.warn('[parse-workflow] hard timeout reached, aborting upstream')
    abortCtl.abort()
  }, TIMEOUT_MS)

  // Detect client disconnect — abort upstream so we don't burn tokens for nothing.
  // IMPORTANT: Use `res.on('close')`, NOT `req.on('close')`. In Express 5 /
  // Node 22, `req` (the ReadableStream half of the socket) emits 'close' as
  // soon as the request body finishes reading — i.e. immediately for a small
  // POST. This is unrelated to whether the client is still connected. The
  // response object's 'close' event is the correct signal for client abort.
  let clientGone = false
  res.on('close', () => {
    if (res.writableEnded) return  // we ended the stream cleanly — not a disconnect
    console.warn('[parse-workflow] client closed before response end')
    clientGone = true
    abortCtl.abort()
  })

  const cleanup = () => {
    clearInterval(heartbeat)
    clearTimeout(timeoutId)
  }

  // Helper: write one SSE event, swallowing errors if socket is dead.
  const writeEvent = (obj: unknown) => {
    if (res.writableEnded) return
    try { res.write(`data: ${JSON.stringify(obj)}\n\n`) } catch { /* socket gone */ }
  }

  try {
    // Sanitize history: only keep {role, content} pairs and clamp to last 6 turns
    // to avoid runaway context. Server is the source of truth for shape.
    const safeHistory = (Array.isArray(history) ? history : [])
      .filter((m: any) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
      .slice(-6)
      .map((m: any) => ({ role: m.role as 'user' | 'assistant', content: m.content }))

    console.log(`[parse-workflow] streaming start (history=${safeHistory.length}, msg=${message.slice(0, 80)}...)`)

    const stream = anthropic.messages.stream({
      model: 'claude-sonnet-4-6',
      max_tokens: 6000,
      // Prompt-cache the (long, stable) system prompt for ~70% cost / latency win.
      // First call seeds the cache; subsequent calls in the next 5 min hit it.
      system: [
        { type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } },
      ] as any,
      messages: [...safeHistory, { role: 'user' as const, content: message }],
    }, { signal: abortCtl.signal as any })

    let charCount = 0
    for await (const chunk of stream) {
      if (clientGone) break
      if (chunk.type === 'content_block_delta' && chunk.delta.type === 'text_delta') {
        charCount += chunk.delta.text.length
        writeEvent({ text: chunk.delta.text })
      }
    }

    // Capture final usage for telemetry
    const final = await stream.finalMessage().catch(() => null)
    const usage = final?.usage
    if (usage) {
      console.log(`[parse-workflow] done chars=${charCount} input=${usage.input_tokens} output=${usage.output_tokens} cache_read=${(usage as any).cache_read_input_tokens ?? 0} cache_create=${(usage as any).cache_creation_input_tokens ?? 0}`)
    }

    if (!clientGone) {
      writeEvent({ done: true })
      res.write('data: [DONE]\n\n')
      res.end()
    }
  } catch (err: any) {
    // Categorize: client-cancel (silent in logs) vs real upstream error (loud).
    const isAbort = err?.name === 'AbortError' || err?.message?.includes('aborted')
    if (isAbort && clientGone) {
      // User navigated away or hit Stop — not actionable, skip the log noise.
    } else {
      console.warn(`[parse-workflow] error name=${err?.name} status=${err?.status} msg=${err?.message?.slice(0, 200)}`)
    }
    writeEvent({
      error: isAbort && clientGone
        ? 'Request was cancelled.'
        : (err?.message ?? 'Unknown error from AI service'),
    })
    if (!res.writableEnded) {
      res.write('data: [DONE]\n\n')
      res.end()
    }
  } finally {
    cleanup()
  }
})

// ── Workflows CRUD ────────────────────────────────────────────────────────────
app.get('/api/workflows', requireAuth, identifyTenant, checkPermission('whatsapp_automation', 'view'), async (req, res) => {
  const tenantId = (req as any).tenantId
  const { page, pageSize, offset } = parsePagination(req.query as Record<string, string>)
  const { search, status, sortBy, sortOrder } = req.query as Record<string, string>

  let q = supabase.from('workflows').select('*', { count: 'exact' })
    .eq('tenant_id', tenantId)

  if (search) q = q.or(`name.ilike.%${search}%,description.ilike.%${search}%,intent_text.ilike.%${search}%`)
  if (status && status !== 'all') q = q.eq('status', status)

  // Dynamic field filters
  const filtersRaw = req.query.filters as string
  if (filtersRaw) {
    try {
      const parsed = JSON.parse(filtersRaw)
      Object.entries(parsed).forEach(([key, val]) => {
        if (val) q = q.ilike(key, `%${val}%`)
      })
    } catch (e) {}
  }

  q = q.order(sortBy || 'created_at', { ascending: sortOrder === 'asc' })
    .range(offset, offset + pageSize - 1)

  const { data, count, error } = await q
  if (error) { res.status(500).json({ error: error.message }); return }
  const total = count ?? 0
  res.json({ data: data ?? [], total, page, pageSize, totalPages: Math.ceil(total / pageSize) })
})

app.get('/api/workflows/:id', requireAuth, identifyTenant, checkPermission('whatsapp_automation', 'view'), async (req, res) => {
  const tenantId = (req as any).tenantId
  const { data, error } = await supabase.from('workflows').select('*')
    .eq('id', req.params.id).eq('tenant_id', tenantId).maybeSingle()
  if (error) { res.status(500).json({ error: error.message }); return }
  if (!data) { res.status(404).json({ error: 'Workflow not found' }); return }
  res.json(data)
})

app.post('/api/workflows', requireAuth, identifyTenant, checkPermission('whatsapp_automation', 'edit'), validateBody(WorkflowCreateSchema), async (req, res) => {
  const tenantId = (req as any).tenantId
  const userId   = (req as any).user.id
  // workflows.user_id is NOT NULL (migration 001) — always set it from the
  // authenticated session so the FE never has to know about the DB shape.
  const { data, error } = await supabase.from('workflows')
    .insert({ ...req.body, tenant_id: tenantId, user_id: userId }).select().single()
  if (error) { res.status(500).json({ error: error.message }); return }
  res.json(data)
})

app.patch('/api/workflows/:id', requireAuth, identifyTenant, checkPermission('whatsapp_automation', 'edit'), validateBody(WorkflowPatchSchema), async (req, res) => {
  const tenantId = (req as any).tenantId
  const { data, error } = await supabase.from('workflows')
    .update({ ...req.body, updated_at: new Date().toISOString() })
    .eq('id', req.params.id).eq('tenant_id', tenantId).select().single()
  if (error) { res.status(500).json({ error: error.message }); return }
  res.json(data)
})

app.delete('/api/workflows/:id', requireAuth, identifyTenant, checkPermission('whatsapp_automation', 'delete'), async (req, res) => {
  const tenantId = (req as any).tenantId
  const { error } = await supabase.from('workflows')
    .delete().eq('id', req.params.id).eq('tenant_id', tenantId)
  if (error) { res.status(500).json({ error: error.message }); return }
  res.json({ success: true })
})

// ── Tenants CRUD ──────────────────────────────────────────────────────────────
app.get('/api/tenants/:id/members', requireAuth, identifyTenant, async (req, res) => {
  const tenantId = req.params.id
  const { data, error } = await supabase
    .from('user_roles')
    .select('user_id, role, profiles:user_id(full_name, avatar_url)')
    .eq('tenant_id', tenantId)

  if (error) { res.status(500).json({ error: error.message }); return }
  
  const members = (data || []).map((m: any) => ({
    id: m.user_id,
    role: m.role,
    name: m.profiles?.full_name || 'Unknown User',
    avatar: m.profiles?.avatar_url
  }))
  
  res.json(members)
})

app.post('/api/onboarding', requireAuth, async (req, res) => {
  const user = (req as any).user
  const { business_name, full_name, phone } = req.body
  
  // Update Profile
  await supabase.from('profiles').update({ 
    full_name, 
    wa_number: phone 
  }).eq('id', user.id)
  
  // Create/Update Tenant
  const { data: tenant, error } = await supabase.from('tenants').upsert({
    user_id: user.id,
    business_name,
    status: 'active'
  }).select().single()
  
  if (error) { res.status(500).json({ error: error.message }); return }
  
  // Mock sending email
  console.log(`[onboarding:email] Sending welcome email to ${user.email}`)
  
  res.json({ success: true, tenant })
})

app.get('/api/tenants', requireAuth, async (req, res) => {
  const user = (req as any).user

  // 1. Tenants the user owns
  const { data: ownedTenants, error: e1 } = await supabase.from('tenants')
    .select('id,waba_id,phone_number_id,business_name,display_phone,status,google_email,created_at')
    .eq('user_id', user.id)
  if (e1) { res.status(500).json({ error: e1.message }); return }

  // 2. Tenants the user has access to via user_roles (team members)
  const { data: roleRows } = await supabase.from('user_roles')
    .select('tenant_id')
    .eq('user_id', user.id)
    .not('tenant_id', 'is', null)
  const roleTenantIds = (roleRows ?? []).map(r => r.tenant_id).filter(id => !(ownedTenants ?? []).find(t => t.id === id))

  let teamTenants: any[] = []
  if (roleTenantIds.length > 0) {
    const { data: extra } = await supabase.from('tenants')
      .select('id,waba_id,phone_number_id,business_name,display_phone,status,google_email,created_at')
      .in('id', roleTenantIds)
    teamTenants = extra ?? []
  }

  const all = [...(ownedTenants ?? []), ...teamTenants]
  console.log(`[/api/tenants] user=${user.id}, found ${all.length} tenant(s)`)
  res.json(all)
})

app.delete('/api/tenants/:id', requireAuth, async (req, res) => {
  const user = (req as any).user
  const { error } = await supabase.from('tenants')
    .delete().eq('id', req.params.id).eq('user_id', user.id)
  if (error) { res.status(500).json({ error: error.message }); return }
  res.json({ success: true })
})

// ── Facebook Embedded Signup callback ─────────────────────────────────────────
// Frontend calls this after user completes Embedded Signup and gets a short-lived token + WABA ID
app.post('/api/auth/facebook/connect-waba', requireAuth, async (req, res) => {
  const user = (req as any).user
  const { code, waba_id, phone_number_id } = req.body
  if (!code || !waba_id || !phone_number_id) {
    res.status(400).json({ error: 'code, waba_id, phone_number_id required' }); return
  }

  try {
    // Exchange short-lived code for a long-lived user access token
    const tokenRes = await fetch(
      `${GRAPH}/oauth/access_token?client_id=${META_APP_ID}&client_secret=${META_APP_SECRET}&code=${code}`
    )
    const tokenData = await tokenRes.json() as any
    if (tokenData.error) throw new Error(tokenData.error.message)

    const shortToken: string = tokenData.access_token

    // Exchange for long-lived token (60 days)
    const longRes = await fetch(
      `${GRAPH}/oauth/access_token?grant_type=fb_exchange_token&client_id=${META_APP_ID}&client_secret=${META_APP_SECRET}&fb_exchange_token=${shortToken}`
    )
    const longData = await longRes.json() as any
    if (longData.error) throw new Error(longData.error.message)
    const longToken: string = longData.access_token

    // Fetch WABA info (business_name, etc.)
    const wabaRes = await fetch(
      `${GRAPH}/${waba_id}?fields=name,currency,timezone_id`,
      { headers: { Authorization: `Bearer ${longToken}` } }
    )
    const wabaData = await wabaRes.json() as any

    // Fetch phone number display info
    const phoneRes = await fetch(
      `${GRAPH}/${phone_number_id}?fields=display_phone_number,verified_name`,
      { headers: { Authorization: `Bearer ${longToken}` } }
    )
    const phoneData = await phoneRes.json() as any

    // Subscribe the app to the WABA webhook
    const subRes = await fetch(`${GRAPH}/${waba_id}/subscribed_apps`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${longToken}` }
    })
    const subData = await subRes.json() as any
    if (subData.success) {
      console.log(`[connect-waba] ✅ Webhook subscription active for WABA ${waba_id}`)
    } else {
      console.error(`[connect-waba] ⚠️ Webhook subscription FAILED for WABA ${waba_id}:`, subData)
    }

    // Upsert tenant row
    const { data, error } = await supabase.from('tenants').upsert({
      user_id: user.id,
      waba_id,
      phone_number_id,
      access_token: longToken,
      business_name: wabaData.name ?? phoneData.verified_name ?? 'My Business',
      display_phone: phoneData.display_phone_number,
      status: 'active',
      updated_at: new Date().toISOString(),
    }, { onConflict: 'waba_id' }).select().single()

    if (error) throw new Error(error.message)

    // Ensure the owner has a user_roles row so identifyTenant always resolves
    const { data: existingRole } = await supabase.from('user_roles')
      .select('id').eq('user_id', user.id).eq('tenant_id', data.id).maybeSingle()
    if (!existingRole) {
      await supabase.from('user_roles').insert({
        user_id: user.id,
        tenant_id: data.id,
        role: 'admin',
      })
    }

    console.log(`[connect-waba] tenant=${data.id} created/updated for user=${user.id}`)
    res.json({ success: true, tenant: data })
  } catch (err: any) {
    res.status(500).json({ error: err.message })
  }
})

// ── Google OAuth ──────────────────────────────────────────────────────────────
const GOOGLE_CLIENT_ID     = process.env.GOOGLE_CLIENT_ID!
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET!
const GOOGLE_REDIRECT_URI  = process.env.GOOGLE_REDIRECT_URI || 'http://localhost:3001/api/auth/google/callback'

app.get('/api/auth/google', requireAuth, (req, res) => {
  const user = (req as any).user
  const scopes = [
    'https://www.googleapis.com/auth/calendar',
    'https://www.googleapis.com/auth/spreadsheets',
    'https://www.googleapis.com/auth/drive.readonly',
    'https://www.googleapis.com/auth/drive.file',
    'https://www.googleapis.com/auth/gmail.modify',
    'email', 'profile'
  ].join(' ')
  const state = Buffer.from(JSON.stringify({ userId: user.id, tenantId: req.query.tenant_id })).toString('base64')
  const url = `https://accounts.google.com/o/oauth2/v2/auth?client_id=${GOOGLE_CLIENT_ID}&redirect_uri=${encodeURIComponent(GOOGLE_REDIRECT_URI)}&response_type=code&scope=${encodeURIComponent(scopes)}&access_type=offline&prompt=consent&state=${state}`
  
  logToFile(`Initiating OAuth for user: ${user.id}`)
  console.log('[google-auth] Initiating OAuth for user:', user.id)
  console.log('[google-auth] Redirect URI:', GOOGLE_REDIRECT_URI)
  
  res.redirect(url)
})

app.get('/api/auth/google/callback', async (req, res) => {
  const { code, state } = req.query as { code: string; state: string }
  if (!code) { res.status(400).send('Missing code'); return }

  try {
    const { userId, tenantId } = JSON.parse(Buffer.from(state, 'base64').toString())

    // Exchange code for tokens
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code, client_id: GOOGLE_CLIENT_ID, client_secret: GOOGLE_CLIENT_SECRET,
        redirect_uri: GOOGLE_REDIRECT_URI, grant_type: 'authorization_code'
      })
    })
    const tokens = await tokenRes.json() as any
    if (tokens.error) throw new Error(tokens.error_description ?? tokens.error)

    // Get user email
    const profileRes = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
      headers: { Authorization: `Bearer ${tokens.access_token}` }
    })
    const profile = await profileRes.json() as any
    const { encrypt } = await import('./google')

    const expiry = new Date(Date.now() + tokens.expires_in * 1000).toISOString()

    // Store on tenant if tenantId provided, otherwise on all user's tenants
    const update = {
      google_email: profile.email,
      google_access_token: encrypt(tokens.access_token),
      google_refresh_token: encrypt(tokens.refresh_token),
      google_token_expiry: expiry,
      updated_at: new Date().toISOString(),
    }

    logToFile(`Updating Google tokens for user ${userId}, tenant ${tenantId ?? 'auto-detect'}`)
    console.log(`[google-auth] Updating Google tokens for user ${userId}, tenant ${tenantId ?? 'auto-detect'}`)
    
    // Resolve tenantId if not in state — find the user's active tenant
    let resolvedTenantId = tenantId
    if (!resolvedTenantId) {
      const { data: role } = await supabase.from('user_roles')
        .select('tenant_id').eq('user_id', userId).not('tenant_id', 'is', null)
        .order('created_at', { ascending: true }).limit(1).maybeSingle()
      if (role?.tenant_id) {
        resolvedTenantId = role.tenant_id
      } else {
        const { data: owned } = await supabase.from('tenants')
          .select('id').eq('user_id', userId).eq('status', 'active')
          .order('created_at', { ascending: true }).limit(1).maybeSingle()
        resolvedTenantId = owned?.id
      }
      logToFile(`[google-auth] Auto-resolved tenant: ${resolvedTenantId}`)
      console.log(`[google-auth] Auto-resolved tenant: ${resolvedTenantId}`)
    }

    if (!resolvedTenantId) {
      throw new Error('No tenant found for user. Complete WhatsApp onboarding first.')
    }

    const { error: updErr, count } = await supabase.from('tenants')
      .update(update).eq('id', resolvedTenantId).select('id', { count: 'exact', head: true })
    
    if (updErr) {
      logToFile(`DB Update failed: ${updErr.message}`)
      throw new Error(`DB Update failed: ${updErr.message}`)
    }

    logToFile(`[google-auth] Updated ${count ?? '?'} tenant row(s) for tenant ${resolvedTenantId}`)
    console.log(`[google-auth] Updated ${count ?? '?'} tenant row(s) for tenant ${resolvedTenantId}`)

    logToFile('[google-auth] Success! Tokens saved.')
    console.log('[google-auth] Success! Tokens saved.')

    // Close the popup and notify parent.
    // Shape MUST be { ok: true } for openOAuthPopup() to resolve — it polls
    // for `e.data.ok` (see src/lib/connectors.ts openOAuthPopup).
    const successPayload = { ok: true, connector: 'google', label: profile.email }
    res.send(`
      <!doctype html><html><head><meta charset="utf-8"><title>Connected</title>
      <style>body{font:14px/1.5 system-ui,sans-serif;text-align:center;padding:32px;color:#1a1a1a}</style>
      </head><body>
      <div style="font-size:42px">✅</div>
      <h2 style="font-size:18px;margin:8px 0">Connected to Google</h2>
      <p>${profile.email ?? ''}</p>
      <p style="color:#6b7280;font-size:13px;margin-top:16px">You can close this window.</p>
      <script>
        try { window.opener?.postMessage(${JSON.stringify(successPayload)}, '*'); } catch(e){}
        setTimeout(() => { try { window.close(); } catch(e){} }, 1200);
      </script>
      </body></html>
    `)
  } catch (err: any) {
    console.error('[google-auth] FATAL ERROR:', err.message)
    res.status(500).send(`Google auth failed: ${err.message}`)
  }
})

// ── WA Templates (per-tenant) ─────────────────────────────────────────────────
async function getTenant(userId: string, tenantId?: string) {
  const q = supabase.from('tenants').select('*').eq('user_id', userId).eq('status', 'active')
  if (tenantId) q.eq('id', tenantId)
  const { data } = await q.order('created_at').limit(1).single()
  return data as any
}

app.get('/api/wa-templates', requireAuth, async (req, res) => {
  const user = (req as any).user
  const { data, error } = await supabase.from('wa_templates')
    .select('*').eq('user_id', user.id).order('created_at', { ascending: false })
  if (error) { res.status(500).json({ error: error.message }); return }

  // Transform DB format → Meta components format so frontend stays consistent
  const formatted = (data ?? []).map((t: any) => {
    const components: any[] = []
    if (t.header) {
      const h = t.header
      if (h.type === 'text') components.push({ type: 'HEADER', format: 'TEXT', text: h.text ?? '' })
      else if (h.type === 'image') components.push({ type: 'HEADER', format: 'IMAGE' })
      else if (h.type === 'video') components.push({ type: 'HEADER', format: 'VIDEO' })
      else if (h.type === 'document') components.push({ type: 'HEADER', format: 'DOCUMENT' })
    }
    if (t.body) components.push({ type: 'BODY', text: t.body })
    if (t.footer) components.push({ type: 'FOOTER', text: t.footer })
    if (t.buttons?.length) components.push({ type: 'BUTTONS', buttons: t.buttons })
    return { id: t.id, name: t.name, status: t.status?.toUpperCase() ?? 'DRAFT', category: t.category?.toUpperCase() ?? 'MARKETING', language: t.language ?? 'en', components }
  })

  res.json(formatted)
})

app.post('/api/wa-templates', requireAuth, async (req, res) => {
  const user = (req as any).user
  const tenant = await getTenant(user.id, req.query.tenant_id as string)
  if (!tenant) { res.status(404).json({ error: 'No connected WhatsApp account' }); return }

  const { name, category = 'MARKETING', language = 'en_US', body, buttons = [] } = req.body
  const components: any[] = [{ type: 'BODY', text: body }]
  if (buttons.length > 0) {
    components.push({ type: 'BUTTONS', buttons: buttons.map((btn: string) => ({ type: 'QUICK_REPLY', text: btn })) })
  }
  try {
    const r = await fetch(`${GRAPH}/${tenant.waba_id}/message_templates`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tenant.access_token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, language, category, components })
    })
    const data = await r.json() as any
    if (data.error) { res.status(400).json({ error: data.error.message }); return }
    res.json(data)
  } catch (err: any) { res.status(500).json({ error: err.message }) }
})

app.delete('/api/wa-templates/:name', requireAuth, async (req, res) => {
  const user = (req as any).user
  const tenant = await getTenant(user.id, req.query.tenant_id as string)
  if (!tenant) { res.status(404).json({ error: 'No connected WhatsApp account' }); return }

  try {
    const r = await fetch(
      `${GRAPH}/${tenant.waba_id}/message_templates?name=${req.params.name}`,
      { method: 'DELETE', headers: { Authorization: `Bearer ${tenant.access_token}` } }
    )
    const data = await r.json() as any
    if (data.error) { res.status(400).json({ error: data.error.message }); return }
    res.json({ success: true })
  } catch (err: any) { res.status(500).json({ error: err.message }) }
})

// ── Broadcasts API ────────────────────────────────────────────────────────────
app.get('/api/broadcasts', requireAuth, identifyTenant, checkPermission('whatsapp_automation', 'view'), async (req, res) => {
  const tenantId = (req as any).tenantId
  const { page, pageSize, offset } = parsePagination(req.query as Record<string, string>)
  const { search, status, sortBy, sortOrder } = req.query as Record<string, string>

  let q = supabase.from('broadcasts').select('*', { count: 'exact' })
    .eq('tenant_id', tenantId)

  if (search) q = q.ilike('name', `%${search}%`)
  if (status && status !== 'all') q = q.eq('status', status)

  // Dynamic field filters
  const filtersRaw = req.query.filters as string
  if (filtersRaw) {
    try {
      const parsed = JSON.parse(filtersRaw)
      Object.entries(parsed).forEach(([key, val]) => {
        if (val) q = q.ilike(key, `%${val}%`)
      })
    } catch (e) {}
  }

  q = q.order(sortBy || 'created_at', { ascending: sortOrder === 'asc' })
    .range(offset, offset + pageSize - 1)

  const { data, count, error } = await q
  if (error) { res.status(500).json({ error: error.message }); return }
  const total = count ?? 0
  res.json({ data: data ?? [], total, page, pageSize, totalPages: Math.ceil(total / pageSize) })
})

app.post('/api/broadcasts', requireAuth, identifyTenant, checkPermission('whatsapp_automation', 'edit'), validateBody(BroadcastCreateSchema), async (req, res) => {
  const tenantId = (req as any).tenantId
  const { data, error } = await supabase.from('broadcasts')
    .insert({ ...req.body, tenant_id: tenantId }).select().single()
  if (error) { res.status(500).json({ error: error.message }); return }
  res.json(data)
})

// Send broadcast — enqueue to broadcast.batch (immediate) or schedule via scheduled_jobs.
// Replaces the legacy fire-and-forget for-loop. Per-message delivery + retries
// are handled by message-sender.ts; broadcast-worker.ts fans out per contact.
app.post('/api/broadcasts/:id/send', requireAuth, identifyTenant, checkPermission('whatsapp_automation', 'edit'), async (req, res) => {
  const tenantId = (req as any).tenantId
  const { data: broadcast } = await supabase.from('broadcasts').select('id, scheduled_at, status, template_name')
    .eq('id', req.params.id).eq('tenant_id', tenantId).maybeSingle()
  if (!broadcast) { res.status(404).json({ error: 'Broadcast not found' }); return }
  if (!broadcast.template_name) { res.status(400).json({ error: 'Broadcast has no template_name' }); return }
  if (broadcast.status === 'sending' || broadcast.status === 'sent') {
    res.status(409).json({ error: `Broadcast already ${broadcast.status}` }); return
  }

  // Schedule for later if scheduled_at is in the future.
  const sched = broadcast.scheduled_at ? new Date(broadcast.scheduled_at) : null
  if (sched && sched.getTime() > Date.now() + 5_000) {
    await supabase.from('scheduled_jobs').insert({
      tenant_id: tenantId,
      kind: 'broadcast_send',
      payload: { broadcastId: broadcast.id },
      resume_at: sched.toISOString(),
    })
    await supabase.from('broadcasts').update({ status: 'scheduled' }).eq('id', broadcast.id)
    res.json({ success: true, scheduled_for: sched.toISOString() }); return
  }

  // Send now: enqueue, return immediately.
  const { broadcastQueue } = await import('./queue')
  await broadcastQueue.add('batch', { broadcastId: broadcast.id })
  await supabase.from('broadcasts').update({ status: 'sending' }).eq('id', broadcast.id)
  res.json({ success: true, queued: true })
})

app.delete('/api/broadcasts/:id', requireAuth, identifyTenant, checkPermission('whatsapp_automation', 'delete'), async (req, res) => {
  const tenantId = (req as any).tenantId
  const { error } = await supabase.from('broadcasts').delete().eq('id', req.params.id).eq('tenant_id', tenantId)
  if (error) { res.status(500).json({ error: error.message }); return }
  res.json({ success: true })
})

// ── Contacts API ─────────────────────────────────────────────────────────────
app.get('/api/contacts', requireAuth, identifyTenant, checkPermission('leads', 'view'), async (req, res) => {
  const tenantId = (req as any).tenantId
  const { page, pageSize, offset } = parsePagination(req.query as Record<string, string>)
  const { search, tag, status, sortBy, sortOrder } = req.query as Record<string, string>

  let q = supabase.from('contacts').select('*', { count: 'exact' })
    .eq('tenant_id', tenantId)

  if (search) q = q.or(`name.ilike.%${search}%,phone.ilike.%${search}%,email.ilike.%${search}%`)
  if (tag) q = q.contains('tags', [tag])
  if (status && status !== 'all') q = q.eq('status', status)

  // Dynamic field filters
  const filtersRaw = req.query.filters as string
  if (filtersRaw) {
    try {
      const parsed = JSON.parse(filtersRaw)
      Object.entries(parsed).forEach(([key, val]) => {
        if (val) q = q.ilike(key, `%${val}%`)
      })
    } catch (e) {}
  }

  q = q.order(sortBy || 'created_at', { ascending: sortOrder === 'asc' })
    .range(offset, offset + pageSize - 1)

  const { data, count, error } = await q
  if (error) { res.status(500).json({ error: error.message }); return }
  const total = count ?? 0
  res.json({ data: data ?? [], total, page, pageSize, totalPages: Math.ceil(total / pageSize) })
})

app.post('/api/contacts', requireAuth, identifyTenant, checkPermission('leads', 'edit'), validateBody(ContactCreateSchema), async (req, res) => {
  const tenantId = (req as any).tenantId
  const { name, phone, email, tags } = req.body

  const cleanPhone = String(phone).replace(/^\+/, '')
  const { data, error } = await supabase.from('contacts')
    .insert({
      tenant_id: tenantId,
      name: name || 'New Contact',
      phone: cleanPhone,
      email,
      tags: tags || [],
      status: 'active'
    }).select().single()

  if (error) { res.status(500).json({ error: error.message }); return }
  res.json(data)
})

app.patch('/api/contacts/:id', requireAuth, identifyTenant, checkPermission('leads', 'edit'), validateBody(ContactPatchSchema), async (req, res) => {
  const tenantId = (req as any).tenantId
  const { data, error } = await supabase.from('contacts')
    .update(req.body).eq('id', req.params.id).eq('tenant_id', tenantId).select().single()
  if (error) { res.status(500).json({ error: error.message }); return }
  res.json(data)
})

app.delete('/api/contacts/:id', requireAuth, identifyTenant, checkPermission('leads', 'delete'), async (req, res) => {
  const tenantId = (req as any).tenantId
  const { error } = await supabase.from('contacts').delete().eq('id', req.params.id).eq('tenant_id', tenantId)
  if (error) { res.status(500).json({ error: error.message }); return }
  res.json({ success: true })
})

// Messages for a specific contact phone
app.get('/api/contacts/:phone/messages', requireAuth, identifyTenant, checkPermission('inbox', 'view'), async (req, res) => {
  const tenantId = (req as any).tenantId
  const phone = decodeURIComponent(req.params.phone as string).replace(/^\+/, '')
  const { data, error } = await supabase.from('messages')
    .select('*').eq('tenant_id', tenantId)
    .eq('contact_phone', phone)
    .order('created_at', { ascending: true })
    .limit(100)
  if (error) { res.status(500).json({ error: error.message }); return }
  res.json(data)
})

// Send message from inbox (agent reply)
app.post('/api/inbox/send', requireAuth, identifyTenant, checkPermission('inbox', 'edit'), validateBody(InboxSendSchema), async (req, res) => {
  const tenantId = (req as any).tenantId
  const { phone, type, text, template_name, template_language, template_params } = req.body
  
  const { data: tenant } = await supabase.from('tenants').select('*').eq('id', tenantId).single()
  if (!tenant?.access_token) { res.status(404).json({ error: 'No active tenant or WhatsApp not connected' }); return }

  try {
    const cleanPhone = String(phone).replace(/^\+/, '')
    if (type === 'text') {
      await sendTextMessage(tenant, cleanPhone, text)
    } else if (type === 'template') {
      await sendTemplateMessage(tenant, cleanPhone, template_name, template_language ?? 'en_US', template_params ?? [])
    }
    res.json({ success: true })
  } catch (err: any) {
    res.status(500).json({ error: err.message })
  }
})

// Toggle bot pause on a contact
app.patch('/api/contacts/:id/bot-pause', requireAuth, identifyTenant, checkPermission('leads', 'edit'), async (req, res) => {
  const tenantId = (req as any).tenantId
  const { bot_paused } = req.body
  const { data, error } = await supabase.from('contacts')
    .update({ bot_paused })
    .eq('id', req.params.id).eq('tenant_id', tenantId)
    .select().single()
  if (error) { res.status(500).json({ error: error.message }); return }
  res.json(data)
})

// ── Skills API ────────────────────────────────────────────────────────────────
app.get('/api/skills', requireAuth, async (req, res) => {
  const user = (req as any).user
  const { data, error } = await supabase.from('workflow_skills')
    .select('*')
    .or(`user_id.eq.${user.id},is_global.eq.true`)
    .order('usage_count', { ascending: false })
  if (error) { res.status(500).json({ error: error.message }); return }
  res.json(data)
})

app.post('/api/skills', requireAuth, async (req, res) => {
  const user = (req as any).user
  const { name, description, tags, workflow_json } = req.body
  const { data, error } = await supabase.from('workflow_skills')
    .insert({ user_id: user.id, name, description, tags: tags ?? [], workflow_json })
    .select().single()
  if (error) { res.status(500).json({ error: error.message }); return }
  res.json(data)
})

// Match user description to existing skills (keyword scoring)
app.post('/api/skills/match', requireAuth, async (req, res) => {
  const user = (req as any).user
  const { description } = req.body as { description: string }
  if (!description) { res.status(400).json({ error: 'description required' }); return }

  const { data: skills } = await supabase.from('workflow_skills')
    .select('*')
    .or(`user_id.eq.${user.id},is_global.eq.true`)
    .order('usage_count', { ascending: false })
    .limit(50)

  if (!skills?.length) { res.json({ matched: false }); return }

  // Score by word overlap between user description and skill description + tags
  const words = description.toLowerCase().replace(/[^a-z0-9\s]/g, '').split(/\s+/).filter((w: string) => w.length > 3)
  const scored = skills.map(s => {
    const haystack = (s.description + ' ' + (s.tags ?? []).join(' ')).toLowerCase()
    const score = words.reduce((acc: number, w: string) => acc + (haystack.includes(w) ? 1 : 0), 0)
    return { ...s, score }
  }).filter((s: any) => s.score > 0).sort((a: any, b: any) => b.score - a.score)

  if (scored.length > 0 && scored[0].score >= 2) {
    // Increment usage_count on the matched skill
    await supabase.from('workflow_skills').update({ usage_count: scored[0].usage_count + 1 }).eq('id', scored[0].id)
    res.json({ matched: true, skill: scored[0], score: scored[0].score })
  } else {
    res.json({ matched: false })
  }
})

// ── WhatsApp Webhook ──────────────────────────────────────────────────────────
// GET: Meta verification handshake
app.get('/webhook/whatsapp', (req, res) => {
  const mode      = req.query['hub.mode']
  const token     = req.query['hub.verify_token']
  const challenge = req.query['hub.challenge']
  if (mode === 'subscribe' && token === WH_VERIFY_TOKEN) {
    console.log('Webhook verified')
    res.status(200).send(challenge)
  } else {
    res.sendStatus(403)
  }
})

// POST: Inbound messages
app.post('/webhook/whatsapp', async (req, res) => {
  // Always ack immediately so Meta doesn't retry
  res.sendStatus(200)

  try {
    const body = req.body

    // ── Diagnostic logging ──
    const msgCount = body.entry?.reduce((acc: number, e: any) =>
      acc + (e.changes?.reduce((a2: number, c: any) =>
        a2 + (c.value?.messages?.length ?? 0), 0) ?? 0), 0) ?? 0
    const statusCount = body.entry?.reduce((acc: number, e: any) =>
      acc + (e.changes?.reduce((a2: number, c: any) =>
        a2 + (c.value?.statuses?.length ?? 0), 0) ?? 0), 0) ?? 0
    console.log(`[webhook] object=${body.object} | messages=${msgCount} | statuses=${statusCount}`)
    if (msgCount > 0) {
      const firstMsg = body.entry?.[0]?.changes?.[0]?.value?.messages?.[0]
      console.log(`[webhook] 📩 INBOUND from=${firstMsg?.from} type=${firstMsg?.type} text="${firstMsg?.text?.body ?? firstMsg?.button?.text ?? '(non-text)'}"`)
    }

    if (body.object !== 'whatsapp_business_account') return

    for (const entry of body.entry ?? []) {
      const wabaId: string = entry.id
      for (const change of entry.changes ?? []) {
        if (change.field !== 'messages') continue
        const value = change.value

        // Find tenant by WABA ID
        const { data: tenant } = await supabase.from('tenants')
          .select('*').eq('waba_id', wabaId).eq('status', 'active').single()
        if (!tenant) continue

        // Handle inbound messages
        for (const msg of value.messages ?? []) {
          await handleInboundMessage(tenant, msg, value.contacts?.[0])
        }

        // Handle status updates (delivered, read, etc.)
        for (const status of value.statuses ?? []) {
          await supabase.from('messages')
            .update({ status: status.status })
            .eq('wa_message_id', status.id)
        }
      }
    }
  } catch (err) {
    console.error('Webhook error:', err)
  }
})

async function handleInboundMessage(tenant: any, msg: any, contact: any) {
  const phone = msg.from // e.g. "919876543210"
  const text  = msg.text?.body ?? msg.button?.text ?? msg.interactive?.button_reply?.title ?? ''

  // Log the message (tenant-scoped)
  await supabase.from('messages').insert({
    tenant_id: tenant.id,
    direction: 'inbound',
    contact_phone: phone,
    wa_message_id: msg.id,
    content: msg,
  })

  // Upsert contact (tenant-scoped — fixes the user_id vs tenant_id leak from 008)
  await supabase.from('contacts').upsert({
    tenant_id: tenant.id,
    user_id:   tenant.user_id,            // kept for legacy RLS policies
    phone:     `+${phone}`,
    name:      contact?.profile?.name ?? `+${phone}`,
  }, { onConflict: 'tenant_id,phone' })

  // Active workflow session?
  const { data: session } = await supabase.from('workflow_sessions')
    .select('id, current_node_id, workflow:workflows(id)')
    .eq('tenant_id', tenant.id)
    .eq('contact_phone', phone)
    .eq('status', 'active')
    .order('started_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (session) {
    // Resume: enqueue execution of the current node with the reply payload.
    // The worker handles condition branching + variable assignment.
    await enqueueWorkflowExecution({
      sessionId: session.id,
      nodeId: session.current_node_id,
      reply: { text, raw: msg },
    })
  } else {
    await checkKeywordTriggers(tenant, phone, text)
  }
}

async function checkKeywordTriggers(tenant: any, phone: string, text: string) {
  // Tenant-scoped (was user_id-scoped before; broken once a user owned >1 tenant)
  const { data: workflows } = await supabase.from('workflows')
    .select('id, nodes')
    .eq('tenant_id', tenant.id)
    .eq('status', 'live')

  for (const wf of workflows ?? []) {
    const trigger = (wf.nodes as any[])?.find((n: any) => n.type === 'trigger_inbound_keyword')
    if (!trigger) continue
    const keywords: string[] = trigger.config?.keywords ?? []
    if (keywords.some((kw: string) => text.toLowerCase().includes(kw.toLowerCase()))) {
      await startWorkflow(tenant, wf, phone)
      break
    }
  }
}

async function startWorkflow(tenant: any, workflow: any, phone: string) {
  const nodes: any[] = workflow.nodes ?? []
  const firstAction = nodes.find((n: any) => !n.type?.startsWith('trigger_'))
  if (!firstAction) return

  const { data: session } = await supabase.from('workflow_sessions').insert({
    tenant_id: tenant.id,
    workflow_id: workflow.id,
    contact_phone: phone,
    current_node_id: firstAction.id,
    variables: {},
    status: 'active',
  }).select('id').single()

  if (session) {
    await enqueueWorkflowExecution({ sessionId: session.id, nodeId: firstAction.id })
  }
}

// NOTE: The inline executor (executeNode/resumeWorkflowSession/interpolate) has
// moved to src/engine/executor.ts and is driven by the BullMQ workflow.execute
// worker (src/workers/workflow-executor.ts). The webhook now enqueues a job
// instead of running nodes inline. See migration 010 + audit roadmap §1.

// Local interpolate kept ONLY for the legacy direct-send routes below.
function interpolate(text: string, vars: Record<string, string> = {}) {
  return (text ?? '').replace(/\{\{(\w+)\}\}/g, (_, k) => vars[k] ?? `{{${k}}}`)
}

async function sendTextMessage(tenant: any, to: string, text: string) {
  const payload = { messaging_product: 'whatsapp', to, type: 'text', text: { body: text } }
  const r = await fetch(`${GRAPH}/${tenant.phone_number_id}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${tenant.access_token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  })
  const data = await r.json() as any
  if (data.messages?.[0]?.id) {
    await supabase.from('messages').insert({
      tenant_id: tenant.id,
      direction: 'outbound',
      contact_phone: to,
      wa_message_id: data.messages[0].id,
      content: payload,
      status: 'sent',
    })
  }
  return data
}

async function sendTemplateMessage(tenant: any, to: string, templateName: string, language: string, parameters: string[]) {
  const components = parameters.length > 0 ? [{
    type: 'body',
    parameters: parameters.map(v => ({ type: 'text', text: v }))
  }] : []
  const payload = {
    messaging_product: 'whatsapp', to, type: 'template',
    template: { name: templateName, language: { code: language }, components }
  }
  const r = await fetch(`${GRAPH}/${tenant.phone_number_id}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${tenant.access_token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  })
  const data = await r.json() as any
  if (data.messages?.[0]?.id) {
    await supabase.from('messages').insert({
      tenant_id: tenant.id, direction: 'outbound', contact_phone: to,
      wa_message_id: data.messages[0].id, content: payload, status: 'sent',
    })
  }
  return data
}

async function sendInteractiveMessage(tenant: any, to: string, config: any) {
  const payload = {
    messaging_product: 'whatsapp', to, type: 'interactive',
    interactive: {
      type: 'button',
      body: { text: config.body ?? '' },
      action: {
        buttons: (config.buttons ?? []).slice(0, 3).map((b: any, i: number) => ({
          type: 'reply', reply: { id: `btn_${i}`, title: b.text ?? b }
        }))
      }
    }
  }
  const r = await fetch(`${GRAPH}/${tenant.phone_number_id}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${tenant.access_token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  })
  return r.json()
}

// ── RBAC / Team API ───────────────────────────────────────────────────────────

// Helper: resolve current user's role for their tenant
async function getUserRole(userId: string): Promise<{ role: string | null; tenantId: string | null }> {
  const { data: superRole } = await supabase.from('user_roles')
    .select('role').eq('user_id', userId).is('tenant_id', null).limit(1)
  if (superRole?.[0]?.role === 'super_admin') return { role: 'super_admin', tenantId: null }

  const { data: tenants } = await supabase.from('tenants')
    .select('id').eq('user_id', userId).eq('status', 'active').limit(1)
  const tenantId = tenants?.[0]?.id ?? null
  if (!tenantId) return { role: 'admin', tenantId: null }  // owner defaults to admin

  const { data: roleRow } = await supabase.from('user_roles')
    .select('role').eq('user_id', userId).eq('tenant_id', tenantId).limit(1)
  return { role: roleRow?.[0]?.role ?? 'admin', tenantId }
}

// Get current user's role info
app.get('/api/me/role', requireAuth, async (req, res) => {
  const user = (req as any).user
  const info = await getUserRole(user.id)
  res.json(info)
})

// List team members for the current user's tenant
app.get('/api/team', requireAuth, async (req, res) => {
  const user = (req as any).user
  const { tenantId } = await getUserRole(user.id)
  if (!tenantId) {
    res.status(400).json({ error: 'No active tenant' }); return
  }
  const { data, error } = await supabase.from('user_roles')
    .select('id,user_id,role,invited_by,created_at')
    .eq('tenant_id', tenantId)
  if (error) { res.status(500).json({ error: error.message }); return }
  res.json(data ?? [])
})

// ── Team API (Live RBAC routes are defined below) ───────────────────────────
// End of old Team API section

// Update a team member's role
app.patch('/api/team/:roleId', requireAuth, async (req, res) => {
  const user = (req as any).user
  const { role: myRole, tenantId } = await getUserRole(user.id)
  if (!['super_admin', 'admin'].includes(myRole ?? '')) {
    res.status(403).json({ error: 'Forbidden' }); return
  }
  if (!tenantId) { res.status(403).json({ error: 'No active tenant' }); return }
  const { role } = req.body
  const { error } = await supabase.from('user_roles').update({ role })
    .eq('id', req.params.roleId).eq('tenant_id', tenantId)
  if (error) { res.status(500).json({ error: error.message }); return }
  res.json({ success: true })
})

// Remove a team member
app.delete('/api/team/:roleId', requireAuth, async (req, res) => {
  const user = (req as any).user
  const { role: myRole, tenantId } = await getUserRole(user.id)
  if (!['super_admin', 'admin'].includes(myRole ?? '')) {
    res.status(403).json({ error: 'Forbidden' }); return
  }
  if (!tenantId) { res.status(403).json({ error: 'No active tenant' }); return }
  const { error } = await supabase.from('user_roles').delete()
    .eq('id', req.params.roleId).eq('tenant_id', tenantId)
  if (error) { res.status(500).json({ error: error.message }); return }
  res.json({ success: true })
})

// Get role permissions for this tenant (or defaults)
app.get('/api/team/permissions', requireAuth, async (req, res) => {
  const user = (req as any).user
  const { tenantId } = await getUserRole(user.id)
  const { data, error } = await supabase.from('role_permissions')
    .select('role,feature,can_view,can_edit,can_delete')
    .or(`tenant_id.eq.${tenantId ?? 'null'},tenant_id.is.null`)
    .order('role').order('feature')
  if (error) { res.status(500).json({ error: error.message }); return }
  res.json(data ?? [])
})

// Super admin: list all tenants with stats
app.get('/api/admin/tenants', requireAuth, async (req, res) => {
  const user = (req as any).user
  const { role } = await getUserRole(user.id)
  if (role !== 'super_admin') { res.status(403).json({ error: 'Super admin access required' }); return }

  const { data, error } = await supabase.from('tenants')
    .select('id,user_id,business_name,display_phone,waba_id,status,created_at')
    .order('created_at', { ascending: false })
  if (error) { res.status(500).json({ error: error.message }); return }
  res.json(data ?? [])
})

// Super admin: platform stats
app.get('/api/admin/stats', requireAuth, async (req, res) => {
  const user = (req as any).user
  const { role } = await getUserRole(user.id)
  if (role !== 'super_admin') { res.status(403).json({ error: 'Super admin access required' }); return }

  const [tenantsRes, contactsRes, msgsRes] = await Promise.all([
    supabase.from('tenants').select('*', { count: 'exact', head: true }),
    supabase.from('contacts').select('*', { count: 'exact', head: true }),
    supabase.from('messages').select('*', { count: 'exact', head: true }),
  ])
  res.json({
    tenants: tenantsRes.count ?? 0,
    contacts: contactsRes.count ?? 0,
    messages: msgsRes.count ?? 0,
  })
})

// Campaigns API
app.get('/api/campaigns', requireAuth, identifyTenant, checkPermission('whatsapp_automation', 'view'), async (req, res) => {
  const tenantId = (req as any).tenantId
  const { page, pageSize, offset } = parsePagination(req.query as Record<string, string>)
  const { search, status, sortBy, sortOrder } = req.query as Record<string, string>

  let q = supabase.from('campaigns').select('*', { count: 'exact' })
    .eq('tenant_id', tenantId)

  if (search) q = q.or(`name.ilike.%${search}%,description.ilike.%${search}%`)
  if (status && status !== 'all') q = q.eq('status', status)

  // Dynamic field filters
  const filtersRaw = req.query.filters as string
  if (filtersRaw) {
    try {
      const parsed = JSON.parse(filtersRaw)
      Object.entries(parsed).forEach(([key, val]) => {
        if (val) q = q.ilike(key, `%${val}%`)
      })
    } catch (e) {}
  }

  q = q.order(sortBy || 'created_at', { ascending: sortOrder === 'asc' })
    .range(offset, offset + pageSize - 1)

  const { data, count, error } = await q
  if (error) { res.status(500).json({ error: error.message }); return }
  const total = count ?? 0
  res.json({ data: data ?? [], total, page, pageSize, totalPages: Math.ceil(total / pageSize) })
})

app.post('/api/campaigns', requireAuth, identifyTenant, checkPermission('whatsapp_automation', 'edit'), validateBody(CampaignCreateSchema), async (req, res) => {
  const tenantId = (req as any).tenantId
  const { data, error } = await supabase.from('campaigns')
    .insert({ ...req.body, tenant_id: tenantId }).select().single()
  if (error) { res.status(500).json({ error: error.message }); return }
  res.json(data)
})

app.patch('/api/campaigns/:id', requireAuth, identifyTenant, checkPermission('whatsapp_automation', 'edit'), async (req, res) => {
  const tenantId = (req as any).tenantId
  const { data, error } = await supabase.from('campaigns')
    .update({ ...req.body, updated_at: new Date().toISOString() })
    .eq('id', req.params.id).eq('tenant_id', tenantId).select().single()
  if (error) { res.status(500).json({ error: error.message }); return }
  res.json(data)
})

app.delete('/api/campaigns/:id', requireAuth, identifyTenant, checkPermission('whatsapp_automation', 'delete'), async (req, res) => {
  const tenantId = (req as any).tenantId
  const { error } = await supabase.from('campaigns').delete()
    .eq('id', req.params.id).eq('tenant_id', tenantId)
  if (error) { res.status(500).json({ error: error.message }); return }
  res.json({ success: true })
})

// ── Integrations API ──────────────────────────────────────────────────────────
app.get('/api/integrations', requireAuth, identifyTenant, checkPermission('integrations', 'view'), async (req, res) => {
  const userId = (req as any).user.id
  const tenantId = (req as any).tenantId
  const { data: dbIntegrations, error } = await supabase.from('tenant_integrations')
    .select('key,status,label,config,connected_at').eq('tenant_id', tenantId)
  
  if (error) { res.status(500).json({ error: error.message }); return }
  
  const integrations = [...(dbIntegrations ?? [])]
  
  // Synthesize WhatsApp + Google integrations from the tenants row
  const { data: tenant } = await supabase.from('tenants')
    .select('waba_id,google_email,google_access_token,updated_at')
    .eq('id', tenantId).maybeSingle()

  if (tenant) {
    console.log(`[integrations] tenant=${tenantId} google_email=${tenant.google_email ?? 'null'} has_google_token=${!!tenant.google_access_token}`)
    if (tenant.waba_id && !integrations.find(i => i.key === 'whatsapp')) {
      integrations.push({ key: 'whatsapp', status: 'connected', label: tenant.waba_id, config: null, connected_at: tenant.updated_at } as any)
    }
    if (tenant.google_access_token) {
      const googleApps = ['google_drive', 'google_calendar', 'google_sheets', 'google_gmail']
      googleApps.forEach(key => {
        if (!integrations.find(i => i.key === key)) {
          integrations.push({ key, status: 'connected', label: tenant.google_email, config: null, connected_at: tenant.updated_at } as any)
        }
      })
    }
  }
  
  res.json(integrations)
})

// Google Sheets endpoints for lead importing
app.get('/api/google/spreadsheets', requireAuth, identifyTenant, checkPermission('google_sheets', 'view'), async (req, res) => {
  const userId = (req as any).user.id
  const tenantId = (req as any).tenantId
  const { data: tenant } = await supabase.from('tenants').select('*').eq('user_id', userId).eq('id', tenantId).maybeSingle()
  if (!tenant || !tenant.google_access_token) {
    res.status(400).json({ error: 'Google account not connected' }); return
  }
  try {
    const files = await listSpreadsheets(tenant)
    res.json(files)
  } catch (err: any) { res.status(500).json({ error: err.message }) }
})

app.get('/api/google/spreadsheets/:id', requireAuth, identifyTenant, checkPermission('google_sheets', 'view'), async (req, res) => {
  const tenantId = (req as any).tenantId
  const { data: tenant } = await supabase.from('tenants').select('*').eq('id', tenantId).maybeSingle()
  if (!tenant || !tenant.google_access_token) {
    res.status(400).json({ error: 'Google account not connected' }); return
  }
  try {
    const meta = await sheetsGetMetadata(tenant, req.params.id)
    const sheets = await Promise.all((meta.sheets ?? []).map(async (s: any) => {
      const name = s.properties.title
      // Read a larger chunk to ensure we get the data and headers correctly
      const values = await sheetsReadRange(tenant, req.params.id, `${name}!1:1000`)
      
      if (!values || values.length === 0) return { name, headers: [], rows: [] }

      // Find the best header row (most non-empty cells in first 20 rows)
      let headerIndex = -1
      let maxCols = 0
      for (let i = 0; i < Math.min(values.length, 20); i++) {
        const nonApparentEmpty = (values[i] || []).filter((v: any) => v && String(v).trim().length > 0).length
        if (nonApparentEmpty > maxCols) {
          maxCols = nonApparentEmpty
          headerIndex = i
        }
      }

      // If no good header found, default to first row
      if (headerIndex === -1) headerIndex = 0

      const headers = (values[headerIndex] ?? []).map((h: any, i: number) => String(h || '').trim() || `Column_${i + 1}`)
      
      // Filter out rows that are completely empty or are actually the header row
      const rows = values.slice(headerIndex + 1).filter(row => row.some(cell => cell && String(cell).trim())).map(row => {
        const obj: Record<string, string> = {}
        headers.forEach((h, i) => { 
          const val = row[i]
          obj[h] = (val === undefined || val === null) ? '' : String(val).trim()
        })
        return obj
      })
      
      return { name, headers, rows }
    }))
    res.json({ name: meta.properties.title, sheets })
  } catch (err: any) { 
    console.error('[google-sheets] READ ERROR:', err)
    res.status(500).json({ error: err.message }) 
  }
})

app.post('/api/integrations/razorpay', requireAuth, identifyTenant, checkPermission('integrations', 'edit'), validateBody(RazorpayConnectSchema), async (req, res) => {
  const tenantId = (req as any).tenantId
  const { key_id, key_secret } = req.body
  const { error } = await supabase.from('tenant_integrations').upsert({
    tenant_id: tenantId, key: 'razorpay', status: 'active',
    label: key_id,
    config: { key_id, key_secret_preview: key_secret.slice(0, 6) + '…' },
  }, { onConflict: 'tenant_id,key' })
  if (error) { res.status(500).json({ error: error.message }); return }
  res.json({ success: true })
})

app.delete('/api/integrations/:key', requireAuth, identifyTenant, async (req, res) => {
  const tenantId = (req as any).tenantId
  const key = req.params.key

  if (key === 'whatsapp') {
    const { error } = await supabase.from('tenants')
      .update({ waba_id: null, phone_number_id: null, display_phone: null, business_name: null })
      .eq('id', tenantId)
    if (error) { res.status(500).json({ error: error.message }); return }
    res.json({ success: true })
    return
  }

  if (key.startsWith('google_')) {
    const { error } = await supabase.from('tenants')
      .update({ google_email: null, google_access_token: null, google_refresh_token: null, google_token_expiry: null })
      .eq('id', tenantId)
    if (error) { res.status(500).json({ error: error.message }); return }
    res.json({ success: true })
    return
  }

  const { error } = await supabase.from('tenant_integrations')
    .delete().eq('tenant_id', tenantId).eq('key', key)
  if (error) { res.status(500).json({ error: error.message }); return }
  res.json({ success: true })
})

app.get('/api/features', async (req, res) => {
  const { data } = await supabase.from('system_features').select('*').order('name')
  res.json(data || [])
})

// ── Role Management API ───────────────────────────────────────────────────────

app.get('/api/roles', requireAuth, identifyTenant, async (req, res) => {
  const tenantId = (req as any).tenantId
  const { data } = await supabase.from('role_permissions').select('*').eq('tenant_id', tenantId)
  res.json(data || [])
})

app.post('/api/roles/permissions', requireAuth, identifyTenant, checkPermission('settings', 'edit'), async (req, res) => {
  const tenantId = (req as any).tenantId
  const { role, feature, can_view, can_edit, can_delete } = req.body
  
  const { data, error } = await supabase.from('role_permissions').upsert({
    tenant_id: tenantId,
    role,
    feature,
    can_view,
    can_edit,
    can_delete,
    updated_at: new Date().toISOString()
  })

  if (error) { res.status(500).json({ error: error.message }); return }
  res.json({ success: true })
})

app.get('/api/team', requireAuth, identifyTenant, checkPermission('settings', 'view'), async (req, res) => {
  const tenantId = (req as any).tenantId
  const { data, error } = await supabase.from('user_roles').select('*').eq('tenant_id', tenantId)
  if (error) { res.status(500).json({ error: error.message }); return }
  res.json({ success: true, team: data || [] })
})

app.post('/api/team/invite', requireAuth, identifyTenant, checkPermission('settings', 'edit'), async (req, res) => {
  const tenantId = (req as any).tenantId
  const { email, role } = req.body
  
  try {
    // 1. Trigger Supabase Invitation
    const { data: invite, error: inviteError } = await supabase.auth.admin.inviteUserByEmail(email, {
      redirectTo: `${process.env.FRONTEND_URL || 'http://localhost:5173'}/auth`
    })

    if (inviteError) {
      // If user already exists, we'll just add the role instead of failing
      if (inviteError.message.includes('already registered')) {
        // Find user ID by email (hacky but effective for development)
        const { data: existingUser } = await supabase.auth.admin.listUsers()
        const user = existingUser.users.find(u => u.email === email)
        if (user) {
          await supabase.from('user_roles').upsert({
            user_id: user.id,
            tenant_id: tenantId,
            role
          })
          return res.json({ success: true, message: `${email} is already on Frequency and has been added to your team.` })
        }
      }
      return res.status(500).json({ error: inviteError.message })
    }

    // 2. Map the new role for the invited user ID
    const { error: roleError } = await supabase.from('user_roles').upsert({
      user_id: invite.user.id,
      tenant_id: tenantId,
      role
    })

    if (roleError) return res.status(500).json({ error: roleError.message })
    
    res.json({ success: true, message: `Invitation sent to ${email}` })
  } catch (err: any) {
    res.status(500).json({ error: err.message })
  }
})

// ── Dev seed endpoint ─────────────────────────────────────────────────────────
if (process.env.NODE_ENV !== 'production') {
  app.post('/api/dev/seed', requireAuth, async (req, res) => {
    const user = (req as any).user

    const contacts = [
      { user_id: user.id, name: 'Rahul Sharma',  phone: '919876543210', tags: ['lead', 'premium'], status: 'active',    attributes: { source: 'website',  city: 'Mumbai'    } },
      { user_id: user.id, name: 'Priya Patel',   phone: '918765432109', tags: ['customer', 'vip'], status: 'active',    attributes: { source: 'referral', city: 'Delhi'     } },
      { user_id: user.id, name: 'Amit Kumar',    phone: '917654321098', tags: ['lead'],             status: 'active',    attributes: { source: 'ad',       city: 'Bangalore' } },
      { user_id: user.id, name: 'Sneha Reddy',   phone: '916543210987', tags: ['customer'],         status: 'active',    attributes: { source: 'website',  city: 'Hyderabad' } },
      { user_id: user.id, name: 'Vijay Nair',    phone: '915432109876', tags: ['opted_out'],        status: 'opted_out', attributes: {}                                       },
    ]
    const { error: cErr, data: contactRows } = await supabase.from('contacts')
      .upsert(contacts, { onConflict: 'phone' }).select('id,name,phone')
    if (cErr) { res.status(500).json({ error: cErr.message }); return }

    // Seed broadcasts
    const broadcasts = [
      { user_id: user.id, name: 'May Diwali Promo',     template_name: 'diwali_offer',   status: 'sent',      audience: { all: true },                stats: { sent: 1240, delivered: 1198, read: 876, replied: 43, failed: 42 },  sent_at: new Date(Date.now() - 7  * 86400e3).toISOString() },
      { user_id: user.id, name: 'Cart Recovery Wave 1', template_name: 'cart_recovery',  status: 'sent',      audience: { tags: ['lead'] },           stats: { sent: 312,  delivered: 298,  read: 201, replied: 18, failed: 14 },  sent_at: new Date(Date.now() - 3  * 86400e3).toISOString() },
      { user_id: user.id, name: 'New Product Launch',   template_name: 'product_launch', status: 'scheduled', audience: { all: true },                stats: { sent: 0, delivered: 0, read: 0, replied: 0, failed: 0 },           scheduled_at: new Date(Date.now() + 2 * 86400e3).toISOString() },
      { user_id: user.id, name: 'VIP Reactivation',     template_name: 'vip_promo',      status: 'draft',     audience: { tags: ['customer', 'vip'] }, stats: { sent: 0, delivered: 0, read: 0, replied: 0, failed: 0 } },
    ]
    // Delete existing seed broadcasts then re-insert (avoids constraint issues)
    await supabase.from('broadcasts').delete()
      .eq('user_id', user.id)
      .in('name', broadcasts.map((b: any) => b.name))
    const { error: bErr } = await supabase.from('broadcasts').insert(broadcasts)
    if (bErr) { res.status(500).json({ error: bErr.message }); return }

    // Seed messages (inbox) — only if we have a tenant
    const { data: tenantRow } = await supabase.from('tenants')
      .select('id').eq('user_id', user.id).eq('status', 'active').limit(1)
    const tenantId = tenantRow?.[0]?.id

    let messagesSeeded = 0
    if (tenantId && contactRows && contactRows.length > 0) {
      const now = Date.now()
      const msgs: any[] = []
      const convos = [
        { name: 'Rahul Sharma', phone: '919876543210', thread: [
          { dir: 'inbound',  text: "Hi! I saw your ad on Instagram. What products do you offer?",           ago: 3600 },
          { dir: 'outbound', text: "Hello Rahul! We offer premium skincare products. Would you like to see our catalog?", ago: 3500 },
          { dir: 'inbound',  text: "Yes please! Also what are your delivery charges?",                      ago: 3000 },
          { dir: 'outbound', text: "Free delivery on orders above ₹499. Here's our catalog link 🛍️",      ago: 2900 },
          { dir: 'inbound',  text: "Great! I'll place an order today.",                                     ago: 1800 },
        ]},
        { name: 'Priya Patel', phone: '918765432109', thread: [
          { dir: 'inbound',  text: "When will my order #ORD-4521 be delivered?",                            ago: 7200 },
          { dir: 'outbound', text: "Hi Priya! Your order is out for delivery and will arrive by 6 PM today.", ago: 7100 },
          { dir: 'inbound',  text: "Thank you! 😊",                                                         ago: 7000 },
        ]},
        { name: 'Amit Kumar', phone: '917654321098', thread: [
          { dir: 'inbound',  text: "Do you have any offers running this week?",                              ago: 86400 },
          { dir: 'outbound', text: "Yes Amit! Use code SAVE20 for 20% off on all orders till Sunday!",     ago: 86300 },
          { dir: 'inbound',  text: "Amazing! Will use it. Thanks",                                          ago: 86200 },
        ]},
        { name: 'Sneha Reddy', phone: '916543210987', thread: [
          { dir: 'inbound',  text: "I have a complaint. My package arrived damaged.",                        ago: 14400 },
          { dir: 'outbound', text: "We are really sorry to hear that Sneha! Please share a photo of the damage.", ago: 14300 },
          { dir: 'inbound',  text: "Sending photo now",                                                     ago: 14200 },
          { dir: 'inbound',  text: "Here's the photo [image]",                                              ago: 14100 },
          { dir: 'outbound', text: "Thank you! We will initiate a replacement within 24 hours.",            ago: 14000 },
        ]},
      ]

      for (const convo of convos) {
        const contact = contactRows.find((c: any) => c.phone === convo.phone)
        if (!contact) continue
        for (const m of convo.thread) {
          msgs.push({
            tenant_id: tenantId,
            contact_id: contact.id,
            direction: m.dir,
            content: m.text,
            message_type: 'text',
            status: m.dir === 'outbound' ? 'delivered' : 'received',
            created_at: new Date(now - m.ago * 1000).toISOString(),
          })
        }
      }

      const { error: mErr } = await supabase.from('messages').insert(msgs)
      if (!mErr) messagesSeeded = msgs.length
    }

    // Seed campaigns
    const campaignNames = ['Lead Nurture Drip', 'Post-Purchase Review', 'Cart Recovery Sequence', 'VIP Loyalty Program']
    await supabase.from('campaigns').delete().eq('user_id', user.id).in('name', campaignNames)
    const campaigns = [
      { user_id: user.id, name: 'Lead Nurture Drip',      description: '5-touch drip for new website leads',     type: 'drip',      status: 'active',    stats: { enrolled: 248,  active: 112, converted: 34, revenue: 68000  } },
      { user_id: user.id, name: 'Post-Purchase Review',   description: 'Ask for Google review 3 days after order', type: 'triggered', status: 'active',    stats: { enrolled: 891,  active: 45,  converted: 221,revenue: 0      } },
      { user_id: user.id, name: 'Cart Recovery Sequence', description: '3-message cart abandonment recovery',     type: 'drip',      status: 'paused',    stats: { enrolled: 134,  active: 0,   converted: 22, revenue: 44000  } },
      { user_id: user.id, name: 'VIP Loyalty Program',   description: 'Exclusive offers for repeat customers',   type: 'drip',      status: 'draft',     stats: { enrolled: 0,    active: 0,   converted: 0,  revenue: 0      } },
    ]
    await supabase.from('campaigns').insert(campaigns)

    res.json({
      success: true,
      seeded: {
        contacts: contacts.length,
        broadcasts: broadcasts.length,
        messages: messagesSeeded,
        campaigns: campaigns.length,
      }
    })
  })
}

// ── Lead Intake module ────────────────────────────────────────────────────────
app.use('/api', createLeadsRouter(supabase, requireAuth, identifyTenant, checkPermission))
app.use('/api/admin', createAdminRouter(supabase, requireAuth))

// ── Phase 3: campaigns, analytics, execution logs, activity ──────────────────
app.use(createPhase3Router({ supabase, requireAuth, identifyTenant, checkPermission }))

// ── Data-source mirroring (Google Sheets → Lead Tables, more sources later) ──
app.use(createDataSourcesRouter({ supabase, requireAuth, identifyTenant, checkPermission }))

// ── Connector registry + per-app OAuth, capabilities ─────────────────────────
app.use(createConnectorsRouter({ supabase, requireAuth, identifyTenant, checkPermission }))

// ── Bull Board (queue dashboard) ──────────────────────────────────────────────
// Mounted at /admin/queues. Guarded — only super_admin (or local dev) can view.
const bullBoardAdapter = new ExpressAdapter()
bullBoardAdapter.setBasePath('/admin/queues')
createBullBoard({
  queues: [
    new BullMQAdapter(workflowQueue),
    new BullMQAdapter(messageQueue),
    new BullMQAdapter(broadcastQueue),
    new BullMQAdapter(cronQueue),
  ],
  serverAdapter: bullBoardAdapter,
})
async function requireSuperAdminOrLocal(req: express.Request, res: express.Response, next: express.NextFunction) {
  // Allow unauthed access on local dev for convenience
  if (process.env.NODE_ENV !== 'production' && (req.hostname === 'localhost' || req.hostname === '127.0.0.1')) return next()
  const token = req.headers.authorization?.replace('Bearer ', '') || (req.query.token as string)
  if (!token) { res.status(401).send('auth required'); return }
  const { data: { user } } = await supabase.auth.getUser(token)
  if (!user) { res.status(401).send('invalid token'); return }
  const { data: superRole } = await supabase.from('user_roles')
    .select('role').eq('user_id', user.id).is('tenant_id', null).limit(1)
  if (superRole?.[0]?.role !== 'super_admin') { res.status(403).send('super admin only'); return }
  next()
}
app.use('/admin/queues', requireSuperAdminOrLocal, bullBoardAdapter.getRouter())

if (process.env.NODE_ENV !== 'production') attachDebugListeners()

const server = app.listen(PORT, () => {
  console.log(`Frequency server running on http://localhost:${PORT}`)
  console.log(`  → Bull Board: http://localhost:${PORT}/admin/queues`)
})

// Graceful shutdown — finish in-flight requests + close queue connections.
async function shutdown(signal: string) {
  console.log(`[shutdown] received ${signal}`)
  const { closeQueues } = await import('./queue')
  server.close(async () => {
    await closeQueues()
    process.exit(0)
  })
  // Hard-exit if shutdown hangs >10s
  setTimeout(() => process.exit(1), 10_000).unref()
}
process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT',  () => shutdown('SIGINT'))
