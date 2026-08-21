-- Nine public tables shipped with RLS off. Supabase's default privileges grant
-- anon + authenticated full DML on every new table in `public`, so each one was
-- readable AND writable (including TRUNCATE) with the anon key that ships in the
-- browser bundle. platform_approval_rules -- which decides what needs approval --
-- was the worst of them.
--
-- Every one is service-role only: verified zero references in src/ (dashboard),
-- storefront/ and storefront-api/, and every backend caller receives the
-- SERVICE_ROLE client from index.ts. service_role bypasses RLS, so nothing
-- in the product changes.
--
-- Belt and braces on purpose: RLS with no policy already denies anon/authenticated,
-- but the REVOKE survives someone later adding a permissive policy by accident.

do $$
declare t text;
begin
  foreach t in array array[
    'guest_sessions',
    'platform_notifications',
    'platform_nudge_log',
    'platform_nudge_rules',
    'platform_action_proposals',
    'platform_approval_rules',
    'catalog_import_batches',
    'entitlement_bulk_jobs',
    'entitlement_bulk_job_items'
  ] loop
    if to_regclass('public.' || t) is null then
      raise notice 'skip %: not present', t;
      continue;
    end if;
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from anon, authenticated', t);
  end loop;
end $$;
