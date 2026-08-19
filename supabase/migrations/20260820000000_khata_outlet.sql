-- Per-outlet khata: tag each ledger entry with the outlet it belongs to so a
-- multi-outlet merchant can view dues/payables per branch AND combined (null =
-- unassigned / legacy / single-outlet, still counted in the combined view).
-- Additive + nullable — no backfill, no behaviour change for existing rows.
alter table if exists public.ledger_entries
  add column if not exists outlet_id text;

comment on column public.ledger_entries.outlet_id is
  'Frequency outlet id (AdminOutlet.id, e.g. o1/o2) this entry belongs to; null = unassigned/combined.';
