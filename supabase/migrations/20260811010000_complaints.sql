-- ─────────────────────────────────────────────────────────────────────────────
-- Unified Complaints — one table, three sources (storefront | swiggy | zomato).
--
-- Normalises storefront mini-app complaints, Swiggy `getComplaints`, and Zomato
-- `customer-issues` into a single actionable queue that rides the EXISTING
-- notification path (emitNotification → bell + email/Slack/WhatsApp) and an
-- SLA-escalation tick modelled on order-sla.
--
-- HoReCa-only (restaurant/cafe). Aggregator write-backs are queued/gated, never
-- faked (see reply_state). See docs/complaints-feature-design.md + src/routes/
-- complaints.ts.
--
-- Mirrors the tasks/appointments tenant-RLS pattern (current_user_tenant_ids()).
-- Idempotent DDL (IF NOT EXISTS / ON CONFLICT). Apply to BETA first.
-- ─────────────────────────────────────────────────────────────────────────────

create table if not exists public.complaints (
  id                  uuid primary key default gen_random_uuid(),
  tenant_id           uuid not null references public.tenants(id) on delete cascade,
  outlet_ref          text,                                -- restaurantId / outletId (nullable)

  source              text not null,                       -- storefront | swiggy | zomato
  external_id         text,                                -- complaintId / order_id+issue / order.id+idx
  order_ref           text,                                -- source order id; join key
  aggregator_order_id uuid references public.aggregator_orders(id) on delete set null,

  category            text not null default 'unknown',     -- normalised enum (see check)
  raw_issue_type      text,                                -- verbatim source category (audit)
  severity            text not null default 'normal',      -- low | normal | high
  status              text not null default 'new',         -- new|acknowledged|in_progress|resolved|escalated|closed
  resolution_status   text,                                -- refunded|comped|replied|no_action|na (nullable)

  customer_name       text,
  customer_context    text,                                -- customerContextDescription / guest name
  item_desc           text,                                -- complaintItemDescription(V2)
  body                text,                                -- issueDescription / storefront text (null for zomato)
  rating              int,                                 -- linked star rating (1..5)

  assignee_user_id    uuid,                                -- auth.users(id) — no FK (matches tasks.assigned_to)
  opened_at           timestamptz not null default now(),  -- createTimestamp / complaint.at
  due_at              timestamptz,                          -- complaintExpiryTimestamp / expired_at (SLA)
  acknowledged_at     timestamptz,
  resolved_at         timestamptz,
  escalated_notified_at timestamptz,                        -- one-shot SLA-breach stamp (mirrors order-sla)

  refund_amount       numeric(12,2),                       -- amountRefunded (READ from source for aggregators)
  resolution_meta     jsonb,                               -- restaurantResolution / response_meta verbatim
  reply_text          text,                                -- operator reply (storefront: sent; aggregator: queued)
  reply_state         text,                                -- sent | queued | blocked  (aggregator write-back honesty)

  raw                 jsonb not null default '{}'::jsonb,  -- full captured payload + internal notes trail
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

-- Idempotent upsert key on re-poll / re-backfill.
create unique index if not exists complaints_source_external_uniq
  on public.complaints (source, external_id) where external_id is not null;
create index if not exists complaints_tenant_status_due_idx
  on public.complaints (tenant_id, status, due_at);
create index if not exists complaints_tenant_source_opened_idx
  on public.complaints (tenant_id, source, opened_at desc);
-- SLA scan hot path: still-open rows with a deadline not yet escalated.
create index if not exists complaints_sla_scan_idx
  on public.complaints (due_at)
  where escalated_notified_at is null and status in ('new','acknowledged','in_progress');

alter table public.complaints drop constraint if exists complaints_source_check;
alter table public.complaints add constraint complaints_source_check
  check (source in ('storefront','swiggy','zomato'));
alter table public.complaints drop constraint if exists complaints_category_check;
alter table public.complaints add constraint complaints_category_check
  check (category in ('missing_items','wrong_items','quality','quantity','spillage',
                      'packaging','delivery','service','billing','other','unknown'));
alter table public.complaints drop constraint if exists complaints_severity_check;
alter table public.complaints add constraint complaints_severity_check
  check (severity in ('low','normal','high'));
alter table public.complaints drop constraint if exists complaints_status_check;
alter table public.complaints add constraint complaints_status_check
  check (status in ('new','acknowledged','in_progress','resolved','escalated','closed'));
alter table public.complaints drop constraint if exists complaints_reply_state_check;
alter table public.complaints add constraint complaints_reply_state_check
  check (reply_state is null or reply_state in ('sent','queued','blocked'));

-- Tenant-scoped RLS (same pattern as tasks/appointments). The backend service
-- role bypasses RLS; this policy lets an authed dashboard user read/write only
-- their own tenants' complaints if ever queried directly.
alter table public.complaints enable row level security;
drop policy if exists complaints_tenant_members on public.complaints;
create policy complaints_tenant_members on public.complaints for all to public
  using (tenant_id in (select current_user_tenant_ids()))
  with check (tenant_id in (select current_user_tenant_ids()));

comment on table public.complaints is
  'Unified HoReCa complaint queue (storefront|swiggy|zomato). Aggregator write-backs gated via reply_state. See src/routes/complaints.ts + docs/complaints-feature-design.md.';
comment on column public.complaints.reply_state is
  'sent = delivered to customer (storefront, owned channel); queued = recorded, NOT yet pushed to source (aggregator write-back unverified); blocked = source has no write path. Never mark aggregator replies "sent" until a live capture verifies the connector.';

-- ─── Entitlements: register the `complaints` feature (HoReCa-only, ops) ──────
insert into public.features (key, name, description, category, verticals, default_enabled, gate_style, sort_order) values
  ('complaints', 'Complaints', 'Unified guest-complaint inbox across storefront, Swiggy & Zomato with SLA escalation',
   'ops', '{horeca}', false, 'locked_teaser', 46)
on conflict (key) do update set
  name = excluded.name, description = excluded.description, category = excluded.category,
  verticals = excluded.verticals, gate_style = excluded.gate_style, sort_order = excluded.sort_order,
  updated_at = now();

-- Grant to growth / scale / enterprise (entitlements-resolver path the FE nav mirror reads).
insert into public.plan_features (plan_id, feature_key)
select p.id, 'complaints' from public.plans p where p.id in ('growth','scale','enterprise')
on conflict (plan_id, feature_key) do nothing;

-- checkPermission() also reads the legacy plans.features text[] whitelist — keep
-- it in lockstep for plans without the '*' wildcard (growth). scale/enterprise
-- carry '*'.
update public.plans
   set features = array_append(features, 'complaints')
 where id = 'growth'
   and not (features @> array['complaints']::text[]);

-- ─── Notification event types (reuse emitNotification transport) ─────────────
-- Severity vocabulary matches existing rows (info|warning|error). complaint.new
-- rides the same bell/POS-alert path as order.new; complaint.sla_breach is loud.
insert into public.notification_event_types
  (key, category, title_template, body_template, default_channels, severity, description)
values
  ('complaint.new', 'orders', 'New complaint · {{source_label}}',
    '{{customer}} · {{category}} · order #{{order_short}}',
    array['in_app']::text[], 'warning',
    'A new guest complaint arrived (storefront/Swiggy/Zomato) and needs to be acknowledged'),
  ('complaint.sla_breach', 'orders', '⏰ Complaint about to expire · {{source_label}}',
    '{{customer}} · due {{due_human}}',
    array['in_app']::text[], 'error',
    'A complaint is past / near its resolution SLA and still open')
on conflict (key) do update set
  category         = excluded.category,
  title_template   = excluded.title_template,
  body_template    = excluded.body_template,
  default_channels = excluded.default_channels,
  severity         = excluded.severity,
  description      = excluded.description;
