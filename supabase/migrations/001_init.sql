-- Enable RLS on all tables
-- Run this in the Supabase SQL editor

-- Workflows
create table if not exists public.workflows (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid references auth.users(id) on delete cascade not null,
  name        text not null,
  description text,
  status      text not null default 'draft' check (status in ('draft','live','paused','archived')),
  intent_text text,
  nodes       jsonb default '[]'::jsonb,
  integrations text[] default '{}',
  stats       jsonb default '{"sent":0,"replied":0,"converted":0,"revenue":0,"conversionRate":0}'::jsonb,
  created_at  timestamptz default now(),
  updated_at  timestamptz default now()
);

alter table public.workflows enable row level security;

create policy "Users manage own workflows" on public.workflows
  for all using (auth.uid() = user_id);

-- Contacts
create table if not exists public.contacts (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid references auth.users(id) on delete cascade not null,
  name              text not null,
  phone             text not null,
  email             text,
  tags              text[] default '{}',
  status            text not null default 'active' check (status in ('active','opted_out','blocked')),
  attributes        jsonb default '{}'::jsonb,
  last_contacted_at timestamptz,
  assigned_to       text,
  created_at        timestamptz default now()
);

alter table public.contacts enable row level security;

create policy "Users manage own contacts" on public.contacts
  for all using (auth.uid() = user_id);

-- WA Templates
create table if not exists public.wa_templates (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid references auth.users(id) on delete cascade not null,
  name         text not null,
  category     text not null check (category in ('marketing','utility','authentication')),
  language     text not null default 'en',
  status       text not null default 'draft' check (status in ('approved','pending','rejected','draft')),
  header       jsonb,
  body         text not null,
  footer       text,
  buttons      jsonb,
  variables    text[] default '{}',
  usage_count  int default 0,
  created_at   timestamptz default now(),
  last_used_at timestamptz
);

alter table public.wa_templates enable row level security;

create policy "Users manage own templates" on public.wa_templates
  for all using (auth.uid() = user_id);

-- Broadcasts
create table if not exists public.broadcasts (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid references auth.users(id) on delete cascade not null,
  name          text not null,
  template_id   uuid references public.wa_templates(id),
  template_name text,
  status        text not null default 'draft' check (status in ('draft','scheduled','sending','sent','failed')),
  audience      jsonb not null default '{}'::jsonb,
  scheduled_at  timestamptz,
  sent_at       timestamptz,
  stats         jsonb default '{"sent":0,"delivered":0,"read":0,"replied":0,"failed":0}'::jsonb,
  created_at    timestamptz default now()
);

alter table public.broadcasts enable row level security;

create policy "Users manage own broadcasts" on public.broadcasts
  for all using (auth.uid() = user_id);

-- Campaigns
create table if not exists public.campaigns (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid references auth.users(id) on delete cascade not null,
  name          text not null,
  description   text,
  status        text not null default 'draft' check (status in ('draft','active','paused','completed')),
  type          text not null check (type in ('drip','one_time','triggered')),
  audience      jsonb not null default '{}'::jsonb,
  message_count int default 1,
  stats         jsonb default '{"enrolled":0,"completed":0,"converted":0,"revenue":0,"conversionRate":0}'::jsonb,
  created_at    timestamptz default now(),
  updated_at    timestamptz default now()
);

alter table public.campaigns enable row level security;

create policy "Users manage own campaigns" on public.campaigns
  for all using (auth.uid() = user_id);

-- User profiles (extended from auth.users)
create table if not exists public.profiles (
  id         uuid primary key references auth.users(id) on delete cascade,
  full_name  text,
  avatar_url text,
  plan       text default 'free',
  wa_number  text,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

alter table public.profiles enable row level security;

create policy "Users view/update own profile" on public.profiles
  for all using (auth.uid() = id);

-- Auto-create profile on signup
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, full_name)
  values (new.id, new.raw_user_meta_data->>'full_name');
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();
