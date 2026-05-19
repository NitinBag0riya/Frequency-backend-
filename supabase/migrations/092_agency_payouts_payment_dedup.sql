-- 092_agency_payouts_payment_dedup
--
-- Hardens the agency revshare credit-as-refund flow against TOCTOU
-- double-refund races. Security audit (2026-05-19) flagged three P0s:
--
--   1. Idempotency check used ILIKE on the `notes` text column BEFORE the
--      row was written → two concurrent invoice.paid webhook deliveries
--      could both pass the check and both issue Razorpay refunds.
--   2. Refund issued before DB row written → if the post-refund DB writes
--      failed, the next webhook retry would re-issue another refund.
--   3. No structural uniqueness on the (agency_id, payment_id) pair.
--
-- Fix architecture:
--   - Add `razorpay_payment_id` column (the Razorpay payment ID the credit
--     was applied against — distinct from `razorpay_payout_id` which is
--     the refund ID written AFTER the refund call succeeds).
--   - UNIQUE partial index on (agency_id, razorpay_payment_id) — partial
--     so existing monthly aggregator rows (payment_id IS NULL) aren't
--     forced into the constraint.
--   - The application code is rewritten to INSERT this row FIRST with
--     status='pending' and razorpay_payout_id=NULL. ON CONFLICT DO
--     NOTHING short-circuits concurrent webhook deliveries — only the
--     first one proceeds to call Razorpay. Subsequent retries that
--     pass the gate use the EXISTING row.
--   - After the Razorpay refund succeeds: UPDATE the row to status='paid'
--     + razorpay_payout_id=refund.id. UPDATE preserves the dedup key so
--     a third retry STILL hits the conflict and no-ops.
--
-- Migration safety:
--   - Adds a nullable column (no default backfill needed; nullable for
--     pre-existing aggregator rows).
--   - Partial unique index avoids breaking aggregator rows where
--     razorpay_payment_id IS NULL.
--   - Idempotent via `if not exists` guards.

alter table public.agency_payouts
  add column if not exists razorpay_payment_id text;

-- Partial unique index: only enforced where razorpay_payment_id IS NOT NULL.
-- Pre-existing monthly aggregator rows (status='pending', payment_id NULL)
-- are unaffected. Two refund-credit attempts for the same payment_id will
-- collide at insert time → ON CONFLICT DO NOTHING in the helper makes the
-- second caller a no-op.
do $$ begin
  if not exists (
    select 1 from pg_indexes where schemaname='public' and indexname='ux_agency_payouts_payment'
  ) then
    create unique index ux_agency_payouts_payment
      on public.agency_payouts(agency_id, razorpay_payment_id)
      where razorpay_payment_id is not null;
  end if;
end $$;

comment on column public.agency_payouts.razorpay_payment_id is
  'Razorpay payment id this credit-as-refund was applied against. Distinct from razorpay_payout_id (the refund id, set AFTER the refund succeeds). Used as the structural idempotency anchor — paired with agency_id in a partial unique index — so concurrent invoice.paid webhook deliveries can race-safely settle at most one refund per payment.';
