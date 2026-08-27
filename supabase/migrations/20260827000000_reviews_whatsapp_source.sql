-- 20260827000000_reviews_whatsapp_source
-- WhatsApp becomes a first-class review source.
--
-- NO constraint change is needed: public.reviews.source is a plain `text not null`
-- (see 20260812000000_reviews.sql) — no CHECK, no enum — so 'whatsapp' is already
-- accepted by the database. The allowed set is enforced in the app (SOURCES in
-- src/routes/reviews.ts). This migration only refreshes the column comment and adds
-- the index the new own-channel dedupe reads on every rating ingest.
--
-- Why the index: a guest rating can arrive twice for ONE order — storefront-api
-- mirrors every rating it records (source 'storefront') and the WhatsApp webhook
-- mirrors the same rating with the channel it knows (source 'whatsapp'). ingestReview
-- collapses the pair onto one row by looking the order up as (tenant_id, order_ref);
-- without this index that lookup scans the tenant's whole review history per write.
-- Additive and idempotent — safe to replay.

comment on column public.reviews.source is
  '''storefront'' | ''whatsapp'' | ''zomato'' | ''swiggy''. storefront + whatsapp are OUR OWN channels: two doors onto the same guest rating on the same order, collapsed to ONE row keyed by (tenant_id, order_ref) — see OWN_CHANNELS in src/routes/reviews.ts.';

create index if not exists reviews_tenant_order_idx
  on public.reviews (tenant_id, order_ref)
  where order_ref is not null;
