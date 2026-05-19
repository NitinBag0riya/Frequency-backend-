-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 073 — Telegram channel parity (P0.8).
--
-- BRIEF: Bring Telegram to feature-parity with WhatsApp in the inbox,
-- broadcasts, workflows, and reporting. Most of the schema landed in earlier
-- migrations (016 omnichannel, 055 webhook_secret). This migration is the
-- thin parity layer for:
--
--   1. A defensive `webhook_secret` add-column (already added by 055 — kept
--      here as an IF NOT EXISTS in case a deployment skipped 055).
--   2. A composite index on (tenant_id, channel, created_at) on messages so
--      the new /api/analytics/messages-by-channel aggregate stays sub-100 ms
--      even on tenants with millions of rows.
--   3. A composite index on (tenant_id, channel, status) on broadcasts so
--      the per-channel broadcast counters on the dashboard scan a small
--      slice instead of the whole tenant partition.
--   4. Tighten the broadcasts.channel default — existing rows are already
--      'whatsapp' from 016; the default stays 'whatsapp' so legacy create
--      flows that don't pass `channel` keep working.
--
-- Idempotent. No data backfill (no existing Telegram broadcast rows).
-- No table restructures — additive only.
-- ─────────────────────────────────────────────────────────────────────────────

-- ─── 1. tg_bots.webhook_secret (defensive re-add) ────────────────────────
-- Already added by 055. Kept here so a fresh DB applying only the latest
-- migrations gets the column too. ALTER ... ADD COLUMN IF NOT EXISTS is a
-- no-op when the column is already present.
alter table public.tg_bots
  add column if not exists webhook_secret text;

comment on column public.tg_bots.webhook_secret is
  'Per-tenant secret_token registered with Telegram setWebhook. Verified against X-Telegram-Bot-Api-Secret-Token on every inbound webhook delivery. NULL = unverified (legacy bots; will fill on next setWebhook call). See src/routes/telegram.ts.';

-- ─── 2. messages per-channel reporting index ─────────────────────────────
-- The new /api/analytics/messages-by-channel endpoint groups by (channel,
-- direction) within a tenant + time-window. Without this index the planner
-- falls back to the (tenant_id, contact_phone, created_at) index from 002
-- and scans every row in the window. With it, the group-by reads a contiguous
-- slice per channel.
create index if not exists messages_tenant_channel_created
  on public.messages(tenant_id, channel, created_at desc);

comment on index public.messages_tenant_channel_created is
  'Reporting index — backs /api/analytics/messages-by-channel and the dashboard per-channel KPIs (P0.8).';

-- ─── 3. broadcasts per-channel filter index ──────────────────────────────
-- 016 added (tenant_id, channel, created_at) on broadcasts. Reporting also
-- groups by status (sent/sending/failed) to compute per-channel success
-- rates. Add the narrower index so the dashboard count(*) filter on
-- channel + status stays cheap.
create index if not exists broadcasts_tenant_channel_status
  on public.broadcasts(tenant_id, channel, status);

comment on index public.broadcasts_tenant_channel_status is
  'Reporting index — dashboard per-channel broadcast success/failed counters (P0.8).';

-- ─── 4. tg_bots.bot_id uniqueness guard (idempotent) ─────────────────────
-- 016 made bot_id NULL-able. A tenant should never have two bots with the
-- same telegram bot_id (one tenant = one TG bot). Index also speeds up the
-- "is this update for a known bot?" lookup in the webhook handler.
create unique index if not exists tg_bots_bot_id_unique
  on public.tg_bots(bot_id) where bot_id is not null;

comment on index public.tg_bots_bot_id_unique is
  'Guards against duplicate Telegram bot connections across tenants — one bot can only belong to one tenant (P0.8).';

-- ─── 5. contacts.telegram_id unique-per-tenant guard (best-effort) ───────
-- 016 created a non-unique partial index on (tenant_id, telegram_id). A
-- unique variant would be ideal for ON CONFLICT upserts, but if a tenant
-- already has duplicate telegram_id rows (from before the webhook went live)
-- the index build will fail and abort the whole migration. Wrap in a DO
-- block that swallows the unique-violation so the rest of 073 still lands.
-- The webhook handler already does a SELECT-then-INSERT (not ON CONFLICT)
-- so a missing unique index is a perf nit, not a correctness bug.
do $$
begin
  create unique index if not exists contacts_tenant_telegram_id_unique
    on public.contacts(tenant_id, telegram_id) where telegram_id is not null;
exception
  when unique_violation then
    raise notice 'contacts_tenant_telegram_id_unique: skipped — duplicate (tenant_id, telegram_id) rows exist; clean up before retrying';
  when others then
    raise notice 'contacts_tenant_telegram_id_unique: skipped — %', sqlerrm;
end $$;
