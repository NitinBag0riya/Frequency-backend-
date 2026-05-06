-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 014 — Workflow blueprint + intent persistence
--
-- The new "create-then-configure" flow needs the full ParsedWorkflow JSON
-- (clarifying_questions, required_integrations, missing_info, compliance_flags,
-- blocking_issues, etc.) saved alongside the workflow row. This enables
-- WorkflowDetailPage to render the configuration UI from the persisted draft.
--
-- Adds:
--   • workflows.blueprint  jsonb — the full ParsedWorkflow object as returned
--                                  by /api/parse-workflow. Stored separately
--                                  from `nodes` so the existing engine
--                                  consumers (which expect nodes:[...]) keep
--                                  working unchanged.
--
-- intent_text already exists (verified via information_schema).
-- ─────────────────────────────────────────────────────────────────────────────

alter table public.workflows
  add column if not exists blueprint jsonb default '{}'::jsonb;

-- Index on blueprint->'overall_status' is useful for "show me drafts" queries.
create index if not exists workflows_status on public.workflows(tenant_id, status, updated_at desc);
