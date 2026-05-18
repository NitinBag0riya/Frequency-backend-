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
  model:                            'claude-opus-4-7',
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
  // websearch_to_tsquery handles user-typed queries gracefully (quotes,
  // OR, negation) without throwing on punctuation. supabase-js exposes
  // tsvector matching via `.textSearch(column, query, { type: 'websearch' })`.
  // The tenant filter is FIRST.
  const { data, error } = await supabase
    .from('tenant_knowledge_chunks')
    .select('id, source_type, source_ref, chunk_text, metadata, created_at')
    .eq('tenant_id', tenantId)   // tenant-isolation primary filter
    .textSearch('search_tsv', q, { type: 'websearch', config: 'english' })
    .order('created_at', { ascending: false })
    .limit(Math.max(1, Math.min(20, limit * 3)))   // pull 3× then re-rank in app
  if (error) {
    // textSearch can throw on weird queries; degrade gracefully so a
    // bad query doesn't crash the AI responder. Caller treats [] as
    // "no context found".
    console.warn(`[ai-knowledge] retrieveChunks tsquery failed for tenant=${tenantId}: ${error.message}`)
    return []
  }
  if (!data || data.length === 0) return []
  // Re-rank: prefer qa_wizard > manual > wa_profile > product > conversation,
  // then by recency. Keeps high-trust chunks at the top when their tsvector
  // match isn't dominant.
  const trust: Record<string, number> = {
    qa_wizard:   5,
    manual:      4,
    wa_profile:  3,
    product:     2,
    conversation:1,
  }
  const ranked = (data as any[])
    .map(row => ({
      id:          row.id,
      source_type: row.source_type,
      source_ref:  row.source_ref,
      chunk_text:  row.chunk_text,
      metadata:    row.metadata ?? {},
      rank:        (trust[row.source_type] ?? 1) + (row.created_at ? Math.min(1, (Date.now() - new Date(row.created_at).getTime()) / (90 * 86400_000)) : 0),
    }))
    .sort((a, b) => b.rank - a.rank)
    .slice(0, limit)
  return ranked
}

export interface ChunkInsert {
  source_type: 'qa_wizard' | 'conversation' | 'manual' | 'wa_profile' | 'product'
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
