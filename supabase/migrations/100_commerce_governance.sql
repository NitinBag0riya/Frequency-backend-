-- 100_commerce_governance
--
-- Two-person approval workflow for sensitive money operations.
--
-- Why this exists:
--   - Refunds, large adjustments, settlement waivers, and credit-limit
--     increases are irreversible operations that can hide insider abuse.
--   - The v1 commerce surface guarded the worst case (route + RPC
--     clamps; append-only RLS; Razorpay verification) but a malicious
--     or careless operator with permissions could still:
--       * issue a refund that doesn't match a real payment
--       * waive a customer's outstanding balance to zero
--       * lift a customer's credit limit past safe bounds
--       * correct a balance "by hand" without an offsetting reason
--   - Two-person approval (proposer ≠ approver) is the standard control.
--     We make it a first-class object in the schema so the FE shows
--     pending actions explicitly, the audit story is queryable, and
--     thresholds can be tuned per tenant in v1.3.
--
-- ─── What this migration creates ──────────────────────────────────────────
--
-- 1. commerce_governance_actions — one row per proposed sensitive op.
--    Status lifecycle: pending → (approved + applied) | rejected | expired.
--    Mutations to khaata_transactions / khaata_accounts driven by an
--    approval are stamped with the action_id so audit can reconstruct
--    "which approval led to which ledger row".
--
-- 2. commerce_governance_thresholds — per-tenant override table. v1.2
--    ships with reasonable defaults baked into the route handlers;
--    this table reserves the shape so tenant admins can tighten in
--    v1.3 without a schema migration.
--
-- 3. commerce_governance_apply RPC — service-role-only function that
--    runs inside a transaction: re-checks state, dispatches to the
--    appropriate underlying mutation (refund → khaata_transactions
--    insert; settlement_waive → khaata_accounts balance write +
--    monthly_settlements status='waived'; etc.), and stamps the
--    governance row as applied. All-or-nothing.

set check_function_bodies = off;

-- ─── 1. commerce_governance_actions ──────────────────────────────────────

create table if not exists public.commerce_governance_actions (
  id                  uuid primary key default gen_random_uuid(),
  tenant_id           uuid not null references public.tenants(id) on delete cascade,

  -- What action is being proposed.
  --   refund               — credit money back to customer + balance -= amount
  --   adjustment_large     — admin correction above the auto-clamp (>₹10k)
  --   settlement_waive     — writing off a customer's outstanding balance
  --   credit_limit_change  — increase/decrease credit_limit_paise
  --   manual_balance_correction — direct balance write with a written reason
  action_type         text not null check (action_type in (
    'refund', 'adjustment_large', 'settlement_waive',
    'credit_limit_change', 'manual_balance_correction'
  )),

  -- Target. Either an account (most actions) or a settlement (waiver).
  account_id          uuid references public.khaata_accounts(id)    on delete set null,
  settlement_id      uuid references public.monthly_settlements(id) on delete set null,

  -- Audit triple.
  proposed_by         uuid not null references auth.users(id) on delete set null,
  approved_by         uuid          references auth.users(id) on delete set null,
  rejected_by         uuid          references auth.users(id) on delete set null,

  -- A human-readable rationale is REQUIRED on every proposal. Without
  -- it the audit story is hollow.
  reason              text not null check (length(reason) between 4 and 500),
  rejection_reason    text check (rejection_reason is null or length(rejection_reason) between 4 and 500),

  -- Action-specific payload. Shape varies; documented per action_type:
  --   refund:                    { amount_paise, razorpay_payment_id?, notes? }
  --   adjustment_large:          { amount_paise (signed), notes? }
  --   settlement_waive:          { settlement_id, amount_paise }
  --   credit_limit_change:       { from_paise, to_paise }
  --   manual_balance_correction: { from_paise, to_paise, notes? }
  payload             jsonb not null default '{}'::jsonb,

  -- Convenience scalar for dashboards & threshold checks.
  amount_paise        bigint,

  -- Lifecycle.
  status              text not null default 'pending' check (status in (
    'pending', 'approved', 'rejected', 'applied', 'expired', 'failed'
  )),
  applied_txn_id      uuid references public.khaata_transactions(id) on delete set null,
  apply_error         text,           -- when status='failed', the underlying reason

  -- Auto-expire pending proposals after this many days so the dashboard
  -- doesn't accumulate stale "should we…?" rows from operators who
  -- forgot to follow up.
  expires_at          timestamptz not null default (now() + interval '7 days'),
  approved_at         timestamptz,
  rejected_at         timestamptz,
  applied_at          timestamptz,

  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create index if not exists idx_governance_tenant_status
  on public.commerce_governance_actions(tenant_id, status, created_at desc);

create index if not exists idx_governance_account
  on public.commerce_governance_actions(account_id, created_at desc)
  where account_id is not null;

create index if not exists idx_governance_expires_pending
  on public.commerce_governance_actions(expires_at)
  where status = 'pending';

comment on table public.commerce_governance_actions is
  'Two-person-approval workflow for sensitive commerce mutations (refunds, large adjustments, settlement waivers, credit-limit changes, manual balance corrections). Approver must differ from proposer. Append-only intent — INSERT/UPDATE flow through the BE service-role; authenticated members read only.';

-- ─── 2. commerce_governance_thresholds (per-tenant) ─────────────────────
-- Reserved shape for v1.3 per-tenant tuning. Defaults are enforced at
-- route layer until any tenant overrides them here.

create table if not exists public.commerce_governance_thresholds (
  tenant_id                      uuid primary key references public.tenants(id) on delete cascade,
  -- All amount thresholds in paise. -1 = "always require governance".
  refund_auto_below_paise        bigint not null default 0,   -- 0 = refunds ALWAYS need governance
  adjustment_auto_below_paise    bigint not null default 1000000, -- ₹10,000
  credit_limit_auto_below_paise  bigint not null default 10000000, -- ₹1,00,000
  -- Two-person rule: when true, approver MUST differ from proposer.
  two_person_required            boolean not null default true,
  created_at                     timestamptz not null default now(),
  updated_at                     timestamptz not null default now()
);

-- ─── RLS ──────────────────────────────────────────────────────────────────

alter table public.commerce_governance_actions    enable row level security;
alter table public.commerce_governance_thresholds enable row level security;

drop policy if exists "governance_actions_tenant_r" on public.commerce_governance_actions;
create policy "governance_actions_tenant_r" on public.commerce_governance_actions for select to authenticated
  using (
    tenant_id in (
      select tenant_id from public.user_role_assignments where user_id = auth.uid()
      union
      select tenant_id from public.user_roles where user_id = auth.uid()
    )
  );

-- Writes go through service-role only. Defence in depth + append-only intent.
revoke insert, update, delete on public.commerce_governance_actions from authenticated;

drop policy if exists "governance_thresholds_tenant_r" on public.commerce_governance_thresholds;
create policy "governance_thresholds_tenant_r" on public.commerce_governance_thresholds for select to authenticated
  using (
    tenant_id in (
      select tenant_id from public.user_role_assignments where user_id = auth.uid()
      union
      select tenant_id from public.user_roles where user_id = auth.uid()
    )
  );

revoke insert, update, delete on public.commerce_governance_thresholds from authenticated;

-- ─── 3. commerce_governance_apply RPC ───────────────────────────────────
-- Approve-and-apply. Service-role only. Caller passes the action id +
-- the user id who is approving. The function:
--   1. Re-loads the action row inside a transaction.
--   2. Verifies status='pending', not expired, approver ≠ proposer
--      (unless thresholds.two_person_required = false).
--   3. Dispatches to the per-action-type mutation:
--        - refund / adjustment_large → khaata_transactions insert via
--          commerce_post_transaction (gets the credit-limit + clamp
--          gates for free, plus the existing balance trigger)
--        - settlement_waive → monthly_settlements.status='waived' +
--          a paired khaata_transactions(type='adjustment') zeroing
--          the corresponding portion of the balance
--        - credit_limit_change → khaata_accounts.credit_limit_paise
--          UPDATE (no balance side-effect)
--        - manual_balance_correction → khaata_transactions(type=
--          'adjustment') with the signed delta needed to reach
--          payload.to_paise from the current balance_paise
--   4. Stamps the action row to status='applied' + applied_txn_id.
-- Returns the resulting status string + (if applied) the txn row.

create or replace function public.commerce_governance_apply(
  p_action_id  uuid,
  p_approver   uuid
) returns table (
  status text,
  detail jsonb
) language plpgsql security definer set search_path = public, pg_catalog as $$
declare
  v_act       public.commerce_governance_actions%rowtype;
  v_thr       public.commerce_governance_thresholds%rowtype;
  v_two_person boolean := true;
  v_amount    bigint;
  v_account   public.khaata_accounts%rowtype;
  v_txn       public.khaata_transactions%rowtype;
  v_rpc_row   record;
  v_to_paise  bigint;
  v_delta     bigint;
begin
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

  -- Two-person rule check.
  select * into v_thr from public.commerce_governance_thresholds
    where tenant_id = v_act.tenant_id;
  if found then v_two_person := v_thr.two_person_required; end if;
  if v_two_person and v_act.proposed_by = p_approver then
    return query select 'cannot_approve_own'::text, '{}'::jsonb;
    return;
  end if;

  -- Dispatch.
  if v_act.action_type in ('refund', 'adjustment_large') then
    -- These flow through khaata_transactions. We reuse the existing RPC
    -- for credit-limit + balance bookkeeping consistency.
    v_amount := coalesce(v_act.amount_paise, (v_act.payload->>'amount_paise')::bigint);
    if v_amount is null then
      update public.commerce_governance_actions
         set status = 'failed', apply_error = 'amount_paise missing in payload', updated_at = now()
       where id = p_action_id;
      return query select 'failed'::text, jsonb_build_object('reason', 'amount_paise missing');
      return;
    end if;
    select * into v_rpc_row from public.commerce_post_transaction(
      v_act.tenant_id,
      v_act.account_id,
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
    -- Mark the settlement as waived AND zero the balance for that period.
    -- We trust the payload's amount_paise as the writeoff value.
    v_amount := coalesce(v_act.amount_paise, (v_act.payload->>'amount_paise')::bigint, 0);
    update public.monthly_settlements
       set status = 'waived', updated_at = now()
     where id = v_act.settlement_id and account_id = v_act.account_id;
    -- Drop a balancing adjustment so the running balance reflects the
    -- waiver. -amount drives balance down by the waived sum.
    insert into public.khaata_transactions(
      account_id, type, items_json, amount_paise, notes, created_by
    ) values (
      v_act.account_id, 'adjustment', '[]'::jsonb, -abs(v_amount),
      'Settlement waived (governance action ' || v_act.id::text || '): ' || v_act.reason,
      p_approver
    ) returning * into v_txn;

  elsif v_act.action_type = 'credit_limit_change' then
    v_to_paise := coalesce((v_act.payload->>'to_paise')::bigint, 0);
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
    -- Compute the delta needed to land balance_paise at to_paise.
    select * into v_account from public.khaata_accounts
      where id = v_act.account_id and tenant_id = v_act.tenant_id for update;
    if not found then
      update public.commerce_governance_actions
         set status = 'failed', apply_error = 'account_not_found', updated_at = now()
       where id = p_action_id;
      return query select 'failed'::text, jsonb_build_object('reason', 'account_not_found');
      return;
    end if;
    v_to_paise := coalesce((v_act.payload->>'to_paise')::bigint, v_account.balance_paise);
    v_delta := v_to_paise - v_account.balance_paise;
    insert into public.khaata_transactions(
      account_id, type, items_json, amount_paise, notes, created_by
    ) values (
      v_act.account_id, 'adjustment', '[]'::jsonb, v_delta,
      'Manual balance correction (governance action ' || v_act.id::text || '): ' || v_act.reason,
      p_approver
    ) returning * into v_txn;
  end if;

  -- Stamp the action row applied.
  update public.commerce_governance_actions
     set status         = 'applied',
         approved_by    = p_approver,
         approved_at    = now(),
         applied_at     = now(),
         applied_txn_id = v_txn.id,
         updated_at     = now()
   where id = p_action_id;

  return query select 'applied'::text, jsonb_build_object('txn_id', v_txn.id);
end;
$$;

revoke all on function public.commerce_governance_apply(uuid, uuid) from public;
grant execute on function public.commerce_governance_apply(uuid, uuid) to service_role;

-- ─── Janitor: expire stale pending actions ───────────────────────────────
-- Called by the cron worker via supabase rpc on a 1-hour cadence. Idempotent.

create or replace function public.commerce_governance_expire_stale()
returns int language sql security definer set search_path = public, pg_catalog as $$
  with expired as (
    update public.commerce_governance_actions
       set status = 'expired', updated_at = now()
     where status = 'pending' and expires_at < now()
     returning id
  )
  select count(*)::int from expired;
$$;

revoke all on function public.commerce_governance_expire_stale() from public;
grant execute on function public.commerce_governance_expire_stale() to service_role;
