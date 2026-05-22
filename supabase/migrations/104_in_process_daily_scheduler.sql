-- ────────────────────────────────────────────────────────────────────────
-- Migration 104 — in-process daily scheduler primitives
-- ────────────────────────────────────────────────────────────────────────
-- Three jobs currently use BullMQ repeatables at 6h/24h cadence:
--   trial-ending           (6h)
--   agency-payout-aggregator (24h)
--   consent-expiry-sweep   (24h)
--
-- For polling that infrequent, BullMQ's retry/visibility/DLQ machinery
-- isn't pulling its weight — each repeatable still costs ~30 Redis ops
-- per tick + a permanent Worker connection, and the 24h ticks register
-- redundant repeatable schedules across every worker boot.
--
-- We move them to a simple in-process setInterval scheduler (see
-- src/lib/daily-scheduler.ts) coordinated through this table + RPC so
-- multiple worker replicas don't double-run a tick.
--
-- Why a table claim instead of pg_advisory_lock:
--   pg_advisory_lock is session-scoped. supabase-js makes a single
--   REST call per RPC, so the session — and the lock — ends as soon as
--   the call returns. We need a CAS-style "did this replica win the
--   tick?" check that survives across requests. Reading + updating
--   last_run_at atomically is the right shape.
-- ────────────────────────────────────────────────────────────────────────

create table if not exists public.system_job_runs (
  name              text primary key,
  last_run_at       timestamptz not null default '1970-01-01'::timestamptz,
  last_completed_at timestamptz,
  last_error        text,
  -- ↓ updated_at handy for ops queries ("which jobs are stale?").
  updated_at        timestamptz not null default now()
);

-- Try to claim a tick. Returns TRUE if this caller wins (and is now
-- expected to run the work), FALSE if another caller already claimed
-- within the interval window.
--
-- Race-safe: the WHERE clause on the ON CONFLICT DO UPDATE only fires
-- when the existing row's last_run_at is older than (now - interval).
-- Two callers running this in parallel will both attempt the UPDATE,
-- but only one will satisfy the WHERE — the other gets NULL out of
-- the RETURNING and we return false.
create or replace function public.try_claim_job_tick(
  p_name         text,
  p_min_interval interval
)
returns boolean
language plpgsql
as $$
declare
  v_claimed boolean;
begin
  insert into public.system_job_runs (name, last_run_at, updated_at)
  values (p_name, now(), now())
  on conflict (name) do update
    set last_run_at = excluded.last_run_at,
        updated_at  = excluded.updated_at
  where public.system_job_runs.last_run_at < now() - p_min_interval
  returning true into v_claimed;

  return coalesce(v_claimed, false);
end;
$$;

-- Record completion. Called from the in-process scheduler after the
-- handler resolves (with or without error). Best-effort — a failure
-- here is logged + swallowed so it can't double-fire the tick.
create or replace function public.mark_job_tick_complete(
  p_name  text,
  p_error text default null
)
returns void
language sql
as $$
  update public.system_job_runs
  set last_completed_at = now(),
      last_error        = p_error,
      updated_at        = now()
  where name = p_name;
$$;

-- ────────────────────────────────────────────────────────────────────────
-- Grants — RPCs callable by the service role only.
-- ────────────────────────────────────────────────────────────────────────
revoke all on function public.try_claim_job_tick(text, interval)   from public;
revoke all on function public.mark_job_tick_complete(text, text)   from public;
grant execute on function public.try_claim_job_tick(text, interval)   to service_role;
grant execute on function public.mark_job_tick_complete(text, text)   to service_role;

-- RLS not strictly needed (service-role-only access) but enable defensively.
alter table public.system_job_runs enable row level security;
-- No policies — RLS blocks anon/authed; service_role bypasses RLS.

comment on table public.system_job_runs
  is 'Distributed coordination for in-process daily scheduler (src/lib/daily-scheduler.ts). One row per scheduled job; multi-replica claim arbitration via try_claim_job_tick().';
