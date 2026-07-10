-- 20260711010000_assets_bucket_authed_upload
-- Allow authenticated browser-DIRECT uploads to the public `assets` bucket, so
-- the reusable FileField widget (table file-columns, menu images, logos) can
-- upload without a BE round-trip. Service-role uploads (/api/assets) still work
-- (service role bypasses RLS). Mirrors inbox-media / storefront-assets policies.

drop policy if exists "assets authed upload" on storage.objects;
create policy "assets authed upload" on storage.objects
  for insert to authenticated with check (bucket_id = 'assets');

drop policy if exists "assets owner update" on storage.objects;
create policy "assets owner update" on storage.objects
  for update to authenticated
  using (bucket_id = 'assets' and owner = auth.uid())
  with check (bucket_id = 'assets' and owner = auth.uid());

drop policy if exists "assets owner delete" on storage.objects;
create policy "assets owner delete" on storage.objects
  for delete to authenticated
  using (bucket_id = 'assets' and owner = auth.uid());

drop policy if exists "assets public read" on storage.objects;
create policy "assets public read" on storage.objects
  for select to public using (bucket_id = 'assets');
