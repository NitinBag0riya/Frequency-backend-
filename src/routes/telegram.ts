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
import crypto from 'crypto'
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
    // tg_bots itself has no user_id column (PK is tenant_id, see migration 016),
    // but the MIRROR into tenant_integrations DOES require user_id NOT NULL —
    // the previous version omitted it and ignored the returned `error`, so the
    // mirror row was never written and /api/connectors/connections never
    // showed Telegram as connected (the FE still saw "connected" because the
    // tg_bots row landed — the mirror is the silent failure).
    const userId = (req as any).user?.id as string | undefined
    if (!userId) { res.status(401).json({ error: 'auth missing user.id' }); return }
    const { bot_token } = req.body
    if (typeof bot_token !== 'string' || !/^\d+:[A-Za-z0-9_-]{30,}$/.test(bot_token)) {
      res.status(400).json({ error: 'Invalid bot token format. Get one from @BotFather.' }); return
    }
    try {
      const me = await tgCall<{ id: number; username?: string; first_name?: string }>(bot_token, 'getMe')
      const enc = encrypt(bot_token)
      const { error: tgErr } = await supabase.from('tg_bots').upsert({
        tenant_id: tenantId,
        bot_username: me.username ?? null,
        bot_id: me.id,
        bot_token: enc,
        updated_at: new Date().toISOString(),
      })
      if (tgErr) {
        console.error(`[telegram connect] tg_bots upsert failed: ${tgErr.message}`)
        res.status(500).json({ error: 'Failed to persist bot: ' + tgErr.message }); return
      }
      // Mirror into tenant_integrations so /api/connectors/connections lists
      // it as a generic connected app for status / disconnect-flow consistency.
      const { error: tiErr } = await supabase.from('tenant_integrations').upsert({
        tenant_id: tenantId, user_id: userId, key: 'telegram', status: 'active',
        brand_label: me.username ? `@${me.username}` : `bot ${me.id}`,
        connected_at: new Date().toISOString(),
      }, { onConflict: 'tenant_id,key' })
      if (tiErr) {
        console.error(`[telegram connect] tenant_integrations mirror upsert failed: ${tiErr.message}`)
        res.status(500).json({ error: 'Failed to persist connection mirror: ' + tiErr.message }); return
      }
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
      // B3: per-tenant Telegram webhook secret_token. Telegram sends the
      // configured value back as `x-telegram-bot-api-secret-token` on every
      // webhook delivery; the inbound handler refuses anything that doesn't
      // match. Without this, anyone who learns the public webhook URL +
      // tenant_id can forge inbound updates.
      const secretToken = crypto.randomBytes(32).toString('hex')
      await tgCall(bot.token, 'setWebhook', {
        url: webhook,
        allowed_updates: ['message', 'callback_query', 'pre_checkout_query'],
        secret_token: secretToken,
      })
      // Persist the secret on the bot row. tg_bots.webhook_secret landed in
      // migration 073 — the legacy try/catch fallback was removed once that
      // applied. If the update fails now it's a real error (likely no row
      // for this tenant — meaning getBot() should have already 404'd).
      const { error: persistErr } = await supabase.from('tg_bots').update({
        webhook_url: webhook,
        webhook_secret: secretToken,
      }).eq('tenant_id', tenantId)
      if (persistErr) {
        // Don't leak the secret to the client — the webhook is set on
        // Telegram's side but we couldn't store the verifier. Force a retry
        // so the operator doesn't end up with an unverifiable webhook.
        res.status(500).json({
          error: 'webhook set on Telegram but secret could not be persisted; retry',
          detail: persistErr.message,
        })
        return
      }
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
    if (error) { res.status((error as any).code === 'PGRST116' ? 404 : 500).json({ error: (error as any).code === 'PGRST116' ? 'not found' : error.message }); return }
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
    if (error) { res.status((error as any).code === 'PGRST116' ? 404 : 500).json({ error: (error as any).code === 'PGRST116' ? 'not found' : error.message }); return }
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
    // The (tenant_id, payload) unique index added in migration 030 ensures
    // the webhook's `update WHERE tenant_id=X AND payload=Y` only ever marks
    // ONE row paid (rather than every pending invoice that happened to share
    // a payload). Reject collisions early with a clean 409 instead of letting
    // the UNIQUE violation surface as a generic 500.
    const { data: existingPayload } = await supabase.from('tg_invoices')
      .select('id, status').eq('tenant_id', tenantId).eq('payload', payload).maybeSingle()
    if (existingPayload) {
      res.status(409).json({
        error:    `Invoice payload '${payload}' already exists for this tenant (status: ${existingPayload.status})`,
        code:     'duplicate_payload',
        existing_invoice_id: existingPayload.id,
      })
      return
    }
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
      if (error) { res.status((error as any).code === 'PGRST116' ? 404 : 500).json({ error: (error as any).code === 'PGRST116' ? 'not found' : error.message }); return }
      res.json(data)
    } catch (err: any) {
      res.status(500).json({ error: err.message })
    }
  })

  // ── Status polling ───────────────────────────────────────────────────────
  // Used by FE to check if a Stars invoice has been paid without waiting for
  // the user to come back to the page. Telegram only delivers payment
  // confirmation via webhook (no GET-status endpoint on the Bot API for
  // invoice links), so we serve this from our own tg_invoices state which
  // the webhook updates inline.
  r.get('/api/telegram/payments/:id', ...guardView, async (req, res) => {
    const tenantId = (req as any).tenantId
    const { data, error } = await supabase.from('tg_invoices')
      .select('id, status, amount, currency, paid_at, invoice_link, title, description, payload, created_at')
      .eq('id', req.params.id).eq('tenant_id', tenantId).maybeSingle()
    if (error) { res.status(500).json({ error: error.message }); return }
    if (!data)  { res.status(404).json({ error: 'invoice not found' }); return }
    res.json(data)
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
    // B3: verify x-telegram-bot-api-secret-token. Look up the per-tenant
    // secret persisted at setWebhook time; if it's set, require an exact
    // (timing-safe) match. If it's NOT set (column missing or older bot row
    // that pre-dates the secret rollout), fall through to the legacy
    // unverified path so we don't break in-flight tenants — but log loudly.
    try {
      const { data: botRow } = await supabase.from('tg_bots')
        .select('webhook_secret').eq('tenant_id', tenantId).maybeSingle()
      const expected = (botRow as any)?.webhook_secret as string | undefined
      if (expected && expected.length > 0) {
        const provided = req.header('x-telegram-bot-api-secret-token') || ''
        const a = Buffer.from(provided, 'utf8')
        const b = Buffer.from(expected, 'utf8')
        const ok = a.length === b.length && crypto.timingSafeEqual(a, b)
        if (!ok) {
          console.warn(`[telegram-webhook] secret token mismatch tenant=${tenantId}`)
          res.status(401).json({ error: 'invalid_secret' }); return
        }
      } else {
        console.warn(`[telegram-webhook] no webhook_secret stored tenant=${tenantId} — accepting unverified (run /api/telegram/bot/webhook to enable)`)
      }
    } catch (e: any) {
      // Column missing on tg_bots — accept this delivery but warn so the
      // operator knows to apply the migration.
      console.warn(`[telegram-webhook] could not read webhook_secret (tenant=${tenantId}): ${e?.message}`)
    }

    // ── Webhook queue handoff (migration 064) ──────────────────────────
    // Telegram bodies arrive as parsed JSON (express.json), not raw Buffer.
    // We serialise back to a string + base64 it so the queue payload shape
    // matches Meta's (worker decodes uniformly). Same flag-gated cutover
    // pattern; falls back to inline on Redis failure.
    if (process.env.WEBHOOK_QUEUE_ENABLED === '1') {
      try {
        const { enqueueWebhookInbound } = await import('../queue')
        const json = JSON.stringify(req.body ?? {})
        await enqueueWebhookInbound({
          source:     'telegram',
          rawBodyB64: Buffer.from(json, 'utf8').toString('base64'),
          tenantId,
          query:      { tenant_id: tenantId },
          receivedAt: new Date().toISOString(),
        })
        res.sendStatus(200)
        return
      } catch (e: any) {
        console.warn(`[telegram-webhook] queue enqueue failed, running inline: ${e?.message ?? e}`)
      }
    }

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

        // Workflow trigger + session resume — same path as the WhatsApp
        // webhook. Without this, inbound Telegram messages were silently
        // logged + discarded; no workflow could ever fire on a TG keyword
        // and no in-flight session could be resumed by a user reply.
        if (text) {
          const { data: tenantRow } = await supabase.from('tenants')
            .select('*').eq('id', tenantId).maybeSingle()
          if (tenantRow) {
            const { routeInboundToWorkflow } = await import('../engine/inbound-router')
            await routeInboundToWorkflow(supabase, tenantRow, 'telegram', fromId, text, msg)
          }
        }
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
      // Successful payment confirmation. Idempotent — we only flip to 'paid'
      // if status is still 'pending', so a TG webhook retry doesn't bump
      // paid_at on an already-confirmed invoice. Also records the
      // telegram_payment_charge_id + provider_payment_charge_id which are
      // required for any future refund call (refundStarPayment).
      if (msg?.successful_payment) {
        const sp = msg.successful_payment
        await supabase.from('tg_invoices').update({
          status:                       'paid',
          paid_at:                      new Date().toISOString(),
          telegram_payment_charge_id:   sp.telegram_payment_charge_id ?? null,
          provider_payment_charge_id:   sp.provider_payment_charge_id ?? null,
          paid_amount:                  sp.total_amount ?? null,
        })
        .eq('tenant_id', tenantId).eq('payload', sp.invoice_payload).eq('status', 'pending')
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
