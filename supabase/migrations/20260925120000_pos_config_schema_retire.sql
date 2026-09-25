-- POS Upgrade Phase 1 (M16) — retire the dead FeatureOptionsCard 'pos.*' seed.
--
-- WHY
-- 20260809030000_naruto_nav_config.sql seeded features.config_schema for the
-- 'pos' key (tax_mode / service_charge_pct / round_off), driving the generic
-- FeatureOptionsCard UI (src/components/settings/FeatureOptionsCard.tsx) via
-- the 3-layer config resolver (src/lib/config-resolver.ts, tenant_config /
-- plan_config / features.config_schema). Phase 0 of the POS Upgrade confirmed
-- the REAL POS tax/round-off settings live entirely in the storefront-api
-- JSON settings.pos.* namespace (server.js DEFAULT_SETTINGS) — nothing in
-- storefront-api or the dashboard ever calls getConfig(tenant,'pos.tax_mode')
-- or reads tenant_config/plan_config rows for the 'pos' feature. The seed is
-- dead: it renders a POS options card that edits values no code path
-- consumes. Phase 1 (M16) deletes the UI (dashboard seat, src/) and this
-- migration deletes the seed + any orphaned override rows (data seat).
--
-- We do NOT touch nav_overrides / tenant_config / plan_config / features
-- themselves, and do NOT drop or rename any column — only null out the one
-- seeded JSON value and delete rows scoped to config_key LIKE 'pos.%'. The
-- 'appointments' config_schema seed (same source migration) is untouched:
-- it is a different feature, out of scope for M16, and still may be read.
--
-- Immutable-migrations rule: 20260809030000_naruto_nav_config.sql is already
-- shipped and is NOT edited in place. This is a new, separately-dated
-- migration that supersedes only the 'pos' rows it seeded.
--
-- Idempotent: every statement is a conditional UPDATE/DELETE — safe to re-run,
-- safe to run whether or not any tenant ever touched the FeatureOptionsCard
-- POS card.
--
-- RLS: no new tables. The three tables touched (features, tenant_config,
-- plan_config) already have RLS enabled with no public policy (writes are
-- service-role only, see 20260809030000_naruto_nav_config.sql:48-52) — this
-- migration runs as the migration role (bypasses RLS, same as every prior
-- migration in this repo) and does not change that posture.
--
-- Indexes: none added. tenant_config_tenant_idx (tenant_id) and the
-- plan_config primary key (plan_id, config_key) already cover the DELETEs
-- below (filtered by config_key, a leading/only predicate column — no new
-- index needed for a one-off migration-time cleanup of a handful of rows).
--
-- Blast radius if applied mid-traffic:
--   - features.config_schema for key='pos' -> null: any open FeatureOptionsCard
--     tab stops showing the POS section on its NEXT GET /api/tenant-config
--     (60s in-process schema cache per instance, see config-resolver.ts:29-30 —
--     worst case a running dashboard tab keeps a stale-but-inert copy of the
--     already-loaded card until refresh; no write is accepted afterwards
--     because the schema check in resolveTenantConfig/getConfig gates on the
--     live schema, not the client's stale copy — a PATCH after the null lands
--     just won't find 'pos' in the resolved feature list to submit against).
--   - tenant_config / plan_config DELETE ... WHERE config_key LIKE 'pos.%':
--     removes only inert override rows nothing reads (getConfig short-circuits
--     to `undefined` once schema.get('pos') is empty, before ever querying
--     these tables for a pos.* key) — no runtime behaviour changes.
--   - No lock contention risk: single-row UPDATE by primary-key-equivalent
--     (features.key='pos') + small filtered DELETEs, no table scan, no DDL.
--   - Nothing for storefront-api, POSPage, or any desktop build to notice —
--     this table is never queried outside src/lib/config-resolver.ts and
--     src/routes/nav-config.ts in flowgpt-server.
--
-- Rollback (down, on paper — NOT applied, forward-only in practice):
--   update features set config_schema = '{
--     "options": [
--       { "key": "tax_mode", "label": "Tax mode", "type": "enum", "options": ["exclusive","inclusive"], "default": "exclusive",
--         "help": "Exclusive charges GST on top of the listed price; inclusive treats price as tax-inclusive." },
--       { "key": "service_charge_pct", "label": "Service charge (%)", "type": "number", "default": 0,
--         "help": "Optional service charge added to the bill." },
--       { "key": "round_off", "label": "Round off totals", "type": "boolean", "default": true }
--     ]
--   }'::jsonb
--   where key = 'pos';
--   -- (tenant_config / plan_config pos.* override rows deleted below cannot be
--   -- un-deleted; they were tenant-authored dead-feature data with no reader,
--   -- so the down path only restores the schema, not any pre-existing override.)

-- 1. Null out the 'pos' feature's config_schema seed (guarded: only touch if
--    it still matches what 20260809030000 seeded, or is otherwise non-null —
--    either way this feature has no code path that reads config_schema for
--    'pos', so any non-null value here is dead).
update public.features
   set config_schema = null,
       updated_at = now()
 where key = 'pos'
   and config_schema is not null;

-- 2. Drop orphaned per-tenant overrides for the retired 'pos.*' options
--    (tax_mode / service_charge_pct / round_off, or any other pos.* key an
--    owner may have set via the old card).
delete from public.tenant_config
 where config_key like 'pos.%';

-- 3. Drop orphaned per-plan overrides for the same namespace.
delete from public.plan_config
 where config_key like 'pos.%';
