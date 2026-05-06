-- ─────────────────────────────────────────────────────────────────────────────
-- Phase 2 / Tasks 2.2-2.5 — Broadcast engine + template-status sync support
--
-- Adds:
--   • broadcasts.language     — was hard-coded to 'en_US'; now per-broadcast
--   • broadcasts.last_error   — surface delivery errors in the UI
--   • messages.broadcast_id   — link outbound messages back to broadcast for
--                               on-demand stats aggregation (vs. race-y counters)
--   • wa_templates.tenant_id  — per-tenant scoping (was user_id only)
--   • wa_templates.meta_template_id, last_synced_at — for status sync polling
--   • Expand wa_templates.status enum to include Meta's 'deleted' and 'in_appeal'
-- ─────────────────────────────────────────────────────────────────────────────

-- ── broadcasts ───────────────────────────────────────────────────────────────
alter table public.broadcasts
  add column if not exists language   text default 'en_US',
  add column if not exists last_error text;

-- ── messages ─────────────────────────────────────────────────────────────────
alter table public.messages
  add column if not exists broadcast_id uuid references public.broadcasts(id) on delete set null;

create index if not exists messages_broadcast on public.messages(broadcast_id, created_at desc)
  where broadcast_id is not null;

-- ── wa_templates: tenant scope + sync metadata ───────────────────────────────
alter table public.wa_templates
  add column if not exists tenant_id        uuid references public.tenants(id) on delete cascade,
  add column if not exists meta_template_id text,
  add column if not exists last_synced_at   timestamptz,
  add column if not exists rejection_reason text;

create index if not exists wat_tenant on public.wa_templates(tenant_id);

-- Backfill tenant_id from user_id → first active tenant
update public.wa_templates t
set tenant_id = (
  select tn.id from public.tenants tn
  where tn.user_id = t.user_id and tn.status = 'active'
  order by tn.created_at limit 1
)
where t.tenant_id is null and t.user_id is not null;

-- Expand status check to accept all Meta states
alter table public.wa_templates drop constraint if exists wa_templates_status_check;
alter table public.wa_templates
  add constraint wa_templates_status_check
  check (status in ('approved','pending','rejected','draft','deleted','in_appeal','paused'));
