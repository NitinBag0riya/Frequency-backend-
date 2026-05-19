-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 081 — Workflow versions (P1 #14 AI workflow author v1)
--
-- Adds a versioning table so the chat-driven workflow author can:
--   • show a "Review changes" diff before publishing an AI-proposed update,
--   • surface a "History" tab where the user can revert to any prior version,
--   • give a one-tap "Undo" by reverting to the previous published version,
--   • cache the plain-English flow explainer per (workflow, version).
--
-- Design notes:
--   • Stored as the FULL jsonb graph rather than a delta — reads stay simple,
--     storage is cheap for the sizes we ship today (median workflow ~3 KB).
--   • Append-only: writes happen via service-role from the parse-workflow /
--     publish-preview / revert handlers. RLS allows authenticated tenant
--     reads only; INSERT/UPDATE/DELETE are revoked for authenticated + anon
--     so a malicious client can never tamper with history.
--   • One row per version_number per workflow (unique constraint). Numbers
--     are monotonically increasing; the handler computes max+1.
--   • current_version_id pointer on workflows for fast "what's live now"
--     lookup without a subquery.
-- ─────────────────────────────────────────────────────────────────────────────

create table if not exists public.workflow_versions (
  id              uuid primary key default gen_random_uuid(),
  workflow_id     uuid not null references public.workflows(id) on delete cascade,
  tenant_id       uuid not null references public.tenants(id) on delete cascade,
  version_number  int not null,
  -- Full node graph snapshot. Same shape as workflows.nodes / blueprint.nodes.
  nodes_json      jsonb not null,
  -- Optional human note: chat builder writes "Added cart-recovery branch",
  -- "Reverted to v3", etc. Helps the user pick a version to revert to.
  change_note     text,
  -- Whether this version is the currently-published one for the workflow
  -- (live and executing). The publish handler ensures only one row per
  -- workflow has is_published=true.
  is_published    boolean not null default false,
  -- The chat-AI message that produced this version, if any. Null for direct
  -- UI edits and for reverts.
  source_chat_message_id uuid,
  -- Cached plain-English explainer for this version. Filled on first
  -- /explain call so we never re-bill the LLM for the same nodes_json.
  explainer_text  text,
  explainer_at    timestamptz,
  created_by      uuid references auth.users(id) on delete set null,
  created_at      timestamptz not null default now(),
  unique (workflow_id, version_number)
);

create index if not exists idx_wv_workflow on public.workflow_versions(workflow_id, version_number desc);
create index if not exists idx_wv_published on public.workflow_versions(workflow_id) where is_published;
create index if not exists idx_wv_tenant on public.workflow_versions(tenant_id, created_at desc);

alter table public.workflow_versions enable row level security;

-- Tenant-scoped read. The publish/revert routes use service-role so they
-- bypass RLS for INSERT/UPDATE; this policy only governs SELECT for users.
drop policy if exists "workflow_versions_tenant_read" on public.workflow_versions;
create policy "workflow_versions_tenant_read" on public.workflow_versions
  for select to authenticated using (
    tenant_id = (current_setting('request.jwt.claims', true)::jsonb->>'tenant_id')::uuid
  );

-- Append-only: INSERT/UPDATE/DELETE blocked for normal callers. Only the
-- service-role key (used by /publish-preview, /revert, parse-workflow's
-- post-stream commit) can write. UPDATE is needed for the explainer cache
-- and for flipping is_published on the previously-live row — both are
-- service-role-only operations.
revoke insert, update, delete on public.workflow_versions from authenticated;
revoke insert, update, delete on public.workflow_versions from anon;

-- Pointer on workflows for O(1) "current version" lookup. Nullable because
-- existing rows have no versions yet — they backfill on first edit.
alter table public.workflows
  add column if not exists current_version_id uuid references public.workflow_versions(id);
