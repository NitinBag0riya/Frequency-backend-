-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 20260814 (e) — Naruto §2.3 bulk entitlement operations.
--
-- Backs the /naruto bulk-ops surface: filter tenants → apply one entitlement
-- change to the selection → run as a background job with per-tenant result +
-- retry → reversible for 24h.
--
--   entitlement_bulk_jobs        one row per bulk operation (the job header +
--                                progress counters + 24h reverse window).
--   entitlement_bulk_job_items   one row per selected tenant (the per-tenant
--                                result AND the pre-image needed to reverse it
--                                exactly — before_json restores storage).
--
-- The change itself lands in the existing stores (tenant_entitlements for a
-- feature ON/OFF/INHERIT override, tenant_subscriptions.plan_id for a plan
-- change). This table only orchestrates the fan-out and holds the reverse
-- image — no entitlement truth is duplicated here.
--
-- ADDITIVE + idempotent. RLS intentionally NOT enabled: the only reader/writer
-- is the platform bulk service (service-role client, capability-gated at the
-- route via requirePlatformCapability('entitlement.bulk.write')). No tenant-user
-- path reaches these tables.
-- ─────────────────────────────────────────────────────────────────────────────

create table if not exists public.entitlement_bulk_jobs (
  id              uuid primary key default gen_random_uuid(),
  actor_user_id   uuid,
  -- The change to apply. Discriminated by `kind`:
  --   { kind: 'feature_override', feature: 'kds', target: 'on'|'off'|'inherit' }
  --   { kind: 'plan_change', plan_id: 'growth' }
  action          jsonb not null,
  -- The filter that produced the selection (audit/debug — how these tenants
  -- were chosen). e.g. { vertical:'horeca', plan:null, lifecycle:'live', feature:'kds' }
  filter          jsonb not null default '{}'::jsonb,
  status          text not null default 'running'
                  check (status in ('running','completed','cancelling','cancelled')),
  -- Progress counters (denormalised from job_items for a cheap header read).
  total           int not null default 0,   -- rows in the selection
  affected        int not null default 0,   -- rows that will/did write
  noop            int not null default 0,   -- rows where nothing changes
  succeeded       int not null default 0,   -- affected rows applied OK
  failed          int not null default 0,   -- affected rows that errored
  reason          text,
  -- Double-clicked Apply must not fan out twice (spec §1.2 "all writes
  -- idempotent and keyed"). Optional per-actor key; duplicate returns the job.
  idempotency_key text,
  created_at      timestamptz not null default now(),
  finished_at     timestamptz,
  reversed_at     timestamptz,
  -- Reverse (undo the whole op) allowed only while now() < expires_at AND
  -- reversed_at is null (spec §2.3 "every bulk job reversible for 24h").
  expires_at      timestamptz not null default (now() + interval '24 hours')
);

create index if not exists entitlement_bulk_jobs_time
  on public.entitlement_bulk_jobs (created_at desc);

create unique index if not exists entitlement_bulk_jobs_idem
  on public.entitlement_bulk_jobs (actor_user_id, idempotency_key)
  where idempotency_key is not null;

create table if not exists public.entitlement_bulk_job_items (
  id           uuid primary key default gen_random_uuid(),
  job_id       uuid not null references public.entitlement_bulk_jobs(id) on delete cascade,
  tenant_id    uuid not null references public.tenants(id) on delete cascade,
  tenant_name  text,
  status       text not null default 'pending'
               check (status in ('pending','applied','noop','failed','reversed')),
  -- Reverse image + applied image, at the STORAGE layer:
  --   feature override → before/after = the tenant_entitlements row (null = no
  --                      override row; reverse of a create is a delete).
  --   plan change      → before/after = { plan_id }.
  before_json  jsonb,
  after_json   jsonb,
  error        text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create index if not exists entitlement_bulk_job_items_job
  on public.entitlement_bulk_job_items (job_id, status);

-- One item per tenant per job (a tenant can't be selected twice in one op).
create unique index if not exists entitlement_bulk_job_items_uniq
  on public.entitlement_bulk_job_items (job_id, tenant_id);
