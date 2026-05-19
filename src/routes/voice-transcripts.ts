/**
 * routes/voice-transcripts.ts — Voice note transcript read + retry (P2 #20).
 *
 * Two endpoints, both tenant-scoped via requireAuth + identifyTenant.
 *
 *   GET  /api/messages/:message_id/transcript
 *     Returns the voice_note_transcripts row if one exists for this message,
 *     scoped to the caller's tenant. 404 if no row.
 *
 *   POST /api/messages/:message_id/retry-transcript
 *     Re-enqueues a voice transcription job for the given message. Used by
 *     the FE when the bubble shows "Transcription unavailable" and the user
 *     clicks Retry. UPSERTs the row back to status='pending' so the bubble
 *     re-renders the spinner without waiting for the worker.
 *
 * RLS on voice_note_transcripts (migration 086) gates SELECT to tenant
 * members. The GET handler uses the request-scoped supabase client so RLS
 * applies; the POST uses the same client to verify message ownership
 * before enqueueing (the worker itself runs with service-role).
 */

import express from 'express'
import { SupabaseClient } from '@supabase/supabase-js'
import { enqueueVoiceNoteTranscribe } from '../queue'

type Middleware = (
  req: express.Request,
  res: express.Response,
  next: express.NextFunction,
) => void | Promise<void>

interface Deps {
  supabase:       SupabaseClient
  requireAuth:    Middleware
  identifyTenant: Middleware
}

// Loose UUID guard so a malformed :message_id doesn't reach Postgres as an
// invalid cast error. Same regex used elsewhere in the codebase.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function createVoiceTranscriptsRouter(deps: Deps): express.Router {
  const r = express.Router()
  const { supabase, requireAuth, identifyTenant } = deps
  const guard = [requireAuth, identifyTenant]

  // ── GET /api/messages/:message_id/transcript ────────────────────────────
  r.get('/api/messages/:message_id/transcript', ...guard, async (req, res) => {
    const tenantId = (req as any).tenantId as string | undefined
    if (!tenantId) {
      res.status(401).json({ error: 'tenant required' })
      return
    }
    const messageId = String(req.params.message_id ?? '').trim()
    if (!UUID_RE.test(messageId)) {
      res.status(400).json({ error: 'invalid message_id' })
      return
    }

    const { data, error } = await supabase
      .from('voice_note_transcripts')
      .select('id, message_id, provider, language_detected, text_raw, duration_sec, cost_paise, status, error, created_at, completed_at')
      .eq('tenant_id', tenantId)
      .eq('message_id', messageId)
      .maybeSingle()

    if (error) {
      // RLS will surface as a missing row, not an error. A real error here
      // is a DB problem — surface 500 so the FE can show its generic
      // network-error state.
      res.status(500).json({ error: error.message })
      return
    }
    if (!data) {
      res.status(404).json({ error: 'transcript not found' })
      return
    }
    res.json({ transcript: data })
  })

  // ── POST /api/messages/:message_id/retry-transcript ─────────────────────
  r.post('/api/messages/:message_id/retry-transcript', ...guard, async (req, res) => {
    const tenantId = (req as any).tenantId as string | undefined
    if (!tenantId) {
      res.status(401).json({ error: 'tenant required' })
      return
    }
    const messageId = String(req.params.message_id ?? '').trim()
    if (!UUID_RE.test(messageId)) {
      res.status(400).json({ error: 'invalid message_id' })
      return
    }

    // Verify the message belongs to this tenant before we waste an enqueue.
    // RLS on `messages` already gates SELECT to tenant members; if the row
    // is invisible, treat as 404.
    const { data: msg, error: msgErr } = await supabase
      .from('messages')
      .select('id, tenant_id')
      .eq('id', messageId)
      .eq('tenant_id', tenantId)
      .maybeSingle()
    if (msgErr) {
      res.status(500).json({ error: msgErr.message })
      return
    }
    if (!msg) {
      res.status(404).json({ error: 'message not found' })
      return
    }

    // Re-seed the transcript row to status='pending' so the FE's polling
    // sees the spinner immediately instead of the stale 'failed' state.
    // Service-role client (same instance passed in via deps) bypasses RLS
    // for this targeted UPSERT.
    await supabase.from('voice_note_transcripts').upsert({
      tenant_id:  tenantId,
      message_id: messageId,
      provider:   'openai-whisper-1',
      text_raw:   '',
      status:     'pending',
      error:      null,
    }, { onConflict: 'message_id' as any })

    try {
      await enqueueVoiceNoteTranscribe({ tenantId, messageId })
    } catch (e: any) {
      // BullMQ duplicate-jobId means a transcription is already inflight.
      // That's fine — the FE will see status flip to completed/failed in due
      // course. Surface as 200 with a hint so the FE doesn't show an error.
      if (String(e?.message ?? e).toLowerCase().includes('already')) {
        res.json({ ok: true, queued: false, reason: 'already_queued' })
        return
      }
      res.status(500).json({ error: e?.message ?? 'enqueue_failed' })
      return
    }
    res.json({ ok: true, queued: true })
  })

  return r
}
