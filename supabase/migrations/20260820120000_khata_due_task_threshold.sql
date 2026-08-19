-- Per-tenant Khata follow-up threshold: the balance (₹) at which a customer's due
-- auto-creates a follow-up SOP task. Nullable/additive; null ⇒ the ₹500 default,
-- 0 ⇒ a task for any positive due. Replaces the hardcoded constant in task-auto.ts.
alter table if exists public.tenants
  add column if not exists khata_due_task_threshold integer;

comment on column public.tenants.khata_due_task_threshold is
  'Khata balance (₹) at which a due auto-creates a follow-up task; null=500 default, 0=any due.';
