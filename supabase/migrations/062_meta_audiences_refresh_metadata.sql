-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 062 — meta_audiences refresh metadata
--
-- Background: meta_audiences was added in migration 016 (omnichannel) with
-- just `size_estimate`, `status`, and `created_at`. When we create a
-- LOOKALIKE via POST /api/meta-ads/audiences/lookalike, Meta returns an
-- audience id immediately but the actual reach estimate is computed
-- asynchronously over 1–24 hours and continues to drift as Meta updates the
-- model. We never re-polled, so the UI showed "estimate pending" forever.
--
-- This migration adds the columns the lookalike-refresh worker
-- (src/workers/lookalike-refresh.ts) writes on every tick:
--
--   approximate_count           — Meta's current reach estimate (bigint, can be
--                                 large for broad lookalikes). Distinct from
--                                 the legacy size_estimate column so existing
--                                 callers keep working; new code reads this.
--   operation_status            — JSONB: {code:int, description:text} as
--                                 returned verbatim by Meta. code=200 ready,
--                                 300 failed, 400 normal, 410/411/412 too
--                                 small / not enough source / unavailable.
--                                 We persist the raw object so the FE can
--                                 surface Meta's exact reason.
--   delivery_status             — JSONB: {code:int, description:text} — used
--                                 for delivery-time gating ("audience too
--                                 small to deliver"); separate axis from
--                                 operation_status.
--   last_estimate_refreshed_at  — timestamp the worker last successfully
--                                 fetched from Meta. The worker skips rows
--                                 newer than 30 min so a tenant with 1000
--                                 audiences doesn't get re-polled on every
--                                 tick.
--   last_error                  — text. Set when the GET fails (network /
--                                 token / Meta 4xx). Cleared on next success.
--                                 The FE shows this on the audience detail.
--
-- Indexes:
--   - meta_audiences_refresh_due (last_estimate_refreshed_at WHERE
--     type='LOOKALIKE'): hot path — every tick picks 25 stalest lookalikes.
--   - meta_audiences_tenant (already implicit via FK; explicit index helps
--     the worker's per-tick "find tenants with stale lookalikes" pull).
--
-- DON'T apply yet — author only. Apply when the worker is reviewed +
-- the meta_ad_audiences vs meta_audiences naming is double-checked against
-- prod schema (grep confirmed meta_audiences is the live table).
-- ─────────────────────────────────────────────────────────────────────────────

alter table public.meta_audiences
  add column if not exists approximate_count          bigint,
  add column if not exists operation_status           jsonb,
  add column if not exists delivery_status            jsonb,
  add column if not exists last_estimate_refreshed_at timestamptz,
  add column if not exists last_error                 text;

-- Hot-path index. Partial on type='LOOKALIKE' because CUSTOM audiences are
-- materialised by us and don't need re-polling (their size is whatever we
-- uploaded). NULLS FIRST so never-refreshed rows are picked up before stale
-- ones on the first tick after deploy.
create index if not exists meta_audiences_refresh_due
  on public.meta_audiences (last_estimate_refreshed_at nulls first)
  where type = 'LOOKALIKE';

-- Tenant grouping — the worker pulls "tenants with at least one stale
-- lookalike" then per-tenant resolves the meta_ads token once. Without
-- this index that pull degenerates into a seq scan as the table grows.
create index if not exists meta_audiences_tenant_type
  on public.meta_audiences (tenant_id, type);

-- Refresh PostgREST schema cache so the new columns are visible to API
-- calls (e.g. GET /api/meta-ads/audiences) immediately on apply.
notify pgrst, 'reload schema';

comment on column public.meta_audiences.approximate_count is
  'Meta-computed lookalike reach estimate. Refreshed every ~30 min by '
  'src/workers/lookalike-refresh.ts. NULL until Meta finishes the first '
  'computation (1–24h after audience create).';

comment on column public.meta_audiences.operation_status is
  'Raw Meta operation_status object: {code, description}. code=200 ready, '
  '300 failed (worker skips re-polling), 400 normal processing, 410/411/412 '
  'too-small / insufficient-source / unavailable.';

comment on column public.meta_audiences.last_estimate_refreshed_at is
  'Set by src/workers/lookalike-refresh.ts on every successful Meta GET. '
  'The worker only re-polls rows older than LOOKALIKE_REFRESH_INTERVAL_MS '
  '(default 30 min) to bound Meta API spend.';

comment on column public.meta_audiences.last_error is
  'Last Meta GET error verbatim. Set on failure, cleared on next successful '
  'refresh. Surfaced on the audience detail page so the user knows why the '
  'estimate is stale.';
