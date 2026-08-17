-- Frequency Desktop — health heartbeat.
--
-- Each install POSTs a signed heartbeat every couple of minutes carrying a compact
-- health snapshot (per-aggregator connect status, last order seen, orders relayed
-- today, misses recovered). Stored on the existing per-install row so /naruto can
-- show, at a glance, WHICH merchants are live and capturing — instead of finding out
-- from an angry merchant. Additive + nullable: a pre-heartbeat install is unaffected.
alter table public.desktop_installs
  add column if not exists health           jsonb,
  add column if not exists tenant_slug      text,
  add column if not exists app_version      text,
  add column if not exists last_heartbeat_at timestamptz;

-- Super-admin health view sorts by liveness; index the heartbeat recency.
create index if not exists desktop_installs_last_heartbeat_idx
  on public.desktop_installs (last_heartbeat_at desc nulls last);
