-- Tenants: one row per connected WhatsApp Business Account
create table if not exists public.tenants (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid references auth.users(id) on delete cascade not null,
  -- Meta / WhatsApp
  waba_id          text unique not null,
  phone_number_id  text not null,
  access_token     text not null,          -- Meta user access token (long-lived)
  business_name    text,
  display_phone    text,                   -- e.g. "+91 98765 43210"
  -- Google OAuth
  google_email         text,
  google_access_token  text,
  google_refresh_token text,
  google_token_expiry  timestamptz,
  -- Status
  status           text not null default 'active'
                   check (status in ('active','disconnected','pending')),
  created_at       timestamptz default now(),
  updated_at       timestamptz default now()
);

alter table public.tenants enable row level security;

create policy "Users manage own tenants" on public.tenants
  for all using (auth.uid() = user_id);

-- Unique: one WABA per user (can be relaxed later)
create unique index if not exists tenants_user_waba on public.tenants(user_id, waba_id);

-- Workflow sessions: tracks each contact's position in a workflow
create table if not exists public.workflow_sessions (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid references public.tenants(id) on delete cascade not null,
  workflow_id     uuid references public.workflows(id) on delete cascade not null,
  contact_phone   text not null,          -- WhatsApp number e.g. "919876543210"
  current_node_id text not null,
  variables       jsonb default '{}'::jsonb,
  status          text not null default 'active'
                  check (status in ('active','completed','failed','abandoned')),
  started_at      timestamptz default now(),
  updated_at      timestamptz default now()
);

alter table public.workflow_sessions enable row level security;

-- Sessions are accessed via tenant → user ownership
create policy "Users manage own sessions" on public.workflow_sessions
  for all using (
    exists (
      select 1 from public.tenants t
      where t.id = tenant_id and t.user_id = auth.uid()
    )
  );

create index if not exists sessions_tenant_phone on public.workflow_sessions(tenant_id, contact_phone);
create index if not exists sessions_active on public.workflow_sessions(tenant_id, status) where status = 'active';

-- Inbound messages log
create table if not exists public.messages (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid references public.tenants(id) on delete cascade not null,
  session_id    uuid references public.workflow_sessions(id),
  direction     text not null check (direction in ('inbound','outbound')),
  contact_phone text not null,
  wa_message_id text,                     -- Meta's message ID
  content       jsonb not null,           -- {type, text, buttons, template, ...}
  status        text default 'sent'
                check (status in ('sent','delivered','read','failed')),
  created_at    timestamptz default now()
);

alter table public.messages enable row level security;

create policy "Users view own messages" on public.messages
  for all using (
    exists (
      select 1 from public.tenants t
      where t.id = tenant_id and t.user_id = auth.uid()
    )
  );

create index if not exists messages_tenant_phone on public.messages(tenant_id, contact_phone, created_at desc);
