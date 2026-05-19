-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 082 — Template approval assistant (P1 #15)
--
-- BRIEF: cut WhatsApp template REJECTED rate by:
--   • surfacing Meta-policy violations BEFORE the user submits the draft
--     (POST /api/wa-templates/policy-check)
--   • translating Meta's terse rejection codes into plain English fixes
--     when a template comes back REJECTED (GET /api/wa-templates/:name/
--     explain-rejection) and suggesting a conservative rewrite
--     (POST /api/wa-templates/:name/resubmit-draft).
--
-- The rule table itself lives in src/lib/wa-template-policy.ts (no LLM, no
-- network calls — deterministic per-rule checks so the policy check runs in
-- <50ms on debounce as the user types). The schema below is the supporting
-- audit + cache layer:
--
--   • wa_template_policy_checks    — append-only audit of every policy-check
--                                    invocation. Lets us measure the
--                                    rejection-rate-before vs after over a
--                                    rolling 30d window per tenant and
--                                    diagnose false positives (e.g. a rule
--                                    flagged ERROR but Meta still approved
--                                    the same body → relax the rule).
--   • wa_template_rejection_explanations — read-through cache for the
--                                    rejection-reason explainer. Today the
--                                    explainer is a rule-table lookup
--                                    (cheap + deterministic) so the cache
--                                    is forward-looking: when the explainer
--                                    eventually delegates UNKNOWN reasons
--                                    to Claude, we hash the reason text +
--                                    cache the translation so we don't pay
--                                    LLM cost for the same Meta phrase
--                                    twice across tenants. Reason hashes
--                                    are global (the rejection text is
--                                    Meta's, not tenant-specific) → the row
--                                    is read-only to every authenticated
--                                    user, and writes happen only via
--                                    service_role.
--
-- Idempotent. No `||` inside COMMENT ON. RLS enabled on every new table.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── 1. Audit log for policy-check invocations ────────────────────────────────
create table if not exists public.wa_template_policy_checks (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references public.tenants(id) on delete cascade,
  template_name   text not null,
  draft_body      text not null,
  category        text not null,
  language        text not null,
  errors_count    int  not null default 0,
  warnings_count  int  not null default 0,
  infos_count     int  not null default 0,
  -- Did the user actually submit AFTER seeing the check result? Stamped by
  -- the create endpoint on a best-effort basis (FE passes the most recent
  -- policy-check id forward in the X-Policy-Check-Id header). NULL when the
  -- user closed the modal or kept editing.
  submitted       boolean not null default false,
  checked_at      timestamptz not null default now(),
  checked_by      uuid references auth.users(id) on delete set null
);

comment on table public.wa_template_policy_checks is
  'Append-only audit of pre-submission policy-check runs from the Template Approval Assistant. One row per debounced check (350ms) — used to measure rejection-rate improvement over time and to spot rules that fire too aggressively. Bodies are stored verbatim because rejection patterns repeat across tenants and Meta versions; this is the dataset the rule-tuning pass reads.';
comment on column public.wa_template_policy_checks.errors_count is
  'How many ERROR-severity rules fired against draft_body. ERROR blocks submit unless the user toggles "Override checks".';
comment on column public.wa_template_policy_checks.warnings_count is
  'How many WARNING-severity rules fired. WARNINGs render yellow but do not block submit (e.g. utility-template with greeting that will get reclassified to MARKETING — 7x cost cliff).';
comment on column public.wa_template_policy_checks.infos_count is
  'How many INFO-severity rules fired. INFOs render as blue chips (e.g. plain numbers that should be currency-formatted).';
comment on column public.wa_template_policy_checks.submitted is
  'TRUE iff the user submitted this exact draft to Meta after the check. Set by the create endpoint when X-Policy-Check-Id correlates back to this row. Drives the "ERRORs ignored → still rejected by Meta" tuning signal.';

create index if not exists idx_wtpc_tenant_checked
  on public.wa_template_policy_checks(tenant_id, checked_at desc);

alter table public.wa_template_policy_checks enable row level security;

drop policy if exists "wtpc_tenant_read" on public.wa_template_policy_checks;
create policy "wtpc_tenant_read" on public.wa_template_policy_checks
  for select to authenticated using (
    tenant_id = (current_setting('request.jwt.claims', true)::jsonb->>'tenant_id')::uuid
  );

-- Writes go through service_role (the BE policy-check endpoint). The
-- tenant-scoped JWT must never be able to forge audit rows.
revoke insert, update, delete on public.wa_template_policy_checks from authenticated;
revoke insert, update, delete on public.wa_template_policy_checks from anon;

-- ── 2. Read-through cache for rejection explanations ─────────────────────────
create table if not exists public.wa_template_rejection_explanations (
  reason_hash       text primary key,
  plain_english     text not null,
  suggested_edits   jsonb not null default '[]'::jsonb,
  created_at        timestamptz not null default now()
);

comment on table public.wa_template_rejection_explanations is
  'Read-through cache mapping Meta rejection_reason hashes to plain-English explanations + suggested fix array. Reason text is Meta-global (not tenant-specific) so the cache is read-only to every authenticated user. Writes happen only via service_role from the rejection explainer (today: rule-table lookup; future: LLM fallback for unknown reasons).';
comment on column public.wa_template_rejection_explanations.reason_hash is
  'sha256 hex of the lowercased+trimmed Meta rejection_reason text. Stable across tenants — every Indian D2C SMB hitting the same Meta phrase reuses the same explanation row.';
comment on column public.wa_template_rejection_explanations.suggested_edits is
  'JSONB array of structured edit hints: [{kind, find, replace, why}]. The resubmit-draft endpoint consumes this to build the conservative auto-edited body.';

alter table public.wa_template_rejection_explanations enable row level security;

drop policy if exists "wtre_read_all" on public.wa_template_rejection_explanations;
create policy "wtre_read_all" on public.wa_template_rejection_explanations
  for select to authenticated using (true);

revoke insert, update, delete on public.wa_template_rejection_explanations from authenticated;
revoke insert, update, delete on public.wa_template_rejection_explanations from anon;
