-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 20260814 (b) — Naruto Platform OS §4: tenant lifecycle state machine
--                          + §5 create-tenant identity columns.
--
-- ADDITIVE + idempotent. Extends the tenants table (the existing lifecycle
-- surface is status + deleted_at + status_changed_*; this adds the computed
-- lifecycle overlay on top, which is DERIVED and refreshed nightly, never a
-- replacement for `status`).
--
--   lifecycle_state   — computed state (lib/tenant-lifecycle.computeLifecycleState).
--                       Allowed values (enforced in code, the single writer):
--                       lead | provisioned | configuring | ready_to_launch |
--                       live | healthy | at_risk | dormant | churned | suspended
--   state_entered_at  — when the tenant entered its current lifecycle_state;
--                       bumped only on an actual transition, so the tenant list
--                       can render truthful TIME-IN-STATE.
--   timezone/currency — collected at create (§5 Step 1); no home on tenants
--                       before this (branding has neither). Defaults applied at
--                       create-time in code (Asia/Kolkata / INR).
-- ─────────────────────────────────────────────────────────────────────────────

alter table public.tenants
  add column if not exists lifecycle_state  text,
  add column if not exists state_entered_at timestamptz,
  add column if not exists timezone         text,
  add column if not exists currency         text;

-- Backfill state_entered_at so time-in-state is never null for existing tenants.
update public.tenants
   set state_entered_at = coalesce(status_changed_at, created_at, now())
 where state_entered_at is null;

-- Coarse initial lifecycle_state; the nightly recompute refines it from real
-- signals. suspended/deleted are respected up front so they never mis-read as
-- provisioned before the first recompute tick.
update public.tenants
   set lifecycle_state = case
         when status = 'suspended' then 'suspended'
         when status = 'deleted'   then 'churned'
         else 'provisioned'
       end
 where lifecycle_state is null;

-- Queue/filter index: the tenant list filters and the needs-attention queues
-- (e.g. "stuck in configuring > 3d") scan by state.
create index if not exists tenants_lifecycle_state_idx
  on public.tenants (lifecycle_state, state_entered_at);
