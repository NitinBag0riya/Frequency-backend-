-- 20260812000000_reviews
-- Unified Reviews & Ratings — one normalised table for storefront + Zomato + Swiggy.
--
-- See docs/reviews-ratings-design.md. Reuse-first: this table feeds the /reviews
-- inbox, the R11 analytics, and the review.low / review.digest notifications
-- (existing emitNotification path). Per-source specifics ride in source_meta jsonb.
--
-- HoReCa-gated at the API/route layer (business_type='horeca'); the table itself
-- is vertical-agnostic so Salon/D2C can inherit storefront reviews later.

create table if not exists public.reviews (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null references public.tenants(id) on delete cascade,
  outlet_ref       text,                             -- res_id / swiggy rest id / storefront outlet id
  source           text not null,                    -- 'storefront' | 'zomato' | 'swiggy'
  source_review_id text,                             -- provider's review id (null → we synthesise, see unique index)
  order_ref        text,                             -- provider order id / storefront order id (nullable)

  -- normalized score: store BOTH the raw and a 1–5 star projection
  rating           numeric,                          -- provider raw (Zomato 1–5, storefront 1–5, Swiggy aggregate)
  rating_scale     smallint not null default 5,      -- 5 for star sources; 10 only if a 0–10 source is ever added
  stars            smallint,                         -- rating normalized to 1–5 (set on write)
  is_aggregate     boolean not null default false,   -- true = outlet-level score (Swiggy today), not a person's review

  title            text,
  text             text,                             -- review body (null for bare ratings)
  dish_ratings     jsonb,                            -- [{ item, item_ref, stars }]  (Zomato dish-level when present)
  tags             text[],                           -- provider tags + operator tags (e.g. 'late', 'cold-food')

  customer_name    text,
  customer_ref     text,                             -- provider customer id → join to CRM/khata
  business_line    text,                             -- 'delivery' | 'dining' | null  (Zomato filter)

  sentiment        text,                             -- 'positive'|'neutral'|'negative' (derived)
  theme            text[],                           -- derived themes: 'taste','packaging','delivery-time',...

  reply_text       text,                             -- our reply body
  reply_status     text not null default 'none',     -- 'none'|'draft'|'queued'|'sent'|'unsupported'
  reply_at         timestamptz,
  reply_by         uuid references auth.users(id),

  status           text not null default 'new',      -- 'new'|'seen'|'actioned'|'ignored'
  complaint_ref    text,                             -- link to customer-issues / khata dispute
  source_meta      jsonb,                            -- raw provider fields we don't promote to columns

  review_at        timestamptz,                      -- when the customer left it (provider timestamp)
  ingested_at      timestamptz not null default now(),
  updated_at       timestamptz not null default now(),

  -- Idempotent ingest (dedupe replays / status re-syncs). The app ALWAYS supplies
  -- source_review_id (storefront order id · Zomato review id · synth agg:<outlet>:<date>
  -- for Swiggy), so the NULLs-are-distinct caveat never bites; a plain unique
  -- constraint lets the ingest upsert target it via onConflict.
  unique (tenant_id, source, source_review_id)
);

create index if not exists reviews_tenant_time_idx  on public.reviews (tenant_id, review_at desc);
create index if not exists reviews_tenant_stars_idx on public.reviews (tenant_id, source, stars);
-- The work queue: ≤3★ unanswered.
create index if not exists reviews_low_unanswered_idx
  on public.reviews (tenant_id, stars, reply_status)
  where is_aggregate = false;

-- RLS: tenant-scoped, mirroring the khaata/orders pattern (owner via tenants.user_id
-- UNION team via user_role_assignments/user_roles). Backend uses the service role
-- (bypasses RLS); this is defense-in-depth for any direct/anon-key read.
alter table public.reviews enable row level security;

drop policy if exists "reviews_tenant_rw" on public.reviews;
create policy "reviews_tenant_rw" on public.reviews for all to authenticated
  using (
    tenant_id in (
      select id from public.tenants where user_id = auth.uid()
      union
      select tenant_id from public.user_role_assignments where user_id = auth.uid()
      union
      select tenant_id from public.user_roles where user_id = auth.uid()
    )
  );

comment on table public.reviews is
  'Unified customer reviews/ratings across storefront + Zomato + Swiggy. See src/routes/reviews.ts and docs/reviews-ratings-design.md.';

-- ── Notification event types ────────────────────────────────────────────────
-- review.low fires on any ≤3★ non-aggregate review (real-time); review.digest is
-- a daily rollup. Both ride the existing emitNotification fan-out — no dispatch code.
insert into public.notification_event_types
  (key, category, title_template, body_template, default_channels, severity, description)
values
  ('review.low', 'reviews', 'New {{source}} review: {{stars}}★',
    '"{{text_snippet}}" — {{customer_name}} · {{outlet}}', array['in_app']::text[], 'high',
    'A customer left a low rating (≤3★) on storefront/Zomato/Swiggy'),
  ('review.digest', 'reviews', 'Reviews today: {{total}} · avg {{avg_stars}}★',
    '{{unanswered_low}} low ratings still need a reply', array['in_app']::text[], 'info',
    'Daily rollup of new reviews by source, average stars, and unanswered low ratings')
on conflict (key) do update set
  category         = excluded.category,
  title_template   = excluded.title_template,
  body_template    = excluded.body_template,
  default_channels = excluded.default_channels,
  severity         = excluded.severity,
  description      = excluded.description;

-- ── Backfill storefront reviews already collected ───────────────────────────
-- The storefront feedback handler has long stored o.rating/o.comment on each
-- order; those orders are mirrored to public.orders (raw jsonb holds the rating).
-- Import them once as source='storefront' rows. Historical → no alerts (INSERT,
-- not the ingest path). ON CONFLICT keeps it idempotent + re-runnable. Guarded so
-- the migration is safe in environments where the orders table isn't present.
do $$
begin
  if to_regclass('public.orders') is not null then
    insert into public.reviews
      (tenant_id, outlet_ref, source, source_review_id, order_ref,
       rating, stars, text, customer_name, customer_ref, business_line, review_at, ingested_at)
    select
      o.tenant_id,
      o.outlet_id,
      'storefront',
      o.id,
      o.id,
      (o.raw->>'rating')::numeric,
      least(5, greatest(1, round((o.raw->>'rating')::numeric)))::smallint,
      nullif(o.raw->>'comment', ''),
      o.guest_name,
      o.guest_key,
      case when o.raw->>'table' is not null and o.raw->>'table' <> 'null' then 'dining' else null end,
      coalesce(o.paid_at, o.created_at),
      now()
    from public.orders o
    where o.tenant_id is not null
      and (o.raw->>'rating') ~ '^[0-9]+(\.[0-9]+)?$'
      and (o.raw->>'rating')::numeric >= 1
    on conflict (tenant_id, source, source_review_id) do nothing;
  end if;
end $$;
