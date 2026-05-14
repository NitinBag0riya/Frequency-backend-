-- ─────────────────────────────────────────────────────────────────────────
-- 054_idempotency_keys.sql
--
-- F4: Idempotency-Key support for non-idempotent endpoints (send messages,
-- broadcast launches, billing checkout/cancel). Clients pass an
-- Idempotency-Key request header; the server caches the first response per
-- (tenant_id, key, endpoint) tuple and replays it for any duplicate request
-- inside the retention window.
--
-- Service-role only — no tenant SELECT/INSERT policy. The
-- src/lib/idempotency.ts helper uses the service role client; tenants must
-- never read each other's cached response bodies, so RLS is enabled with no
-- "allow" policy (default = deny everything).
-- ─────────────────────────────────────────────────────────────────────────

create table if not exists public.idempotency_keys (
  tenant_id     uuid       not null,
  key           text       not null,
  endpoint      text       not null,
  status_code   int        not null,
  response_body jsonb,
  created_at    timestamptz not null default now(),
  primary key (tenant_id, key, endpoint)
);

-- Cleanup index — a future cron job (or manual purge) deletes rows older
-- than 24h. PK already covers the common lookup path, but a created_at
-- range scan needs its own index.
create index if not exists idempotency_keys_created_idx
  on public.idempotency_keys (created_at);

-- Enable RLS with NO policies → effectively service-role only. This matches
-- the pattern used by other internal-only tables (webhook_dlq).
alter table public.idempotency_keys enable row level security;

-- Comment on table for future maintainers.
comment on table public.idempotency_keys is
  'F4: caches first response per (tenant, key, endpoint). Service-role only. Purge rows older than 24h.';
