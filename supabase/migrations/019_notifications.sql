-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 019 — Notification system
--
-- Tables:
--   notifications              In-app notifications shown in the bell dropdown.
--                              One row per (recipient_user_id, event). Read +
--                              archived flags. Realtime subscribed by FE.
--   notification_preferences   Per-user, per-event-type config: channels
--                              (in-app, email, whatsapp, slack), quiet hours,
--                              digest frequency.
--   notification_event_types   Catalog of event keys (broadcast.completed,
--                              payment.received, lead.new, …) with default
--                              config. Editable by super-admin via
--                              /admin/notification-events.
--   notification_delivery_log  Audit of every delivery attempt (in-app insert,
--                              email send, etc.) for debugging.
--
-- All tables RLS-protected. Idempotent — safe to re-run.
-- ─────────────────────────────────────────────────────────────────────────────

create table if not exists public.notification_event_types (
  key             text primary key,                           -- 'broadcast.completed','payment.received',…
  category        text not null,                              -- 'inbox','broadcast','campaign','billing','system','team'
  title_template  text not null,                              -- "Broadcast '{{name}}' sent"
  body_template   text,                                       -- supports {{vars}}
  default_channels text[] not null default '{in_app}',        -- ['in_app','email','whatsapp']
  severity        text not null default 'info'
                  check (severity in ('info','success','warning','error')),
  description     text,
  is_active       boolean default true,
  created_at      timestamptz default now()
);

alter table public.notification_event_types enable row level security;
create policy "ne_types_read_all" on public.notification_event_types for select using (true);

create table if not exists public.notifications (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid references public.tenants(id) on delete cascade,
  recipient_user_id uuid not null references auth.users(id) on delete cascade,
  event_key         text not null references public.notification_event_types(key),
  title             text not null,
  body              text,
  link              text,                                     -- deep-link inside the app
  data              jsonb default '{}'::jsonb,                -- event-specific payload
  severity          text not null default 'info'
                    check (severity in ('info','success','warning','error')),
  read_at           timestamptz,
  archived_at       timestamptz,
  created_at        timestamptz default now()
);

alter table public.notifications enable row level security;
create policy "notif_own" on public.notifications for all using (recipient_user_id = auth.uid());

create index if not exists notif_recipient_unread
  on public.notifications(recipient_user_id, read_at, created_at desc);
create index if not exists notif_tenant_event
  on public.notifications(tenant_id, event_key, created_at desc);

create table if not exists public.notification_preferences (
  user_id        uuid not null references auth.users(id) on delete cascade,
  tenant_id      uuid references public.tenants(id) on delete cascade,  -- NULL = applies across all tenants
  event_key      text not null references public.notification_event_types(key),
  channels       text[] not null default '{in_app}',                    -- ['in_app','email','whatsapp','slack']
  quiet_hours    jsonb default '{}'::jsonb,                              -- { start: '22:00', end: '08:00', tz: 'Asia/Kolkata' }
  digest_frequency text default 'instant'                                 -- 'instant' | 'hourly' | 'daily' | 'never'
                    check (digest_frequency in ('instant','hourly','daily','never')),
  is_muted       boolean default false,
  updated_at     timestamptz default now(),
  primary key (user_id, tenant_id, event_key)
);

alter table public.notification_preferences enable row level security;
create policy "notif_pref_own" on public.notification_preferences for all using (user_id = auth.uid());

create table if not exists public.notification_delivery_log (
  id              uuid primary key default gen_random_uuid(),
  notification_id uuid references public.notifications(id) on delete cascade,
  channel         text not null,                              -- 'in_app','email','whatsapp','slack'
  status          text not null check (status in ('queued','sent','delivered','failed','skipped')),
  error_message   text,
  delivered_at    timestamptz,
  metadata        jsonb default '{}'::jsonb,
  created_at      timestamptz default now()
);

alter table public.notification_delivery_log enable row level security;
create policy "ndl_via_notif" on public.notification_delivery_log for select using (
  exists (select 1 from public.notifications n where n.id = notification_id and n.recipient_user_id = auth.uid())
);

create index if not exists ndl_notif_channel on public.notification_delivery_log(notification_id, channel);

-- ── Seed default event types ────────────────────────────────────────────────
insert into public.notification_event_types (key, category, title_template, body_template, default_channels, severity, description) values
  ('inbox.new_message',        'inbox',     'New message from {{contact_name}}', '{{preview}}',                                    ARRAY['in_app']::text[],            'info',    'A contact replied in the inbox'),
  ('inbox.assigned',           'inbox',     'Conversation assigned to you',     'From {{contact_name}}',                          ARRAY['in_app','email']::text[],    'info',    'A teammate assigned a conversation to you'),
  ('inbox.mentioned',          'inbox',     '{{actor}} mentioned you',         'In conversation with {{contact_name}}',          ARRAY['in_app']::text[],            'info',    'You were @-mentioned in a conversation note'),
  ('broadcast.completed',      'broadcast', 'Broadcast "{{name}}" finished',   '{{sent}} sent · {{delivered}} delivered · {{failed}} failed', ARRAY['in_app','email']::text[], 'success', 'A broadcast finished sending'),
  ('broadcast.failed',         'broadcast', 'Broadcast "{{name}}" failed',     '{{error}}',                                       ARRAY['in_app','email']::text[],    'error',   'A broadcast hit an error'),
  ('campaign.enrollment',      'campaign',  '{{count}} contacts enrolled',     'In campaign "{{name}}"',                          ARRAY['in_app']::text[],            'info',    'Contacts enrolled in a triggered campaign'),
  ('payment.received',         'billing',   'Payment received',                '₹{{amount}} from {{customer_name}}',              ARRAY['in_app','email']::text[],    'success', 'A Razorpay payment was captured'),
  ('payment.failed',           'billing',   'Payment failed',                  '₹{{amount}} from {{customer_name}}: {{reason}}',  ARRAY['in_app','email']::text[],    'error',   'A Razorpay payment failed'),
  ('lead.new',                 'inbox',     'New lead: {{name}}',              'From {{source}}',                                 ARRAY['in_app','email']::text[],    'success', 'A new contact was created from a webhook / form / lead ad'),
  ('team.invite_accepted',     'team',      '{{name}} joined your team',       'As {{role}}',                                     ARRAY['in_app','email']::text[],    'success', 'A pending invite was accepted'),
  ('team.member_disabled',     'team',      '{{name}} was disabled',           'By {{actor}}',                                    ARRAY['in_app']::text[],            'warning', 'A team member was disabled'),
  ('billing.trial_ending',     'billing',   'Your trial ends in {{days}} days', 'Upgrade to keep your features active',           ARRAY['in_app','email']::text[],    'warning', 'Trial expiry warning'),
  ('billing.payment_overdue',  'billing',   'Subscription payment overdue',     'Update your payment method',                     ARRAY['in_app','email']::text[],    'error',   'Subscription payment failed'),
  ('system.tenant_suspended',  'system',    'Your account is suspended',        '{{reason}}',                                     ARRAY['in_app','email']::text[],    'error',   'Tenant was suspended by Trust & Safety'),
  ('system.platform_announcement', 'system','{{title}}',                       '{{body}}',                                        ARRAY['in_app']::text[],            'info',    'Platform-wide announcement (outage, maintenance, feature)'),
  ('approval.requested',       'team',      'Approval needed: {{action}}',     '{{requested_by_name}} needs your approval',       ARRAY['in_app','email']::text[],    'warning', 'A teammate needs your approval (broadcast >5k, etc.)'),
  ('approval.granted',         'team',      'Approval granted',                'Your {{action}} request was approved',            ARRAY['in_app']::text[],            'success', 'A pending request was approved'),
  ('approval.rejected',        'team',      'Approval rejected',               'Your {{action}} request was rejected: {{reason}}', ARRAY['in_app','email']::text[],   'warning', 'A pending request was rejected')
on conflict (key) do update set
  category         = EXCLUDED.category,
  title_template   = EXCLUDED.title_template,
  body_template    = EXCLUDED.body_template,
  default_channels = EXCLUDED.default_channels,
  severity         = EXCLUDED.severity,
  description      = EXCLUDED.description;
