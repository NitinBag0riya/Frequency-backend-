-- 096_ai_knowledge_base
--
-- Phase 2 of the post-deploy roadmap. Per-tenant AI knowledge base
-- backing the simple 3-step "Teach → Test → Turn on" agent UX
-- (docs/ROADMAP.md §4 Phase 2).
--
-- ─── Schema ───────────────────────────────────────────────────────────────
--
-- Five tables, intentionally lean:
--
-- 1. knowledge_bases — one per tenant (could be many later; v1 = single)
-- 2. kb_sources — uploaded PDF / URL / manual Q&A. Each source produces
--                  N chunks via the ingest worker. status tracks ingest.
-- 3. kb_chunks — text + embedding. pgvector for cosine search.
-- 4. kb_test_runs — playground transcripts. Powers regression testing
--                    AND the agent's "edit/improve" loop (👎 → adds a fix).
-- 5. kb_inference_log — per-conversation use. Anchored to message_id so
--                       analytics can compute "how often did the AI
--                       actually fire?" + "thumbs-down rate per chunk".
--
-- ─── Vector dimension ────────────────────────────────────────────────────
--
-- 1536 to match OpenAI text-embedding-3-small. For Anthropic-only stacks
-- we'll use Voyage or sentence-transformers with the same 1536 dim
-- (Voyage's voyage-3-lite is the natural fit and matches dim). Until
-- the embed worker is implemented, chunks land with embedding=NULL and
-- retrieval falls back to keyword search.
--
-- ─── pgvector availability ───────────────────────────────────────────────
--
-- Supabase ships pgvector pre-installed in all paid projects. The
-- CREATE EXTENSION is idempotent + safe on existing instances.

create extension if not exists vector;

-- ─── 1. knowledge_bases ───────────────────────────────────────────────────

create table if not exists public.knowledge_bases (
  id                  uuid primary key default gen_random_uuid(),
  tenant_id           uuid not null references public.tenants(id) on delete cascade,
  name                text not null default 'Default knowledge base',
  status              text not null default 'draft'
                      check (status in ('draft', 'live')),
  -- v1 doesn't expose versioning to users (auto-publish with undo); the
  -- column is here so future iterations can pin a specific version.
  current_version     integer not null default 1,
  -- Live config consumed by the inference path. Mirrors the FE settings
  -- toggle: when ai_enabled=false the workflow node + reply suggestions
  -- silently skip (no surfacing).
  ai_enabled          boolean not null default false,
  mode                text not null default 'always'
                      check (mode in ('always', 'after_hours', 'no_agent_available')),
  -- When true, the AI reply is shown as a SUGGESTION in the agent
  -- inbox composer instead of auto-sent. Default-on for safety.
  require_approval    boolean not null default true,
  -- Cosine similarity threshold for "confident" retrieval. Below this,
  -- the AI silently abstains. 0.78 is a reasonable default for the
  -- Voyage/OpenAI-small embedding family.
  confidence_threshold numeric(4,3) not null default 0.780
                       check (confidence_threshold >= 0 and confidence_threshold <= 1),
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create unique index if not exists ux_knowledge_bases_tenant on public.knowledge_bases(tenant_id);

comment on table public.knowledge_bases is
  'Per-tenant AI agent config + KB pointer. v1 = single KB per tenant. mode = when the agent fires (always / after-hours / when no human agent is online). require_approval = render reply as a suggestion in the composer instead of auto-sending.';

-- ─── 2. kb_sources ────────────────────────────────────────────────────────

create table if not exists public.kb_sources (
  id                  uuid primary key default gen_random_uuid(),
  kb_id               uuid not null references public.knowledge_bases(id) on delete cascade,
  -- 'pdf' = uploaded file; 'url' = crawled page; 'qa' = inline Q&A pair;
  -- 'notion'/'gdrive' = future connector adapters.
  type                text not null check (type in ('pdf', 'url', 'qa', 'notion', 'gdrive')),
  -- For 'qa' rows we store the question + answer inline in source_meta:
  --   { "question": "...", "answer": "..." }
  -- For PDF/URL we store { "filename", "size", "url", "title" } etc.
  source_meta         jsonb not null default '{}'::jsonb,
  status              text not null default 'pending'
                      check (status in ('pending', 'ingesting', 'ready', 'failed')),
  status_message      text,                     -- error details when status='failed'
  last_ingested_at    timestamptz,
  chunk_count         integer not null default 0,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create index if not exists idx_kb_sources_kb on public.kb_sources(kb_id);

comment on table public.kb_sources is
  'Uploaded/added knowledge sources. Ingested into kb_chunks asynchronously. status flows pending → ingesting → ready (or failed). For pdf/url an ingest worker pulls + chunks + embeds; for qa the row stays inline (one source = one chunk).';

-- ─── 3. kb_chunks ─────────────────────────────────────────────────────────

create table if not exists public.kb_chunks (
  id                  uuid primary key default gen_random_uuid(),
  kb_id               uuid not null references public.knowledge_bases(id) on delete cascade,
  source_id           uuid references public.kb_sources(id) on delete cascade,
  text                text not null,
  tokens              integer,                  -- approximate token count
  embedding           vector(1536),             -- NULL until embed worker runs
  tags                text[] not null default '{}',
  -- Engagement counters maintained by the inference path (best-effort).
  retrieval_count     bigint not null default 0,
  thumbs_up           integer not null default 0,
  thumbs_down         integer not null default 0,
  needs_review        boolean not null default false,
  manual_edit_at      timestamptz,              -- set when an admin hand-edits this chunk
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create index if not exists idx_kb_chunks_kb on public.kb_chunks(kb_id);
create index if not exists idx_kb_chunks_source on public.kb_chunks(source_id);
-- HNSW index for fast cosine search. ivfflat is the alternative but
-- needs ANALYZE after every insert burst; HNSW is more forgiving.
create index if not exists idx_kb_chunks_embedding on public.kb_chunks
  using hnsw (embedding vector_cosine_ops);

comment on table public.kb_chunks is
  'Atomic units of retrievable text. Embedded with the 1536-dim model used by the inference worker. retrieval_count + thumbs_{up,down} drive the "needs rewriting" admin signal. Hand-edits set manual_edit_at so re-ingest of the parent source can skip overwrites.';

-- ─── 4. kb_test_runs ──────────────────────────────────────────────────────
--
-- Playground transcripts. Used for: (a) regression — after editing a
-- chunk, re-run the saved tests + diff outputs; (b) "this answer was
-- wrong" → admin clicks "Add a Q&A" CTA which seeds a new kb_sources row.

create table if not exists public.kb_test_runs (
  id                  uuid primary key default gen_random_uuid(),
  kb_id               uuid not null references public.knowledge_bases(id) on delete cascade,
  input_text          text not null,
  output_text         text not null,
  confidence          numeric(4,3),
  cited_chunk_ids     uuid[] not null default '{}',
  agent_rating        smallint check (agent_rating between -1 and 1),  -- -1=👎, 0=neutral, 1=👍
  created_by          uuid references auth.users(id) on delete set null,
  created_at          timestamptz not null default now()
);

create index if not exists idx_kb_test_runs_kb on public.kb_test_runs(kb_id, created_at desc);

-- ─── 5. kb_inference_log ──────────────────────────────────────────────────

create table if not exists public.kb_inference_log (
  id                  uuid primary key default gen_random_uuid(),
  kb_id               uuid not null references public.knowledge_bases(id) on delete cascade,
  conversation_phone  text,
  message_id          text,
  query_text          text not null,
  query_embedding     vector(1536),
  retrieved_chunks    uuid[] not null default '{}',
  confidence          numeric(4,3),
  response_text       text,
  -- did the agent override the AI reply before sending?
  agent_overrode      boolean not null default false,
  -- thumbs_up = 1, thumbs_down = -1, no feedback = 0
  agent_feedback      smallint check (agent_feedback between -1 and 1),
  created_at          timestamptz not null default now()
);

create index if not exists idx_kb_inference_log_kb_time
  on public.kb_inference_log(kb_id, created_at desc);

-- ─── RLS ──────────────────────────────────────────────────────────────────

alter table public.knowledge_bases   enable row level security;
alter table public.kb_sources        enable row level security;
alter table public.kb_chunks         enable row level security;
alter table public.kb_test_runs      enable row level security;
alter table public.kb_inference_log  enable row level security;

drop policy if exists "knowledge_bases_tenant_rw" on public.knowledge_bases;
create policy "knowledge_bases_tenant_rw" on public.knowledge_bases
  for all to authenticated
  using (
    tenant_id in (
      select tenant_id from public.user_role_assignments where user_id = auth.uid()
      union
      select tenant_id from public.user_roles where user_id = auth.uid()
    )
  );

-- kb_sources / chunks / test_runs / inference_log are gated via the parent
-- knowledge_bases row. Per-table policies (terser via macros would be nice
-- but Supabase migration runner doesn't accept anonymous PL/pgSQL with
-- composite loop variables on this version).

drop policy if exists "kb_sources_tenant_rw" on public.kb_sources;
create policy "kb_sources_tenant_rw" on public.kb_sources for all to authenticated
  using (exists (
    select 1 from public.knowledge_bases kb
    where kb.id = kb_sources.kb_id
      and kb.tenant_id in (
        select tenant_id from public.user_role_assignments where user_id = auth.uid()
        union
        select tenant_id from public.user_roles where user_id = auth.uid()
      )
  ));

drop policy if exists "kb_chunks_tenant_rw" on public.kb_chunks;
create policy "kb_chunks_tenant_rw" on public.kb_chunks for all to authenticated
  using (exists (
    select 1 from public.knowledge_bases kb
    where kb.id = kb_chunks.kb_id
      and kb.tenant_id in (
        select tenant_id from public.user_role_assignments where user_id = auth.uid()
        union
        select tenant_id from public.user_roles where user_id = auth.uid()
      )
  ));

drop policy if exists "kb_test_runs_tenant_rw" on public.kb_test_runs;
create policy "kb_test_runs_tenant_rw" on public.kb_test_runs for all to authenticated
  using (exists (
    select 1 from public.knowledge_bases kb
    where kb.id = kb_test_runs.kb_id
      and kb.tenant_id in (
        select tenant_id from public.user_role_assignments where user_id = auth.uid()
        union
        select tenant_id from public.user_roles where user_id = auth.uid()
      )
  ));

drop policy if exists "kb_inference_log_tenant_rw" on public.kb_inference_log;
create policy "kb_inference_log_tenant_rw" on public.kb_inference_log for all to authenticated
  using (exists (
    select 1 from public.knowledge_bases kb
    where kb.id = kb_inference_log.kb_id
      and kb.tenant_id in (
        select tenant_id from public.user_role_assignments where user_id = auth.uid()
        union
        select tenant_id from public.user_roles where user_id = auth.uid()
      )
  ));
