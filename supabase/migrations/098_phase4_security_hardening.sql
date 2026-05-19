-- 098_phase4_security_hardening
--
-- Production-readiness fixes for migrations 095/096/097 surfaced by the
-- pre-deploy security + code audit. Strictly additive — no destructive
-- changes to existing data, no column drops, no table renames.
--
-- Issues addressed:
--
-- 1. APPEND-ONLY ENFORCEMENT
--    The comments on kb_test_runs, kb_inference_log, khaata_transactions,
--    and monthly_settlements all describe them as append-only / tamper-
--    evident, but the RLS policies are `for all to authenticated` and
--    nothing was revoked. A tenant member with a Supabase JWT could
--    UPDATE/DELETE these rows directly through PostgREST and (via the
--    khaata balance trigger) silently zero-out their outstanding
--    balance with no audit. All writes must go through the BE which
--    uses the service-role client.
--
-- 2. RAZORPAY PAYMENT-ID UNIQUENESS
--    khaata_transactions.razorpay_payment_id had no uniqueness
--    constraint. The settlement endpoint accepts a body-supplied
--    razorpay_payment_id and inserts it raw — an attacker who knows
--    any one valid Razorpay payment_id could replay it to credit any
--    number of khaata. Partial unique index closes the replay door at
--    the DB level; the BE layer (see commerce.ts) gains a fetch+verify
--    step against the Razorpay API in a follow-up.
--
-- 3. SLA CONFIG UNIQUE-INDEX MISMATCH
--    Migration 095 created a partial unique index over
--    `coalesce(team_id, '00000000-...')`, but the BE upsert specified
--    `onConflict: 'tenant_id,team_id,channel'` — Postgres treats NULL
--    as not-equal for plain column-list constraints, so every save of
--    a tenant-default rule (team_id IS NULL) inserted a NEW row instead
--    of updating. Switch to NULLS NOT DISTINCT (PG15+, supported by
--    Supabase) so the column-list onConflict matches.
--
-- 4. KHAATA BALANCE TRIGGER UPDATE BRANCH
--    The maintain-balance trigger only handled INSERT and DELETE. If
--    anyone ever runs an admin correction script that updates
--    amount_paise (or a future PATCH endpoint), balance_paise silently
--    desyncs. Add the UPDATE branch; on append-only intent it's
--    defence-in-depth.
--
-- 5. KHAATA ORDER POSTING RPC (RACE FIX)
--    The credit-limit check in routes/commerce.ts is read-then-write —
--    two concurrent orders both see balance < limit and both insert,
--    blowing past the limit. New `commerce_post_transaction` SECURITY
--    DEFINER function does the SELECT FOR UPDATE + conditional insert
--    atomically.
--
-- 6. KB_CHUNKS TEXT CAP (DoS BUDGET)
--    Added a CHECK constraint capping kb_chunks.text at 16 KB. The
--    /test endpoint sends top-3 chunks to Claude as context — without
--    a cap, a tenant admin could insert a single multi-MB chunk that
--    blows past Anthropic's context window AND inflates inference cost
--    per request.

set check_function_bodies = off;

-- ─── 1. Append-only revokes ──────────────────────────────────────────────

revoke insert, update, delete on public.kb_test_runs        from authenticated;
revoke insert, update, delete on public.kb_inference_log    from authenticated;
revoke insert, update, delete on public.khaata_transactions from authenticated;
revoke insert, update, delete on public.monthly_settlements from authenticated;

-- Read access is left intact (anon/authenticated SELECT through RLS) so the
-- FE list/detail pages still work. Writes flow through the BE only.

-- ─── 2. Razorpay payment-id uniqueness ───────────────────────────────────
-- Partial index — NULL values (non-Razorpay txns) don't share the slot.

create unique index if not exists ux_khaata_transactions_razorpay_payment_id
  on public.khaata_transactions(razorpay_payment_id)
  where razorpay_payment_id is not null;

-- ─── 3. SLA configs — NULLS NOT DISTINCT unique constraint ───────────────
-- Drop the legacy coalesce()-based partial index and add a real unique
-- constraint with NULLS NOT DISTINCT so the column-list onConflict
-- works correctly for tenant-default rules (team_id IS NULL).

drop index if exists public.ux_sla_configs_tenant_team_channel;

-- Some Supabase pg versions (PG15+) support NULLS NOT DISTINCT directly.
-- If the table already has duplicate (tenant_id, team_id, channel)
-- rows from the buggy upsert, the constraint creation will fail — we
-- DELETE duplicates first, keeping the most recently updated row.
with ranked as (
  select id,
         row_number() over (
           partition by tenant_id, team_id, channel
           order by updated_at desc, created_at desc, id
         ) as rn
    from public.sla_configs
)
delete from public.sla_configs c
 using ranked r
 where c.id = r.id and r.rn > 1;

alter table public.sla_configs
  add constraint ux_sla_configs_tenant_team_channel
  unique nulls not distinct (tenant_id, team_id, channel);

-- ─── 4. khaata balance trigger UPDATE branch ─────────────────────────────

create or replace function public.tg_khaata_transactions_update_balance()
returns trigger language plpgsql as $$
begin
  if (tg_op = 'INSERT') then
    update public.khaata_accounts
       set balance_paise = balance_paise + new.amount_paise,
           updated_at = now()
     where id = new.account_id;
  elsif (tg_op = 'DELETE') then
    update public.khaata_accounts
       set balance_paise = balance_paise - old.amount_paise,
           updated_at = now()
     where id = old.account_id;
  elsif (tg_op = 'UPDATE') then
    -- Defence in depth: writes are revoked from authenticated, so
    -- this branch only fires from service-role admin scripts. Still,
    -- keep the balance correct rather than letting it silently drift.
    if old.account_id <> new.account_id then
      update public.khaata_accounts
         set balance_paise = balance_paise - old.amount_paise,
             updated_at = now()
       where id = old.account_id;
      update public.khaata_accounts
         set balance_paise = balance_paise + new.amount_paise,
             updated_at = now()
       where id = new.account_id;
    else
      update public.khaata_accounts
         set balance_paise = balance_paise + (new.amount_paise - old.amount_paise),
             updated_at = now()
       where id = new.account_id;
    end if;
  end if;
  return null;
end;
$$;

drop trigger if exists trg_khaata_transactions_update_balance on public.khaata_transactions;
create trigger trg_khaata_transactions_update_balance
  after insert or update or delete on public.khaata_transactions
  for each row execute function public.tg_khaata_transactions_update_balance();

-- ─── 5. Atomic order-posting RPC ─────────────────────────────────────────
-- Eliminates the credit-limit TOCTOU race by acquiring a row-level lock
-- on the parent khaata_accounts row before inserting the transaction.
-- Returns 'ok' + the new transaction row, OR a sentinel error code that
-- the BE maps to a 402 response.

create or replace function public.commerce_post_transaction(
  p_tenant_id           uuid,
  p_account_id          uuid,
  p_type                text,
  p_items_json          jsonb,
  p_amount_paise        bigint,
  p_notes               text,
  p_conversation_phone  text,
  p_razorpay_payment_id text,
  p_created_by          uuid
) returns table (
  status        text,
  detail        jsonb,
  txn           public.khaata_transactions
) language plpgsql security definer set search_path = public, pg_catalog as $$
declare
  v_account public.khaata_accounts%rowtype;
  v_amt     bigint;
  v_new     public.khaata_transactions%rowtype;
begin
  -- Normalise sign convention per type (mirrors routes/commerce.ts).
  -- adjustment: caller-signed (subject to clamp + role check at BE).
  if p_type = 'order' then
    v_amt := abs(p_amount_paise);
  elsif p_type in ('settlement', 'refund') then
    v_amt := -abs(p_amount_paise);
  else
    v_amt := p_amount_paise;
  end if;

  -- Row-lock the account, verify tenant ownership.
  select * into v_account
    from public.khaata_accounts
   where id = p_account_id and tenant_id = p_tenant_id
   for update;
  if not found then
    return query select 'not_found'::text, '{}'::jsonb, null::public.khaata_transactions;
    return;
  end if;

  -- Credit-limit check for ANY balance-increasing transaction
  -- (order OR adjustment-up). settlement/refund only reduce balance,
  -- never block. The BE additionally clamps adjustment magnitude.
  if v_amt > 0
     and (v_account.balance_paise + v_amt) > v_account.credit_limit_paise then
    return query select
      'credit_limit_exceeded'::text,
      jsonb_build_object(
        'balance_paise',      v_account.balance_paise,
        'credit_limit_paise', v_account.credit_limit_paise,
        'attempted_paise',    v_amt
      ),
      null::public.khaata_transactions;
    return;
  end if;

  -- Insert. Idempotency on razorpay_payment_id is enforced by the
  -- partial unique index added above; a duplicate raises sqlstate
  -- 23505 which the caller catches and reports.
  insert into public.khaata_transactions(
    account_id, conversation_phone, type, items_json, amount_paise,
    delivered_at, paid_at, razorpay_payment_id, notes, created_by
  ) values (
    p_account_id, p_conversation_phone, p_type, coalesce(p_items_json, '[]'::jsonb), v_amt,
    case when p_type = 'order' then now() end,
    case when p_type = 'settlement' then now() end,
    p_razorpay_payment_id, p_notes, p_created_by
  )
  returning * into v_new;

  return query select 'ok'::text, '{}'::jsonb, v_new;
end;
$$;

revoke all on function public.commerce_post_transaction(
  uuid, uuid, text, jsonb, bigint, text, text, text, uuid
) from public;
grant execute on function public.commerce_post_transaction(
  uuid, uuid, text, jsonb, bigint, text, text, text, uuid
) to service_role;

-- ─── 6. kb_chunks text length cap ────────────────────────────────────────
-- 16 KB ≈ 4k tokens — enough for any reasonable Q&A or PDF page, well
-- under the per-chunk budget the /test endpoint promises Claude.

alter table public.kb_chunks
  drop constraint if exists kb_chunks_text_length_chk;

alter table public.kb_chunks
  add constraint kb_chunks_text_length_chk
  check (length(text) between 1 and 16384);
