-- 099_phase4_v11_followups
--
-- v1.1 audit follow-ups for Phase 4 (SLA / AI Agent / Commerce / PII).
-- Strictly additive — no destructive changes.
--
-- Touches:
--
-- 1. commerce_post_transaction RPC — push the adjustment magnitude clamp
--    into the DB so direct service-role callers can't bypass the route's
--    ±₹50,000 guardrail. Now enforced in BOTH the route AND the RPC.
--
-- 2. pii_masking_config — new `outbound_action` column (off | warn | block).
--    Drives the new outbound PII check in /api/inbox/send: when set to
--    'block' we 400 the request if the outbound text contains any enabled
--    PII type; 'warn' returns the send result with a `pii_warning` payload
--    so the FE can chip the message; 'off' is the legacy behaviour.
--    Default 'warn' — safe for existing tenants (they'll see chips, but
--    no sends will break).
--
-- 3. kb_chunks — `embedding` column got created in 096 as vector(1536).
--    Add a HNSW vector-cosine index (096 already declared a placeholder
--    btree, this migration upgrades to the proper ANN index that the new
--    embeddings worker queries via match_kb_chunks).
--
-- 4. `match_kb_chunks` RPC — the AI Agent /test endpoint now uses this
--    when the tenant has embeddings populated. Keyword fallback stays
--    intact when no embedding rows exist or no embed key is configured.

set check_function_bodies = off;

-- ─── 1. Adjustment clamp inside commerce_post_transaction ────────────────

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
  v_clamp   bigint := 5000000; -- ₹50,000 in paise; mirrors route-layer
begin
  -- Normalise sign convention per type.
  if p_type = 'order' then
    v_amt := abs(p_amount_paise);
  elsif p_type in ('settlement', 'refund') then
    v_amt := -abs(p_amount_paise);
  elsif p_type = 'adjustment' then
    -- Reject magnitudes above the clamp at the DB layer. Defence in
    -- depth — the route already enforces this, but a direct
    -- service-role call must also be blocked.
    if abs(p_amount_paise) > v_clamp then
      return query select
        'adjustment_amount_too_large'::text,
        jsonb_build_object('clamp_paise', v_clamp),
        null::public.khaata_transactions;
      return;
    end if;
    v_amt := p_amount_paise;
  else
    v_amt := p_amount_paise;
  end if;

  select * into v_account
    from public.khaata_accounts
   where id = p_account_id and tenant_id = p_tenant_id
   for update;
  if not found then
    return query select 'not_found'::text, '{}'::jsonb, null::public.khaata_transactions;
    return;
  end if;

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

-- ─── 2. PII outbound_action ──────────────────────────────────────────────

alter table public.pii_masking_config
  add column if not exists outbound_action text
  not null default 'warn'
  check (outbound_action in ('off', 'warn', 'block'));

comment on column public.pii_masking_config.outbound_action is
  'Drives /api/inbox/send: off=skip check; warn=allow send but include detected-field metadata in response; block=400 the send when any enabled PII type matches the outbound text.';

-- ─── 3. HNSW index for vector retrieval ──────────────────────────────────
-- Idempotent: if 096 already created an HNSW index, skip. Otherwise
-- create with sane defaults (m=16, ef_construction=64). We use cosine
-- distance because the embedding model (Voyage voyage-3) is normalised.

do $$
begin
  if not exists (
    select 1 from pg_indexes
     where schemaname = 'public'
       and tablename  = 'kb_chunks'
       and indexname  = 'idx_kb_chunks_embedding_hnsw'
  ) then
    create index idx_kb_chunks_embedding_hnsw
      on public.kb_chunks using hnsw (embedding vector_cosine_ops)
      with (m = 16, ef_construction = 64);
  end if;
end $$;

-- ─── 4. match_kb_chunks vector RPC ───────────────────────────────────────
-- Takes a query embedding + a kb_id + top-k. Returns ranked chunks
-- with cosine similarity (1 - cosine_distance). Used by the AI Agent
-- /test endpoint when embeddings are populated.

create or replace function public.match_kb_chunks(
  p_kb_id       uuid,
  p_embedding   vector(1536),
  p_match_count int default 5
) returns table (
  id         uuid,
  source_id  uuid,
  text       text,
  tags       text[],
  similarity float
) language sql stable security definer set search_path = public, pg_catalog as $$
  select c.id,
         c.source_id,
         c.text,
         c.tags,
         (1 - (c.embedding <=> p_embedding))::float as similarity
    from public.kb_chunks c
   where c.kb_id = p_kb_id
     and c.embedding is not null
   order by c.embedding <=> p_embedding
   limit greatest(1, least(p_match_count, 50));
$$;

revoke all on function public.match_kb_chunks(uuid, vector(1536), int) from public;
grant execute on function public.match_kb_chunks(uuid, vector(1536), int) to service_role;
