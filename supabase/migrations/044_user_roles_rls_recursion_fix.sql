-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 044 — fix RLS infinite recursion on user_roles
--
-- Bug surfaced by Lighthouse network audit during perf v1: every
-- `GET /rest/v1/user_roles?...` returned HTTP 500 "infinite recursion
-- detected in policy". Root cause: the existing self_read / admin_insert
-- / admin_delete policies query `FROM user_roles` inside their own
-- USING / WITH CHECK clause. Postgres re-applies the same policy to that
-- inner query, recursing forever.
--
-- Fix: move the "is super-admin?" and "is tenant admin?" checks into
-- SECURITY DEFINER helper functions. Functions bypass the calling user's
-- RLS, so the inner query reads user_roles without re-triggering the
-- policy. Same authorization semantics, no recursion.
--
-- Idempotent — re-runnable.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── Helper functions (SECURITY DEFINER bypasses RLS) ─────────────────
CREATE OR REPLACE FUNCTION public.is_super_admin()
RETURNS BOOLEAN
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.user_roles
     WHERE user_id = auth.uid()
       AND role = 'super_admin'
       AND tenant_id IS NULL
  );
$$;

CREATE OR REPLACE FUNCTION public.is_tenant_admin(p_tenant_id UUID)
RETURNS BOOLEAN
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.user_roles
     WHERE user_id = auth.uid()
       AND role = ANY (ARRAY['super_admin', 'admin'])
       AND (tenant_id IS NULL OR tenant_id = p_tenant_id)
  );
$$;

GRANT EXECUTE ON FUNCTION public.is_super_admin() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.is_tenant_admin(UUID) TO authenticated, service_role;

-- ── Replace recursive policies with helper-based ones ────────────────
DROP POLICY IF EXISTS self_read     ON public.user_roles;
DROP POLICY IF EXISTS admin_insert  ON public.user_roles;
DROP POLICY IF EXISTS admin_delete  ON public.user_roles;

-- SELECT: a user can read their own row, OR a super-admin can read any.
CREATE POLICY self_read ON public.user_roles
  FOR SELECT
  USING (
    user_id = auth.uid()
    OR public.is_super_admin()
  );

-- INSERT: super-admin can grant any role; tenant admin can grant within
-- their own tenant.
CREATE POLICY admin_insert ON public.user_roles
  FOR INSERT
  WITH CHECK (
    public.is_super_admin()
    OR (tenant_id IS NOT NULL AND public.is_tenant_admin(tenant_id))
  );

-- DELETE: a user can revoke their own role; admins can revoke any.
CREATE POLICY admin_delete ON public.user_roles
  FOR DELETE
  USING (
    user_id = auth.uid()
    OR (tenant_id IS NULL AND public.is_super_admin())
    OR (tenant_id IS NOT NULL AND public.is_tenant_admin(tenant_id))
  );

COMMENT ON FUNCTION public.is_super_admin() IS
  'SECURITY DEFINER. Used in user_roles RLS policies to break the recursive '
  'subquery loop that previously caused 500s on every /rest/v1/user_roles read.';

COMMENT ON FUNCTION public.is_tenant_admin(UUID) IS
  'SECURITY DEFINER. Tenant-admin check used by user_roles INSERT/DELETE policies.';
