-- 20260607010000_knowledge_embeddings
-- Semantic retrieval for the AI responder's knowledge base.
--
-- Adds a 384-dim embedding column to tenant_knowledge_chunks (384 chosen so a
-- single fixed dimension works across providers: local MiniLM = 384, and
-- OpenAI text-embedding-3-small supports `dimensions:384`). pgvector 0.8.0 is
-- already installed on this project. A SECURITY DEFINER-free SQL function
-- ranks a tenant's chunks by cosine distance for the backend (service role)
-- to call via rpc. An HNSW index keeps it fast as KBs grow.

create extension if not exists vector;

alter table public.tenant_knowledge_chunks
  add column if not exists embedding   public.vector(384),
  add column if not exists embed_model  text;

-- Cosine-distance HNSW index (pgvector >= 0.5). Partial — only embedded rows.
create index if not exists tkc_embedding_hnsw
  on public.tenant_knowledge_chunks
  using hnsw (embedding vector_cosine_ops)
  where embedding is not null;

-- Tenant-scoped nearest-neighbour search. Returns cosine distance (0 = identical).
create or replace function public.match_knowledge_chunks(
  p_tenant    uuid,
  p_embedding public.vector(384),
  p_limit     int default 8
)
returns table (
  id          uuid,
  source_type text,
  source_ref  text,
  chunk_text  text,
  metadata    jsonb,
  created_at  timestamptz,
  distance    double precision
)
language sql
stable
as $$
  select c.id, c.source_type, c.source_ref, c.chunk_text, c.metadata, c.created_at,
         (c.embedding <=> p_embedding) as distance
  from public.tenant_knowledge_chunks c
  where c.tenant_id = p_tenant
    and c.embedding is not null
  order by c.embedding <=> p_embedding
  limit greatest(1, least(50, p_limit))
$$;

grant execute on function public.match_knowledge_chunks(uuid, vector, int) to service_role;
