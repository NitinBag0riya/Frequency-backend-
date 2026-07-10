-- 20260711000000_storefront_assets_bucket
-- Public `storefront-assets` bucket for storefront branding images (logo / hero
-- / dish), uploaded BROWSER-DIRECT by uploadBrandImage() in FE src/lib/storefront.ts.
-- Mirrors the inbox-media setup: public read + authenticated upload + owner
-- update/delete. Without this bucket the FE throws
-- 'Create a public "storefront-assets" bucket in Supabase Storage first.'

insert into storage.buckets (id, name, public, file_size_limit)
values ('storefront-assets', 'storefront-assets', true, 52428800)
on conflict (id) do update set public = true, file_size_limit = 52428800;

-- Browser-direct upload → needs storage.objects policies for the authenticated role.
drop policy if exists "storefront-assets authed upload" on storage.objects;
create policy "storefront-assets authed upload" on storage.objects
  for insert to authenticated with check (bucket_id = 'storefront-assets');

drop policy if exists "storefront-assets owner update" on storage.objects;
create policy "storefront-assets owner update" on storage.objects
  for update to authenticated
  using (bucket_id = 'storefront-assets' and owner = auth.uid())
  with check (bucket_id = 'storefront-assets' and owner = auth.uid());

drop policy if exists "storefront-assets owner delete" on storage.objects;
create policy "storefront-assets owner delete" on storage.objects
  for delete to authenticated
  using (bucket_id = 'storefront-assets' and owner = auth.uid());

drop policy if exists "storefront-assets public read" on storage.objects;
create policy "storefront-assets public read" on storage.objects
  for select to public using (bucket_id = 'storefront-assets');
