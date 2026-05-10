-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 028 — workflow chaining
--
-- Adds `triggered_by_workflow_id` to `workflows` so a downstream workflow
-- can declare "fire me when workflow X completes". The /create page's
-- WorkflowContextPicker already surfaces this in the UI ("Trigger from")
-- but the trigger itself wasn't wired — the value was sent to the AI
-- parser as context but never persisted as a real trigger.
--
-- Now:
--   1. Workflow B declares triggered_by_workflow_id = A.id
--   2. When ANY session for workflow A completes (status flips to 'completed'),
--      the executor checks for downstream workflows and creates a new session
--      for each, enqueuing their first node — see workflow-executor.ts.
--   3. Variables from A's terminal session are copied into B's initial
--      session.variables, so B can read upstream output without explicit
--      mapping ("upstream.X" naming convention in B's nodes).
--
-- Cycle prevention: enforced at workflow CREATE time in routes/index.ts
-- (we do a graph walk before persisting). The DB constraint here is just
-- a self-reference guard.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE public.workflows
  ADD COLUMN IF NOT EXISTS triggered_by_workflow_id uuid REFERENCES public.workflows(id) ON DELETE SET NULL;

-- Guards against the most common foot-gun: a workflow listing itself as its
-- own trigger. Multi-step cycles still need the FE-side graph walk.
-- Wrapped in DO so re-runs don't error on the duplicate constraint name.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'workflows_no_self_trigger'
  ) THEN
    ALTER TABLE public.workflows
      ADD CONSTRAINT workflows_no_self_trigger
      CHECK (triggered_by_workflow_id IS NULL OR triggered_by_workflow_id <> id);
  END IF;
END $$;

-- Hot-path lookup for the chaining dispatcher: "find all downstream workflows
-- of this just-completed upstream". Partial so unchaied workflows (the
-- vast majority) don't bloat the index.
CREATE INDEX IF NOT EXISTS workflows_triggered_by_idx
  ON public.workflows(triggered_by_workflow_id)
  WHERE triggered_by_workflow_id IS NOT NULL;

COMMENT ON COLUMN public.workflows.triggered_by_workflow_id IS
  'When set, this workflow auto-runs each time the upstream workflow completes a session. See engine/chaining.ts.';
