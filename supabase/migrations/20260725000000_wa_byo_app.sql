-- Bring-your-own WhatsApp app (Tech Provider dual-mode).
--
-- Until our platform Meta app clears Business Verification + App Review for
-- Advanced Access to whatsapp_business_messaging / whatsapp_business_management,
-- it sits in dev mode and can only serve accounts that hold a role on it —
-- i.e. no real merchant. BYO is the bridge: a merchant who already owns a WABA
-- and their own Meta app can run on Frequency today, signing webhooks with
-- THEIR app secret.
--
-- Once Tech Provider approval lands, Embedded Signup becomes the default for
-- new tenants and these columns simply stay null (wa_mode = 'platform').
--
-- Outbound already used tenants.access_token per-tenant, so nothing here
-- changes the send path — only inbound verification and credential origin.

alter table public.tenants
  -- 'platform' = onboarded through our app (Embedded Signup / Tech Provider).
  -- 'byo'      = merchant's own Meta app; we hold their app id + secret.
  add column if not exists wa_mode text not null default 'platform',
  add column if not exists wa_app_id text,
  -- AES-256-GCM blob from lib/app-secrets.ts. Never returned to the browser.
  add column if not exists wa_app_secret_enc text,
  -- Per-tenant inbound webhook path segment. Lets us know WHICH app secret to
  -- verify an inbound signature against BEFORE parsing the body — avoids the
  -- parse-untrusted-JSON-then-verify ordering problem entirely.
  add column if not exists wa_webhook_token text,
  -- Last capability probe of the WABA (tier, quality, verification state).
  -- Drives automatic mode selection + the readout on the connection page.
  add column if not exists wa_capability jsonb,
  add column if not exists wa_capability_at timestamptz;

alter table public.tenants
  drop constraint if exists tenants_wa_mode_check;
alter table public.tenants
  add constraint tenants_wa_mode_check check (wa_mode in ('platform', 'byo'));

-- The webhook token is a lookup key on an unauthenticated route: it must be
-- unique, and the index is what keeps that resolution O(1) under Meta's
-- retry storms. Partial so the platform-mode rows (null) don't collide.
create unique index if not exists tenants_wa_webhook_token_key
  on public.tenants (wa_webhook_token)
  where wa_webhook_token is not null;

-- A BYO tenant is only complete with both halves of its app identity. Enforced
-- in the DB because a half-configured BYO row silently fails every inbound
-- signature check, which is painful to debug from logs alone.
alter table public.tenants
  drop constraint if exists tenants_byo_complete_check;
alter table public.tenants
  add constraint tenants_byo_complete_check check (
    wa_mode <> 'byo'
    or (wa_app_id is not null and wa_app_secret_enc is not null and wa_webhook_token is not null)
  );

-- Meta's data deletion callback (required to submit the app for review, and
-- an ongoing Tech Provider obligation). We record the request and hand Meta a
-- status URL + confirmation code rather than deleting inline — deletion spans
-- several tables and Meta expects a fast ack.
create table if not exists public.data_deletion_requests (
  id uuid primary key default gen_random_uuid(),
  meta_user_id text not null,
  confirmation_code text not null unique,
  status text not null default 'received' check (status in ('received', 'processing', 'completed', 'rejected')),
  created_at timestamptz not null default now(),
  completed_at timestamptz
);

create index if not exists data_deletion_requests_meta_user_idx
  on public.data_deletion_requests (meta_user_id);

-- Service-role only: the callback is written by the server, and the public
-- status page looks a row up by its unguessable confirmation code via the API.
alter table public.data_deletion_requests enable row level security;

comment on column public.tenants.wa_mode is
  'platform = our Meta app (Tech Provider onboarding); byo = merchant supplied their own app id + secret';
comment on column public.tenants.wa_webhook_token is
  'Path segment for /webhook/whatsapp/:token — identifies which app secret verifies the HMAC';
