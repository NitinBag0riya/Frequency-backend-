-- ─────────────────────────────────────────────────────────────────────────
-- 055_tg_bot_webhook_secret.sql
--
-- F7: per-tenant Telegram webhook secret.
--
-- Telegram lets us pass `secret_token` to setWebhook; on every inbound
-- delivery, Telegram echoes it in the `X-Telegram-Bot-Api-Secret-Token`
-- header. We persist it server-side (here) and verify it on every webhook
-- POST in src/routes/telegram.ts:329-347.
--
-- Why per-tenant: the bot_token is also per-tenant. Without a per-tenant
-- webhook_secret, an attacker who learns the path of one tenant's webhook
-- could spoof inbound updates for any tenant if we shared a global secret.
-- (Path is /webhook/telegram/<tenant_id>, but path is not authentication.)
--
-- Backfill: existing rows get NULL. The route handler tolerates NULL by
-- accepting unverified deliveries with a warn log, then the next call to
-- POST /api/telegram/bot/webhook (re-runs setWebhook) writes a value and
-- the verification kicks in. Net effect: zero downtime, soft rollout.
-- ─────────────────────────────────────────────────────────────────────────

alter table public.tg_bots
  add column if not exists webhook_secret text;

comment on column public.tg_bots.webhook_secret is
  'F7: secret_token registered with Telegram setWebhook. Verified against X-Telegram-Bot-Api-Secret-Token on every inbound. NULL = unverified (legacy bots; will fill on next setWebhook call).';
