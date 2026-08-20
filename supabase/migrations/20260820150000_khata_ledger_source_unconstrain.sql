-- Remove the stale ledger_entries_source_check.
-- The original khata migration (20260725010000_khata_ledger_entries.sql) never
-- constrained `source` — it is app-controlled text: 'manual' (default + manual add),
-- 'purchase' (vendor goods-receipt → payable), and the documented 'order'/'pos'
-- auto-fill. An out-of-band CHECK later limited it to ('manual','opening','advance'),
-- which made every vendor-receive → Khata payable FAIL in prod (source='purchase'
-- rejected). Drop it so the real flow works; `direction` stays checked (the true invariant).
alter table if exists ledger_entries drop constraint if exists ledger_entries_source_check;
