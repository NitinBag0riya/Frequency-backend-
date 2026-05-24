-- ────────────────────────────────────────────────────────────────────────
-- 117_revert_pipelines.sql
--
-- Cleanly reverts migration 116 (Vertical Packs / pipelines). The user
-- decided the feature isn't needed for now. We drop the three overlay
-- tables in the right order (FKs first) so the stage DB matches what the
-- code expects after the revert of commit 8484355.
--
-- Idempotent — `if exists` on every drop so a fresh DB that never had
-- 116 applied is a no-op.
-- ────────────────────────────────────────────────────────────────────────

drop table if exists public.pipeline_workflow_bindings cascade;
drop table if exists public.pipelines cascade;
drop table if exists public.pipeline_packs cascade;

-- Drop the updated_at trigger functions only if they were standalone
-- (the public.set_updated_at() helper is shared with other tables and
-- must stay). 116 didn't add any helper functions of its own.
