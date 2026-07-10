-- 20260709010000_aggregator_notifications
-- Order notification event types + DynoAPIs connection heartbeat.
--
-- New/changed aggregator orders emit in-app notifications (rings the existing
-- NotificationBell + drives the audible POS alert). `order.new` is a warning
-- (needs action → accept/reject); `order.status` is informational.

INSERT INTO public.notification_event_types
  (key, category, title_template, body_template, default_channels, severity, description)
VALUES
  ('order.new',    'orders', 'New {{channel_label}} order #{{order_id}}',
    '{{summary}}', ARRAY['in_app']::text[], 'warning',
    'A new Zomato/Swiggy order arrived and needs to be accepted'),
  ('order.status', 'orders', '{{channel_label}} order #{{order_id}} — {{status_label}}',
    '{{summary}}', ARRAY['in_app']::text[], 'info',
    'An aggregator order changed status'),
  ('order.late',   'orders', '⏰ {{channel_label}} order #{{order_id}} still not accepted',
    '{{summary}}', ARRAY['in_app']::text[], 'error',
    'An order has been waiting past the acceptance SLA')
ON CONFLICT (key) DO UPDATE SET
  category         = EXCLUDED.category,
  title_template   = EXCLUDED.title_template,
  body_template    = EXCLUDED.body_template,
  default_channels = EXCLUDED.default_channels,
  severity         = EXCLUDED.severity,
  description      = EXCLUDED.description;

-- Liveness of the merchant's DynoAPIs client — bumped every time it polls us.
-- The dashboard shows an online/offline chip from this (stale > ~90s = offline).
create table if not exists public.aggregator_heartbeats (
  tenant_id    uuid primary key references public.tenants(id) on delete cascade,
  source       text not null default 'dynoapis',
  last_seen_at timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

alter table public.aggregator_heartbeats enable row level security;

comment on table public.aggregator_heartbeats is
  'Last-seen heartbeat for the active aggregator source (DynoAPIs polls bump this) — drives the connection-health indicator.';
