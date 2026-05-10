-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 025 — revoke ingest_token from PUBLIC (defence-in-depth)
--
-- Migration 023 revoked column-level SELECT from `authenticated` and `anon`,
-- which covers the two roles Supabase issues to JWTs today. But Postgres
-- inherits `PUBLIC` privileges to every role, including any future custom
-- role we (or a Growth+ tenant via custom RBAC) might create.
--
-- Revoking from PUBLIC ensures any new role created in the future starts
-- with NO access to the ingest_token column unless we explicitly grant it.
--
-- The server still reads via service_role (which bypasses both RLS and
-- column GRANTs anyway), so the route gate (leads:edit) remains the actual
-- enforcement boundary. This migration just closes the "what if a custom
-- role gets SELECT *" hypothetical.
-- ─────────────────────────────────────────────────────────────────────────────

revoke select (ingest_token) on public.lead_tables from public;

-- Also re-revoke from authenticated/anon explicitly in case 023 got rolled
-- back at some point during a deploy. Idempotent.
revoke select (ingest_token) on public.lead_tables from authenticated;
revoke select (ingest_token) on public.lead_tables from anon;
