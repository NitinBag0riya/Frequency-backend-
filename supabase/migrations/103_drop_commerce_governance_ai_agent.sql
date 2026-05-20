-- 103_drop_commerce_governance_ai_agent
--
-- Removes commerce + khaata + governance + the parallel AI-agent KB
-- shipped in migrations 096–102. These were product mistakes — the
-- AI-agent KB duplicated the existing /api/ai responder + ai_settings
-- + ai_knowledge_chunks, and the commerce surface bypassed the Tables
-- + Apps + Workflows architecture that the rest of the product builds
-- on. The 3-step UX from /settings/ai-agent migrates onto the
-- existing /settings/ai surface; commerce will be re-introduced (if
-- ever) on top of the Tables model.
--
-- This migration is strictly DROP. It does NOT touch:
--   - sla_configs / sla_breaches             (migration 095, kept)
--   - pii_masking_config (incl. outbound_action col from 099, kept)
--   - any of the older AI Responder schema (ai_settings,
--     ai_knowledge_chunks) which /settings/ai already uses
--   - conversation_notes / quick_replies     (Phase 1A, kept)
--
-- Order: drop dependent objects first (FK CASCADE handles most of it),
-- then functions, then tables. RPC drops use the exact signatures
-- that exist in the database so we don't leak orphans.

set check_function_bodies = off;

-- ─── Views ───────────────────────────────────────────────────────────────

drop view if exists public.v_governance_actions_for_agency;

-- ─── Functions / RPCs ────────────────────────────────────────────────────
-- IF EXISTS so re-running on a partially-dropped state is safe.

drop function if exists public.commerce_governance_apply(uuid, uuid);
drop function if exists public.commerce_governance_apply(uuid, uuid, text);
drop function if exists public.commerce_governance_expire_stale();
drop function if exists public.commerce_post_transaction(uuid, uuid, text, jsonb, bigint, text, text, text, uuid);
drop function if exists public.match_kb_chunks(uuid, vector, int);
-- Trigger function is referenced by the trigger on khaata_transactions;
-- the table drop below will cascade the trigger, but we drop the
-- function explicitly afterwards so nothing dangles.

-- ─── Governance tables ───────────────────────────────────────────────────

drop table if exists public.commerce_governance_actions    cascade;
drop table if exists public.commerce_governance_thresholds cascade;

-- ─── Commerce tables ─────────────────────────────────────────────────────
-- monthly_settlements references khaata_accounts; standing_orders too.
-- CASCADE handles the chain. khaata_transactions has the balance trigger
-- which cascades on table drop.

drop table if exists public.monthly_settlements    cascade;
drop table if exists public.standing_orders        cascade;
drop table if exists public.khaata_transactions    cascade;
drop table if exists public.khaata_accounts        cascade;
drop table if exists public.catalog_items          cascade;

-- Trigger function survives the table drop above (CASCADE drops the
-- trigger, not the function). Remove it now.
drop function if exists public.tg_khaata_transactions_update_balance();

-- ─── AI-agent KB tables (parallel to /settings/ai — being killed) ────────
-- kb_chunks references kb_sources + knowledge_bases (cascade).
-- kb_test_runs + kb_inference_log reference knowledge_bases.

drop table if exists public.kb_inference_log  cascade;
drop table if exists public.kb_test_runs      cascade;
drop table if exists public.kb_chunks         cascade;
drop table if exists public.kb_sources        cascade;
drop table if exists public.knowledge_bases   cascade;
