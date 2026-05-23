-- ────────────────────────────────────────────────────────────────────────
-- Migration 107 — Save-and-resume (partial_submissions)
-- ────────────────────────────────────────────────────────────────────────
-- Save-and-resume lets a visitor close the tab mid-form and pick up
-- where they left off (on the same device — keyed by an anonymous
-- token stored in localStorage). Auto-expires after 30 days so old
-- partials don't accumulate forever.
-- ────────────────────────────────────────────────────────────────────────

create table if not exists public.form_partial_submissions (
  id                  uuid primary key default gen_random_uuid(),
  tenant_id           uuid not null references public.tenants(id) on delete cascade,
  form_id             uuid not null references public.form_pages(id) on delete cascade,
  -- High-entropy token the FE generates client-side + stores in
  -- localStorage. NOT user-bound (anonymous visitors), NOT sessionful
  -- (laptop crash → next browser open still resumes).
  anonymous_token     text not null,
  response_data       jsonb not null default '{}'::jsonb,
  current_step_index  integer default 0,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  expires_at          timestamptz not null default (now() + interval '30 days'),

  unique (form_id, anonymous_token)
);

create index if not exists idx_form_partial_form_token
  on public.form_partial_submissions (form_id, anonymous_token);
-- Cleanup query targets the expires_at TTL.
create index if not exists idx_form_partial_expires_at
  on public.form_partial_submissions (expires_at);

alter table public.form_partial_submissions enable row level security;
-- Tenant members can read for debugging. Writes only via service role
-- (the public save endpoint runs as service role).
create policy form_partial_select_tenant on public.form_partial_submissions
  for select using (
    exists (
      select 1 from public.user_role_assignments
      where user_id = auth.uid() and tenant_id = form_partial_submissions.tenant_id
        and disabled_at is null
    )
  );

-- ── updated_at trigger ──────────────────────────────────────────────────
drop trigger if exists trg_form_partial_updated_at on public.form_partial_submissions;
create trigger trg_form_partial_updated_at before update on public.form_partial_submissions
  for each row execute function public.set_updated_at();

comment on table public.form_partial_submissions
  is 'Save-and-resume state for public forms. Keyed by an anonymous token in localStorage. Expires 30d after last update.';
