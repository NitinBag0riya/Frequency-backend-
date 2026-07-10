-- 20260709020000_assets_and_order_sla
-- (1) Tenant asset library — brand logos, images, video, any file. Bytes live
--     in the public `assets` storage bucket; this table is the index the app
--     reads: each row is { name, url } (+ metadata) pointing at one uploaded
--     object. Upload flow: FE file input → BE /api/assets (multer) → Storage →
--     row inserted here with the public URL.
-- (2) `late_notified_at` closes the order-SLA gap: the order-sla worker stamps
--     it when it emits an `order.late` escalation, so an order is only escalated
--     once even across ticks / multiple worker instances.

create table if not exists public.assets (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references public.tenants(id) on delete cascade,
  name         text not null,                 -- human/asset name (defaults to filename)
  url          text not null,                 -- public URL to the stored object
  storage_path text not null,                 -- path within the `assets` bucket (for delete)
  type         text not null default 'other', -- image | video | logo | audio | document | other
  mime_type    text,
  size_bytes   bigint,
  created_by   uuid,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create index if not exists assets_tenant_idx      on public.assets (tenant_id, created_at desc);
create index if not exists assets_tenant_type_idx on public.assets (tenant_id, type);

-- Service role only (the API mediates all access, same posture as the other
-- backend-owned tables). The dashboard reaches assets through /api/assets.
alter table public.assets enable row level security;

comment on table public.assets is
  'Tenant asset library (logos/images/video/any file). Bytes in the public `assets` storage bucket; row holds name + public url. See src/routes/assets.ts.';

-- Order-SLA escalation guard.
alter table public.aggregator_orders
  add column if not exists late_notified_at timestamptz;

comment on column public.aggregator_orders.late_notified_at is
  'Set by the order-sla worker when an order.late escalation was emitted — dedups escalation across ticks.';
