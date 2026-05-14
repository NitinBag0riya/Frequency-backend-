-- Restore 'disconnected' as a valid tenants.status value.
--
-- Background: migration 002 originally allowed status ∈
-- ('active','disconnected','pending'). When 017_super_admin_rbac.sql
-- introduced super-admin tenant lifecycle controls, it replaced the
-- check constraint with ('active','suspended','deleted','pending') —
-- 'disconnected' was inadvertently dropped because the rewrite was
-- scoped around platform-admin states (suspend, delete) and didn't
-- consider the existing tenant-initiated channel-disconnect flow.
--
-- The disconnect handler in src/routes/connectors/index.ts (POST
-- /api/connectors/whatsapp/disconnect) flips status to 'disconnected'
-- as the canonical signal that a WABA-linked tenant has revoked its
-- Meta integration. Multiple call-sites already filter by
-- `status !== 'disconnected'`:
--   - src/lib/whatsapp-notifications.ts:98
--   - src/engine/workflow-validator.ts:176
--   - src/routes/connectors/index.ts:118 (and related)
--
-- The check constraint failure ("new row for relation 'tenants'
-- violates check constraint 'tenants_status_check'") has been blocking
-- every disconnect attempt since 017 shipped. Restoring 'disconnected'
-- as a permitted value reconciles the constraint with the application
-- logic that's already in production.

alter table public.tenants
  drop constraint if exists tenants_status_check;

alter table public.tenants
  add constraint tenants_status_check
  check (status in ('active','suspended','deleted','pending','disconnected'));

-- Index on (status, deleted_at) was created by 017 and remains correct;
-- no change needed since indexes do not enforce value sets.
