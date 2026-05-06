-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 015 — Connector OAuth columns
--
-- The existing tenant_integrations table only stored API-key style configs.
-- To support OAuth flows (Razorpay, Shopify, Airtable, future apps) we need:
--
--   • access_token / refresh_token  — both AES-encrypted at rest
--   • token_expires_at               — for refresh-on-expiry (Airtable: 1h, Shopify: never, Razorpay: 24h)
--   • scope                          — granted scope strings, persist for audit
--   • brand_label                    — human label like "Acme Live store" / "rzp_live_..."
--   • metadata                       — provider-specific data (shopify shop_domain, etc.)
--
-- A short-lived oauth_states table holds CSRF + PKCE state across the popup
-- redirect. Rows are auto-pruned on use; old ones are cleaned by a poller.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── tenant_integrations: add OAuth columns ───────────────────────────────────
alter table public.tenant_integrations
  add column if not exists access_token      text,
  add column if not exists refresh_token     text,
  add column if not exists token_expires_at  timestamptz,
  add column if not exists scope             text,
  add column if not exists brand_label       text,
  add column if not exists metadata          jsonb default '{}'::jsonb,
  add column if not exists last_used_at      timestamptz;

create index if not exists ti_token_expiry
  on public.tenant_integrations(token_expires_at)
  where token_expires_at is not null;

-- ── oauth_states: CSRF + PKCE handshake state ────────────────────────────────
create table if not exists public.oauth_states (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid references public.tenants(id) on delete cascade not null,
  user_id         uuid references auth.users(id) on delete cascade not null,
  connector_key   text not null,
  state           text unique not null,         -- random CSRF token
  pkce_verifier   text,                          -- present for OAuth-PKCE flows
  redirect_origin text,                          -- where the popup was opened
  metadata        jsonb default '{}'::jsonb,    -- e.g. shopify { shop_domain }
  expires_at      timestamptz not null default (now() + interval '10 minutes'),
  created_at      timestamptz default now()
);

alter table public.oauth_states enable row level security;

create policy "oauth_states_owner" on public.oauth_states
  for all using (auth.uid() = user_id);

create index if not exists oauth_states_state on public.oauth_states(state);
create index if not exists oauth_states_expires on public.oauth_states(expires_at);

-- ── Drop old over-narrow check constraint on tenant_integrations.key (if any),
--    so new connector keys (airtable, shopify, ...) can be inserted.
do $$ begin
  -- defensive — only drop if it exists and is too narrow
  if exists (select 1 from information_schema.check_constraints
             where constraint_name = 'tenant_integrations_key_check') then
    alter table public.tenant_integrations drop constraint tenant_integrations_key_check;
  end if;
end $$;
