-- 20260607030000_tenants_member_read
-- FIX: non-owner members could not load their own workspace.
--
-- The only SELECT path on public.tenants was the migration-002 policy
-- "Users manage own tenants" (USING auth.uid() = user_id). So a teammate
-- added to a tenant via user_role_assignments (sales_rep, support_agent,
-- marketing_manager, …) could read their assignment row but NOT the tenant
-- row it points to. The frontend's useOrg() lists a user's orgs by
-- inner-joining tenants onto user_role_assignments; that join was
-- RLS-filtered to empty for members → the member resolved to "no org" →
-- the router bounced them to /onboarding instead of their workspace.
-- (Owners were unaffected because they satisfy auth.uid() = user_id.)
--
-- Fix: add a permissive SELECT policy that also lets assigned members read
-- their tenant, reusing the existing SECURITY DEFINER helper
-- public.is_tenant_member(uuid). The helper already covers BOTH owners and
-- non-disabled assignees and runs as definer (bypasses RLS internally), so
-- there is no policy recursion. Permissive policies are OR-ed, so this is
-- purely additive — the existing owner "manage" policy is untouched.

drop policy if exists "Members can read their tenant" on public.tenants;

create policy "Members can read their tenant"
  on public.tenants
  for select
  to authenticated
  using ( public.is_tenant_member(id) );
