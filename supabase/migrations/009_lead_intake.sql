-- Migration 009: Lead Intake module
-- Tables: lead_tables, lead_columns, lead_rows, lead_field_mappings, lead_assignment_rules

-- ── Lead table definitions ─────────────────────────────────────────────────────
create table if not exists lead_tables (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users(id) on delete cascade,
  name          text not null,
  description   text not null default '',
  source        text not null default 'manual', -- manual | csv | google_sheets | airtable
  source_config jsonb not null default '{}',
  row_count     integer not null default 0,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

-- ── Column schema per table ────────────────────────────────────────────────────
create table if not exists lead_columns (
  id          uuid primary key default gen_random_uuid(),
  table_id    uuid not null references lead_tables(id) on delete cascade,
  user_id     uuid not null,
  name        text not null,
  key         text not null,
  type        text not null default 'text', -- text | number | email | phone | date | select | boolean | url
  options     jsonb not null default '[]',  -- enum options for 'select' type
  is_required boolean not null default false,
  is_primary  boolean not null default false,
  position    integer not null default 0,
  created_at  timestamptz not null default now()
);

-- ── Lead rows (flexible JSONB storage) ────────────────────────────────────────
create table if not exists lead_rows (
  id               uuid primary key default gen_random_uuid(),
  table_id         uuid not null references lead_tables(id) on delete cascade,
  user_id          uuid not null,
  data             jsonb not null default '{}',
  assigned_to      text,
  assigned_to_name text not null default '',
  tags             text[] not null default '{}',
  status           text not null default 'new', -- new | contacted | qualified | lost | won
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

-- ── Saved field mapping presets ───────────────────────────────────────────────
create table if not exists lead_field_mappings (
  id          uuid primary key default gen_random_uuid(),
  table_id    uuid not null references lead_tables(id) on delete cascade,
  user_id     uuid not null,
  name        text not null,
  source_type text not null default 'csv',
  mappings    jsonb not null default '{}', -- { "csv_header": "column_key" }
  created_at  timestamptz not null default now()
);

-- ── Assignment rules ──────────────────────────────────────────────────────────
create table if not exists lead_assignment_rules (
  id               uuid primary key default gen_random_uuid(),
  table_id         uuid not null references lead_tables(id) on delete cascade,
  user_id          uuid not null,
  name             text not null,
  priority         integer not null default 0,
  conditions       jsonb not null default '[]', -- [{ field, operator, value }]
  assign_to        text not null,               -- user_id or identifier
  assign_to_name   text not null default '',
  assign_to_role   text not null default 'agent', -- senior | agent | junior
  apply_tags       text[] not null default '{}',
  is_active        boolean not null default true,
  created_at       timestamptz not null default now()
);

-- ── RLS ───────────────────────────────────────────────────────────────────────
alter table lead_tables           enable row level security;
alter table lead_columns          enable row level security;
alter table lead_rows             enable row level security;
alter table lead_field_mappings   enable row level security;
alter table lead_assignment_rules enable row level security;

do $$ begin
  if not exists (select 1 from pg_policies where tablename = 'lead_tables' and policyname = 'lead_tables_own') then
    create policy "lead_tables_own"    on lead_tables           for all using (auth.uid() = user_id);
  end if;
  if not exists (select 1 from pg_policies where tablename = 'lead_columns' and policyname = 'lead_columns_own') then
    create policy "lead_columns_own"   on lead_columns          for all using (auth.uid() = user_id);
  end if;
  if not exists (select 1 from pg_policies where tablename = 'lead_rows' and policyname = 'lead_rows_own') then
    create policy "lead_rows_own"      on lead_rows             for all using (auth.uid() = user_id);
  end if;
  if not exists (select 1 from pg_policies where tablename = 'lead_field_mappings' and policyname = 'lead_mappings_own') then
    create policy "lead_mappings_own"  on lead_field_mappings   for all using (auth.uid() = user_id);
  end if;
  if not exists (select 1 from pg_policies where tablename = 'lead_assignment_rules' and policyname = 'lead_rules_own') then
    create policy "lead_rules_own"     on lead_assignment_rules for all using (auth.uid() = user_id);
  end if;
end $$;

-- ── row_count trigger ─────────────────────────────────────────────────────────
create or replace function update_lead_table_row_count()
returns trigger language plpgsql security definer as $$
begin
  if TG_OP = 'INSERT' then
    update lead_tables
      set row_count = row_count + 1, updated_at = now()
    where id = NEW.table_id;
  elsif TG_OP = 'DELETE' then
    update lead_tables
      set row_count = greatest(0, row_count - 1), updated_at = now()
    where id = OLD.table_id;
  end if;
  return coalesce(NEW, OLD);
end;
$$;

drop trigger if exists trg_lead_rows_count on lead_rows;
create trigger trg_lead_rows_count
  after insert or delete on lead_rows
  for each row execute function update_lead_table_row_count();
