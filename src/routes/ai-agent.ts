/**
 * routes/ai-agent.ts — AI Knowledge Base + agent config endpoints.
 *
 * Phase 2 (migration 096 + 098 hardening). MVP scope:
 *
 *   GET    /api/ai-agent/config       — KB + agent config (auto-seeds default)
 *   PATCH  /api/ai-agent/config       — toggle ai_enabled, mode, require_approval
 *
 *   GET    /api/ai-agent/sources      — list sources (PDF/URL/Q&A)
 *   POST   /api/ai-agent/sources/qa   — add a Q&A pair inline (no ingest worker needed)
 *   DELETE /api/ai-agent/sources/:id  — remove source + cascade its chunks
 *
 *   POST   /api/ai-agent/test         — playground: run a question against the
 *                                       KB, return AI reply + cited chunks
 *
 * Hardening notes (audit fixes shipped with this file):
 *   - ensureKb uses upsert(onConflict='tenant_id') so concurrent first
 *     requests don't crash on the unique-violation race.
 *   - All Zod schemas are .strict() with hard caps on every array.
 *   - Anthropic API errors NEVER reach the wire AND never log the
 *     request headers — we only log a fixed string.
 *   - Test endpoint truncates assembled context to a fixed budget so
 *     a pathological chunk doesn't blow Claude's window.
 *   - Generic respond500 helper hides Supabase error.message details.
 */

import express from 'express'
import { z } from 'zod'
import type { SupabaseClient } from '@supabase/supabase-js'

type Deps = {
  supabase: SupabaseClient
  requireAuth: express.RequestHandler
  identifyTenant: express.RequestHandler
}

// Resolve-or-create the tenant's default KB. The unique constraint on
// (tenant_id) protects against duplicate rows; we use upsert with
// `ignoreDuplicates:false` so a concurrent first request just re-selects
// instead of crashing with a 23505. Returns the resolved row, or throws
// on any non-conflict error.
async function ensureKb(supabase: SupabaseClient, tenantId: string) {
  // Fast path: row already exists.
  const { data: existing } = await supabase.from('knowledge_bases')
    .select('*').eq('tenant_id', tenantId).maybeSingle()
  if (existing) return existing
  // Slow path: try to create. On unique-violation (concurrent first
  // request from the same tenant), fall back to a fresh select.
  const { data: created, error } = await supabase.from('knowledge_bases')
    .insert({ tenant_id: tenantId }).select().single()
  if (created) return created
  if (error && (error as any).code === '23505') {
    const { data: refetched } = await supabase.from('knowledge_bases')
      .select('*').eq('tenant_id', tenantId).maybeSingle()
    if (refetched) return refetched
  }
  throw new Error(`ensureKb failed for tenant=${tenantId}: ${error?.message ?? 'unknown'}`)
}

// Strict body schemas — no extra keys, every text bounded, every array
// capped. Without these, a malicious caller could spread a `tenant_id`
// override or send a 1MB tag list.
const PatchConfigBody = z.object({
  ai_enabled:           z.boolean().optional(),
  mode:                 z.enum(['always', 'after_hours', 'no_agent_available']).optional(),
  require_approval:     z.boolean().optional(),
  confidence_threshold: z.number().min(0).max(1).optional(),
  name:                 z.string().min(1).max(120).optional(),
}).strict()

const QaSourceBody = z.object({
  question: z.string().min(1).max(2000),
  answer:   z.string().min(1).max(8000),
  tags:     z.array(z.string().max(60)).max(20).optional(),
}).strict()

const TestBody = z.object({
  input_text: z.string().min(1).max(2000),
}).strict()

// Generic Supabase error responder — logs server-side, returns generic
// message + correlation id. Same pattern as routes/sla.ts.
function respond500(res: express.Response, scope: string, error: unknown): void {
  const corrId = Math.random().toString(36).slice(2, 10)
  // eslint-disable-next-line no-console
  console.warn(`[ai-agent:${scope}] ${corrId}`, error)
  res.status(500).json({ error: 'internal', scope, ref: corrId })
}

export function createAiAgentRouter(deps: Deps): express.Router {
  const { supabase, requireAuth, identifyTenant } = deps
  const r = express.Router()

  r.get('/api/ai-agent/config', requireAuth, identifyTenant, async (req, res) => {
    const tenantId = (req as any).tenantId as string
    try {
      const kb = await ensureKb(supabase, tenantId)
      res.json({ data: kb })
    } catch (e) {
      respond500(res, 'config_get', e)
    }
  })

  r.patch('/api/ai-agent/config', requireAuth, identifyTenant, async (req, res) => {
    const tenantId = (req as any).tenantId as string
    const parsed = PatchConfigBody.safeParse(req.body)
    if (!parsed.success) { res.status(400).json({ error: 'invalid_body', issues: parsed.error.issues }); return }
    try {
      const kb = await ensureKb(supabase, tenantId)
      const { data, error } = await supabase.from('knowledge_bases')
        .update({ ...parsed.data, updated_at: new Date().toISOString() })
        .eq('id', kb.id).select().single()
      if (error) { respond500(res, 'config_patch', error); return }
      res.json({ data })
    } catch (e) {
      respond500(res, 'config_patch', e)
    }
  })

  r.get('/api/ai-agent/sources', requireAuth, identifyTenant, async (req, res) => {
    const tenantId = (req as any).tenantId as string
    try {
      const kb = await ensureKb(supabase, tenantId)
      const { data, error } = await supabase.from('kb_sources')
        .select('*').eq('kb_id', kb.id).order('created_at', { ascending: false })
      if (error) { respond500(res, 'sources_list', error); return }
      res.json({ data: data ?? [] })
    } catch (e) {
      respond500(res, 'sources_list', e)
    }
  })

  r.post('/api/ai-agent/sources/qa', requireAuth, identifyTenant, async (req, res) => {
    const tenantId = (req as any).tenantId as string
    const parsed = QaSourceBody.safeParse(req.body)
    if (!parsed.success) { res.status(400).json({ error: 'invalid_body', issues: parsed.error.issues }); return }
    try {
      const kb = await ensureKb(supabase, tenantId)
      // Create the kb_sources row AND the single chunk it produces, in
      // one round-trip. Embedding stays NULL — the test endpoint falls
      // back to keyword overlap until the embed worker is built.
      const { data: src, error: srcErr } = await supabase.from('kb_sources').insert({
        kb_id: kb.id,
        type:  'qa',
        source_meta: { question: parsed.data.question, answer: parsed.data.answer },
        status: 'ready',
        last_ingested_at: new Date().toISOString(),
        chunk_count: 1,
      }).select().single()
      if (srcErr) { respond500(res, 'qa_insert_source', srcErr); return }
      const chunkText = `Q: ${parsed.data.question}\nA: ${parsed.data.answer}`
      const { error: chErr } = await supabase.from('kb_chunks').insert({
        kb_id: kb.id,
        source_id: src.id,
        text: chunkText,
        tokens: Math.ceil(chunkText.length / 4),
        tags: parsed.data.tags ?? [],
      })
      if (chErr) { respond500(res, 'qa_insert_chunk', chErr); return }
      // Retrieval is Claude-based — no separate embed step. The
      // chunk is immediately queryable via /api/ai-agent/test.
      res.status(201).json({ data: src })
    } catch (e) {
      respond500(res, 'qa_insert', e)
    }
  })

  r.delete('/api/ai-agent/sources/:id', requireAuth, identifyTenant, async (req, res) => {
    const tenantId = (req as any).tenantId as string
    try {
      const kb = await ensureKb(supabase, tenantId)
      // Confirm the source belongs to this kb before delete so the
      // response correctly reports 404 on cross-tenant or unknown ids.
      const { data: src } = await supabase.from('kb_sources')
        .select('id').eq('id', req.params.id).eq('kb_id', kb.id).maybeSingle()
      if (!src) { res.status(404).json({ error: 'not_found' }); return }
      const { error } = await supabase.from('kb_sources')
        .delete().eq('id', src.id).eq('kb_id', kb.id)
      if (error) { respond500(res, 'sources_delete', error); return }
      res.json({ success: true })
    } catch (e) {
      respond500(res, 'sources_delete', e)
    }
  })

  // Playground / test endpoint.
  // v1 retrieval: keyword overlap (no embeddings yet) — pull all chunks,
  // score by token overlap, take top 3, feed to Anthropic with a clear
  // "answer only from the provided context" system prompt.
  // confidence ≈ overlap_score / token_count, capped at 1.
  r.post('/api/ai-agent/test', requireAuth, identifyTenant, async (req, res) => {
    const tenantId = (req as any).tenantId as string
    const userId = (req as any).user?.id as string | undefined
    const parsed = TestBody.safeParse(req.body)
    if (!parsed.success) { res.status(400).json({ error: 'invalid_body', issues: parsed.error.issues }); return }
    const { input_text } = parsed.data

    try {
      const kb = await ensureKb(supabase, tenantId)

      const { data: chunks } = await supabase.from('kb_chunks')
        .select('id, text, tags').eq('kb_id', kb.id).limit(500)
      if (!chunks || chunks.length === 0) {
        res.json({ data: { output_text: 'No knowledge yet. Add some Q&A or upload a document under "Teach me".', confidence: 0, cited_chunk_ids: [] } })
        return
      }

      // ── Two-stage Claude-only retrieval ────────────────────────────────
      //
      // Stage 1 (free, fast): rank chunks by keyword token overlap on the
      // query. Take the top 12 candidates. This is the "recall" pass — it
      // guarantees Claude sees enough relevant material without sending
      // the entire KB on every query.
      //
      // Stage 2 (one Claude call): give Claude the query + the 12
      // candidates and ask it to (a) pick the 1-3 most relevant chunk
      // ids AND (b) write the customer-facing answer in the same JSON
      // response. This collapses what was previously "embed → vector
      // search → re-prompt for answer" into one call against the key the
      // tenant already has (ANTHROPIC_API_KEY).
      //
      // Why this is preferable to a separate embeddings provider:
      //   - One key for the whole AI Agent surface (Anthropic).
      //   - No worker to schedule, no backfill to debug.
      //   - Claude's reranking is robust to Hindi/English code-switch
      //     where bag-of-words tokenizers struggle.
      // Trade-off: latency is ~600-1000ms per query (one Haiku call)
      // instead of ~150ms (embed lookup). Acceptable for playground +
      // inbox-suggest UX.
      type Scored = { id: string; text: string; score: number }
      const qTokens = tokenize(input_text)
      const prefiltered: Scored[] = chunks.map((c: any) => {
        const overlap = tokenize(c.text).filter((t: string) => qTokens.includes(t)).length
        return { id: c.id, text: c.text, score: overlap / Math.max(1, qTokens.length) }
      }).sort((a, b) => b.score - a.score).slice(0, 12)

      // If keyword pre-filter found NOTHING (zero-overlap query — happens
      // on cross-lingual or paraphrase queries), don't give up — pass the
      // first N chunks as candidates so Claude can still rerank.
      const candidates: Scored[] = prefiltered.some(c => c.score > 0)
        ? prefiltered
        : chunks.slice(0, 12).map((c: any) => ({ id: c.id, text: c.text, score: 0 }))

      // Hard cap on combined candidate-context size: 12 KB total across
      // the 12 candidates. Each chunk is already capped at 16 KB by the
      // schema (migration 098); the combined budget keeps Claude tokens
      // predictable per playground request.
      const CTX_CAP = 12 * 1024
      let candidateBlock = candidates
        .map((c, i) => `[Candidate ${i + 1}, id=${c.id}]\n${c.text}`)
        .join('\n\n')
      if (candidateBlock.length > CTX_CAP) candidateBlock = candidateBlock.slice(0, CTX_CAP)

      // Default fallback when Claude is unreachable.
      let outputText = `Based on what I have:\n\n${(candidates[0]?.text ?? '(no context)').slice(0, 600)}`
      let citedIds: string[] = candidates.slice(0, 1).map(c => c.id)
      let confidence = candidates[0]?.score ?? 0

      try {
        const key = process.env.ANTHROPIC_API_KEY
        if (key && candidates.length > 0) {
          const aiRes = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: {
              'x-api-key': key,
              'anthropic-version': '2023-06-01',
              'content-type': 'application/json',
            },
            body: JSON.stringify({
              model: process.env.AI_AGENT_MODEL ?? 'claude-3-5-haiku-latest',
              max_tokens: 800,
              system:
                'You are a customer-support assistant for an Indian business. ' +
                'You receive a customer question and a numbered list of candidate ' +
                'knowledge-base chunks (each with an id). Decide which 1-3 ' +
                'chunks are relevant, then write a SHORT (2-3 sentences) ' +
                'friendly reply using ONLY those chunks. If no chunk is ' +
                'relevant, set cited_chunk_ids to [] and answer with ' +
                '"I don\'t have that information yet." ' +
                'Respond with strict JSON ONLY (no prose, no markdown fence) in this shape: ' +
                '{"answer": "...", "cited_chunk_ids": ["uuid1", "uuid2"], "confidence": 0.0-1.0}',
              messages: [{
                role: 'user',
                content: `Candidates:\n${candidateBlock}\n\nCustomer question: ${input_text}`,
              }],
            }),
          })
          if (aiRes.ok) {
            const j: any = await aiRes.json()
            const raw = j?.content?.[0]?.text ?? ''
            // Strip code fences if Claude wrapped despite the instruction.
            const cleaned = raw.replace(/```(?:json)?/gi, '').replace(/```/g, '').trim()
            try {
              const parsed = JSON.parse(cleaned)
              if (typeof parsed.answer === 'string' && parsed.answer.length > 0) outputText = parsed.answer
              if (Array.isArray(parsed.cited_chunk_ids)) {
                citedIds = parsed.cited_chunk_ids
                  .filter((id: any) => typeof id === 'string')
                  .filter((id: string) => candidates.some(c => c.id === id))
                  .slice(0, 3)
              }
              if (typeof parsed.confidence === 'number') {
                confidence = Math.max(0, Math.min(1, parsed.confidence))
              }
            } catch {
              // Claude returned non-JSON. Use the raw text as answer; keep keyword-based citations.
              if (raw && raw.length > 0) outputText = raw
            }
          }
          // Non-OK upstream bodies are intentionally NOT inspected — they
          // could echo the key on misconfigured proxies. Falling back to
          // the keyword-based answer is safer than logging the raw body.
        }
      } catch (e: any) {
        // NEVER pass the raw error object to the logger — defence
        // against a future logger serializing the request (which
        // would include x-api-key).
        // eslint-disable-next-line no-console
        console.warn('[ai-agent.test] anthropic_call_failed')
      }

      // Build the cited_chunks display payload from the (Claude-chosen)
      // citedIds, preserving order. Falls back to keyword-top-3 if Claude
      // returned no ids.
      const idOrder = citedIds.length > 0 ? citedIds : candidates.slice(0, 3).map(c => c.id)
      const top: Scored[] = idOrder
        .map(id => candidates.find(c => c.id === id))
        .filter((x): x is Scored => Boolean(x))

      // Log the test run (best-effort).
      const corrId = Math.random().toString(36).slice(2, 10)
      await supabase.from('kb_test_runs').insert({
        kb_id: kb.id,
        input_text,
        output_text: outputText,
        confidence,
        cited_chunk_ids: top.map((c: any) => c.id),
        created_by: userId ?? null,
      }).then(() => {}, (e: any) => {
        // eslint-disable-next-line no-console
        console.warn(`[ai-agent:test_log_insert] ${corrId}`, e?.message ?? e)
      })

      res.json({
        data: {
          output_text: outputText,
          confidence,
          cited_chunk_ids: top.map((c: any) => c.id),
          cited_chunks: top.map((c: any) => ({ id: c.id, text: c.text.slice(0, 200), score: c.score })),
        },
      })
    } catch (e) {
      respond500(res, 'test', e)
    }
  })

  return r
}

// Tiny tokenizer for the keyword-overlap retrieval fallback. Lowercases,
// strips punctuation, drops stopwords, returns unique tokens.
const STOPWORDS = new Set(['the', 'a', 'an', 'is', 'are', 'i', 'we', 'you', 'do', 'does', 'how', 'what', 'when', 'where', 'why', 'and', 'or', 'to', 'for', 'of', 'on', 'in', 'with', 'my', 'me', 'your', 'this', 'that', 'it', 'be'])

function tokenize(text: string): string[] {
  return Array.from(new Set(
    text.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(t => t.length > 2 && !STOPWORDS.has(t))
  ))
}
