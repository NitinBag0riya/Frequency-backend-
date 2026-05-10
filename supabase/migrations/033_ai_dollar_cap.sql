-- ─── ai_dollars_per_month plan cap — margin firewall ───────────────────────
--
-- Tokens alone don't cap real cost: Sonnet output is 15× the cost of Haiku
-- input. A 5M-token cap on Growth could mean anywhere from $5 to $75 in
-- actual Anthropic spend depending on what models the workflow actually
-- invoked. Tokens are the user-facing "you've used X" signal; dollars are
-- the gross-margin floor.
--
-- Targets (70%+ gross margin per paid plan, accounting for prompt caching
-- now wired at all 3 AI call sites):
--
--   Plan       Price   AI cost cap   Other infra cost   Total cost   Margin
--   ─────────  ──────  ───────────  ─────────────────  ───────────  ──────
--   Free       $0       $0.50         $0.30            $0.80          n/a (acquisition)
--   Starter    $12      $3            $0.50             $3.50          71%   ✅
--   Growth     $30      $9            $1.50             $10.50         65% → tighten infra share or accept 65%; with cache savings 70%+
--   Scale     $84       $25           $5                $30            64% → BYOK route long-term; today the hard cap caps loss
--   Enterprise custom   -1 (unlim)    bespoke                          contracted
--
-- Token caps remain for UX (the bar shown in /settings/billing). Dollar
-- caps are the hard gate on top — whichever bites first stops the call.
--
-- All steps idempotent — re-running this migration is a no-op.

-- 1. Update each tier's plan.limits jsonb to include the new key. Uses
--    jsonb_set with create_missing=true so the key is added if absent
--    or updated if already present.
UPDATE public.plans SET limits = jsonb_set(limits, '{ai_dollars_per_month}', '0',  true) WHERE id = 'free';
UPDATE public.plans SET limits = jsonb_set(limits, '{ai_dollars_per_month}', '3',  true) WHERE id = 'starter';
UPDATE public.plans SET limits = jsonb_set(limits, '{ai_dollars_per_month}', '9',  true) WHERE id = 'growth';
UPDATE public.plans SET limits = jsonb_set(limits, '{ai_dollars_per_month}', '25', true) WHERE id = 'scale';
UPDATE public.plans SET limits = jsonb_set(limits, '{ai_dollars_per_month}', '-1', true) WHERE id = 'enterprise';

-- 2. usage_counters already accepts arbitrary `metric` strings (the table
--    PK is (tenant_id, metric, period_start)). The new `ai_cost_cents`
--    metric just needs to be writable — no schema change. Document the
--    convention so future readers know what to expect:
COMMENT ON TABLE public.usage_counters IS
  'Rolling-window quota counters per (tenant_id, metric, period_start). '
  'Known metric values: '
  '''ai_tokens'' (sum of input+output+cache tokens), '
  '''ai_cost_cents'' (USD cents at Anthropic''s per-model rate, written by '
  'lib/ai-usage.ts:recordAiUsage), and the legacy metrics defined in '
  'migration 021.';

-- 3. Sanity check after deploy:
--   select id, name, monthly_price_inr, limits->>'ai_tokens_per_month' as tokens,
--          limits->>'ai_dollars_per_month' as dollars
--     from public.plans order by sort_order;
