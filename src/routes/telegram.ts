/**
 * Telegram endpoints — bot connect, send, broadcasts, mini-apps, payments,
 * channels, bot settings.
 *
 * Connect flow (`bot_token` auth mode):
 *   1. User pastes the token from @BotFather into the AppsModal.
 *   2. POST /api/telegram/connect verifies the token via getMe and stores
 *      the bot row (token AES-encrypted).
 *   3. POST /api/telegram/bot/webhook sets the public webhook URL with
 *      the Bot API.
 *
 * Inbound webhook → /webhook/telegram inserts a `messages` row with
 * channel='telegram' and upserts the contact with telegram_id.
 *
 * The webhook supports the routes mounted at /api/* + the /webhook/telegram
 * non-auth route. Only the latter is exposed publicly.
 */

import express from 'express'
import { SupabaseClient } from '@supabase/supabase-js'
import { encrypt, decrypt } from '../crypto'

type Middleware = (req: express.Request, res: express.Response, next: express.NextFunction) => void | Promise<void>

interface Deps {
  supabase: SupabaseClient
  requireAuth: Middleware
  identifyTenant: Middleware
  checkPermission: (feature: string, action: 'view' | 'edit' | 'delete') => Middleware
}

const TG_API = 'https://api.telegram.org'

async function tgCall<T = any>(token: string, method: string, body?: any): Promise<T> {
  const r = await fetch(`${TG_API}/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  })
  const data = await r.json() as any
  if (!data.ok) throw new Error(data.description || `Telegram API error (${r.status})`)
  return data.result as T
}

export function createTelegramRouter(deps: Deps): express.Router {
  const r = express.Router()
  const { supabase, requireAuth, identifyTenant, checkPermission } = deps
  const guard = [requireAuth, identifyTenant, checkPermission('whatsapp_automation', 'edit')]
  const guardView = [requireAuth, identifyTenant, checkPermission('whatsapp_automation', 'view')]

  // ── Connect / disconnect ──────────────────────────────────────────────────
  r.post('/api/telegram/connect', requireAuth, identifyTenant, async (req, res) => {
    const tenantId = (req as any).tenantId
    const { bot_token } = req.body
    if (typeof bot_token !== 'string' || !/^\d+:[A-Za-z0-9_-]{30,}$/.test(bot_token)) {
      res.status(400).json({ error: 'Invalid bot token format. Get one from @BotFather.' }); return
    }
    try {
      const me = await tgCall<{ id: number; username?: string; first_name?: string }>(bot_token, 'getMe')
      const enc = encrypt(bot_token)
      await supabase.from('tg_bots').upsert({
        tenant_id: tenantId,
        bot_username: me.username ?? null,
        bot_id: me.id,
        bot_token: enc,
        updated_at: new Date().toISOString(),
      })
      // Mirror into tenant_integrations so /api/connectors/connections lists
      // it as a generic connected app for status / disconnect-flow consistency.
      await supabase.from('tenant_integrations').upsert({
        tenant_id: tenantId, key: 'telegram', status: 'active',
        brand_label: me.username ? `@${me.username}` : `bot ${me.id}`,
        connected_at: new Date().toISOString(),
      })
      res.json({ success: true, bot: { id: me.id, username: me.username, name: me.first_name } })
    } catch (err: any) {
      res.status(400).json({ error: err.message || 'Could not validate bot token' })
    }
  })

  // ── Bot info / settings ───────────────────────────────────────────────────
  r.get('/api/telegram/bot', ...guardView, async (req, res) => {
    const tenantId = (req as any).tenantId
    const { data } = await supabase.from('tg_bots').select('bot_username, bot_id, short_description, description, commands, webhook_url, created_at, updated_at')
      .eq('tenant_id', tenantId).maybeSingle()
    res.json(data ?? null)
  })

  r.post('/api/telegram/bot/commands', ...guard, async (req, res) => {
    const tenantId = (req as any).tenantId
    const commands = (req.body.commands ?? []) as Array<{ command: string; description: string }>
    const bot = await getBot(supabase, tenantId)
    if (!bot) { res.status(404).json({ error: 'Telegram bot not connected' }); return }
    try {
      await tgCall(bot.token, 'setMyCommands', { commands })
      await supabase.from('tg_bots').update({ commands, updated_at: new Date().toISOString() }).eq('tenant_id', tenantId)
      res.json({ success: true })
    } catch (err: any) {
      res.status(500).json({ error: err.message })
    }
  })

  r.post('/api/telegram/bot/profile', ...guard, async (req, res) => {
    const tenantId = (req as any).tenantId
    const { short_description, description } = req.body
    const bot = await getBot(supabase, tenantId)
    if (!bot) { res.status(404).json({ error: 'Telegram bot not connected' }); return }
    try {
      if (typeof short_description === 'string') await tgCall(bot.token, 'setMyShortDescription', { short_description })
      if (typeof description === 'string')       await tgCall(bot.token, 'setMyDescription',      { description })
      await supabase.from('tg_bots').update({ short_description, description, updated_at: new Date().toISOString() }).eq('tenant_id', tenantId)
      res.json({ success: true })
    } catch (err: any) {
      res.status(500).json({ error: err.message })
    }
  })

  r.post('/api/telegram/bot/webhook', ...guard, async (req, res) => {
    const tenantId = (req as any).tenantId
    const bot = await getBot(supabase, tenantId)
    if (!bot) { res.status(404).json({ error: 'Telegram bot not connected' }); return }
    const baseUrl = (req.body.public_url ?? process.env.PUBLIC_API_URL ?? '').replace(/\/$/, '')
    if (!baseUrl) { res.status(400).json({ error: 'public_url required (or set PUBLIC_API_URL env)' }); return }
    const webhook = `${baseUrl}/webhook/telegram?tenant_id=${tenantId}`
    try {
      await tgCall(bot.token, 'setWebhook', { url: webhook, allowed_updates: ['message', 'callback_query', 'pre_checkout_query'] })
      await supabase.from('tg_bots').update({ webhook_url: webhook }).eq('tenant_id', tenantId)
      res.json({ success: true, webhook })
    } catch (err: any) {
      res.status(500).json({ error: err.message })
    }
  })

  // ── Send / Messaging ──────────────────────────────────────────────────────
  r.post('/api/telegram/send', ...guard, async (req, res) => {
    const tenantId = (req as any).tenantId
    const { chat_id, text, reply_markup } = req.body
    if (!chat_id || typeof text !== 'string') { res.status(400).json({ error: 'chat_id + text required' }); return }
    const bot = await getBot(supabase, tenantId)
    if (!bot) { res.status(404).json({ error: 'Telegram bot not connected' }); return }
    try {
      const msg = await tgCall<any>(bot.token, 'sendMessage', { chat_id, text, reply_markup })
      await supabase.from('messages').insert({
        tenant_id: tenantId, channel: 'telegram', direction: 'outbound',
        contact_phone: String(chat_id),
        platform_message_id: String(msg.message_id),
        content: { type: 'text', text },
        status: 'sent',
      })
      res.json({ success: true, message_id: msg.message_id })
    } catch (err: any) {
      res.status(500).json({ error: err.message })
    }
  })

  // ── Broadcasts ────────────────────────────────────────────────────────────
  r.get('/api/telegram/broadcasts', ...guardView, async (req, res) => {
    const tenantId = (req as any).tenantId
    const { data, error } = await supabase.from('broadcasts')
      .select('*').eq('tenant_id', tenantId).eq('channel', 'telegram')
      .order('created_at', { ascending: false })
    if (error) { res.status(500).json({ error: error.message }); return }
    res.json(data ?? [])
  })

  r.post('/api/telegram/broadcasts', ...guard, async (req, res) => {
    const tenantId = (req as any).tenantId
    const { name, text, audience } = req.body
    if (!name || !text) { res.status(400).json({ error: 'name + text required' }); return }
    const { data, error } = await supabase.from('broadcasts').insert({
      tenant_id: tenantId, channel: 'telegram',
      name, audience: audience ?? { all: true },
      // template_name is reused as the text payload for non-WA channels
      template_name: text.slice(0, 200),
      status: 'draft',
    }).select().single()
    if (error) { res.status(500).json({ error: error.message }); return }
    res.json(data)
  })

  // ── Mini Apps ─────────────────────────────────────────────────────────────
  r.get('/api/telegram/mini-apps', ...guardView, async (req, res) => {
    const tenantId = (req as any).tenantId
    const { data, error } = await supabase.from('tg_mini_apps')
      .select('*').eq('tenant_id', tenantId).order('created_at', { ascending: false })
    if (error) { res.status(500).json({ error: error.message }); return }
    res.json(data ?? [])
  })

  r.post('/api/telegram/mini-apps', ...guard, async (req, res) => {
    const tenantId = (req as any).tenantId
    const { name, url, short_name } = req.body
    if (!name || !url) { res.status(400).json({ error: 'name + url required' }); return }
    const { data, error } = await supabase.from('tg_mini_apps').insert({
      tenant_id: tenantId, name, url, short_name: short_name ?? null,
    }).select().single()
    if (error) { res.status(500).json({ error: error.message }); return }
    res.json(data)
  })

  r.delete('/api/telegram/mini-apps/:id', ...guard, async (req, res) => {
    const tenantId = (req as any).tenantId
    const { error } = await supabase.from('tg_mini_apps').delete()
      .eq('id', req.params.id).eq('tenant_id', tenantId)
    if (error) { res.status(500).json({ error: error.message }); return }
    res.json({ success: true })
  })

  // ── Payments (Stars) ──────────────────────────────────────────────────────
  r.get('/api/telegram/payments', ...guardView, async (req, res) => {
    const tenantId = (req as any).tenantId
    const { data, error } = await supabase.from('tg_invoices')
      .select('*').eq('tenant_id', tenantId).order('created_at', { ascending: false }).limit(100)
    if (error) { res.status(500).json({ error: error.message }); return }
    res.json(data ?? [])
  })

  r.post('/api/telegram/payments/invoice', ...guard, async (req, res) => {
    const tenantId = (req as any).tenantId
    const { title, description, amount, payload, currency } = req.body
    if (!title || !amount || !payload) { res.status(400).json({ error: 'title + amount + payload required' }); return }
    const bot = await getBot(supabase, tenantId)
    if (!bot) { res.status(404).json({ error: 'Telegram bot not connected' }); return }
    try {
      const link = await tgCall<string>(bot.token, 'createInvoiceLink', {
        title, description: description ?? '',
        payload, currency: currency ?? 'XTR',
        prices: [{ label: title, amount: Number(amount) }],
      })
      const { data, error } = await supabase.from('tg_invoices').insert({
        tenant_id: tenantId,
        amount: Number(amount), currency: currency ?? 'XTR',
        payload, title, description,
        status: 'pending', invoice_link: link,
      }).select().single()
      if (error) { res.status(500).json({ error: error.message }); return }
      res.json(data)
    } catch (err: any) {
      res.status(500).json({ error: err.message })
    }
  })

  // ── Channels (bot is admin of) ────────────────────────────────────────────
  r.get('/api/telegram/channels', ...guardView, async (req, res) => {
    // Telegram doesn't expose a "list of channels I admin" endpoint via Bot
    // API; we surface what we have stored locally (channels are added when
    // the bot first posts to one).
    res.json([])
  })

  r.post('/api/telegram/channels/post', ...guard, async (req, res) => {
    const tenantId = (req as any).tenantId
    const { chat_id, text } = req.body
    if (!chat_id || !text) { res.status(400).json({ error: 'chat_id + text required' }); return }
    const bot = await getBot(supabase, tenantId)
    if (!bot) { res.status(404).json({ error: 'Telegram bot not connected' }); return }
    try {
      const msg = await tgCall<any>(bot.token, 'sendMessage', { chat_id, text })
      res.json({ success: true, message_id: msg.message_id })
    } catch (err: any) {
      res.status(500).json({ error: err.message })
    }
  })

  // ── Inbound webhook ───────────────────────────────────────────────────────
  // Public; routed by ?tenant_id=... query param. We could also embed the
  // tenant in the path; keeping query for now to keep the URL setWebhook
  // call simple.
  r.post('/webhook/telegram', async (req, res) => {
    const tenantId = String(req.query.tenant_id ?? '')
    if (!tenantId) { res.sendStatus(400); return }
    try {
      const update: any = req.body
      const msg = update.message ?? update.edited_message
      if (msg) {
        const fromId = String(msg.chat?.id ?? msg.from?.id ?? '')
        const username = msg.from?.username ?? null
        const name = [msg.from?.first_name, msg.from?.last_name].filter(Boolean).join(' ') || username || `Telegram ${fromId}`
        const text = msg.text ?? msg.caption ?? ''
        // Upsert contact by telegram_id
        const { data: existing } = await supabase.from('contacts')
          .select('id').eq('tenant_id', tenantId).eq('telegram_id', fromId).maybeSingle()
        if (!existing) {
          await supabase.from('contacts').insert({
            tenant_id: tenantId, name, phone: `tg:${fromId}`, telegram_id: fromId,
            channel_primary: 'telegram',
          })
        }
        await supabase.from('messages').insert({
          tenant_id: tenantId, channel: 'telegram', direction: 'inbound',
          contact_phone: fromId,
          platform_message_id: String(msg.message_id),
          content: { type: 'text', text, raw: msg },
        })
      }
      // Pre-checkout for Stars invoices — must respond OK or Telegram cancels.
      if (update.pre_checkout_query) {
        const bot = await getBot(supabase, tenantId)
        if (bot) {
          await tgCall(bot.token, 'answerPreCheckoutQuery', {
            pre_checkout_query_id: update.pre_checkout_query.id,
            ok: true,
          })
        }
      }
      // Successful payment confirmation
      if (msg?.successful_payment) {
        const payload = msg.successful_payment.invoice_payload
        await supabase.from('tg_invoices').update({
          status: 'paid', paid_at: new Date().toISOString(),
        }).eq('tenant_id', tenantId).eq('payload', payload)
      }
      res.sendStatus(200)
    } catch (err) {
      console.error('[telegram-webhook]', err)
      res.sendStatus(200)   // never let TG retry — log and move on
    }
  })

  return r
}

async function getBot(supabase: SupabaseClient, tenantId: string): Promise<{ token: string; username: string | null } | null> {
  const { data } = await supabase.from('tg_bots')
    .select('bot_token, bot_username').eq('tenant_id', tenantId).maybeSingle()
  if (!data?.bot_token) return null
  return { token: decrypt(data.bot_token), username: data.bot_username }
}
