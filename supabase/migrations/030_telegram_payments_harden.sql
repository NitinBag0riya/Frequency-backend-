-- ─── Telegram payments hardening ────────────────────────────────────────
--
-- The webhook handler in src/routes/telegram.ts marks an invoice paid via
--   UPDATE tg_invoices SET status='paid' WHERE tenant_id=X AND payload=Y
-- Without uniqueness on (tenant_id, payload), a tenant that re-uses a
-- payload string across two invoices would have BOTH marked paid the moment
-- one is settled — silent over-credit. The route's pre-insert check (added
-- alongside this migration) gives a clean 409 for duplicates, but the
-- partial-unique index here is the database-level guarantee.
--
-- Also adds three audit columns for refund support:
--   - telegram_payment_charge_id    — needed by refundStarPayment Bot API
--   - provider_payment_charge_id    — provider's id (Stripe / Stars provider)
--   - paid_amount                   — Telegram-reported total_amount, can
--                                     differ from invoice amount if currency
--                                     conversion or provider fees applied
--
-- All steps `IF NOT EXISTS` / `ADD COLUMN IF NOT EXISTS` so re-running the
-- migration on an already-applied DB is a no-op (matches the rest of our
-- migration convention).

-- 1. Add audit columns first so existing rows survive index creation.
ALTER TABLE public.tg_invoices
  ADD COLUMN IF NOT EXISTS telegram_payment_charge_id text,
  ADD COLUMN IF NOT EXISTS provider_payment_charge_id text,
  ADD COLUMN IF NOT EXISTS paid_amount                bigint;

COMMENT ON COLUMN public.tg_invoices.telegram_payment_charge_id IS
  'Set on successful_payment webhook. Required by Bot API refundStarPayment.';
COMMENT ON COLUMN public.tg_invoices.provider_payment_charge_id IS
  'Provider-side charge id (Stripe txn id or Stars provider id).';
COMMENT ON COLUMN public.tg_invoices.paid_amount IS
  'Telegram-reported total_amount at settlement. May differ from invoice amount.';

-- 2. Unique partial index — only enforces on PENDING + PAID rows. We exclude
--    'cancelled' / 'refunded' so a tenant can re-use the payload string for
--    a fresh invoice after cancelling the old one (matches user mental model:
--    "the old one is dead, let me recreate with the same id").
--
--    Partial-unique requires the predicate to be IMMUTABLE. `status IN (...)`
--    on a text column is immutable, so this is safe.
CREATE UNIQUE INDEX IF NOT EXISTS tg_invoices_tenant_payload_active_uniq
  ON public.tg_invoices (tenant_id, payload)
  WHERE status IN ('pending', 'paid');

COMMENT ON INDEX public.tg_invoices_tenant_payload_active_uniq IS
  'Prevents two active (pending or paid) invoices from sharing a payload — '
  'webhook update by payload would otherwise silently mark the wrong one paid. '
  'Cancelled/refunded rows are excluded so payloads can be re-used after kill.';
