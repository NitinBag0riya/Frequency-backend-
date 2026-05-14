-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 047 — recursion-safe RLS for user_role_assignments + dependents
--
-- Mirrors migration 044 (which fixed user_roles), but applied to the newer
-- user_role_assignments table introduced in 017. Any RLS policy that does
--   EXISTS (SELECT 1 FROM user_role_assignments WHERE user_id = auth.uid() …)
-- inline will trigger Postgres RLS recursion the moment user_role_assignments
-- itself has an RLS policy that selects from user_role_assignments. Today's
-- ura_read_self_or_tenant policy only joins to public.tenants so it's fine,
-- but the moment we tighten ura policies (which we do here), all dependent
-- policies that inline-query ura must move to SECURITY DEFINER helpers.
--
-- Pattern (same as 044):
--   • is_super_admin()    — already exists from 044
--   • is_tenant_admin()   — already exists from 044
--   • NEW: is_tenant_member(tenant_id) — bypasses RLS to check membership
--
-- Threat model traced:
--   user X is a member of tenant A → is_tenant_member(A) = true → reads OK
--   admin Y removes X from ura     → next call: ura row gone → false → denied
--   X is super_admin                → is_super_admin() short-circuits true
--
-- Idempotent.
-- ─────────────────────────────────────────────────────────────────────────────

BEGIN;

-- ── New helper: is_tenant_member (SECURITY DEFINER, bypasses RLS) ───────
CREATE OR REPLACE FUNCTION public.is_tenant_member(p_tenant_id uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.user_role_assignments
     WHERE user_id   = auth.uid()
       AND tenant_id = p_tenant_id
       AND disabled_at IS NULL
  )
  OR EXISTS (
    SELECT 1 FROM public.tenants
     WHERE id = p_tenant_id AND user_id = auth.uid()
  );
$$;
GRANT EXECUTE ON FUNCTION public.is_tenant_member(uuid) TO authenticated, service_role;
COMMENT ON FUNCTION public.is_tenant_member(uuid) IS
  'SECURITY DEFINER membership check — used in RLS policies to break recursion '
  'when policies on user_role_assignments need to reference user_role_assignments.';

-- ── Replace user_role_assignments policies with helper-based ones ───────
DROP POLICY IF EXISTS "ura_read_self_or_tenant"  ON public.user_role_assignments;
DROP POLICY IF EXISTS "ura_self_read"            ON public.user_role_assignments;
DROP POLICY IF EXISTS "ura_admin_insert"         ON public.user_role_assignments;
DROP POLICY IF EXISTS "ura_admin_update"         ON public.user_role_assignments;
DROP POLICY IF EXISTS "ura_admin_delete"         ON public.user_role_assignments;

-- SELECT: a user can read their own row, OR a super-admin can read any,
-- OR a tenant admin can read all rows for their tenant.
CREATE POLICY "ura_self_read" ON public.user_role_assignments
  FOR SELECT USING (
    user_id = auth.uid()
    OR public.is_super_admin()
    OR (tenant_id IS NOT NULL AND public.is_tenant_admin(tenant_id))
  );
COMMENT ON POLICY "ura_self_read" ON public.user_role_assignments IS
  'Self + super-admin + tenant-admin (own tenant). Helpers prevent recursion.';

-- INSERT: super-admin can grant any role; tenant admin can grant within tenant.
CREATE POLICY "ura_admin_insert" ON public.user_role_assignments
  FOR INSERT WITH CHECK (
    public.is_super_admin()
    OR (tenant_id IS NOT NULL AND public.is_tenant_admin(tenant_id))
  );
COMMENT ON POLICY "ura_admin_insert" ON public.user_role_assignments IS
  'Only admins may create role assignments. Platform-scope rows require super-admin.';

-- UPDATE: same authority as INSERT.
CREATE POLICY "ura_admin_update" ON public.user_role_assignments
  FOR UPDATE
  USING (
    public.is_super_admin()
    OR (tenant_id IS NOT NULL AND public.is_tenant_admin(tenant_id))
  )
  WITH CHECK (
    public.is_super_admin()
    OR (tenant_id IS NOT NULL AND public.is_tenant_admin(tenant_id))
  );
COMMENT ON POLICY "ura_admin_update" ON public.user_role_assignments IS
  'Edits (e.g. disabled_at toggles) gated by same admin authority as INSERT.';

-- DELETE: a user can revoke their own row; admins can revoke any.
CREATE POLICY "ura_admin_delete" ON public.user_role_assignments
  FOR DELETE USING (
    user_id = auth.uid()
    OR (tenant_id IS NULL AND public.is_super_admin())
    OR (tenant_id IS NOT NULL AND public.is_tenant_admin(tenant_id))
  );
COMMENT ON POLICY "ura_admin_delete" ON public.user_role_assignments IS
  'Self-revoke or admin-revoke. Mirrors user_roles 044 pattern.';

-- ── Rewrite dependent table policies that inline-query ura ──────────────
-- usage_counters: previously did inline EXISTS on user_role_assignments.
DROP POLICY IF EXISTS "tenant members read usage" ON public.usage_counters;
CREATE POLICY "usage_counters_tenant_members" ON public.usage_counters
  FOR SELECT USING (public.is_tenant_member(tenant_id));
COMMENT ON POLICY "usage_counters_tenant_members" ON public.usage_counters IS
  'Tenant members can read their usage. Helper prevents ura-recursion.';

-- invoices: previously did inline JOIN ura→role_definitions for billing role.
DROP POLICY IF EXISTS "tenant admins read invoices" ON public.invoices;
CREATE POLICY "invoices_tenant_admin_read" ON public.invoices
  FOR SELECT USING (
    public.is_super_admin()
    OR public.is_tenant_admin(tenant_id)
  );
COMMENT ON POLICY "invoices_tenant_admin_read" ON public.invoices IS
  'Tenant admins (workspace owners) read invoices. Billing role gated by helper, '
  'not inline EXISTS — avoids RLS recursion + matches 044 pattern.';

COMMIT;
