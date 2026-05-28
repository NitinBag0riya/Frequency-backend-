/**
 * One-shot: set the Telegram webhook for a tenant's bot.
 *
 * Why this exists: the FE flow to /api/telegram/bot/webhook never fired
 * for the tenant in question, leaving tg_bots.webhook_url = NULL and
 * Telegram with no idea where to deliver updates. This script does the
 * same work the route does, but service-role-direct so we don't need
 * an authenticated session.
 *
 * Usage:
 *   cd flowgpt-server
 *   npx tsx scripts/set-telegram-webhook.ts <tenant_id>
 *
 * Output: prints the resolved webhook URL + Telegram's setWebhook
 * response + the DB update result. Idempotent — re-running with the
 * same tenant just rotates the secret_token.
 */
import '../src/env'
import { createClient } from '@supabase/supabase-js'
import { decrypt } from '../src/crypto'
import crypto from 'crypto'

const tenantId = process.argv[2]
if (!tenantId) {
  console.error('Usage: tsx scripts/set-telegram-webhook.ts <tenant_id>')
  process.exit(1)
}

const PUBLIC_API_URL = process.env.PUBLIC_API_URL_PROD ?? 'https://api.getfrequency.app'
const SUPABASE_URL   = process.env.SUPABASE_URL!
const SR_KEY         = process.env.SUPABASE_SERVICE_ROLE_KEY!
const supabase       = createClient(SUPABASE_URL, SR_KEY)

async function tgCall(token: string, method: string, body: any) {
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const data: any = await res.json()
  if (!res.ok || !data.ok) {
    throw new Error(`tg.${method} failed (${res.status}): ${JSON.stringify(data)}`)
  }
  return data.result
}

async function main() {
  const { data: bot, error: botErr } = await supabase
    .from('tg_bots').select('*').eq('tenant_id', tenantId).maybeSingle()
  if (botErr) throw new Error(`tg_bots lookup: ${botErr.message}`)
  if (!bot)   throw new Error(`No tg_bots row for tenant ${tenantId}`)

  const decryptedToken = decrypt(bot.bot_token)
  if (!decryptedToken || decryptedToken === bot.bot_token) {
    throw new Error('decrypt(bot_token) returned the input — encryption key may be wrong')
  }

  const webhook = `${PUBLIC_API_URL}/webhook/telegram?tenant_id=${tenantId}`
  const secretToken = crypto.randomBytes(32).toString('hex')

  console.log(`[setWebhook] bot=@${bot.bot_username} → ${webhook}`)

  // Verify the token works first via getMe — saves a confused error
  // if the token is malformed.
  const me = await tgCall(decryptedToken, 'getMe', {})
  console.log(`[getMe] id=${me.id} username=@${me.username}`)

  const setRes = await tgCall(decryptedToken, 'setWebhook', {
    url: webhook,
    allowed_updates: ['message', 'callback_query', 'pre_checkout_query'],
    secret_token: secretToken,
    drop_pending_updates: false,
  })
  console.log(`[setWebhook] ok =`, setRes)

  const { error: upErr } = await supabase.from('tg_bots').update({
    webhook_url:    webhook,
    webhook_secret: secretToken,
    updated_at:     new Date().toISOString(),
  }).eq('tenant_id', tenantId)
  if (upErr) throw new Error(`tg_bots update: ${upErr.message}`)
  console.log(`[db] persisted webhook_url + webhook_secret`)

  // Final state — getWebhookInfo confirms what Telegram actually has.
  const info = await tgCall(decryptedToken, 'getWebhookInfo', {})
  console.log(`[getWebhookInfo]`, JSON.stringify(info, null, 2))
}

main().catch(e => { console.error(e); process.exit(1) })
