-- Frequency Desktop — per-install attestation registry (Wave 3).
--
-- Each Frequency Desktop install enrols once (POST /api/desktop/enroll) by
-- registering an Ed25519 public key against a self-generated install id. The
-- private key never leaves the install; provisioning requests are signed with it
-- and verified here against the stored public key. This replaces the baked shared
-- secret as the primary trust gate (the legacy secret stays as a back-compat path).
--
-- First-write-wins: an install id is bound to its first public key and can only be
-- rebound by an explicit admin action (delete/rotate), so a leaked install id can't
-- be hijacked by re-enrolling a different key. `revoked` lets ops kill one install
-- without rotating the shared secret for everyone.
create table if not exists public.desktop_installs (
  install_id   text primary key,
  public_key   text        not null,           -- Ed25519 SPKI PEM
  revoked      boolean      not null default false,
  created_at   timestamptz  not null default now(),
  last_seen_at timestamptz  not null default now()
);

-- Service-role only: this table is written/read exclusively by the backend
-- (enrol + verify). No tenant/end-user access. RLS on with no policies = deny all
-- for anon/authenticated; the service role bypasses RLS.
alter table public.desktop_installs enable row level security;
