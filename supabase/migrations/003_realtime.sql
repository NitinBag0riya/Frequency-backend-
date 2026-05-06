-- Add bot_paused + notes to contacts
alter table public.contacts add column if not exists bot_paused  boolean default false;
alter table public.contacts add column if not exists notes       text;

-- Enable Supabase Realtime on key tables
-- (run once; safe to re-run)
do $$
begin
  begin
    alter publication supabase_realtime add table public.messages;
  exception when others then null;
  end;
  begin
    alter publication supabase_realtime add table public.contacts;
  exception when others then null;
  end;
  begin
    alter publication supabase_realtime add table public.tenants;
  exception when others then null;
  end;
end $$;

-- Index for realtime conversation list (latest msg per contact)
create index if not exists messages_tenant_contact_time
  on public.messages(tenant_id, contact_phone, created_at desc);
