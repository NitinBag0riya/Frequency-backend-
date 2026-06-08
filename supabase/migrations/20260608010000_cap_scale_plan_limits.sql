-- Cap the Scale tier's limits before the plans table becomes the single
-- source of truth for the pricing UI (BillingPage + landing page both move to
-- reading GET /api/plans).
--
-- WHY: migration 018 seeded Scale with EVERY limit = -1 (unlimited) — back when
-- Scale was the top "custom pricing" tier. Migration 021 then gave Scale a real
-- price (₹6,999) but left the limits unlimited, and migration 021 also added a
-- separate Enterprise tier as the true "unlimited / talk-to-sales" plan. So
-- today Scale is a fixed-price ₹6,999 plan with UNLIMITED contacts / messages /
-- workflows — a margin hole. Once the UI reads from the DB we'd be publicly
-- advertising "Scale: unlimited everything", which the pricing economics review
-- flagged as loss-making. Enterprise remains the unlimited tier.
--
-- Finite, defensible Scale caps (well above any real SMB need, so no current
-- Scale tenant is realistically affected, but bounded for COGS/abuse). The AI
-- dollar cap (ai_dollars_per_month = 25, set in migration 033) — the real
-- margin guardrail — is intentionally left untouched. custom_roles_allowed
-- (true) and any other keys survive via the || merge.

update public.plans
   set limits = limits || jsonb_build_object(
         'contacts_max',        200000,
         'messages_per_month',  250000,
         'workflows_max',       200,
         'broadcasts_per_day',  200,
         'team_size_max',       50,
         'ai_tokens_per_month', 50000000
       ),
       updated_at = now()
 where id = 'scale';

-- Enterprise stays unlimited (-1) — it is the genuine "talk to sales" tier.
