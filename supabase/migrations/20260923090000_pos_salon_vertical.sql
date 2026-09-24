-- POS: add 'salon' to the feature's vertical gate.
--
-- WHY
-- features.pos.verticals was '{horeca}', but three client-side layers already
-- treated POS as available to salon:
--   flowgpt-apex src/lib/feature-registry.ts   → ['horeca','salon']
--   the sidebar nav registry                    → packs: ['horeca','service']
--   flowgpt-apex src/pages/POSPage.tsx          → posAllowedFor
-- The SERVER gate is the one that's enforced, so it resolved pos=false for
-- salon tenants and the nav item was hidden — the enforced layer silently
-- contradicting all three display layers. A salon bills at a counter the same
-- way a cafe does, so the server row was the one that was wrong.
--
-- The seed in 20260809000000_naruto_entitlements.sql has been corrected too
-- (it upserts with `verticals = excluded.verticals`, so it is the declarative
-- source of truth and would otherwise revert this on its next apply).
--
-- Idempotent: safe to re-run.

update public.features
   set verticals = '{horeca,salon}',
       updated_at = now()
 where key = 'pos'
   and not ('salon' = any(verticals));
