-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 016 — Omnichannel foundation
--
-- Turns the WhatsApp-only data model into a channel-aware one without
-- destroying existing rows. Strategy:
--   • Add `channel text` to messages / broadcasts / campaign_steps with
--     DEFAULT 'whatsapp' so back-fill is automatic.
--   • Rename `messages.wa_message_id` → `platform_message_id` so the column
--     name no longer lies about its content.
--   • Add channel-identity columns to contacts (`instagram_id`, `telegram_id`,
--     `channel_primary`) so a single contact can be reached on multiple
--     channels and we can index per-channel reachability.
--   • Carve out per-channel feature tables (catalog, flows, QR codes, profile,
--     IG comments, Telegram bots, Meta Ads campaigns). Each has tenant_id +
--     RLS so multi-tenant isolation matches the rest of the schema.
--
-- All ALTER statements are idempotent — the file is safe to re-run.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── messages: channel + rename wa_message_id ────────────────────────────────
alter table public.messages
  add column if not exists channel text not null default 'whatsapp';

-- Constrain to known channels; drop & recreate if it already exists with a
-- narrower set so we can add new channels later.
alter table public.messages
  drop constraint if exists messages_channel_check;
alter table public.messages
  add constraint messages_channel_check
  check (channel in ('whatsapp','instagram','telegram','email','sms'));

-- Rename wa_message_id → platform_message_id (only if not already renamed)
do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema='public' and table_name='messages' and column_name='wa_message_id'
  ) and not exists (
    select 1 from information_schema.columns
    where table_schema='public' and table_name='messages' and column_name='platform_message_id'
  ) then
    alter table public.messages rename column wa_message_id to platform_message_id;
  end if;
end$$;

-- Index for channel-filtered conversation queries
create index if not exists messages_tenant_channel_phone
  on public.messages(tenant_id, channel, contact_phone, created_at desc);

-- ── contacts: per-channel identifiers ───────────────────────────────────────
alter table public.contacts
  add column if not exists instagram_id    text,
  add column if not exists telegram_id     text,
  add column if not exists channel_primary text default 'whatsapp';

-- Constrain channel_primary to known channels (idempotent re-create)
alter table public.contacts
  drop constraint if exists contacts_channel_primary_check;
alter table public.contacts
  add constraint contacts_channel_primary_check
  check (channel_primary is null or channel_primary in ('whatsapp','instagram','telegram','email','sms'));

create index if not exists contacts_ig
  on public.contacts(tenant_id, instagram_id) where instagram_id is not null;
create index if not exists contacts_tg
  on public.contacts(tenant_id, telegram_id)  where telegram_id  is not null;

-- ── broadcasts: channel column ──────────────────────────────────────────────
alter table public.broadcasts
  add column if not exists channel text not null default 'whatsapp';
alter table public.broadcasts
  drop constraint if exists broadcasts_channel_check;
alter table public.broadcasts
  add constraint broadcasts_channel_check
  check (channel in ('whatsapp','instagram','telegram','email','sms'));
create index if not exists broadcasts_tenant_channel
  on public.broadcasts(tenant_id, channel, created_at desc);

-- ── campaign_steps: channel per step ────────────────────────────────────────
alter table public.campaign_steps
  add column if not exists channel text default 'whatsapp';
alter table public.campaign_steps
  drop constraint if exists campaign_steps_channel_check;
alter table public.campaign_steps
  add constraint campaign_steps_channel_check
  check (channel is null or channel in ('whatsapp','instagram','telegram','email','sms'));

-- ─────────────────────────────────────────────────────────────────────────────
-- WhatsApp commerce + flows + QR + profile
-- ─────────────────────────────────────────────────────────────────────────────

-- WA Catalog (Meta-side product catalog metadata; each product mirrored locally)
create table if not exists public.wa_catalog_products (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references public.tenants(id) on delete cascade,
  meta_product_id text,                         -- Meta retailer_id or fb_product_id
  name            text not null,
  description     text,
  price           numeric(12,2),
  currency        text default 'INR',
  image_url       text,
  url             text,
  source          text not null default 'manual'
                  check (source in ('manual','shopify','google_sheets','lead_table')),
  source_ref      text,                          -- shopify product_id, sheet row id, table id
  metadata        jsonb default '{}'::jsonb,
  created_at      timestamptz default now(),
  updated_at      timestamptz default now()
);
alter table public.wa_catalog_products enable row level security;
create policy "Tenant manages own catalog products" on public.wa_catalog_products
  for all using (
    exists (select 1 from public.tenants t where t.id = tenant_id and t.user_id = auth.uid())
  );
create index if not exists wa_catalog_tenant on public.wa_catalog_products(tenant_id, created_at desc);

-- WA Flows (Meta WhatsApp Flows; multi-screen interactive forms)
create table if not exists public.wa_flows (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references public.tenants(id) on delete cascade,
  meta_flow_id text unique,
  name         text not null,
  status       text not null default 'DRAFT'
               check (status in ('DRAFT','PUBLISHED','DEPRECATED')),
  category     text,                           -- SIGN_UP / LEAD_GEN / SURVEY / etc.
  definition   jsonb not null default '{}'::jsonb,
  created_at   timestamptz default now(),
  updated_at   timestamptz default now()
);
alter table public.wa_flows enable row level security;
create policy "Tenant manages own flows" on public.wa_flows
  for all using (
    exists (select 1 from public.tenants t where t.id = tenant_id and t.user_id = auth.uid())
  );
create index if not exists wa_flows_tenant on public.wa_flows(tenant_id, status, created_at desc);

create table if not exists public.wa_flow_responses (
  id            uuid primary key default gen_random_uuid(),
  flow_id       uuid references public.wa_flows(id) on delete cascade,
  tenant_id     uuid not null references public.tenants(id) on delete cascade,
  contact_id    uuid references public.contacts(id) on delete set null,
  contact_phone text,
  screen_id     text,
  response_data jsonb not null default '{}'::jsonb,
  created_at    timestamptz default now()
);
alter table public.wa_flow_responses enable row level security;
create policy "Tenant manages own flow responses" on public.wa_flow_responses
  for all using (
    exists (select 1 from public.tenants t where t.id = tenant_id and t.user_id = auth.uid())
  );
create index if not exists wa_flow_responses_flow
  on public.wa_flow_responses(flow_id, created_at desc);

-- WA QR codes (deep links via wa.me with prefilled message)
create table if not exists public.wa_qr_codes (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.tenants(id) on delete cascade,
  code        text not null,                    -- short code shown to humans
  prefilled_message text,
  url         text not null,                    -- wa.me/<phone>?text=...
  uses        int  default 0,
  created_at  timestamptz default now()
);
alter table public.wa_qr_codes enable row level security;
create policy "Tenant manages own QR codes" on public.wa_qr_codes
  for all using (
    exists (select 1 from public.tenants t where t.id = tenant_id and t.user_id = auth.uid())
  );
create unique index if not exists wa_qr_tenant_code
  on public.wa_qr_codes(tenant_id, code);

-- WA Business profile (mirror of Meta phone-number profile)
create table if not exists public.wa_business_profiles (
  tenant_id    uuid primary key references public.tenants(id) on delete cascade,
  about        text,
  description  text,
  email        text,
  websites     text[] default '{}',
  vertical     text,
  address      text,
  profile_picture_url text,
  updated_at   timestamptz default now()
);
alter table public.wa_business_profiles enable row level security;
create policy "Tenant manages own profile" on public.wa_business_profiles
  for all using (
    exists (select 1 from public.tenants t where t.id = tenant_id and t.user_id = auth.uid())
  );

-- ─────────────────────────────────────────────────────────────────────────────
-- Instagram automation
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists public.ig_comment_rules (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references public.tenants(id) on delete cascade,
  name            text not null,
  trigger_keywords text[] not null default '{}',
  match_kind      text not null default 'contains'
                  check (match_kind in ('contains','exact','starts_with','any')),
  reply_text      text,
  auto_dm_text    text,
  enabled         boolean default true,
  fired_count     int default 0,
  created_at      timestamptz default now()
);
alter table public.ig_comment_rules enable row level security;
create policy "Tenant manages own ig_comment_rules" on public.ig_comment_rules
  for all using (
    exists (select 1 from public.tenants t where t.id = tenant_id and t.user_id = auth.uid())
  );

create table if not exists public.ig_posts (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references public.tenants(id) on delete cascade,
  meta_post_id text,
  type         text not null default 'image'
               check (type in ('image','carousel','reel','story')),
  caption      text,
  media_urls   text[] default '{}',
  scheduled_at timestamptz,
  published_at timestamptz,
  status       text not null default 'draft'
               check (status in ('draft','scheduled','published','failed')),
  created_at   timestamptz default now()
);
alter table public.ig_posts enable row level security;
create policy "Tenant manages own ig_posts" on public.ig_posts
  for all using (
    exists (select 1 from public.tenants t where t.id = tenant_id and t.user_id = auth.uid())
  );

-- ─────────────────────────────────────────────────────────────────────────────
-- Telegram bots + mini-apps + payments
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists public.tg_bots (
  tenant_id    uuid primary key references public.tenants(id) on delete cascade,
  bot_username text,
  bot_id       bigint,
  bot_token    text not null,                    -- AES-encrypted; same crypto.ts as connector tokens
  webhook_url  text,
  commands     jsonb default '[]'::jsonb,        -- [{command, description}]
  short_description text,
  description  text,
  created_at   timestamptz default now(),
  updated_at   timestamptz default now()
);
alter table public.tg_bots enable row level security;
create policy "Tenant manages own tg_bot" on public.tg_bots
  for all using (
    exists (select 1 from public.tenants t where t.id = tenant_id and t.user_id = auth.uid())
  );

create table if not exists public.tg_mini_apps (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.tenants(id) on delete cascade,
  name        text not null,
  url         text not null,
  short_name  text,
  created_at  timestamptz default now()
);
alter table public.tg_mini_apps enable row level security;
create policy "Tenant manages own tg_mini_apps" on public.tg_mini_apps
  for all using (
    exists (select 1 from public.tenants t where t.id = tenant_id and t.user_id = auth.uid())
  );

create table if not exists public.tg_invoices (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references public.tenants(id) on delete cascade,
  contact_phone text,
  amount        bigint not null,                  -- in Stars (smallest unit)
  currency      text default 'XTR',               -- Telegram Stars
  payload       text not null,                    -- opaque app reference
  title         text,
  description   text,
  status        text not null default 'pending'
                check (status in ('pending','paid','failed','refunded')),
  invoice_link  text,
  paid_at       timestamptz,
  created_at    timestamptz default now()
);
alter table public.tg_invoices enable row level security;
create policy "Tenant manages own tg_invoices" on public.tg_invoices
  for all using (
    exists (select 1 from public.tenants t where t.id = tenant_id and t.user_id = auth.uid())
  );

-- ─────────────────────────────────────────────────────────────────────────────
-- Meta Ads (CTWA / CTID / Lead Ads / Audiences / CAPI)
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists public.meta_ad_accounts (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references public.tenants(id) on delete cascade,
  ad_account_id text not null,                    -- act_xxx
  name          text,
  currency      text,
  business_id   text,
  created_at    timestamptz default now()
);
alter table public.meta_ad_accounts enable row level security;
create policy "Tenant manages own ad_accounts" on public.meta_ad_accounts
  for all using (
    exists (select 1 from public.tenants t where t.id = tenant_id and t.user_id = auth.uid())
  );

create table if not exists public.meta_ad_campaigns (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references public.tenants(id) on delete cascade,
  ad_account_id text not null,
  meta_campaign_id text unique,
  name          text not null,
  objective     text not null
                check (objective in ('OUTCOME_ENGAGEMENT','OUTCOME_LEADS','OUTCOME_TRAFFIC','OUTCOME_SALES','OUTCOME_AWARENESS','OUTCOME_APP_PROMOTION')),
  destination   text,                              -- 'whatsapp' | 'instagram_dm' | 'website' | 'app'
  status        text not null default 'PAUSED'
                check (status in ('ACTIVE','PAUSED','DELETED','ARCHIVED')),
  daily_budget  numeric(12,2),
  start_time    timestamptz,
  stop_time     timestamptz,
  metadata      jsonb default '{}'::jsonb,
  created_at    timestamptz default now()
);
alter table public.meta_ad_campaigns enable row level security;
create policy "Tenant manages own ad_campaigns" on public.meta_ad_campaigns
  for all using (
    exists (select 1 from public.tenants t where t.id = tenant_id and t.user_id = auth.uid())
  );

create table if not exists public.meta_lead_forms (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references public.tenants(id) on delete cascade,
  form_id       text unique not null,
  name          text not null,
  page_id       text,
  questions     jsonb default '[]'::jsonb,
  follow_up_template_name text,                    -- WhatsApp template auto-sent on lead
  follow_up_lead_table_id uuid,                    -- where leads land (FK kept loose; lead_tables is in another schema)
  created_at    timestamptz default now()
);
alter table public.meta_lead_forms enable row level security;
create policy "Tenant manages own lead_forms" on public.meta_lead_forms
  for all using (
    exists (select 1 from public.tenants t where t.id = tenant_id and t.user_id = auth.uid())
  );

create table if not exists public.meta_audiences (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references public.tenants(id) on delete cascade,
  ad_account_id text not null,
  meta_audience_id text unique,
  name          text not null,
  type          text not null check (type in ('CUSTOM','LOOKALIKE','VALUE_BASED')),
  source        text,                              -- 'phone_hash','email_hash','crm','website','engagement'
  size_estimate bigint,
  status        text default 'PROCESSING',
  created_at    timestamptz default now()
);
alter table public.meta_audiences enable row level security;
create policy "Tenant manages own audiences" on public.meta_audiences
  for all using (
    exists (select 1 from public.tenants t where t.id = tenant_id and t.user_id = auth.uid())
  );

-- ─────────────────────────────────────────────────────────────────────────────
-- Channel filter helper view
--   Lists the connected message channels for a tenant. Used by
--   GET /api/channels/connected to populate filter tabs without round-tripping
--   tenant_integrations + tenants twice.
-- ─────────────────────────────────────────────────────────────────────────────
create or replace view public.tenant_connected_channels as
  -- WhatsApp lives on tenants (legacy)
  select t.id as tenant_id, 'whatsapp'::text as channel
  from public.tenants t
  where t.waba_id is not null and t.status = 'active'
  union
  select tg.tenant_id, 'telegram'::text from public.tg_bots tg
  union
  select ti.tenant_id, 'instagram'::text
  from public.tenant_integrations ti
  where ti.key = 'instagram' and (ti.status is null or ti.status = 'active');
