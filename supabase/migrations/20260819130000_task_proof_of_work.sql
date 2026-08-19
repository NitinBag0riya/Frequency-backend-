-- ─────────────────────────────────────────────────────────────────────────────
-- Task proof-of-work + approval — additive extension of public.tasks.
--
-- Opt-in per task: when `requires_proof` is true the assignee cannot mark the
-- task done directly. They SUBMIT proof (uploaded files + optional note); the
-- task lands in a new 'submitted' ("In review") state; the creator then either
-- APPROVES (→ done) or BOUNCES it back with a reason (→ in_progress).
--
-- The direct done path stays intact for non-proof tasks (enhance, never delete).
-- Idempotent DDL (IF NOT EXISTS). Mirrors 20260809120000_org_tasks.sql style.
-- ─────────────────────────────────────────────────────────────────────────────

alter table public.tasks add column if not exists requires_proof  boolean not null default false;
alter table public.tasks add column if not exists accepted_at     timestamptz;
alter table public.tasks add column if not exists submitted_at    timestamptz;
alter table public.tasks add column if not exists reviewed_at     timestamptz;
alter table public.tasks add column if not exists reviewed_by     uuid;
alter table public.tasks add column if not exists proof           jsonb;            -- [{url,type,name,size}]
alter table public.tasks add column if not exists submission_note text;
alter table public.tasks add column if not exists review_note     text;

-- Widen the status check to admit 'submitted' alongside the existing values.
alter table public.tasks drop constraint if exists tasks_status_check;
alter table public.tasks add constraint tasks_status_check
  check (status in ('pending','accepted','rejected','in_progress','submitted','done','cancelled'));
