-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 085 — Click-tracking on broadcast links (P2 #19).
--
-- BRIEF: AiSensy-style parity. When a tenant sends a broadcast with a URL in
-- the message body, the BE replaces each URL with a short tracking link of
-- the form  https://api.getfrequency.app/r/{token}  before dispatch. Each
-- recipient gets their OWN unique short-link, so a click can be attributed
-- back to the contact + broadcast + position-in-body without ever embedding
-- contact PII in the URL itself (the token is the only join key the public
-- internet sees).
--
-- Two tables:
--   1. broadcast_links       — the mapping (token → original_url + audience)
--   2. broadcast_link_clicks — append-only click events (multiple clicks per
--                              link are expected: phone, desktop, share-with-
--                              spouse, etc.)
--
-- Tenant-scoped RLS on both. Writes happen via the service role (the public
-- /r/:token redirect handler + the broadcast worker's pre-send shortener),
-- so authenticated/anon roles are EXPLICITLY denied insert/update/delete —
-- only the read paths the analytics UI uses are exposed.
--
-- Idempotent. Apply via `supabase db push`.
-- ─────────────────────────────────────────────────────────────────────────────

-- ─── 1. broadcast_links — token → original_url + audience mapping ────────────
-- One row per (broadcast, recipient, URL-position-in-body). The token is the
-- public identifier for the short link — base62, 6–16 chars. Default length
-- in the BE is 10 chars (~60 bits of entropy, collision probability negligible
-- at our scale: even at 100M links the birthday-paradox collision rate is
-- ~4e-7). The CHECK accepts the wider 6–16 range so we can shorten the
-- defaults later without a schema change.
--
-- `broadcast_id` and `contact_id` are nullable on purpose: the same shortener
-- also runs for ad-hoc inbox sends (no broadcast) and for tests against
-- contact-less synthetic numbers (smoke).
create table if not exists public.broadcast_links (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references public.tenants(id) on delete cascade,
  broadcast_id    uuid,
  contact_id      uuid,
  token           text not null unique check (token ~ '^[A-Za-z0-9]{6,16}$'),
  original_url    text not null check (length(original_url) between 4 and 2048),
  position        int  not null default 0,
  created_at      timestamptz not null default now()
);

create index if not exists idx_bl_broadcast      on public.broadcast_links(broadcast_id);
create index if not exists idx_bl_tenant_created on public.broadcast_links(tenant_id, created_at desc);

alter table public.broadcast_links enable row level security;

drop policy if exists "bl_tenant_read" on public.broadcast_links;
create policy "bl_tenant_read" on public.broadcast_links for select to authenticated
  using (
    tenant_id in (
      select tenant_id from public.user_role_assignments where user_id = auth.uid()
      union
      select tenant_id from public.user_roles where user_id = auth.uid()
      union
      select id from public.tenants where user_id = auth.uid()
    )
  );

-- Hard lock writes from the client roles. All inserts come from the service
-- role (broadcast worker + /r/:token redirect handler bypasses RLS).
revoke insert, update, delete on public.broadcast_links from authenticated;
revoke insert, update, delete on public.broadcast_links from anon;

-- ─── 2. broadcast_link_clicks — append-only click events ─────────────────────
-- Multiple clicks per link are expected (user opens on mobile then desktop,
-- forwards the WA message, etc.). Stored fields are deliberately PII-light:
--   - user_agent_hash: 16 hex chars of sha256(ua). Enough to dedupe
--     unique-clicks-per-link without retaining the raw UA string. DPDPA
--     friendly.
--   - ip_country_code: 2-letter ISO code. Sourced from the X-Country-Code
--     header that Vercel/Cloudflare put on the edge — we never store the
--     raw IP.
--   - referer_host: just the hostname (no path, no query). Useful for
--     attribution ("clicks coming from wa.me vs instagram.com").
create table if not exists public.broadcast_link_clicks (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references public.tenants(id) on delete cascade,
  link_id         uuid not null references public.broadcast_links(id) on delete cascade,
  broadcast_id    uuid,
  contact_id      uuid,
  clicked_at      timestamptz not null default now(),
  user_agent_hash text,
  ip_country_code text,
  referer_host    text
);

create index if not exists idx_blc_link        on public.broadcast_link_clicks(link_id, clicked_at desc);
create index if not exists idx_blc_broadcast   on public.broadcast_link_clicks(broadcast_id, clicked_at desc);
create index if not exists idx_blc_tenant_day  on public.broadcast_link_clicks(tenant_id, clicked_at desc);

alter table public.broadcast_link_clicks enable row level security;

drop policy if exists "blc_tenant_read" on public.broadcast_link_clicks;
create policy "blc_tenant_read" on public.broadcast_link_clicks for select to authenticated
  using (
    tenant_id in (
      select tenant_id from public.user_role_assignments where user_id = auth.uid()
      union
      select tenant_id from public.user_roles where user_id = auth.uid()
      union
      select id from public.tenants where user_id = auth.uid()
    )
  );

revoke insert, update, delete on public.broadcast_link_clicks from authenticated;
revoke insert, update, delete on public.broadcast_link_clicks from anon;
