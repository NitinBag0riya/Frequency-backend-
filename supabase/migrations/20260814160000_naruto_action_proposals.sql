-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 20260814160000 — Naruto Platform OS §1.2: approval rules +
-- dangerous-action gating (proposal → second approver → applied).
--
-- ADDITIVE + idempotent. Three tables, all platform-scoped (no tenant RLS —
-- reached only through the service-role platform API, guarded by
-- requirePlatformCapability):
--
--   1. platform_approval_rules       — which dangerous actions require a second
--                                       approver + which platform roles may approve.
--   2. platform_action_proposals     — a pending dangerous mutation: action + args
--                                       + before-image + proposer + reason, awaiting
--                                       a DIFFERENT approver, then applied/failed.
--   3. platform_notifications        — platform-team notify sink (proposal waiting,
--                                       break-glass fired). Distinct from the
--                                       tenant-scoped `notifications` table.
--
-- This is the PLATFORM approval engine (operators gating each other on
-- plan.downgrade / entitlement.bulk / payout / suspend / delete). It is separate
-- from the TENANT-internal approval_rules/approval_requests tables (team-member
-- gating, routes/approvals.ts) — different scope, different lifecycle.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── 1. Approval-rules config ─────────────────────────────────────────────────
create table if not exists public.platform_approval_rules (
  action            text primary key,
  label             text not null,
  requires_approval boolean not null default true,
  -- Platform role keys allowed to approve (any one of them, and never the
  -- proposer). Empty ⇒ only platform_owner (who can always approve).
  approver_roles    text[] not null default array['platform_owner','platform_admin']::text[],
  updated_at        timestamptz not null default now(),
  updated_by        uuid
);

comment on table public.platform_approval_rules is
  'Naruto §1.2: which dangerous platform actions need a second approver + who may approve.';

-- Seed the dangerous actions (spec §1.2). Upsert so re-running the migration
-- re-asserts labels/roles without clobbering an operator toggling requires_approval.
insert into public.platform_approval_rules (action, label, requires_approval, approver_roles) values
  ('plan.downgrade',         'Plan downgrade',            true, array['platform_owner','platform_admin','platform_finance']::text[]),
  ('entitlement.bulk',       'Bulk entitlement change',   true, array['platform_owner','platform_admin']::text[]),
  ('payments.route_account', 'Payout / Route account change', true, array['platform_owner','platform_finance']::text[]),
  ('payments.payout',        'Payout release',            true, array['platform_owner','platform_finance']::text[]),
  ('tenant.suspend',         'Tenant suspend',            true, array['platform_owner','platform_admin']::text[]),
  ('tenant.delete',          'Tenant delete',             true, array['platform_owner']::text[])
on conflict (action) do update set
  label          = excluded.label,
  approver_roles = excluded.approver_roles,
  updated_at     = now();

-- ── 2. Action proposals (the queue) ──────────────────────────────────────────
create table if not exists public.platform_action_proposals (
  id               uuid primary key default gen_random_uuid(),
  action           text not null,
  tenant_id        uuid,                       -- nullable: some actions aren't tenant-scoped
  args             jsonb not null default '{}'::jsonb,   -- the mutation inputs to replay
  before_json      jsonb,                      -- before-image captured at propose time
  reason           text not null,              -- why proposed (required)
  status           text not null default 'pending'
                     check (status in ('pending','approved','applied','rejected','failed','expired')),
  proposer_user_id uuid not null,
  proposer_role    text,
  approver_user_id uuid,                        -- MUST differ from proposer (enforced in code)
  decision_reason  text,
  after_json       jsonb,                       -- result of apply()
  error            text,                        -- populated when status='failed'
  created_at       timestamptz not null default now(),
  decided_at       timestamptz,
  applied_at       timestamptz,
  expires_at       timestamptz not null default (now() + interval '7 days')
);

comment on table public.platform_action_proposals is
  'Naruto §1.2: a dangerous platform mutation awaiting a second approver, then applied.';

create index if not exists pap_status_time on public.platform_action_proposals(status, created_at desc);
create index if not exists pap_tenant      on public.platform_action_proposals(tenant_id);

-- ── 3. Platform-team notification sink ───────────────────────────────────────
create table if not exists public.platform_notifications (
  id            uuid primary key default gen_random_uuid(),
  kind          text not null,                 -- 'approval.waiting' | 'action.break_glass' | ...
  severity      text not null default 'info'
                 check (severity in ('info','warn','critical')),
  title         text not null,
  body          text,
  ref_type      text,                          -- 'proposal' | 'audit' | ...
  ref_id        uuid,
  actor_user_id uuid,
  tenant_id     uuid,
  created_at    timestamptz not null default now(),
  read_at       timestamptz
);

comment on table public.platform_notifications is
  'Naruto §16: platform-team notifications (approvals waiting, break-glass). Read by the Overview needs-attention queue.';

create index if not exists pn_unread_time on public.platform_notifications(created_at desc) where read_at is null;
