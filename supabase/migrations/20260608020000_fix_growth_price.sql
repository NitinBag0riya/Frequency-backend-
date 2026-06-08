-- Fix the Growth tier price-column inconsistency.
--
-- The display field monthly_price_inr was raised to ₹2,999 (via the admin
-- Plans editor) but the Razorpay charge columns were left at the old ₹2,499 —
-- so the pricing UI showed ₹2,999 while customers were actually charged
-- ₹2,499. The admin editor only writes monthly_price_inr (rupees), not the
-- paise columns Razorpay bills against.
--
-- Canonical decision: ₹2,999 is correct. Sync the paise columns to match.
-- Annual follows the platform's "2 months free" convention (10× monthly),
-- consistent with the other tiers: ₹2,999 × 10 = ₹29,990 = 2999000 paise.
-- monthly_price_inr is already 2,999; set it explicitly for idempotency.

update public.plans
   set monthly_price_inr = 2999,
       price_inr_mo      = 299900,    -- ₹2,999 in paise
       price_inr_yr      = 2999000,   -- ₹29,990/yr in paise
       updated_at        = now()
 where id = 'growth';
