-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 046 — drop the `auth.uid() = user_id` fallback from RLS policies
--
-- Threat model: The legacy policies on lead_*, workflows, contacts, broadcasts,
-- campaigns and wa_templates allowed access via either tenant membership OR
-- by being the original `user_id` row owner. After a user is removed from a
-- tenant (delete from user_role_assignments), the `user_id = auth.uid()`
-- fallback still grants them access to rows they originally created — even
-- though they are no longer a member of the tenant. This is a privilege
-- escalation / data-leak vector for ex-employees.
--
-- Fix: replace ALL existing policies on these tables with strict tenant-only
-- checks via public.current_user_tenant_ids() (added in 035). When the user
-- is removed from user_role_assignments the helper returns an empty set and
-- access is denied. The owning `tenants.user_id` (workspace owner) is still
-- a member of the tenant via tenants RLS / role assignment, so they retain
-- access through legitimate membership, not the user_id legacy column.
--
-- Idempotent. Re-runnable. The SET-OF helper exists per migration 035.
-- ─────────────────────────────────────────────────────────────────────────────

BEGIN;

-- ── Defensive: ensure the helper exists (035 created it; if a fresh DB
--    runs migrations out of order this still works). Same signature.
CREATE OR REPLACE FUNCTION public.current_user_tenant_ids()
RETURNS SETOF uuid
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT tenant_id
    FROM public.user_role_assignments
   WHERE user_id = auth.uid()
     AND tenant_id IS NOT NULL
     AND disabled_at IS NULL;
$$;
GRANT EXECUTE ON FUNCTION public.current_user_tenant_ids() TO authenticated, service_role;

-- ── lead_tables ──────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "lead_tables_own"     ON public.lead_tables;
DROP POLICY IF EXISTS "lead_tables_tenant"  ON public.lead_tables;
DROP POLICY IF EXISTS "lead_tables_user_owner" ON public.lead_tables;
DROP POLICY IF EXISTS "lead_tables_user_self"  ON public.lead_tables;
CREATE POLICY "lead_tables_tenant_members" ON public.lead_tables FOR ALL
  USING      (tenant_id IN (SELECT public.current_user_tenant_ids()))
  WITH CHECK (tenant_id IN (SELECT public.current_user_tenant_ids()));
COMMENT ON POLICY "lead_tables_tenant_members" ON public.lead_tables IS
  'Threat model: ex-tenant-members must lose access. user_id fallback removed.';

-- ── lead_columns ─────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "lead_columns_own"     ON public.lead_columns;
DROP POLICY IF EXISTS "lead_columns_tenant"  ON public.lead_columns;
DROP POLICY IF EXISTS "lead_columns_user_owner" ON public.lead_columns;
DROP POLICY IF EXISTS "lead_columns_user_self"  ON public.lead_columns;
CREATE POLICY "lead_columns_tenant_members" ON public.lead_columns FOR ALL
  USING      (tenant_id IN (SELECT public.current_user_tenant_ids()))
  WITH CHECK (tenant_id IN (SELECT public.current_user_tenant_ids()));
COMMENT ON POLICY "lead_columns_tenant_members" ON public.lead_columns IS
  'Tenant-only access. Removed creator user_id fallback to revoke ex-members.';

-- ── lead_rows ────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "lead_rows_own"     ON public.lead_rows;
DROP POLICY IF EXISTS "lead_rows_tenant"  ON public.lead_rows;
DROP POLICY IF EXISTS "lead_rows_user_owner" ON public.lead_rows;
DROP POLICY IF EXISTS "lead_rows_user_self"  ON public.lead_rows;
CREATE POLICY "lead_rows_tenant_members" ON public.lead_rows FOR ALL
  USING      (tenant_id IN (SELECT public.current_user_tenant_ids()))
  WITH CHECK (tenant_id IN (SELECT public.current_user_tenant_ids()));
COMMENT ON POLICY "lead_rows_tenant_members" ON public.lead_rows IS
  'Tenant-only. Lead data is the highest-value PII set; no creator fallback.';

-- ── lead_field_mappings ──────────────────────────────────────────────────
DROP POLICY IF EXISTS "lead_mappings_own"           ON public.lead_field_mappings;
DROP POLICY IF EXISTS "lead_field_mappings_tenant"  ON public.lead_field_mappings;
DROP POLICY IF EXISTS "lead_field_mappings_user_owner" ON public.lead_field_mappings;
DROP POLICY IF EXISTS "lead_field_mappings_user_self"  ON public.lead_field_mappings;
CREATE POLICY "lead_field_mappings_tenant_members" ON public.lead_field_mappings FOR ALL
  USING      (tenant_id IN (SELECT public.current_user_tenant_ids()))
  WITH CHECK (tenant_id IN (SELECT public.current_user_tenant_ids()));
COMMENT ON POLICY "lead_field_mappings_tenant_members" ON public.lead_field_mappings IS
  'Tenant-only access; mappings can leak external system column shapes.';

-- ── lead_assignment_rules ────────────────────────────────────────────────
DROP POLICY IF EXISTS "lead_rules_own"                ON public.lead_assignment_rules;
DROP POLICY IF EXISTS "lead_assignment_rules_tenant"  ON public.lead_assignment_rules;
DROP POLICY IF EXISTS "lead_assignment_rules_user_owner" ON public.lead_assignment_rules;
DROP POLICY IF EXISTS "lead_assignment_rules_user_self"  ON public.lead_assignment_rules;
CREATE POLICY "lead_assignment_rules_tenant_members" ON public.lead_assignment_rules FOR ALL
  USING      (tenant_id IN (SELECT public.current_user_tenant_ids()))
  WITH CHECK (tenant_id IN (SELECT public.current_user_tenant_ids()));
COMMENT ON POLICY "lead_assignment_rules_tenant_members" ON public.lead_assignment_rules IS
  'Tenant-only access; routing rules disclose org structure.';

-- ── workflows ────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "Users manage own workflows" ON public.workflows;
DROP POLICY IF EXISTS "workflows_user_owner"       ON public.workflows;
DROP POLICY IF EXISTS "workflows_user_self"        ON public.workflows;
DROP POLICY IF EXISTS "workflows_tenant"           ON public.workflows;
CREATE POLICY "workflows_tenant_members" ON public.workflows FOR ALL
  USING      (tenant_id IN (SELECT public.current_user_tenant_ids()))
  WITH CHECK (tenant_id IN (SELECT public.current_user_tenant_ids()));
COMMENT ON POLICY "workflows_tenant_members" ON public.workflows IS
  'Tenant-only. Workflows can contain credentials in node configs.';

-- ── contacts ─────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "Users manage own contacts" ON public.contacts;
DROP POLICY IF EXISTS "contacts_user_owner"       ON public.contacts;
DROP POLICY IF EXISTS "contacts_user_self"        ON public.contacts;
DROP POLICY IF EXISTS "contacts_tenant"           ON public.contacts;
CREATE POLICY "contacts_tenant_members" ON public.contacts FOR ALL
  USING      (tenant_id IN (SELECT public.current_user_tenant_ids()))
  WITH CHECK (tenant_id IN (SELECT public.current_user_tenant_ids()));
COMMENT ON POLICY "contacts_tenant_members" ON public.contacts IS
  'Tenant-only. Contacts are PII (phone/email); no creator fallback.';

-- ── broadcasts ───────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "Users manage own broadcasts" ON public.broadcasts;
DROP POLICY IF EXISTS "broadcasts_user_owner"       ON public.broadcasts;
DROP POLICY IF EXISTS "broadcasts_user_self"        ON public.broadcasts;
DROP POLICY IF EXISTS "broadcasts_tenant"           ON public.broadcasts;
CREATE POLICY "broadcasts_tenant_members" ON public.broadcasts FOR ALL
  USING      (tenant_id IN (SELECT public.current_user_tenant_ids()))
  WITH CHECK (tenant_id IN (SELECT public.current_user_tenant_ids()));
COMMENT ON POLICY "broadcasts_tenant_members" ON public.broadcasts IS
  'Tenant-only. Broadcasts can address entire customer lists; ex-members blocked.';

-- ── campaigns ────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "Users manage own campaigns" ON public.campaigns;
DROP POLICY IF EXISTS "owner_all"                  ON public.campaigns;
DROP POLICY IF EXISTS "campaigns_user_owner"       ON public.campaigns;
DROP POLICY IF EXISTS "campaigns_user_self"        ON public.campaigns;
DROP POLICY IF EXISTS "campaigns_tenant"           ON public.campaigns;
CREATE POLICY "campaigns_tenant_members" ON public.campaigns FOR ALL
  USING      (tenant_id IN (SELECT public.current_user_tenant_ids()))
  WITH CHECK (tenant_id IN (SELECT public.current_user_tenant_ids()));
COMMENT ON POLICY "campaigns_tenant_members" ON public.campaigns IS
  'Tenant-only. Drip campaigns can spend money via Meta/Razorpay.';

-- ── wa_templates ─────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "Users manage own templates" ON public.wa_templates;
DROP POLICY IF EXISTS "wa_templates_user_owner"    ON public.wa_templates;
DROP POLICY IF EXISTS "wa_templates_user_self"     ON public.wa_templates;
DROP POLICY IF EXISTS "wa_templates_tenant"        ON public.wa_templates;
CREATE POLICY "wa_templates_tenant_members" ON public.wa_templates FOR ALL
  USING      (tenant_id IN (SELECT public.current_user_tenant_ids()))
  WITH CHECK (tenant_id IN (SELECT public.current_user_tenant_ids()));
COMMENT ON POLICY "wa_templates_tenant_members" ON public.wa_templates IS
  'Tenant-only. WABA-approved templates are tenant-scoped intellectual property.';

COMMIT;
