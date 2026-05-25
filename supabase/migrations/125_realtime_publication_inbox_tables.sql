-- Add the inbox-driving tables to the supabase_realtime publication so
-- the FE's `supabase.channel(...).on('postgres_changes', ...)`
-- subscriptions actually receive INSERT/UPDATE events.
--
-- Without this, the InboxPage subscribes to messages + contacts and
-- NotificationBell subscribes to notifications, but Supabase never
-- publishes changes for those tables (only call_* tables were in the
-- publication), so the inbox feels frozen — new inbound WhatsApp
-- replies land in the DB but never appear in the UI until the user
-- manually reloads the page. This is the inbox "not updating in
-- realtime" bug.
--
-- Idempotent: ADD TABLE on an already-published table errors, so
-- check pg_publication_tables first.
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and tablename = 'messages' and schemaname = 'public'
  ) then
    alter publication supabase_realtime add table public.messages;
  end if;

  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and tablename = 'contacts' and schemaname = 'public'
  ) then
    alter publication supabase_realtime add table public.contacts;
  end if;

  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and tablename = 'notifications' and schemaname = 'public'
  ) then
    alter publication supabase_realtime add table public.notifications;
  end if;
end $$;

-- REPLICA IDENTITY FULL ensures UPDATE events carry the old row too —
-- needed for the FE to compute deltas on status transitions (queued →
-- sent → delivered → read) and on contact attribute changes. DEFAULT
-- replica identity only sends primary-key + changed columns, which
-- breaks rules like "did the status field change?" because both old
-- and new are visible to the realtime listener but not to a downstream
-- filter that only sees `new` post-merge.
alter table public.messages       replica identity full;
alter table public.contacts       replica identity full;
alter table public.notifications  replica identity full;
