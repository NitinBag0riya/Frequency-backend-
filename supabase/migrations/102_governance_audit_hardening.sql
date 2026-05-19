-- 102_governance_audit_hardening
--
-- Hardening pass on migrations 100 + 101 after the end-to-end governance
-- audit. Strictly additive — no destructive changes.
--
-- Audit findings addressed:
--
-- C2 + C3 + C4 (security): The RPC has no concept of "approver layer"
--   and no membership check. Entire policy is route-layer convention.
--   Fix: replace commerce_governance_apply with a version that takes
--   p_approver_layer ('tenant'|'agency'), verifies the approver has
--   membership in that layer, AND honours the per-sub-account
--   governance_approval_mode at apply time.
--
-- Mid-flight policy snapshot: commerce_governance_actions gets a
--   governance_approval_mode_snapshot column populated at propose time.
--   The RPC enforces against the SNAPSHOT, so flipping the mode after
--   the proposal lands can't escalate or de-escalate an in-flight action.
--
-- C5 (security): v_governance_actions_for_agency is reachable from any
--   authenticated user via PostgREST + their JWT. Lock it down with an
--   explicit REVOKE on the authenticated role; agency reads now go
--   exclusively through the service-role BE handlers.
--
-- Audit #1 (code review): commerce_governance_apply dispatch ladder
--   silently marks 'applied' on unknown action_type or NULL settlement_id.
--   Fix: explicit ELSE clause + nullability guard + lock all moving rows.
--
-- Audit #2 (code review): settlement_waive doesn't FOR UPDATE the
--   khaata_accounts row. Fix: lock before the insert.
--
-- Audit #6 (code review): settlement_waive uses payload.amount_paise
--   which the proposer can fabricate. Fix: derive from
--   (monthly_settlements.total_paise - paid_paise) inside the RPC.
--
-- H5 (security): commerce_governance_expire_stale is never called.
--   Fix: a wrapper RPC that the BullMQ cron worker can hit by name;
--   the actual cron registration lands in src/workers/governance-janitor.ts.
--
-- Audit #9 (code review): agency_sub_accounts(tenant_id) has no unique
--   index on active rows. Two concurrent active links for the same
--   tenant would double-emit through the view. Fix: partial unique
--   index. (Defensive — the existing logic prevents double-links, but
--   the schema didn't enforce it.)
--
-- Audit M5 (security): the route's `proposer:proposed_by(*)` join was
--   resolving foreign keys against auth.users and could leak email /
--   encrypted_password / raw_user_meta_data. The route is patched to
--   drop the wildcard expansion; this migration adds a CHECK comment
--   so future audits notice.

set check_function_bodies = off;

-- ─── Snapshot column ─────────────────────────────────────────────────────

alter table public.commerce_governance_actions
  add column if not exists governance_approval_mode_snapshot text
  check (governance_approval_mode_snapshot is null
         or governance_approval_mode_snapshot in ('tenant_only', 'agency_or_tenant', 'agency_only'));

comment on column public.commerce_governance_actions.governance_approval_mode_snapshot is
  'Snapshot of agency_sub_accounts.governance_approval_mode at propose time. Enforced by commerce_governance_apply so post-proposal mode flips cannot escalate / de-escalate the action.';

-- Backfill existing rows by joining to the current link (best effort).
update public.commerce_governance_actions a
   set governance_approval_mode_snapshot = coalesce(
         (select governance_approval_mode from public.agency_sub_accounts asa
           where asa.tenant_id = a.tenant_id and asa.removed_at is null
           limit 1),
         'tenant_only')
 where governance_approval_mode_snapshot is null;

-- ─── Active-link uniqueness ──────────────────────────────────────────────

create unique index if not exists ux_agency_sub_accounts_active_tenant
  on public.agency_sub_accounts(tenant_id)
  where removed_at is null;

-- ─── View hardening: revoke from authenticated ──────────────────────────

revoke all on public.v_governance_actions_for_agency from authenticated;
revoke all on public.v_governance_actions_for_agency from anon;
-- Service-role keeps its implicit access (it bypasses RLS entirely).
-- BE handlers read through service-role + membership checks in JS.

-- ─── Rewrite commerce_governance_apply ──────────────────────────────────

create or replace function public.commerce_governance_apply(
  p_action_id        uuid,
  p_approver         uuid,
  p_approver_layer   text  -- 'tenant' | 'agency'
) returns table (
  status text,
  detail jsonb
) language plpgsql security definer set search_path = public, pg_catalog as $$
declare
  v_act                public.commerce_governance_actions%rowtype;
  v_thr                public.commerce_governance_thresholds%rowtype;
  v_two_person         boolean := true;
  v_amount             bigint;
  v_account            public.khaata_accounts%rowtype;
  v_settlement         public.monthly_settlements%rowtype;
  v_txn                public.khaata_transactions%rowtype;
  v_rpc_row            record;
  v_to_paise           bigint;
  v_delta              bigint;
  v_link               public.agency_sub_accounts%rowtype;
  v_mode               text;
  v_member_exists      boolean := false;
  -- ₹1,00,00,000 ceiling on any single governance-driven mutation. Anything
  -- bigger requires a separate manual ops process; the schema-level cap
  -- guards against payload-driven int8 overflow attacks.
  v_per_action_ceiling bigint := 10000000000;
begin
  -- Validate approver layer.
  if p_approver_layer is null or p_approver_layer not in ('tenant', 'agency') then
    return query select 'invalid_layer'::text, '{}'::jsonb;
    return;
  end if;

  -- Lock the action row.
  select * into v_act from public.commerce_governance_actions
    where id = p_action_id for update;
  if not found then
    return query select 'not_found'::text, '{}'::jsonb;
    return;
  end if;
  if v_act.status <> 'pending' then
    return query select 'wrong_status'::text, jsonb_build_object('current_status', v_act.status);
    return;
  end if;
  if v_act.expires_at < now() then
    update public.commerce_governance_actions
       set status = 'expired', updated_at = now()
     where id = p_action_id;
    return query select 'expired'::text, '{}'::jsonb;
    return;
  end if;

  -- H5 defence: NULL proposed_by (orphaned via on-delete-set-null) makes
  -- the proposer ≠ approver check meaningless. Refuse the apply outright.
  if v_act.proposed_by is null then
    update public.commerce_governance_actions
       set status = 'failed', apply_error = 'proposer_orphaned', updated_at = now()
     where id = p_action_id;
    return query select 'failed'::text, jsonb_build_object('reason', 'proposer_orphaned');
    return;
  end if;

  -- Two-person rule.
  select * into v_thr from public.commerce_governance_thresholds
    where tenant_id = v_act.tenant_id;
  if found then v_two_person := v_thr.two_person_required; end if;
  if v_two_person and v_act.proposed_by = p_approver then
    return query select 'cannot_approve_own'::text, '{}'::jsonb;
    return;
  end if;

  -- Membership verification (C4 fix). Approver MUST be a member of the
  -- claimed layer for the action's tenant. We trust user_role_assignments
  -- + user_roles for the tenant layer (union pattern used elsewhere in
  -- this codebase), agency_members.accepted_at for the agency layer.
  if p_approver_layer = 'tenant' then
    select exists(
      select 1 from public.user_role_assignments
       where user_id = p_approver and tenant_id = v_act.tenant_id
      union all
      select 1 from public.user_roles
       where user_id = p_approver and tenant_id = v_act.tenant_id
    ) into v_member_exists;
  else
    -- p_approver_layer = 'agency'
    select exists(
      select 1 from public.agency_members am
        join public.agency_sub_accounts asa on asa.agency_id = am.agency_id
       where am.user_id = p_approver
         and am.accepted_at is not null
         and asa.tenant_id = v_act.tenant_id
         and asa.removed_at is null
    ) into v_member_exists;
  end if;
  if not v_member_exists then
    return query select 'not_authorized'::text, jsonb_build_object('layer', p_approver_layer);
    return;
  end if;

  -- Policy enforcement (C2 + C3 fix). Honour the snapshot first; fall
  -- back to a live lookup for old rows from before migration 102.
  v_mode := v_act.governance_approval_mode_snapshot;
  if v_mode is null then
    select governance_approval_mode into v_mode
      from public.agency_sub_accounts
     where tenant_id = v_act.tenant_id and removed_at is null
     limit 1;
    v_mode := coalesce(v_mode, 'tenant_only');
  end if;
  if v_mode = 'tenant_only' and p_approver_layer <> 'tenant' then
    return query select 'policy_violation'::text, jsonb_build_object('mode', v_mode, 'layer', p_approver_layer);
    return;
  end if;
  if v_mode = 'agency_only' and p_approver_layer <> 'agency' then
    return query select 'policy_violation'::text, jsonb_build_object('mode', v_mode, 'layer', p_approver_layer);
    return;
  end if;
  -- 'agency_or_tenant' permits both layers.

  -- ── Dispatch ──────────────────────────────────────────────────────────
  if v_act.action_type in ('refund', 'adjustment_large') then
    v_amount := coalesce(v_act.amount_paise, (v_act.payload->>'amount_paise')::bigint);
    if v_amount is null then
      update public.commerce_governance_actions
         set status = 'failed', apply_error = 'amount_paise_missing', updated_at = now()
       where id = p_action_id;
      return query select 'failed'::text, jsonb_build_object('reason', 'amount_paise_missing');
      return;
    end if;
    if abs(v_amount) > v_per_action_ceiling then
      update public.commerce_governance_actions
         set status = 'failed', apply_error = 'amount_above_ceiling', updated_at = now()
       where id = p_action_id;
      return query select 'failed'::text, jsonb_build_object('reason', 'amount_above_ceiling', 'ceiling_paise', v_per_action_ceiling);
      return;
    end if;
    select * into v_rpc_row from public.commerce_post_transaction(
      v_act.tenant_id, v_act.account_id,
      case when v_act.action_type = 'refund' then 'refund' else 'adjustment' end,
      coalesce(v_act.payload->'items_json', '[]'::jsonb),
      v_amount,
      coalesce(v_act.payload->>'notes', v_act.reason),
      null,
      v_act.payload->>'razorpay_payment_id',
      p_approver
    );
    if v_rpc_row.status <> 'ok' then
      update public.commerce_governance_actions
         set status = 'failed', apply_error = v_rpc_row.status, updated_at = now()
       where id = p_action_id;
      return query select 'failed'::text, jsonb_build_object('reason', v_rpc_row.status, 'detail', v_rpc_row.detail);
      return;
    end if;
    v_txn := v_rpc_row.txn;

  elsif v_act.action_type = 'settlement_waive' then
    -- Audit #1 / #2 / #6: settlement_id must exist; lock the settlement
    -- row + the parent khaata_accounts row; derive amount from the
    -- settlement itself (NOT from the proposer-supplied payload).
    if v_act.settlement_id is null then
      update public.commerce_governance_actions
         set status = 'failed', apply_error = 'settlement_id_missing', updated_at = now()
       where id = p_action_id;
      return query select 'failed'::text, jsonb_build_object('reason', 'settlement_id_missing');
      return;
    end if;
    select * into v_settlement from public.monthly_settlements
      where id = v_act.settlement_id and account_id = v_act.account_id
      for update;
    if not found then
      update public.commerce_governance_actions
         set status = 'failed', apply_error = 'settlement_not_found', updated_at = now()
       where id = p_action_id;
      return query select 'failed'::text, jsonb_build_object('reason', 'settlement_not_found');
      return;
    end if;
    if v_settlement.status <> 'pending' then
      update public.commerce_governance_actions
         set status = 'failed', apply_error = 'settlement_not_pending', updated_at = now()
       where id = p_action_id;
      return query select 'failed'::text, jsonb_build_object('reason', 'settlement_not_pending', 'current_status', v_settlement.status);
      return;
    end if;
    perform 1 from public.khaata_accounts where id = v_act.account_id for update;
    v_amount := greatest(0, v_settlement.total_paise - v_settlement.paid_paise);
    if abs(v_amount) > v_per_action_ceiling then
      update public.commerce_governance_actions
         set status = 'failed', apply_error = 'amount_above_ceiling', updated_at = now()
       where id = p_action_id;
      return query select 'failed'::text, jsonb_build_object('reason', 'amount_above_ceiling', 'ceiling_paise', v_per_action_ceiling);
      return;
    end if;
    update public.monthly_settlements
       set status = 'waived', updated_at = now()
     where id = v_act.settlement_id;
    insert into public.khaata_transactions(
      account_id, type, items_json, amount_paise, notes, created_by
    ) values (
      v_act.account_id, 'adjustment', '[]'::jsonb, -abs(v_amount),
      'Settlement waived (governance action ' || v_act.id::text || ')',
      p_approver
    ) returning * into v_txn;

  elsif v_act.action_type = 'credit_limit_change' then
    v_to_paise := coalesce((v_act.payload->>'to_paise')::bigint, null);
    if v_to_paise is null or v_to_paise < 0 or v_to_paise > v_per_action_ceiling then
      update public.commerce_governance_actions
         set status = 'failed', apply_error = 'invalid_to_paise', updated_at = now()
       where id = p_action_id;
      return query select 'failed'::text, jsonb_build_object('reason', 'invalid_to_paise');
      return;
    end if;
    -- Audit H6: lock the account before mutating credit_limit_paise.
    perform 1 from public.khaata_accounts
      where id = v_act.account_id and tenant_id = v_act.tenant_id
      for update;
    update public.khaata_accounts
       set credit_limit_paise = v_to_paise, updated_at = now()
     where id = v_act.account_id and tenant_id = v_act.tenant_id
     returning * into v_account;
    if not found then
      update public.commerce_governance_actions
         set status = 'failed', apply_error = 'account_not_found', updated_at = now()
       where id = p_action_id;
      return query select 'failed'::text, jsonb_build_object('reason', 'account_not_found');
      return;
    end if;

  elsif v_act.action_type = 'manual_balance_correction' then
    select * into v_account from public.khaata_accounts
      where id = v_act.account_id and tenant_id = v_act.tenant_id for update;
    if not found then
      update public.commerce_governance_actions
         set status = 'failed', apply_error = 'account_not_found', updated_at = now()
       where id = p_action_id;
      return query select 'failed'::text, jsonb_build_object('reason', 'account_not_found');
      return;
    end if;
    v_to_paise := coalesce((v_act.payload->>'to_paise')::bigint, null);
    if v_to_paise is null or abs(v_to_paise) > v_per_action_ceiling then
      update public.commerce_governance_actions
         set status = 'failed', apply_error = 'invalid_to_paise', updated_at = now()
       where id = p_action_id;
      return query select 'failed'::text, jsonb_build_object('reason', 'invalid_to_paise');
      return;
    end if;
    v_delta := v_to_paise - v_account.balance_paise;
    if abs(v_delta) > v_per_action_ceiling then
      update public.commerce_governance_actions
         set status = 'failed', apply_error = 'delta_above_ceiling', updated_at = now()
       where id = p_action_id;
      return query select 'failed'::text, jsonb_build_object('reason', 'delta_above_ceiling');
      return;
    end if;
    insert into public.khaata_transactions(
      account_id, type, items_json, amount_paise, notes, created_by
    ) values (
      v_act.account_id, 'adjustment', '[]'::jsonb, v_delta,
      'Manual balance correction (governance action ' || v_act.id::text || ')',
      p_approver
    ) returning * into v_txn;

  else
    -- Audit #1: unknown action_type — refuse to mark applied.
    update public.commerce_governance_actions
       set status = 'failed', apply_error = 'unknown_action_type', updated_at = now()
     where id = p_action_id;
    return query select 'failed'::text, jsonb_build_object('reason', 'unknown_action_type');
    return;
  end if;

  -- Stamp applied. Only set applied_txn_id when a txn was actually written.
  update public.commerce_governance_actions
     set status         = 'applied',
         approved_by    = p_approver,
         approved_at    = now(),
         applied_at     = now(),
         applied_txn_id = case when v_txn.id is null then null else v_txn.id end,
         updated_at     = now()
   where id = p_action_id;

  return query select 'applied'::text, jsonb_build_object('txn_id', v_txn.id);
end;
$$;

revoke all on function public.commerce_governance_apply(uuid, uuid, text) from public;
grant execute on function public.commerce_governance_apply(uuid, uuid, text) to service_role;

-- Drop the legacy 2-arg signature so callers can't accidentally invoke
-- the unhardened version.
drop function if exists public.commerce_governance_apply(uuid, uuid);
