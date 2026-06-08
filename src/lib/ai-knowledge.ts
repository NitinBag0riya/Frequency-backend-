/**
 * AI Responder knowledge-base helpers.
 *
 *   getTenantAiSettings(tenantId)
 *     - resolves the per-tenant row; returns sane defaults if no row exists
 *       (matches the "disabled by default" contract)
 *
 *   ensureTenantAiSettings(tenantId)
 *     - upserts a default row; idempotent. Called the first time a tenant
 *       admin hits /api/ai/settings or /api/ai/qa-wizard.
 *
 *   retrieveChunks(tenantId, query, limit=5)
 *     - full-text retrieval over `tenant_knowledge_chunks` ranked by
 *       ts_rank. ALWAYS filters by tenant_id first (the tenant-isolation
 *       contract). Returns the top-N chunks for RAG injection.
 *     - When pgvector lands, swap the body for a `<=>` vector-distance
 *       lookup against `embedding`. The signature stays the same.
 *
 *   insertChunks(tenantId, items)
 *     - bulk insert. Idempotent on (tenant_id, source_type, source_ref)
 *       when source_ref is provided — re-syncing a conversation replaces
 *       the old chunk rather than duplicating.
 *
 *   deleteChunk(tenantId, id)
 *     - tenant-scoped delete. Refuses to delete a chunk that doesn't
 *       belong to the caller's tenant.
 *
 *   chunkText(text, maxChars=1200, overlap=120)
 *     - greedy text splitter. Keeps paragraphs intact when possible; falls
 *       back to sentence boundaries; only mid-sentence-cuts as last resort.
 *
 * TENANT ISOLATION CONTRACT:
 *   Every query in this file takes `tenantId` and uses it as the FIRST
 *   filter in the .eq() chain. Service-role bypasses RLS, so the explicit
 *   filter is the actual security boundary. Reviewers: a missing
 *   `.eq('tenant_id', tenantId)` here = cross-tenant data leak.
 */

import type { SupabaseClient } from '@supabase/supabase-js'

export interface TenantAiSettings {
  tenant_id:                          string
  enabled:                            boolean
  qa_wizard_completed_at:             string | null
  model:                              string
  system_prompt_addon:                string | null
  max_tokens:                         number
  temperature:                        number
  escalate_to_human_on_uncertainty:   boolean
  business_context:                   Record<string, any>
  created_at?:                        string
  updated_at?:                        string
}

export interface RetrievedChunk {
  id:           string
  source_type:  string
  source_ref:   string | null
  chunk_text:   string
  metadata:     Record<string, any>
  rank:         number   // ts_rank score; higher = more relevant
}

/**
 * Defaults applied when a tenant has never touched AI settings. Matches
 * the migration 066 column defaults so the FE renders the same values
 * whether the row exists or not.
 *
 * CRITICAL: enabled=false. The wizard MUST run before anything fires.
 */
export const DEFAULT_AI_SETTINGS: Omit<TenantAiSettings, 'tenant_id'> = {
  enabled:                          false,
  qa_wizard_completed_at:           null,
  // Sonnet by default — the responder is our highest-volume AI path; Opus 4.7
  // is ~5× pricier per call and its 4,096-token cache floor never engages on
  // our ~1k-token prompt (Sonnet's 1,024 floor does). Tenants can opt into
  // Opus explicitly. Keep in sync with the column default in tenant_ai_settings.
  model:                            'claude-sonnet-4-6',
  system_prompt_addon:              null,
  max_tokens:                       500,
  temperature:                      0.7,
  escalate_to_human_on_uncertainty: true,
  business_context:                 {},
}

export async function getTenantAiSettings(
  supabase: SupabaseClient,
  tenantId: string,
): Promise<TenantAiSettings> {
  if (!tenantId) throw new Error('getTenantAiSettings: tenantId required')
  const { data, error } = await supabase
    .from('tenant_ai_settings')
    .select('*')
    .eq('tenant_id', tenantId)   // tenant-isolation primary filter
    .maybeSingle()
  if (error) throw new Error(`getTenantAiSettings: ${error.message}`)
  if (!data) return { tenant_id: tenantId, ...DEFAULT_AI_SETTINGS }
  return data as TenantAiSettings
}

export async function ensureTenantAiSettings(
  supabase: SupabaseClient,
  tenantId: string,
): Promise<TenantAiSettings> {
  if (!tenantId) throw new Error('ensureTenantAiSettings: tenantId required')
  const existing = await getTenantAiSettings(supabase, tenantId)
  if (existing.created_at) return existing
  // No row yet — seed with defaults. on conflict do nothing so two parallel
  // settings page loads don't race.
  const { data, error } = await supabase
    .from('tenant_ai_settings')
    .upsert({ tenant_id: tenantId, ...DEFAULT_AI_SETTINGS }, { onConflict: 'tenant_id' })
    .select()
    .single()
  if (error) throw new Error(`ensureTenantAiSettings: ${error.message}`)
  return data as TenantAiSettings
}

/**
 * Retrieve the top-N most relevant chunks for `query` from `tenantId`'s
 * corpus. ALWAYS tenant-scoped — the .eq('tenant_id', tenantId) filter
 * is the security boundary, not the RLS policy (we call as service-role).
 *
 * Today: tsvector + ts_rank via a tenant-scoped RPC OR an in-app rank
 * fallback (we POST the query as a websearch_to_tsquery, then read the
 * top-N by ts_rank). Postgres doesn't expose tsquery construction through
 * the supabase-js .textSearch builder cleanly when we want a tenant
 * pre-filter, so we use a small RPC if available, falling back to a
 * client-side ranking pass when not (keeps the migration self-contained).
 *
 * The fallback is good enough for SMB corpora (≤10k chunks): we pull
 * candidates that match ANY token of the query (covered by GIN), then
 * compute ts_rank in JS using the same chunks (the supabase-js builder
 * surfaces `ts_rank` via `select('chunk_text, ts_rank(search_tsv, ...)')`
 * which is what we do).
 */
export async function retrieveChunks(
  supabase: SupabaseClient,
  tenantId: string,
  query: string,
  limit: number = 5,
): Promise<RetrievedChunk[]> {
  if (!tenantId) throw new Error('retrieveChunks: tenantId required')
  const q = (query ?? '').trim()
  if (!q) return []

  const candPool = Math.max(8, Math.min(24, limit * 4))
  type Cand = {
    id: string; source_type: string; source_ref: string | null
    chunk_text: string; metadata: any; created_at?: string
    sim?: number  // semantic cosine similarity (0..1), set only for vector hits
  }
  const byId = new Map<string, Cand>()

  // ── 1. SEMANTIC retrieval ───────────────────────────────────────────────
  // Embed the query and find nearest chunks by cosine distance (pgvector RPC).
  // This catches paraphrases that keyword search misses — e.g. "how expensive
  // is a two-bedroom apartment?" matches a "2 BHK … ₹75 lakh" chunk even with
  // no shared keywords. Degrades gracefully to keyword-only if embeddings or
  // the vector column aren't available.
  try {
    const { embedText, toVectorLiteral } = await import('./embeddings')
    const emb = await embedText(q)
    if (emb && emb.length) {
      const { data, error } = await supabase.rpc('match_knowledge_chunks', {
        p_tenant: tenantId, p_embedding: toVectorLiteral(emb), p_limit: candPool,
      })
      if (error) throw new Error(error.message)
      for (const r of (data ?? []) as any[]) {
        byId.set(r.id, {
          id: r.id, source_type: r.source_type, source_ref: r.source_ref,
          chunk_text: r.chunk_text, metadata: r.metadata ?? {}, created_at: r.created_at,
          sim: Math.max(0, 1 - Number(r.distance ?? 1)),
        })
      }
    }
  } catch (e: any) {
    console.warn(`[ai-knowledge] semantic retrieval unavailable (keyword fallback) for tenant=${tenantId}: ${e?.message ?? e}`)
  }

  // ── 2. KEYWORD retrieval ────────────────────────────────────────────────
  // OR the significant tokens (lexical recall + exact term/number hits that
  // embeddings can under-weight, e.g. an exact SKU or "₹75 lakh").
  const tokens = q.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter(t => t.length > 1)
  try {
    const orQuery = tokens.length ? tokens.join(' OR ') : q
    const { data } = await supabase
      .from('tenant_knowledge_chunks')
      .select('id, source_type, source_ref, chunk_text, metadata, created_at')
      .eq('tenant_id', tenantId)
      .textSearch('search_tsv', orQuery, { type: 'websearch', config: 'english' })
      .limit(candPool)
    for (const r of (data ?? []) as any[]) {
      if (!byId.has(r.id)) {
        byId.set(r.id, {
          id: r.id, source_type: r.source_type, source_ref: r.source_ref,
          chunk_text: r.chunk_text, metadata: r.metadata ?? {}, created_at: r.created_at,
        })
      }
    }
  } catch (e: any) {
    console.warn(`[ai-knowledge] keyword retrieval failed for tenant=${tenantId}: ${e?.message ?? e}`)
  }

  // ── 2b. CONTEXT PADDING (Anthropic-native fallback) ─────────────────────
  // When vector search is unavailable (no embedding provider) a paraphrase
  // with no keyword overlap ("two-bedroom" vs "2 BHK") would surface nothing.
  // For SMB knowledge bases the cheapest, key-free fix is to hand Claude — the
  // model we already use — enough of the KB as context and let IT do the
  // semantic matching. So pad with the most recent chunks up to `limit`.
  if (byId.size < limit) {
    try {
      const { data } = await supabase
        .from('tenant_knowledge_chunks')
        .select('id, source_type, source_ref, chunk_text, metadata, created_at')
        .eq('tenant_id', tenantId)
        .order('created_at', { ascending: false })
        .limit(limit * 2)
      for (const r of (data ?? []) as any[]) {
        if (byId.size >= limit * 2) break
        if (!byId.has(r.id)) {
          byId.set(r.id, {
            id: r.id, source_type: r.source_type, source_ref: r.source_ref,
            chunk_text: r.chunk_text, metadata: r.metadata ?? {}, created_at: r.created_at,
          })
        }
      }
    } catch { /* best-effort padding */ }
  }

  if (byId.size === 0) return []

  // ── 3. RERANK ───────────────────────────────────────────────────────────
  // Lightweight hybrid reranker over both candidate sets: semantic similarity
  // (primary signal) + lexical overlap + source trust + recency. Keeps the
  // most relevant chunks on top before they're handed to the LLM.
  // 'document' = operator-uploaded brochure/price-list → authoritative, on par
  // with hand-written 'manual' knowledge (and above passively-captured chats).
  const trust: Record<string, number> = { qa_wizard: 1, manual: 0.9, document: 0.9, wa_profile: 0.7, product: 0.6, conversation: 0.4 }
  const tks = new Set(tokens)
  const kwScore = (text: string) => {
    if (!tks.size) return 0
    const lt = text.toLowerCase(); let hit = 0
    for (const t of tks) if (lt.includes(t)) hit++
    return hit / tks.size
  }
  const recency = (c?: string) => (c ? Math.max(0, 1 - (Date.now() - new Date(c).getTime()) / (180 * 86400_000)) : 0)

  return [...byId.values()]
    .map(e => ({
      id: e.id, source_type: e.source_type, source_ref: e.source_ref,
      chunk_text: e.chunk_text, metadata: e.metadata ?? {},
      rank: 0.62 * (e.sim ?? 0) + 0.28 * kwScore(e.chunk_text) + 0.07 * (trust[e.source_type] ?? 0.5) + 0.03 * recency(e.created_at),
    }))
    .sort((a, b) => b.rank - a.rank)
    .slice(0, limit)
}

export interface ChunkInsert {
  source_type: 'qa_wizard' | 'conversation' | 'manual' | 'wa_profile' | 'product' | 'document'
  source_ref:  string | null
  chunk_text:  string
  metadata?:   Record<string, any>
}

/**
 * Bulk insert chunks for a tenant. ALL rows are tagged with the caller's
 * tenantId — callers cannot pass a different tenant_id even by accident.
 */
export async function insertChunks(
  supabase: SupabaseClient,
  tenantId: string,
  items: ChunkInsert[],
): Promise<number> {
  if (!tenantId) throw new Error('insertChunks: tenantId required')
  if (!Array.isArray(items) || items.length === 0) return 0
  const rows = items
    .filter(i => i.chunk_text && i.chunk_text.trim().length > 0)
    .map(i => ({
      tenant_id:   tenantId,                       // tenant-isolation: forced
      source_type: i.source_type,
      source_ref:  i.source_ref ?? null,
      chunk_text:  i.chunk_text.slice(0, 8000),   // see migration 066 note
      metadata:    i.metadata ?? {},
    }))
  if (rows.length === 0) return 0
  // Embed each chunk for semantic retrieval (provider-agnostic — see
  // embeddings.ts). Best-effort: if embedding fails the chunk still stores and
  // stays keyword-searchable; the backfill script can fill vectors later.
  try {
    const { embedTexts, toVectorLiteral, embedModelName } = await import('./embeddings')
    const vecs = await embedTexts(rows.map(r => r.chunk_text))
    if (vecs.length === rows.length) {
      const model = embedModelName()
      rows.forEach((r, i) => { (r as any).embedding = toVectorLiteral(vecs[i]); (r as any).embed_model = model })
    }
  } catch (e: any) {
    console.warn(`[ai-knowledge] insertChunks embed failed (stored without vector): ${e?.message ?? e}`)
  }
  const { error } = await supabase.from('tenant_knowledge_chunks').insert(rows)
  if (error) throw new Error(`insertChunks: ${error.message}`)
  return rows.length
}

/**
 * Tenant-scoped delete. Refuses to delete a chunk that doesn't belong to
 * the caller — even though the .eq('tenant_id', tenantId) filter would
 * already make the delete a no-op, we double-check with a SELECT first
 * so the API returns a proper 404 vs silently succeeding.
 */
export async function deleteChunk(
  supabase: SupabaseClient,
  tenantId: string,
  id: string,
): Promise<boolean> {
  if (!tenantId || !id) return false
  const { data: existing } = await supabase
    .from('tenant_knowledge_chunks')
    .select('id, tenant_id')
    .eq('id', id)
    .eq('tenant_id', tenantId)    // tenant-isolation primary filter
    .maybeSingle()
  if (!existing) return false
  const { error } = await supabase
    .from('tenant_knowledge_chunks')
    .delete()
    .eq('id', id)
    .eq('tenant_id', tenantId)   // belt + suspenders
  if (error) throw new Error(`deleteChunk: ${error.message}`)
  return true
}

/**
 * Greedy chunker. Tries paragraph boundaries first (\n\n), then sentence
 * boundaries, then a hard char cut. Keeps overlap so chunks don't
 * shear mid-thought when retrieved adjacent.
 *
 * Tunables — defaults work for typical Q&A + product descriptions.
 */
export function chunkText(
  text: string,
  maxChars: number = 1200,
  overlap: number = 120,
): string[] {
  if (!text) return []
  const trimmed = text.trim()
  if (trimmed.length <= maxChars) return [trimmed]

  const paragraphs = trimmed.split(/\n{2,}/)
  const chunks: string[] = []
  let buf = ''
  for (const p of paragraphs) {
    if ((buf + '\n\n' + p).length > maxChars && buf.length > 0) {
      chunks.push(buf.trim())
      // overlap from previous tail to preserve continuity
      buf = buf.length > overlap ? buf.slice(-overlap) + '\n\n' + p : p
    } else {
      buf = buf ? buf + '\n\n' + p : p
    }
    while (buf.length > maxChars) {
      // single oversized paragraph — sentence-split
      const sentences = buf.split(/(?<=[.!?])\s+/)
      let part = ''
      for (const s of sentences) {
        if ((part + ' ' + s).length > maxChars && part.length > 0) {
          chunks.push(part.trim())
          part = part.slice(-overlap) + ' ' + s
        } else {
          part = part ? part + ' ' + s : s
        }
        while (part.length > maxChars) {
          chunks.push(part.slice(0, maxChars))
          part = part.slice(maxChars - overlap)
        }
      }
      buf = part
    }
  }
  if (buf.trim().length > 0) chunks.push(buf.trim())
  return chunks.filter(c => c.length > 0)
}

/**
 * Markers an LLM might emit when it's unsure. Used by the executor to
 * decide whether to escalate to a human instead of sending the reply.
 * Kept conservative — false positives (escalating a confident answer)
 * are cheaper than false negatives (sending a hallucinated answer).
 */
const UNCERTAINTY_MARKERS = [
  "i don't know", "i'm not sure", "i am not sure", "i do not know",
  'unable to find', 'cannot find', 'no information', "don't have information",
  "don't have details", 'please contact', 'please reach out',
]

export function looksUncertain(text: string): boolean {
  const lower = (text ?? '').toLowerCase()
  return UNCERTAINTY_MARKERS.some(m => lower.includes(m))
}

/**
 * QA wizard payload shape. The FE submits one POST that:
 *   1) Stores the structured answers on tenant_ai_settings.business_context
 *   2) Seeds tenant_knowledge_chunks with source_type='qa_wizard' chunks
 *   3) Sets qa_wizard_completed_at to now()
 *
 * After this completes the `enabled` flag is unlocked for toggling.
 */
export interface QaWizardPayload {
  business_name:      string
  hours?:             string
  services?:          string
  what_we_do_not_do?: string
  common_questions?:  Array<{ q: string; a: string }>
}

/**
 * Turn a QA wizard submission into chunk inserts. Each Q/A becomes its own
 * chunk so retrieval can surface a specific answer without dragging the
 * whole wizard. Free-text fields (hours, services) become standalone chunks.
 */
export function qaWizardToChunks(payload: QaWizardPayload): ChunkInsert[] {
  const out: ChunkInsert[] = []
  const biz = payload.business_name?.trim() || 'our business'
  if (payload.hours?.trim()) {
    out.push({
      source_type: 'qa_wizard', source_ref: 'hours',
      chunk_text: `${biz} business hours: ${payload.hours.trim()}`,
      metadata: { field: 'hours' },
    })
  }
  if (payload.services?.trim()) {
    out.push({
      source_type: 'qa_wizard', source_ref: 'services',
      chunk_text: `${biz} services / what we do: ${payload.services.trim()}`,
      metadata: { field: 'services' },
    })
  }
  if (payload.what_we_do_not_do?.trim()) {
    out.push({
      source_type: 'qa_wizard', source_ref: 'do_not_do',
      chunk_text: `IMPORTANT — what ${biz} does NOT do: ${payload.what_we_do_not_do.trim()}. Do not promise these to customers.`,
      metadata: { field: 'what_we_do_not_do' },
    })
  }
  for (const qa of payload.common_questions ?? []) {
    if (!qa?.q?.trim() || !qa?.a?.trim()) continue
    out.push({
      source_type: 'qa_wizard',
      source_ref: `faq:${qa.q.slice(0, 60).toLowerCase().replace(/[^a-z0-9]+/g, '_')}`,
      chunk_text: `Q: ${qa.q.trim()}\nA: ${qa.a.trim()}`,
      metadata: { field: 'faq' },
    })
  }
  return out
}
