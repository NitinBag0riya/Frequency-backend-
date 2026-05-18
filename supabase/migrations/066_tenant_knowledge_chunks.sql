-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 066 — AI Responder: per-tenant knowledge base + opt-in settings
--
-- Background:
--   The existing `run_ai_responder` workflow node calls Anthropic with a
--   tenant-supplied system_prompt + the inbound message, but has no concept of
--   tenant-scoped knowledge or opt-in gating. That means:
--     - every tenant gets the same generic reply quality (no business context)
--     - any workflow with the node ENABLED auto-replies on day 0, even if the
--       tenant hasn't told us anything about their business (LLM hallucinates)
--     - past conversations are not learned from
--
--   This migration lands the schema half:
--     1) `tenant_ai_settings` — opt-in row per tenant (disabled by default).
--        Wizard completion is REQUIRED before `enabled` can flip to true.
--     2) `tenant_knowledge_chunks` — the RAG corpus, strictly scoped by
--        tenant_id with RLS. One tenant's chunk can NEVER be retrieved by
--        another. Service-role queries in the API handler ALSO filter
--        explicitly by tenant_id (defence in depth — service-role bypasses
--        RLS, so the filter is the actual contract).
--
--   The runtime half lives in:
--     - src/lib/ai-knowledge.ts        — retrieve / store / embed helpers
--     - src/routes/ai-responder.ts     — /api/ai/{settings,knowledge,qa-wizard,test}
--     - src/engine/executor.ts         — `run_ai_responder` retrieves chunks
--       before the Anthropic call + writes the (question, answer) pair back
--       into the corpus afterward (source_type='conversation')
--
-- pgvector vs full-text:
--   pgvector is NOT currently enabled on the Supabase project (no prior
--   migration calls `create extension vector`). Enabling it requires the
--   Supabase dashboard toggle which is operator-only on the prod project.
--
--   To stay self-contained, this migration uses Postgres' built-in tsvector
--   + GIN index for retrieval. The retrieval helper in lib/ai-knowledge.ts
--   uses websearch_to_tsquery() ranking which is good enough for tenant
--   corpora in the 10–10,000 chunk range (typical SMB tenant).
--
--   The `embedding bytea` column is added now (nullable) so that when
--   pgvector is enabled later we can:
--     1) `create extension if not exists vector`
--     2) `alter table tenant_knowledge_chunks add column embedding_v vector(1536)`
--     3) backfill from existing embedding bytea (if any populated)
--     4) drop embedding bytea
--   See lib/ai-knowledge.ts:retrieveChunks for the swap-in point.
--
-- Idempotent — every CREATE / INSERT uses IF NOT EXISTS or ON CONFLICT so the
-- migration is safe to re-run.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── 1. tenant_ai_settings — opt-in + business context ──────────────────────
-- One row per tenant. Default disabled. The qa_wizard_completed_at gate is
-- the second layer of "don't reply until we know who we're replying for":
-- without business context the LLM hallucinates company facts (hours, prices,
-- services), which is a brand-safety incident waiting to happen.
--
-- escalate_to_human_on_uncertainty: when the AI's response signals it doesn't
-- know (we detect via keyword markers in the response), we route to the
-- existing notify_human flow rather than send a low-confidence answer.

create table if not exists public.tenant_ai_settings (
  tenant_id                          uuid primary key references public.tenants(id) on delete cascade,
  enabled                            boolean not null default false,
  qa_wizard_completed_at             timestamptz null,
  model                              text not null default 'claude-opus-4-7',
  system_prompt_addon                text null,
  max_tokens                         int  not null default 500  check (max_tokens between 50 and 4000),
  temperature                        real not null default 0.7  check (temperature between 0 and 1),
  escalate_to_human_on_uncertainty   boolean not null default true,
  business_context                   jsonb not null default '{}'::jsonb,
  created_at                         timestamptz not null default now(),
  updated_at                         timestamptz not null default now(),

  -- Hard guarantee: enabled=true REQUIRES qa_wizard_completed_at. Schema-level
  -- check beats relying on the API handler alone — a future migration or
  -- direct SQL update can't accidentally bypass the wizard gate.
  constraint tais_wizard_required_when_enabled
    check (enabled = false or qa_wizard_completed_at is not null)
);

alter table public.tenant_ai_settings enable row level security;

drop policy if exists "tais_tenant_read"  on public.tenant_ai_settings;
drop policy if exists "tais_no_direct_write" on public.tenant_ai_settings;

-- Tenant members read their own settings (UI display). Writes go through
-- the service-role API path — never direct PostgREST writes — so we reject
-- those at the policy layer too.
create policy "tais_tenant_read"
  on public.tenant_ai_settings
  for select
  using (
    tenant_id in (
      select tenant_id from public.user_role_assignments
      where user_id = auth.uid() and disabled_at is null
    )
    or exists (
      select 1 from public.tenants t
      where t.id = tenant_id and t.user_id = auth.uid()
    )
  );

create policy "tais_no_direct_write"
  on public.tenant_ai_settings
  for all
  using (false)
  with check (false);

-- updated_at trigger so PATCH /api/ai/settings doesn't have to remember to
-- bump it (lib pattern from other tables in this project).
create or replace function public.tenant_ai_settings_touch()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

drop trigger if exists tenant_ai_settings_touch on public.tenant_ai_settings;
create trigger tenant_ai_settings_touch
  before update on public.tenant_ai_settings
  for each row execute function public.tenant_ai_settings_touch();

-- ── 2. tenant_knowledge_chunks — the RAG corpus ────────────────────────────
-- source_type values:
--   qa_wizard    — seeded from the QA wizard answers; high trust
--   conversation — past message threads (auto-learned); medium trust
--   manual       — admin-added via /api/ai/knowledge POST
--   wa_profile   — WhatsApp Business profile (about, address, etc.)
--   product      — product/catalog rows
--
-- source_ref is the upstream id (conversation_id, product_id, …) so we can
-- de-duplicate when re-syncing and trace provenance from chat to chunk.
--
-- chunk_text capped at 8000 chars at the application layer (lib/ai-knowledge.ts)
-- to keep retrieval bodies under Anthropic's context budget at fanout=5.
-- No DB-level CHECK so future migrations can lift the cap without a
-- table rewrite.

create table if not exists public.tenant_knowledge_chunks (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references public.tenants(id) on delete cascade,
  source_type  text not null check (source_type in ('qa_wizard','conversation','manual','wa_profile','product')),
  source_ref   text null,
  chunk_text   text not null,
  -- Embedding storage: bytea now (placeholder), swap to vector(1536) when
  -- pgvector is enabled. nullable so the tsvector path can write without
  -- ever populating embeddings.
  embedding    bytea null,
  -- Generated tsvector — the full-text retrieval primary key. STORED so the
  -- GIN index lookup never re-tokenises. `english` config is the right
  -- default for SMB tenants in en-* locales; future per-tenant locale
  -- can store a separate column.
  search_tsv   tsvector generated always as (to_tsvector('english', coalesce(chunk_text, ''))) stored,
  metadata     jsonb not null default '{}'::jsonb,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

alter table public.tenant_knowledge_chunks enable row level security;

drop policy if exists "tkc_tenant_read"  on public.tenant_knowledge_chunks;
drop policy if exists "tkc_no_direct_write" on public.tenant_knowledge_chunks;

-- Same shape as tenant_ai_settings — tenant members read, writes only via
-- service-role API path. The API handler ADDITIONALLY filters by
-- tenant_id explicitly on every query (defence in depth).
create policy "tkc_tenant_read"
  on public.tenant_knowledge_chunks
  for select
  using (
    tenant_id in (
      select tenant_id from public.user_role_assignments
      where user_id = auth.uid() and disabled_at is null
    )
    or exists (
      select 1 from public.tenants t
      where t.id = tenant_id and t.user_id = auth.uid()
    )
  );

create policy "tkc_no_direct_write"
  on public.tenant_knowledge_chunks
  for all
  using (false)
  with check (false);

-- ── 3. Indexes ──────────────────────────────────────────────────────────────
-- Full-text retrieval — the hot path. Always combined with tenant_id =
-- in the application layer, so a composite is overkill — Postgres planner
-- prefers GIN on tsvector + bitmap-and with the tenant filter index.
create index if not exists tkc_search_tsv
  on public.tenant_knowledge_chunks using gin(search_tsv);

-- Tenant scoping — every query filters by tenant_id first. The
-- (tenant_id, created_at desc) shape covers the list+paginate endpoint
-- and the tsvector retrieval pre-filter.
create index if not exists tkc_tenant_recent
  on public.tenant_knowledge_chunks(tenant_id, created_at desc);

-- Provenance / dedup: when re-syncing the same conversation we want to
-- find existing chunks for that (tenant, source_type, source_ref) tuple
-- and update in place rather than appending duplicates.
create index if not exists tkc_tenant_source
  on public.tenant_knowledge_chunks(tenant_id, source_type, source_ref)
  where source_ref is not null;

create or replace function public.tenant_knowledge_chunks_touch()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

drop trigger if exists tenant_knowledge_chunks_touch on public.tenant_knowledge_chunks;
create trigger tenant_knowledge_chunks_touch
  before update on public.tenant_knowledge_chunks
  for each row execute function public.tenant_knowledge_chunks_touch();

-- ── 4. Comments ─────────────────────────────────────────────────────────────
comment on table public.tenant_ai_settings is
  'AI Responder opt-in + per-tenant configuration. enabled=true requires '
  'qa_wizard_completed_at IS NOT NULL (schema CHECK enforces this) so the '
  'LLM never auto-replies for a tenant whose business context we have not '
  'collected.';

comment on table public.tenant_knowledge_chunks is
  'Per-tenant RAG corpus for the AI Responder. STRICTLY tenant-isolated: '
  'RLS allows reads only to same-tenant members; service-role API queries '
  'ADDITIONALLY filter by tenant_id explicitly so cross-tenant retrieval '
  'is impossible even via service-role bypass.';

comment on column public.tenant_knowledge_chunks.embedding is
  'Reserved for pgvector. nullable bytea today; swap to vector(1536) once '
  '`create extension vector` is enabled on the project. The tsvector + GIN '
  'index in search_tsv is the active retrieval path until then.';

comment on column public.tenant_knowledge_chunks.source_type is
  'Provenance: qa_wizard | conversation | manual | wa_profile | product. '
  'Used by /api/ai/knowledge filters and by recency-weighted ranking '
  '(qa_wizard chunks are highest trust, conversation chunks decay).';
