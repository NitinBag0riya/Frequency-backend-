-- POS Phase 4 (4.9): register the `reservations` feature key.
--
-- WHY
-- Table reservations (floor hold + WA confirm/reminder, storefront-api side)
-- are gated behind a plan-feature the same way `pos`/`kot`/`kds` are
-- (flowgpt-server features table -> admin proxy `hasFeature` -> the
-- storefront-api /admin/pos/* gate, T0.3 pattern). This is a NEW capability,
-- not a bug fix, so it ships default OFF (opt-in) — every existing tenant's
-- resolved entitlements are unchanged until a plan grant or tenant override
-- turns it on.
--
-- Applies to horeca + salon only (same vertical pair as `pos`, corrected in
-- 20260923090000_pos_salon_vertical.sql) — a restaurant table or a salon
-- chair are both "reservable slots"; real_estate/d2c never see this row
-- (verticalAllowed() hard-gates it out for those business groups regardless
-- of plan or override).
--
-- Idempotent: `on conflict (key) do nothing` — a re-run never clobbers an
-- admin's later hand-edit of this row (matches the guard style of the sole
-- other post-seed features migration, 20260923090000_pos_salon_vertical.sql,
-- which also only touches its own key).
--
-- No plan_features backfill here (deliberate): the one-time '*'-plan backfill
-- in 20260809000000_naruto_entitlements.sql ran once, at that migration's
-- creation, against plans as they existed then. Re-running an equivalent
-- backfill now would silently grant `reservations` to every '*'-plan tenant
-- today, contradicting "default OFF / opt-in". Turning it on for a plan or
-- tenant is a separate, deliberate product/ops action (INSERT plan_features
-- row, or a tenant_entitlements override) — not this migration's job.
--
-- RLS: no new table. `features` already has row-level security enabled with
-- a `features_read_all` (select using (true)) policy from
-- 20260809000000_naruto_entitlements.sql; writes stay service-role only.
-- This row inherits that policy — no new policy needed.

insert into features (key, name, description, category, verticals, default_enabled, gate_style, sort_order)
values (
  'reservations',
  'Table reservations',
  'Reserve a table/slot ahead of time; WhatsApp confirm + reminder to the guest',
  'commerce',
  '{horeca,salon}',
  false,          -- default OFF — opt-in per plan grant / tenant override
  'locked_teaser',
  61              -- between tax(60) and salon services(70) in sort_order
)
on conflict (key) do nothing;

-- ─── DOWN (manual rollback, not run by this migration) ───────────────────────
-- delete from plan_features where feature_key = 'reservations';
-- delete from tenant_entitlements where feature = 'reservations';
-- delete from features where key = 'reservations';
