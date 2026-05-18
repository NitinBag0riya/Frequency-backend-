-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 064 — Webhook dead-letter table
--
-- Background: prior to this migration the webhook flow was:
--
--   inbound (Meta WA / IG / Telegram / Razorpay / WA calls)
--     → signature verify (sync, 200 OK)
--     → DB writes + workflow router (sync, inline)
--     → if Supabase / Redis is slow, Meta times out at 2s and retries
--
--   outbound (workflow http_request node, notification webhook pings)
--     → fetch() inline; BullMQ default 3-retry exponential backoff
--     → if the third retry fails, the job sits in the `failed` set with no
--       admin-visible record. Operator has to know to open Bull Board.
--
-- The runtime half of this fix is two new BullMQ queues — `webhook.inbound`
-- and `webhook.outbound` — with retry config 5 attempts (1s/5s/30s/5m/30m)
-- and DLQ `webhook.inbound.dead` / `webhook.outbound.dead`. When a payload
-- exhausts retries the worker writes a row to this table and the operator
-- can view + replay it from the super-admin UI (GET /webhook-failures and
-- POST /webhook-failures/:id/replay).
--
-- Why a real Postgres table and not just rely on BullMQ's `failed` set:
--   1. BullMQ trims `removeOnFail` to keep memory bounded — failed jobs
--      eventually disappear. Compliance + customer trust need a permanent
--      record ("we received your payment.captured webhook at 14:03:11").
--   2. Postgres rows are queryable + indexable by source / direction /
--      tenant — Bull Board can only list per-queue.
--   3. Replay needs a stable id we can audit-log — BullMQ job ids are
--      ephemeral.
--
-- Idempotent — every CREATE uses IF NOT EXISTS so the migration is safe to
-- re-run.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── 1. Table ────────────────────────────────────────────────────────────────
-- Columns:
--   source     — e.g. 'meta_whatsapp', 'meta_instagram', 'telegram',
--                'razorpay', 'wa_calls' for inbound; 'workflow_http' or
--                a tenant-supplied label for outbound.
--   direction  — 'inbound' (we received) | 'outbound' (we sent)
--   payload    — the full job payload as enqueued. For inbound this is
--                { rawBody (base64), headers, query, source }. For outbound
--                it's the planned HTTP request { url, method, headers,
--                body, tenantId, ... }. We keep enough to re-enqueue.
--   attempts   — final attempts count from BullMQ (job.attemptsMade)
--   last_error — message + stack tail from the final failure
--   replayed_at, replayed_by — set when an operator hits the replay endpoint
--
-- tenant_id is nullable because for some inbound deliveries we couldn't
-- resolve the tenant (e.g. Meta delivered a payload for a WABA we don't
-- know about). The replay path will re-run that lookup.

create table if not exists public.webhook_dead_letter (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid null,
  source        text not null,
  direction     text not null check (direction in ('inbound', 'outbound')),
  payload       jsonb not null,
  attempts      int  not null default 0 check (attempts >= 0),
  last_error    text null,
  created_at    timestamptz not null default now(),
  replayed_at   timestamptz null,
  replayed_by   uuid null,
  replay_count  int not null default 0
);

-- Enable RLS — only the service role + super-admin should ever touch rows.
-- Tenants don't get to see their failed-webhook stream directly (yet); the
-- super-admin endpoint does the filtering.
alter table public.webhook_dead_letter enable row level security;

-- Block all anon/authed reads. The super-admin router uses the service-role
-- client which bypasses RLS.
drop policy if exists "wdl_no_direct_read"   on public.webhook_dead_letter;
drop policy if exists "wdl_no_direct_write"  on public.webhook_dead_letter;
create policy "wdl_no_direct_read"  on public.webhook_dead_letter for select using (false);
create policy "wdl_no_direct_write" on public.webhook_dead_letter for all    using (false) with check (false);

-- ── 2. Indexes ──────────────────────────────────────────────────────────────
-- The super-admin list page filters by source + direction and sorts newest
-- first. The composite covers the typical "show me the last 50 razorpay
-- inbound failures" query without a sort step.
create index if not exists wdl_recent
  on public.webhook_dead_letter(created_at desc);

create index if not exists wdl_source_direction_recent
  on public.webhook_dead_letter(source, direction, created_at desc);

-- Tenant-scoped lookup for support tickets ("which webhooks failed for
-- tenant X this week?"). Partial index keeps it small since most rows do
-- have a tenant.
create index if not exists wdl_tenant_recent
  on public.webhook_dead_letter(tenant_id, created_at desc)
  where tenant_id is not null;

-- Replay-status filter ("show only unreplayed failures").
create index if not exists wdl_unreplayed
  on public.webhook_dead_letter(created_at desc)
  where replayed_at is null;

-- ── 3. Comment ──────────────────────────────────────────────────────────────
comment on table public.webhook_dead_letter is
  'Dead-letter store for webhook deliveries that exhausted BullMQ retries. '
  'Inbound rows come from webhook.inbound queue, outbound from webhook.outbound. '
  'Super-admin can list + replay via /api/super-admin/webhook-failures.';
