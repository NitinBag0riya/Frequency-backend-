/**
 * routes/inbox-presence.ts — Inbox agent-collision presence audit (P1 #16).
 *
 * Two endpoints, both server-side audit only. The live "Agent X is already
 * replying" toast in the inbox is driven by Supabase Realtime presence +
 * broadcast channels keyed by conversation — these endpoints exist purely so
 * we can answer "who handled this thread on Tuesday" without scraping
 * Realtime logs.
 *
 *   POST /api/inbox/presence/activity
 *     Body: { conversation_key: string, event_type: 'open' | 'typing_start' |
 *             'typing_stop' | 'reply_sent' | 'close' }
 *     Appends one row to inbox_agent_activity (tenant_id + user_id derived
 *     server-side from auth + identifyTenant). Fire-and-forget from the FE —
 *     a 500 here MUST NOT break the inbox.
 *
 *   GET  /api/inbox/conversations/:conversation_key/recent-activity?limit=50
 *     Returns the last N events for the thread, newest-first. Default 50,
 *     max 200. Used by the post-incident review UI (not yet wired) and by
 *     QA in smoke tests.
 *
 * NO write path here is allowed to gate or block any other inbox operation —
 * collision detection is advisory + visual. Concurrent sends from two
 * agents both persist; the FE just shows both messages.
 *
 * RLS on inbox_agent_activity (migration 083) is the source of truth for
 * cross-tenant safety. This router uses the request-scoped supabase client
 * (auth-bearer forwarded) so RLS is enforced.
 */

import express from 'express'
import { SupabaseClient } from '@supabase/supabase-js'

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

const VALID_EVENTS = new Set([
  'open',
  'typing_start',
  'typing_stop',
  'reply_sent',
  'close',
])

// conversation_key is a free-form FE-constructed string. Keep it short enough
// that a misbehaving client can't bloat the audit table. Format we currently
// emit is "<channel>:<phone>" e.g. "whatsapp:+919876543210" — well under 128.
const MAX_CONVERSATION_KEY_LEN = 256

export function createInboxPresenceRouter(deps: Deps): express.Router {
  const r = express.Router()
  const { supabase, requireAuth, identifyTenant } = deps
  const guard = [requireAuth, identifyTenant]

  // ── POST /api/inbox/presence/activity ───────────────────────────────────
  r.post('/api/inbox/presence/activity', ...guard, async (req, res) => {
    const userId   = (req as any).user?.id as string | undefined
    const tenantId = (req as any).tenantId as string | undefined
    if (!userId || !tenantId) {
      // requireAuth + identifyTenant should make this unreachable, but be
      // defensive — the FE treats this endpoint as fire-and-forget so a 500
      // here is harmless visually, but we'd rather return a clean 4xx so
      // smoke tests catch a regression in the guards.
      res.status(401).json({ error: 'auth + tenant required' })
      return
    }

    const body = req.body ?? {}
    const conversationKey = String(body.conversation_key ?? '').trim()
    const eventType       = String(body.event_type ?? '').trim()

    if (!conversationKey) {
      res.status(400).json({ error: 'conversation_key required' })
      return
    }
    if (conversationKey.length > MAX_CONVERSATION_KEY_LEN) {
      res.status(400).json({ error: `conversation_key must be <= ${MAX_CONVERSATION_KEY_LEN} chars` })
      return
    }
    if (!VALID_EVENTS.has(eventType)) {
      res.status(400).json({
        error: `event_type must be one of: ${[...VALID_EVENTS].join(', ')}`,
      })
      return
    }

    const { data, error } = await supabase
      .from('inbox_agent_activity')
      .insert({
        tenant_id:        tenantId,
        conversation_key: conversationKey,
        user_id:          userId,
        event_type:       eventType,
      })
      .select('id, occurred_at')
      .single()

    if (error) {
      // Surface but don't escalate — the FE ignores this response either way.
      res.status(500).json({ error: error.message })
      return
    }
    res.status(201).json({
      id:               data.id,
      occurred_at:      data.occurred_at,
      conversation_key: conversationKey,
      event_type:       eventType,
    })
  })

  // ── GET /api/inbox/conversations/:conversation_key/recent-activity ──────
  r.get(
    '/api/inbox/conversations/:conversation_key/recent-activity',
    ...guard,
    async (req, res) => {
      const tenantId = (req as any).tenantId as string | undefined
      if (!tenantId) {
        res.status(401).json({ error: 'tenant required' })
        return
      }

      const conversationKey = String(req.params.conversation_key ?? '').trim()
      if (!conversationKey) {
        res.status(400).json({ error: 'conversation_key required' })
        return
      }

      const rawLimit = Number(req.query.limit ?? 50)
      const limit = Number.isFinite(rawLimit)
        ? Math.min(200, Math.max(1, Math.floor(rawLimit)))
        : 50

      const { data, error } = await supabase
        .from('inbox_agent_activity')
        .select('id, user_id, event_type, occurred_at')
        .eq('tenant_id', tenantId)
        .eq('conversation_key', conversationKey)
        .order('occurred_at', { ascending: false })
        .limit(limit)

      if (error) {
        res.status(500).json({ error: error.message })
        return
      }
      res.json({ activity: data ?? [] })
    },
  )

  return r
}
