-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 20260814190000 — Naruto Platform OS §6 nudge engine + §16 platform
-- notification dedupe.
--
-- ADDITIVE + idempotent. Two platform-scoped tables (no tenant RLS — reached
-- only through the service-role platform API, guarded by requirePlatformCapability):
--
--   1. platform_nudge_rules — the rules table: trigger condition → template →
--      channel → cooldown. Data-driven; each `trigger` maps to a code evaluator
--      in lib/nudge-engine.ts (TRIGGERS registry). Args live in `condition`.
--   2. platform_nudge_log — one row per (tenant, rule) send attempt. The daily
--      evaluator reads it to enforce cooldown/dedupe (don't re-nudge inside the
--      rule's cooldown window). Also the dedupe ledger for §16 notification
--      emission (reserved rule_ids '__notify_*') so a stall/limit/spike notifies
--      the platform team at most once per window.
--
-- Sends reuse the EXISTING paths — email (lib/email.sendEmail) + WhatsApp
-- (lib/whatsapp-notifications.sendWaNotification). No new send infra.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── 1. Nudge rules ────────────────────────────────────────────────────────────
create table if not exists public.platform_nudge_rules (
  id           text primary key,               -- stable key, e.g. 'catalog_done_payments_pending'
  label        text not null,
  description  text,
  -- Which code evaluator selects candidate tenants (lib/nudge-engine TRIGGERS).
  trigger      text not null,
  -- Trigger params (e.g. { step:'payments', requires_done:['catalog'], min_hours:72 }).
  condition    jsonb not null default '{}'::jsonb,
  channel      text not null default 'email'
                 check (channel in ('email','whatsapp','both')),
  -- Message template key (lib/nudge-engine TEMPLATES).
  template_key text not null,
  cooldown_hours int not null default 72 check (cooldown_hours >= 1),
  enabled      boolean not null default true,
  updated_at   timestamptz not null default now(),
  updated_by   uuid
);

comment on table public.platform_nudge_rules is
  'Naruto §6: automated nudge rules (trigger → template → channel → cooldown). Evaluated daily by lib/nudge-engine.';

-- ── 2. Nudge log (cooldown + dedupe ledger) ──────────────────────────────────
create table if not exists public.platform_nudge_log (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null,
  -- Rule key, or a reserved '__notify_*' marker for §16 notification dedupe.
  rule_id    text not null,
  channel    text,
  status     text not null default 'sent'
               check (status in ('sent','failed','skipped')),
  detail     text,
  -- 'auto' (daily evaluator) or 'manual' (operator override from /naruto).
  source     text not null default 'auto',
  actor_user_id uuid,
  sent_at    timestamptz not null default now()
);

comment on table public.platform_nudge_log is
  'Naruto §6: per-(tenant,rule) nudge send ledger. Powers cooldown/dedupe + §16 notification dedupe.';

-- Cooldown scans by (tenant_id, rule_id) newest-first.
create index if not exists pnl_tenant_rule_time
  on public.platform_nudge_log (tenant_id, rule_id, sent_at desc);

-- ── 3. Seed default rules (upsert — re-asserts copy without clobbering toggles) ─
-- The spec's worked example ("menu up but payments not connected") + two more.
insert into public.platform_nudge_rules (id, label, description, trigger, condition, channel, template_key, cooldown_hours) values
  ('catalog_done_payments_pending',
   'Menu up, payments not connected',
   'Catalog is live but the tenant has not connected payments — the last blocker before going live.',
   'step_stalled',
   '{"step":"payments","requires_done":["catalog"],"min_hours":72}'::jsonb,
   'email', 'catalog_done_payments_pending', 72),
  ('onboarding_stalled',
   'Onboarding stalled',
   'Tenant has been sitting mid-setup (provisioned/configuring/ready_to_launch) for more than 3 days.',
   'lifecycle_stalled',
   '{"states":["provisioned","configuring","ready_to_launch"],"min_hours":72}'::jsonb,
   'email', 'onboarding_stalled', 96),
  ('no_first_order',
   'Live, no first order',
   'Tenant went live but has not taken a first real order after 3 days.',
   'no_first_order',
   '{"min_hours":72}'::jsonb,
   'email', 'no_first_order', 120)
on conflict (id) do update set
  label = excluded.label, description = excluded.description,
  trigger = excluded.trigger, template_key = excluded.template_key
  -- NB: do NOT overwrite condition/channel/cooldown_hours/enabled — those are
  -- operator-tunable and re-running the migration must not reset them.
;
