-- Switch the default AI responder model from Opus 4.7 to Sonnet 4.6.
--
-- WHY: ai_responder is the highest-frequency AI call site (fires on every
-- inbound automated reply). Opus 4.7 costs ~5× more per call than Sonnet 4.6
-- ($15/$75 vs $3/$15 per 1M tokens) AND its prompt-cache floor is 4,096 tokens
-- — our ~1k-token system prompt never reaches it, so the cache never engages on
-- Opus. Sonnet's 1,024-token floor does engage. Net: Sonnet is the correct
-- default for margin with negligible quality impact on support replies.
--
-- The application code default already changed (DEFAULT_AI_SETTINGS.model in
-- src/lib/ai-knowledge.ts, DEFAULT_MODEL in src/routes/ai-responder.ts, the
-- run_ai_responder fallback in src/engine/executor.ts). This migration keeps
-- the DB in sync:
--   1. Column default → Sonnet, so any raw insert that omits `model` matches.
--   2. One-time backfill of existing rows still pointing at Opus 4.7.
--
-- CAVEAT ON THE BACKFILL: we cannot distinguish a tenant who *deliberately*
-- selected Opus in settings from one who was simply *defaulted* onto it by the
-- old code. This backfill treats ALL current Opus rows as "defaulted" and
-- resets them to Sonnet (the chosen Option A — capture the margin on the
-- existing base; the quality delta on support replies is negligible, and any
-- tenant who truly wants Opus can re-select it). If you would rather preserve
-- deliberate Opus choosers, skip step 2 and only ship the column-default change.

-- 1. Column default for new rows.
alter table tenant_ai_settings
  alter column model set default 'claude-sonnet-4-6';

-- 2. Backfill existing rows that are still on the old default.
update tenant_ai_settings
   set model = 'claude-sonnet-4-6'
 where model = 'claude-opus-4-7';
