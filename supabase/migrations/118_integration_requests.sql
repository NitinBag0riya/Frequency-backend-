-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 118 — integration_requests
--
-- Tracks user-submitted requests for apps/integrations we don't natively
-- support yet. The first source is the n8n import flow: when a paste contains
-- a Slack / HubSpot / Zoom / etc. node, the FE renders a "Request onboarding"
-- CTA per app, which writes a row here AND fires an email to
-- developers@frequency.app via the existing Resend wrapper (src/lib/email.ts).
--
-- Status workflow:
--   pending    — just received, dev team will triage
--   in_review  — engineering is scoping a native connector
--   onboarded  — connector shipped, requestor notified
--   wont_do    — declined (out of roadmap / low priority)
--
-- RLS: tenant-scoped read/write — only members of the requesting tenant can
-- see their own rows. Super-admins read everything via the service-role key
-- (their UI bypasses RLS in routes/super-admin.ts).
-- ─────────────────────────────────────────────────────────────────────────────

create table if not exists public.integration_requests (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references public.tenants(id) on delete cascade,
  requested_by  uuid not null,                       -- auth.uid() at the time of insert
  app_name      text not null,                       -- display name shown in the modal (e.g. 'Slack')
  n8n_type      text,                                -- source identifier (e.g. 'n8n-nodes-base.slack') if it came from n8n import
  reason        text,                                -- free-text from the user about why they need it
  context       jsonb,                               -- structured context (e.g. { workflow_slug, occurrences })
  status        text not null default 'pending'
                check (status in ('pending','in_review','onboarded','wont_do')),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index if not exists idx_integration_requests_tenant_status
  on public.integration_requests(tenant_id, status);

create index if not exists idx_integration_requests_created_at
  on public.integration_requests(created_at desc);

alter table public.integration_requests enable row level security;

-- Tenant-scoped: any active member of the tenant can read/write their tenant's
-- requests. Mirrors the pattern used by other tenant-scoped tables (e.g.
-- workflows). Super-admin access bypasses RLS via the service-role key.
drop policy if exists integration_requests_tenant on public.integration_requests;
create policy integration_requests_tenant on public.integration_requests
  for all using (
    auth.uid() in (
      select user_id from public.user_role_assignments
      where tenant_id = integration_requests.tenant_id
        and disabled_at is null
    )
  );

-- updated_at auto-bump trigger — mirrors the convention used on other tables.
create or replace function public.touch_integration_requests_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists trg_integration_requests_updated_at on public.integration_requests;
create trigger trg_integration_requests_updated_at
  before update on public.integration_requests
  for each row execute procedure public.touch_integration_requests_updated_at();

comment on table public.integration_requests is
  'User-submitted requests for native app integrations. Sourced from the n8n import flow today; can be reused for any in-product "request this app" CTA.';
