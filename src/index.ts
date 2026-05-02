import 'dotenv/config'
import express from 'express'
import cors from 'cors'
import { createClient } from '@supabase/supabase-js'
import Anthropic from '@anthropic-ai/sdk'
import { sheetsAppendRow, sheetsUpdateRange, calendarCreateEvent, calendarCheckAvailability } from './google'

const app = express()
const PORT = process.env.PORT || 3001

app.use(cors({ origin: process.env.FRONTEND_URL || 'http://localhost:5173' }))
app.use(express.json())

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://yiicpndeggaedxobyopu.supabase.co'
const supabase = createClient(SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY!)

const META_APP_ID     = process.env.META_APP_ID!
const META_APP_SECRET = process.env.META_APP_SECRET!
const GRAPH           = 'https://graph.facebook.com/v18.0'
const WH_VERIFY_TOKEN = process.env.WH_VERIFY_TOKEN || 'flowgpt_webhook_secret'

// ── Auth middleware ───────────────────────────────────────────────────────────
async function requireAuth(req: express.Request, res: express.Response, next: express.NextFunction) {
  const token = req.headers.authorization?.replace('Bearer ', '')
  if (!token) { res.status(401).json({ error: 'Unauthorized' }); return }
  const { data: { user }, error } = await supabase.auth.getUser(token)
  if (error || !user) { res.status(401).json({ error: 'Invalid token' }); return }
  ;(req as any).user = user
  next()
}

// ── Health ────────────────────────────────────────────────────────────────────
app.get('/health', (_req, res) => res.json({ status: 'ok', service: 'flowgpt-server' }))

// ── NLP Parse (streaming) ─────────────────────────────────────────────────────
const SYSTEM_PROMPT = `You are a WhatsApp Business API workflow architect inside FlowGPT.

Parse the user's plain-language automation intent and return ONLY a compact JSON workflow blueprint. No prose, no markdown, no code blocks — pure JSON only.

NODE TYPES (use exact strings):
Triggers: trigger_form_submit, trigger_webhook, trigger_sheet_row, trigger_inbound_keyword, trigger_scheduled, trigger_api, trigger_broadcast_reply
Actions: send_text, send_template, send_interactive, collect_input, send_payment_link, update_crm, update_sheet, http_request, run_ai_responder, assign_agent, add_tag, wait_delay
Logic: condition_reply, condition_button_click, condition_variable, condition_time, split_ab, end_flow

WHATSAPP RULES (always enforce):
- Free-form messages only within 24h of last user message
- Outside 24h window → approved template required (mark template_required: true)
- Marketing templates need opt-in proof
- Quick reply buttons: max 3, CTA buttons: max 2, never mix types

OUTPUT SCHEMA (be concise, omit null/empty arrays):
{
  "workflow_name": "string",
  "description": "string",
  "trigger_summary": "string",
  "nodes": [{
    "id": "node_1",
    "type": "string",
    "label": "string",
    "description": "string",
    "position": 1,
    "config": {},
    "missing_config": [{"field":"","label":"","type":"text|textarea|select|number|url","required":true,"placeholder":"","options":[]}],
    "connections": {"default": "node_2"},
    "template_required": false,
    "compliance_note": null,
    "warnings": []
  }],
  "required_integrations": [{"key":"","name":"","reason":"","required":true}],
  "template_required": false,
  "templates_needed": [{"purpose":"","suggested_name":"","category":"MARKETING|UTILITY|AUTHENTICATION","body_preview":"","variables":[],"approval_time":"24-72 hours"}],
  "compliance_flags": [{"severity":"error|warning|info","message":"","how_to_fix":""}],
  "missing_info": [],
  "config_completion_percent": 60,
  "overall_status": "needs_config",
  "blocking_issues": []
}

Be concise. Keep descriptions under 15 words. Keep compliance_note under 20 words. Only include fields that have values.`

app.post('/api/parse-workflow', requireAuth, async (req, res) => {
  const { message, history = [] } = req.body
  if (!message) { res.status(400).json({ error: 'message required' }); return }

  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')

  try {
    const stream = await anthropic.messages.stream({
      model: 'claude-sonnet-4-6',
      max_tokens: 4096,
      system: SYSTEM_PROMPT,
      messages: [...history, { role: 'user' as const, content: message }],
    })

    for await (const chunk of stream) {
      if (chunk.type === 'content_block_delta' && chunk.delta.type === 'text_delta') {
        res.write(`data: ${JSON.stringify({ text: chunk.delta.text })}\n\n`)
      }
    }
    res.write('data: [DONE]\n\n')
    res.end()
  } catch (err: any) {
    res.write(`data: ${JSON.stringify({ error: err.message })}\n\n`)
    res.end()
  }
})

// ── Workflows CRUD ────────────────────────────────────────────────────────────
app.get('/api/workflows', requireAuth, async (req, res) => {
  const user = (req as any).user
  const { data, error } = await supabase.from('workflows').select('*')
    .eq('user_id', user.id).order('created_at', { ascending: false })
  if (error) { res.status(500).json({ error: error.message }); return }
  res.json(data)
})

app.post('/api/workflows', requireAuth, async (req, res) => {
  const user = (req as any).user
  const { data, error } = await supabase.from('workflows')
    .insert({ ...req.body, user_id: user.id }).select().single()
  if (error) { res.status(500).json({ error: error.message }); return }
  res.json(data)
})

app.patch('/api/workflows/:id', requireAuth, async (req, res) => {
  const user = (req as any).user
  const { data, error } = await supabase.from('workflows')
    .update({ ...req.body, updated_at: new Date().toISOString() })
    .eq('id', req.params.id).eq('user_id', user.id).select().single()
  if (error) { res.status(500).json({ error: error.message }); return }
  res.json(data)
})

app.delete('/api/workflows/:id', requireAuth, async (req, res) => {
  const user = (req as any).user
  const { error } = await supabase.from('workflows')
    .delete().eq('id', req.params.id).eq('user_id', user.id)
  if (error) { res.status(500).json({ error: error.message }); return }
  res.json({ success: true })
})

// ── Tenants CRUD ──────────────────────────────────────────────────────────────
app.get('/api/tenants', requireAuth, async (req, res) => {
  const user = (req as any).user
  const { data, error } = await supabase.from('tenants')
    .select('id,waba_id,phone_number_id,business_name,display_phone,status,google_email,created_at')
    .eq('user_id', user.id)
  if (error) { res.status(500).json({ error: error.message }); return }
  res.json(data)
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
    await fetch(`${GRAPH}/${waba_id}/subscribed_apps`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${longToken}` }
    })

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
    'https://www.googleapis.com/auth/drive.file',
    'email', 'profile'
  ].join(' ')
  const state = Buffer.from(JSON.stringify({ userId: user.id, tenantId: req.query.tenant_id })).toString('base64')
  const url = `https://accounts.google.com/o/oauth2/v2/auth?client_id=${GOOGLE_CLIENT_ID}&redirect_uri=${encodeURIComponent(GOOGLE_REDIRECT_URI)}&response_type=code&scope=${encodeURIComponent(scopes)}&access_type=offline&prompt=consent&state=${state}`
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

    const expiry = new Date(Date.now() + tokens.expires_in * 1000).toISOString()

    // Store on tenant if tenantId provided, otherwise on all user's tenants
    const update = {
      google_email: profile.email,
      google_access_token: tokens.access_token,
      google_refresh_token: tokens.refresh_token,
      google_token_expiry: expiry,
      updated_at: new Date().toISOString(),
    }

    if (tenantId) {
      await supabase.from('tenants').update(update).eq('id', tenantId).eq('user_id', userId)
    } else {
      await supabase.from('tenants').update(update).eq('user_id', userId)
    }

    // Redirect back to frontend
    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:5173'
    res.redirect(`${frontendUrl}/onboarding?google=connected`)
  } catch (err: any) {
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
  const tenant = await getTenant(user.id, req.query.tenant_id as string)
  if (!tenant) { res.status(404).json({ error: 'No connected WhatsApp account' }); return }

  try {
    const r = await fetch(
      `${GRAPH}/${tenant.waba_id}/message_templates?fields=id,name,status,category,language,components&limit=100`,
      { headers: { Authorization: `Bearer ${tenant.access_token}` } }
    )
    const data = await r.json() as any
    if (data.error) { res.status(400).json({ error: data.error.message }); return }
    res.json(data.data ?? [])
  } catch (err: any) { res.status(500).json({ error: err.message }) }
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
app.get('/api/broadcasts', requireAuth, async (req, res) => {
  const user = (req as any).user
  const { data, error } = await supabase.from('broadcasts').select('*')
    .eq('user_id', user.id).order('created_at', { ascending: false })
  if (error) { res.status(500).json({ error: error.message }); return }
  res.json(data)
})

app.post('/api/broadcasts', requireAuth, async (req, res) => {
  const user = (req as any).user
  const { data, error } = await supabase.from('broadcasts')
    .insert({ ...req.body, user_id: user.id }).select().single()
  if (error) { res.status(500).json({ error: error.message }); return }
  res.json(data)
})

// Send broadcast — fetch audience contacts, fire template messages
app.post('/api/broadcasts/:id/send', requireAuth, async (req, res) => {
  const user = (req as any).user
  const { data: broadcast } = await supabase.from('broadcasts').select('*')
    .eq('id', req.params.id).eq('user_id', user.id).single()
  if (!broadcast) { res.status(404).json({ error: 'Broadcast not found' }); return }

  const tenant = await getTenant(user.id)
  if (!tenant) { res.status(404).json({ error: 'No connected WhatsApp account' }); return }

  // Build contact query based on audience filters
  let q = supabase.from('contacts').select('id,phone,name').eq('user_id', user.id).eq('status', 'active')
  if (broadcast.audience?.tags?.length) q = q.overlaps('tags', broadcast.audience.tags)

  const { data: contacts } = await q
  if (!contacts?.length) { res.status(400).json({ error: 'No contacts match audience' }); return }

  // Update status
  await supabase.from('broadcasts').update({ status: 'sending', sent_at: new Date().toISOString() }).eq('id', broadcast.id)

  res.json({ success: true, recipients: contacts.length })

  // Fire in background
  let sent = 0, failed = 0
  for (const contact of contacts) {
    try {
      await sendTemplateMessage(tenant, contact.phone.replace(/^\+/, ''), broadcast.template_name, 'en_US', [])
      sent++
    } catch { failed++ }
    await new Promise(r => setTimeout(r, 200)) // 5/sec rate limit
  }

  await supabase.from('broadcasts').update({
    status: 'sent',
    stats: { sent, failed, delivered: 0, read: 0, replied: 0 },
    updated_at: new Date().toISOString(),
  }).eq('id', broadcast.id)
})

app.delete('/api/broadcasts/:id', requireAuth, async (req, res) => {
  const user = (req as any).user
  const { error } = await supabase.from('broadcasts').delete().eq('id', req.params.id).eq('user_id', user.id)
  if (error) { res.status(500).json({ error: error.message }); return }
  res.json({ success: true })
})

// ── Contacts API ─────────────────────────────────────────────────────────────
app.get('/api/contacts', requireAuth, async (req, res) => {
  const user = (req as any).user
  const { search, tag } = req.query as Record<string, string>
  let q = supabase.from('contacts').select('*').eq('user_id', user.id).order('created_at', { ascending: false })
  if (search) q = q.or(`name.ilike.%${search}%,phone.ilike.%${search}%`)
  if (tag) q = q.contains('tags', [tag])
  const { data, error } = await q
  if (error) { res.status(500).json({ error: error.message }); return }
  res.json(data)
})

app.patch('/api/contacts/:id', requireAuth, async (req, res) => {
  const user = (req as any).user
  const { data, error } = await supabase.from('contacts')
    .update(req.body).eq('id', req.params.id).eq('user_id', user.id).select().single()
  if (error) { res.status(500).json({ error: error.message }); return }
  res.json(data)
})

app.delete('/api/contacts/:id', requireAuth, async (req, res) => {
  const user = (req as any).user
  const { error } = await supabase.from('contacts').delete().eq('id', req.params.id).eq('user_id', user.id)
  if (error) { res.status(500).json({ error: error.message }); return }
  res.json({ success: true })
})

// Messages for a specific contact phone
app.get('/api/contacts/:phone/messages', requireAuth, async (req, res) => {
  const user = (req as any).user
  // Find tenant belonging to user
  const { data: tenants } = await supabase.from('tenants').select('id').eq('user_id', user.id)
  const tenantIds = (tenants ?? []).map((t: any) => t.id)
  if (tenantIds.length === 0) { res.json([]); return }

  const phone = decodeURIComponent(req.params.phone as string).replace(/^\+/, '')
  const { data, error } = await supabase.from('messages')
    .select('*').in('tenant_id', tenantIds)
    .eq('contact_phone', phone)
    .order('created_at', { ascending: true })
    .limit(100)
  if (error) { res.status(500).json({ error: error.message }); return }
  res.json(data)
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

  // Log the message
  await supabase.from('messages').insert({
    tenant_id: tenant.id,
    direction: 'inbound',
    contact_phone: phone,
    wa_message_id: msg.id,
    content: msg,
  })

  // Upsert contact
  await supabase.from('contacts').upsert({
    user_id: tenant.user_id,
    phone: `+${phone}`,
    name: contact?.profile?.name ?? `+${phone}`,
  }, { onConflict: 'user_id,phone' })

  // Check for active workflow session
  const { data: session } = await supabase.from('workflow_sessions')
    .select('*, workflow:workflows(*)')
    .eq('tenant_id', tenant.id)
    .eq('contact_phone', phone)
    .eq('status', 'active')
    .order('started_at', { ascending: false })
    .limit(1)
    .single()

  if (session) {
    // Resume existing session with this reply
    await resumeWorkflowSession(tenant, session, text, msg)
  } else {
    // Check keyword triggers
    await checkKeywordTriggers(tenant, phone, text)
  }
}

async function checkKeywordTriggers(tenant: any, phone: string, text: string) {
  const { data: workflows } = await supabase.from('workflows')
    .select('*')
    .eq('user_id', tenant.user_id)
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
  const firstAction = nodes.find((n: any) => !n.type.startsWith('trigger_'))
  if (!firstAction) return

  const { data: session } = await supabase.from('workflow_sessions').insert({
    tenant_id: tenant.id,
    workflow_id: workflow.id,
    contact_phone: phone,
    current_node_id: firstAction.id,
    variables: {},
    status: 'active',
  }).select().single()

  if (session) await executeNode(tenant, session, firstAction)
}

async function resumeWorkflowSession(tenant: any, session: any, reply: string, rawMsg: any) {
  const nodes: any[] = session.workflow.nodes ?? []
  const currentNode = nodes.find((n: any) => n.id === session.current_node_id)
  if (!currentNode) return

  // Store reply as variable if collect_input node
  let variables = { ...(session.variables ?? {}) }
  if (currentNode.type === 'collect_input' && currentNode.config?.variable_name) {
    variables[currentNode.config.variable_name] = reply
  }

  // Determine next node
  let nextNodeId: string | null = null
  if (currentNode.type === 'condition_reply' || currentNode.type === 'condition_button_click') {
    const branches: Record<string, string> = currentNode.connections ?? {}
    const match = Object.keys(branches).find(k => reply.toLowerCase().includes(k.toLowerCase()))
    nextNodeId = match ? branches[match] : branches['default'] ?? null
  } else {
    nextNodeId = currentNode.connections?.default ?? null
  }

  if (!nextNodeId || nextNodeId === 'end_flow') {
    await supabase.from('workflow_sessions').update({ status: 'completed', updated_at: new Date().toISOString() }).eq('id', session.id)
    return
  }

  const nextNode = nodes.find((n: any) => n.id === nextNodeId)
  if (!nextNode) return

  await supabase.from('workflow_sessions').update({
    current_node_id: nextNodeId,
    variables,
    updated_at: new Date().toISOString(),
  }).eq('id', session.id)

  await executeNode(tenant, { ...session, variables }, nextNode)
}

async function executeNode(tenant: any, session: any, node: any) {
  switch (node.type) {
    case 'send_text':
      await sendTextMessage(tenant, session.contact_phone, interpolate(node.config?.text ?? '', session.variables))
      // Auto-advance if next node exists and isn't collect_input
      break

    case 'send_template': {
      await sendTemplateMessage(tenant, session.contact_phone, node.config?.template_name, node.config?.language ?? 'en_US', node.config?.parameters ?? [])
      break
    }

    case 'send_interactive': {
      await sendInteractiveMessage(tenant, session.contact_phone, node.config)
      break
    }

    case 'collect_input':
      // Just send the prompt; wait for next inbound message
      if (node.config?.prompt) {
        await sendTextMessage(tenant, session.contact_phone, interpolate(node.config.prompt, session.variables))
      }
      break

    case 'update_sheet': {
      const { spreadsheet_id, range, values = [] } = node.config ?? {}
      if (spreadsheet_id && range && tenant.google_access_token) {
        const interpolated = (values as string[]).map((v: string) => interpolate(v, session.variables))
        if (node.config?.mode === 'update') {
          await sheetsUpdateRange(tenant, spreadsheet_id, range, [interpolated])
        } else {
          await sheetsAppendRow(tenant, spreadsheet_id, range, interpolated)
        }
      }
      break
    }

    case 'create_calendar_event': {
      const cfg = node.config ?? {}
      if (tenant.google_access_token && cfg.summary) {
        await calendarCreateEvent(tenant, cfg.calendar_id ?? 'primary', {
          summary:         interpolate(cfg.summary, session.variables),
          description:     cfg.description ? interpolate(cfg.description, session.variables) : undefined,
          location:        cfg.location    ? interpolate(cfg.location, session.variables)    : undefined,
          startTime:       interpolate(cfg.start_time, session.variables),
          endTime:         interpolate(cfg.end_time,   session.variables),
          timeZone:        cfg.time_zone ?? 'Asia/Kolkata',
          attendeeEmails:  cfg.attendee_emails ?? [],
        })
      }
      break
    }

    case 'check_calendar_availability': {
      const cfg = node.config ?? {}
      if (tenant.google_access_token && cfg.variable_name) {
        const available = await calendarCheckAvailability(
          tenant,
          cfg.calendar_id ?? 'primary',
          interpolate(cfg.start_time, session.variables),
          interpolate(cfg.end_time,   session.variables),
        )
        await supabase.from('workflow_sessions').update({
          variables: { ...(session.variables ?? {}), [cfg.variable_name]: available ? 'yes' : 'no' },
          updated_at: new Date().toISOString(),
        }).eq('id', session.id)
      }
      break
    }

    case 'wait_delay':
      // Schedule resume (simplified: just advance immediately in dev)
      break

    case 'end_flow':
      await supabase.from('workflow_sessions').update({ status: 'completed', updated_at: new Date().toISOString() }).eq('id', session.id)
      break
  }
}

function interpolate(text: string, vars: Record<string, string> = {}) {
  return text.replace(/\{\{(\w+)\}\}/g, (_, k) => vars[k] ?? `{{${k}}}`)
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

app.listen(PORT, () => console.log(`FlowGPT server running on http://localhost:${PORT}`))
