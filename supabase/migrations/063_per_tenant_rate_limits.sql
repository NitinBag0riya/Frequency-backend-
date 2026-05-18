-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 063 — Per-tenant rate limiting (plan quotas + idempotency + events)
--
-- Background: src/queue.ts mounts a GLOBAL `limiter: { max: 50, duration: 1000 }`
-- on the message.send worker — one bucket shared by every tenant. A noisy
-- tenant sending 10k broadcasts in a minute starves smaller tenants and we
-- have no way to honor per-plan quotas. This migration is the schema half of
-- the per-tenant rate-limit work. The runtime half lives in
-- src/lib/rate-limit.ts + src/lib/quota.ts and consumes the columns added
-- below.
--
-- What this lands:
--
--   1. New plan-limit keys on plans.limits (jsonb):
--        messages_per_day      — daily send cap (msg.send + broadcast.send)
--        messages_per_minute   — smoothing cap (matches Meta's per-WABA cap)
--        broadcasts_per_day    — already exists, retained as-is
--        ai_requests_per_day   — feature-flagged; future AI-responder gate
--      Encoded as merges into plans.limits (jsonb_build_object + ||) so
--      existing keys (messages_per_month, contacts_max, …) survive.
--
--   2. New table public.quota_notification_log (id, tenant_id, quota_key,
--      bucket_date, level, fired_at) — the persistent idempotency record that
--      makes the "fire once per day per quota per tenant" rule reliable
--      across worker restarts. Redis token-bucket keys expire after their
--      window; a worker that restarts the next day must not re-fire the
--      previous day's "approaching" notification because the in-memory flag
--      went away.
--
--   3. Two new rows in public.notification_event_types:
--        quota.approaching  — fired at 80% of any quota
--        quota.exhausted    — fired at 100%; suggests upgrade
--      Both opt-in to email by default since hitting a quota is a
--      business-critical event (failed sends == lost revenue).
--
-- Idempotent — every CREATE / INSERT uses ON CONFLICT or IF NOT EXISTS so
-- the migration is safe to re-run. The plan-limit merges read the current
-- limits jsonb and only add the new keys when missing, so a super-admin who
-- already tuned messages_per_day for a specific plan via /admin keeps their
-- override.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── 1. Plan quota defaults ──────────────────────────────────────────────────
-- Numbers from the per-tenant rate-limit spec:
--   free:       100 msg/day, 5 msg/min,  0 broadcasts/day  (Free has no broadcasts)
--   starter:   5000 msg/day, 30 msg/min, 5 broadcasts/day
--   growth:   50000 msg/day, 80 msg/min, 50 broadcasts/day
--   scale:   500000 msg/day, 200 msg/min, 500 broadcasts/day
--   enterprise: unlimited (-1 sentinel, consistent with existing keys)
--
-- We retain the existing broadcasts_per_day where present (Starter=5,
-- Growth=25, Scale=-1) because some super-admins have likely tuned it.
-- Only fill the new keys if missing. coalesce(limits, '{}'::jsonb) defends
-- against a NULL limits column (shouldn't happen, but harmless).
--
-- 018 didn't seed Enterprise. The Scale row uses -1 across the board which
-- already serves Enterprise customers in practice.

update public.plans
   set limits = coalesce(limits, '{}'::jsonb)
              || jsonb_build_object(
                   'messages_per_day',    100,
                   'messages_per_minute',  5,
                   'ai_requests_per_day', 50
                 )
              || coalesce(limits, '{}'::jsonb)  -- existing keys win
 where id = 'free';

update public.plans
   set limits = coalesce(limits, '{}'::jsonb)
              || jsonb_build_object(
                   'messages_per_day',    5000,
                   'messages_per_minute',   30,
                   'ai_requests_per_day',  500
                 )
              || coalesce(limits, '{}'::jsonb)  -- existing keys (broadcasts_per_day, …) win
 where id = 'starter';

update public.plans
   set limits = coalesce(limits, '{}'::jsonb)
              || jsonb_build_object(
                   'messages_per_day',    50000,
                   'messages_per_minute',    80,
                   'ai_requests_per_day',  5000
                 )
              || coalesce(limits, '{}'::jsonb)
 where id = 'growth';

update public.plans
   set limits = coalesce(limits, '{}'::jsonb)
              || jsonb_build_object(
                   'messages_per_day',    -1,
                   'messages_per_minute', -1,
                   'ai_requests_per_day', -1
                 )
              || coalesce(limits, '{}'::jsonb)
 where id = 'scale';

-- ── 2. Idempotency log for quota notifications ─────────────────────────────
-- One row per (tenant, quota, day, level) — the unique index is what
-- enforces "fire once per day per quota per tenant".
--
-- Why a real table and not just a Redis set: workers restart, Redis evicts
-- on memory pressure, and missing a "you hit your quota" notification is
-- worse than the rare double-notify. Postgres is durable; this table is
-- ~365 rows/year/tenant in the worst case (one entry per quota per day).
--
-- We deliberately do NOT add an FK to public.tenants(id) — that would force
-- a cascade-delete consideration on tenant.deleted_at, and the rows are
-- valuable retrospectively for "did we notify you when you blew your cap"
-- support questions. A loose tenant_id uuid is enough.

create table if not exists public.quota_notification_log (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null,
  quota_key    text not null,                                  -- 'messages_per_day','broadcasts_per_day',…
  bucket_date  date not null,                                  -- IST day; matches the rate-limit window
  level        text not null check (level in ('approaching','exhausted')),
  fired_at     timestamptz default now(),
  fired_to_user_ids uuid[] default '{}',                       -- audit trail of recipients
  current_usage bigint,                                        -- snapshot at fire time
  cap          bigint,                                         -- snapshot at fire time
  created_at   timestamptz default now()
);

alter table public.quota_notification_log enable row level security;

-- Tenants can read their own quota notification history (powers the
-- /settings/billing "previous warnings" panel). Inserts come from the
-- service-role worker; users never write.
create policy "qnl_read_own" on public.quota_notification_log for select using (
  exists (select 1 from public.tenants t where t.id = tenant_id and t.user_id = auth.uid())
);

-- The idempotency contract: one fire per (tenant, quota, day, level).
-- We INSERT ... ON CONFLICT DO NOTHING in lib/quota-notify.ts — if the row
-- already exists, we silently skip the send.
create unique index if not exists qnl_unique_per_day
  on public.quota_notification_log(tenant_id, quota_key, bucket_date, level);

-- For the future /api/usage history view + retention sweeps.
create index if not exists qnl_tenant_recent
  on public.quota_notification_log(tenant_id, fired_at desc);

-- ── 3. Notification event types ────────────────────────────────────────────
-- Both events default to in_app + email — failed sends cost the tenant
-- money, so a passive in-app badge isn't enough. Severity is warning for
-- approaching (still time to upgrade) and error for exhausted (sends are
-- now actively failing).

insert into public.notification_event_types
  (key, category, title_template, body_template, default_channels, severity, description)
values
  ('quota.approaching', 'billing',
   'Approaching your {{quota_label}} limit',
   'You''ve used {{used}} of {{cap}} ({{percent}}%) — quota resets at {{resets_at}}. Upgrade to avoid hitting the cap.',
   ARRAY['in_app','email']::text[],
   'warning',
   'Tenant has consumed 80% of a plan quota (messages, broadcasts, …). Fired once per quota per day.'),
  ('quota.exhausted',   'billing',
   '{{quota_label}} limit reached',
   'You''ve used {{used}} of {{cap}}. New sends are blocked until {{resets_at}}. Upgrade to /settings/billing to lift the cap.',
   ARRAY['in_app','email']::text[],
   'error',
   'Tenant has hit 100% of a plan quota. Sends are rejected with RateLimitExceededError. Fired once per quota per day.')
on conflict (key) do update set
  category         = EXCLUDED.category,
  title_template   = EXCLUDED.title_template,
  body_template    = EXCLUDED.body_template,
  default_channels = EXCLUDED.default_channels,
  severity         = EXCLUDED.severity,
  description      = EXCLUDED.description;

-- ── 4. Done ────────────────────────────────────────────────────────────────
-- Runtime consumers (created in the same PR):
--   src/lib/rate-limit.ts     — Lua-backed Redis token bucket; sub-1ms p99
--   src/lib/quota.ts          — checkAndConsumeQuota(tenantId, key, n)
--   src/lib/quota-notify.ts   — idempotent emitNotification() wrapper
--   src/workers/message-sender.ts   — wires the check before every send
--   src/workers/broadcast-worker.ts — same, for broadcasts
--   src/routes/usage.ts       — GET /api/usage for the billing UI
