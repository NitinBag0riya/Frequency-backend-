-- ─────────────────────────────────────────────────────────────────────────────
-- Org Tasks — cross-vertical internal follow-up tracker.
--
-- A teammate assigns a task to another; it lands in the assignee's list with an
-- Accept / Reject(reason) / Start / Done lifecycle, and every status change
-- notifies the other party. Works identically across ALL verticals (HoReCa,
-- Salon, Real-Estate, D2C, Others) — the `tasks` feature is verticals='{*}'.
--
-- Mirrors the appointments/listings tenant-RLS pattern (current_user_tenant_ids).
-- Idempotent DDL (IF NOT EXISTS / ON CONFLICT). BETA-only apply.
-- ─────────────────────────────────────────────────────────────────────────────

-- ─── tasks ──────────────────────────────────────────────────────────────────
create table if not exists public.tasks (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references public.tenants(id) on delete cascade,
  title         text not null,
  description   text,
  created_by    uuid,
  assigned_to   uuid,
  assignee_name text,
  priority      text not null default 'normal',   -- low|normal|high|urgent
  status        text not null default 'pending',  -- pending|accepted|rejected|in_progress|done|cancelled
  reject_reason text,
  due_at        timestamptz,
  linked_type   text,                             -- lead|appointment|order|null
  linked_id     text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  completed_at  timestamptz
);

alter table public.tasks drop constraint if exists tasks_priority_check;
alter table public.tasks add constraint tasks_priority_check check (priority in ('low','normal','high','urgent'));
alter table public.tasks drop constraint if exists tasks_status_check;
alter table public.tasks add constraint tasks_status_check check (status in ('pending','accepted','rejected','in_progress','done','cancelled'));

create index if not exists tasks_tenant_idx        on public.tasks (tenant_id);
create index if not exists tasks_assigned_idx       on public.tasks (assigned_to);
create index if not exists tasks_tenant_status_idx  on public.tasks (tenant_id, status);

alter table public.tasks enable row level security;
drop policy if exists tasks_tenant_members on public.tasks;
create policy tasks_tenant_members on public.tasks for all to public
  using (tenant_id in (select current_user_tenant_ids()))
  with check (tenant_id in (select current_user_tenant_ids()));

-- ─── task_activity — lean update trail (accept/reject/start/done/update) ─────
create table if not exists public.task_activity (
  id      uuid primary key default gen_random_uuid(),
  task_id uuid not null references public.tasks(id) on delete cascade,
  actor   uuid,
  action  text not null,   -- created|assigned|accepted|rejected|started|completed|cancelled|reassigned|updated|comment
  note    text,
  at      timestamptz not null default now()
);
create index if not exists task_activity_task_idx on public.task_activity (task_id, at);

alter table public.task_activity enable row level security;
drop policy if exists task_activity_tenant_members on public.task_activity;
-- Scope via the parent task's tenant (keeps the activity table lean, no tenant_id col).
create policy task_activity_tenant_members on public.task_activity for all to public
  using (task_id in (select id from public.tasks where tenant_id in (select current_user_tenant_ids())))
  with check (task_id in (select id from public.tasks where tenant_id in (select current_user_tenant_ids())));

-- ─── Entitlements: register the `tasks` feature (cross-vertical, ops) ────────
insert into public.features (key, name, description, category, verticals, default_enabled, gate_style, sort_order) values
  ('tasks', 'Tasks', 'Assignable internal follow-up tasks with accept/reject/done', 'ops', '{*}', false, 'locked_teaser', 45)
on conflict (key) do update set
  name = excluded.name, description = excluded.description, category = excluded.category,
  verticals = excluded.verticals, gate_style = excluded.gate_style, sort_order = excluded.sort_order,
  updated_at = now();

-- Grant to growth / scale / enterprise (the entitlements-resolver path used by
-- the FE nav mirror). Idempotent.
insert into public.plan_features (plan_id, feature_key)
select p.id, 'tasks' from public.plans p where p.id in ('growth','scale','enterprise')
on conflict (plan_id, feature_key) do nothing;

-- checkPermission() still reads the legacy plans.features text[] whitelist, so
-- keep it in lockstep for plans that lack the '*' wildcard (growth). scale +
-- enterprise already carry '*', which grants everything.
update public.plans
   set features = array_append(features, 'tasks')
 where id = 'growth'
   and not (features @> array['tasks']::text[]);

-- ─── Notification event types (assignee + creator alerts) ───────────────────
insert into public.notification_event_types
  (key, category, title_template, body_template, default_channels, severity, description)
values
  ('task.assigned', 'inbox', '{{assigner}} assigned you a task',
    '{{title}}',
    array['in_app']::text[], 'info',
    'A teammate assigned an internal follow-up task to this user'),
  ('task.updated',  'inbox', 'Task {{status}}: {{title}}',
    '{{summary}}',
    array['in_app']::text[], 'info',
    'A task the user created or was assigned changed status (accepted/rejected/started/done/cancelled) or got an update')
on conflict (key) do update set
  category         = excluded.category,
  title_template   = excluded.title_template,
  body_template    = excluded.body_template,
  default_channels = excluded.default_channels,
  severity         = excluded.severity,
  description      = excluded.description;
