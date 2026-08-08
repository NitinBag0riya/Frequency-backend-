-- Naruto control-plane P3 — targeted announcements.
--
-- Adds vertical/plan targeting to platform announcements so an operator can
-- broadcast "New POS features" to HoReCa Growth tenants only. '{*}' = all
-- (current behaviour), so existing rows keep broadcasting to everyone.
-- A banner consumer filters: show iff (target ∋ '*' OR target ∋ tenant.value).
-- BETA-only apply.
alter table platform_announcements add column if not exists target_verticals text[] not null default '{*}';
alter table platform_announcements add column if not exists target_plans    text[] not null default '{*}';
