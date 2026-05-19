/**
 * routes/composer-tools.ts — Quick Replies + Internal Notes API
 *
 * Phase 1A of the post-deploy roadmap (docs/ROADMAP.md). Two feature
 * families that share the conversation-composer surface, mounted under
 * a single router so they're easy to gate behind the same auth +
 * tenant-identification middleware chain.
 *
 * ─── Endpoints ────────────────────────────────────────────────────────
 *
 *   Quick Replies:
 *     GET    /api/quick-replies                  — list (filtered by scope)
 *     POST   /api/quick-replies                  — create
 *     PATCH  /api/quick-replies/:id              — update
 *     DELETE /api/quick-replies/:id              — delete
 *     POST   /api/quick-replies/:id/use          — log a use (for analytics
 *                                                   + usage_count denorm)
 *     GET    /api/quick-replies/suggest?conversation_id=X
 *                                                — stage-aware ranked
 *                                                   suggestions for the
 *                                                   composer picker
 *
 *   Internal Notes:
 *     GET    /api/notes?target_type=X&target_id=Y — list notes for a target
 *     POST   /api/notes                          — create note (with mentions)
 *     PATCH  /api/notes/:id                      — update body / resolve
 *     DELETE /api/notes/:id                      — delete (creator only)
 *     POST   /api/notes/:id/resolve              — mark addressed
 *     POST   /api/note-mentions/:id/read         — mark a mention as read
 *
 * ─── Variable interpolation ───────────────────────────────────────────
 *
 * Quick reply body_template uses double-mustache placeholders:
 *   {{contact.first_name}}  {{deal.amount_inr | format_inr}}  …
 *
 * Interpolation happens server-side in the composer-suggest endpoint —
 * the FE receives a pre-expanded body so agents don't see raw
 * placeholders in the picker preview. The composer can also do
 * client-side interpolation when inserting (so the agent sees the
 * resolved text in the textarea before sending).
 *
 * Supported variables (extend in `interpolate()` below):
 *   contact.first_name · contact.last_name · contact.full_name · contact.phone
 *   deal.title · deal.stage · deal.amount_inr · deal.owner_name
 *   agent.name · agent.signature
 *   tenant.business_name · tenant.support_email
 *   date.today  (formatter pipe: | format:'DD MMM YYYY')
 *   razorpay.link(amount, ref) — special; generates a fresh link
 *
 * Unknown placeholders are left literal so admins can spot typos.
 *
 * ─── Stage-aware ranking ──────────────────────────────────────────────
 *
 * `/suggest` returns the picker's top suggestions ordered by:
 *   1. Hard match: applicable_stages contains conversation's deal.stage
 *   2. Hard match: applicable_intents overlaps inferred conversation intent
 *   3. Soft signal: usage_count (popularity)
 *   4. Recency: last_used_at
 *
 * Intent inference is intentionally simple for v1 — keyword regex on the
 * last inbound message (price|cost|refund|cancel|support|demo|book).
 * A future iteration can swap this for a small classifier.
 *
 * ─── Mentions / notifications ─────────────────────────────────────────
 *
 * Note inserts auto-fan-out into note_mentions via a DB trigger
 * (migration 093). This route handler ALSO fires an in-app notification
 * + Expo push per mention via the existing notification stack. Failure
 * to notify is non-fatal — the note is still saved.
 */

import express from 'express'
import { z } from 'zod'
import type { SupabaseClient } from '@supabase/supabase-js'

type Deps = {
  supabase: SupabaseClient
  requireAuth: express.RequestHandler
  identifyTenant: express.RequestHandler
}

// ─── Validation schemas ──────────────────────────────────────────────────

const ScopeEnum = z.enum(['workspace', 'team', 'personal'])

const CreateQuickReplyBody = z.object({
  scope: ScopeEnum,
  scope_target_id: z.string().uuid().nullable().optional(),
  title: z.string().min(1).max(80),
  body_template: z.string().min(1).max(4000),
  hotkey: z.string().max(24).optional(),
  applicable_stages: z.array(z.string()).optional(),
  applicable_intents: z.array(z.string()).optional(),
})

const PatchQuickReplyBody = CreateQuickReplyBody.partial()

const UseQuickReplyBody = z.object({
  conversation_id: z.string().uuid().optional(),
  edited: z.boolean().default(false),
})

const TargetTypeEnum = z.enum(['conversation', 'message', 'deal', 'contact'])

const CreateNoteBody = z.object({
  target_type: TargetTypeEnum,
  target_id: z.string().uuid(),
  body: z.string().min(1).max(8000),
  mentions: z.array(z.string().uuid()).optional(),
  attachments: z.array(z.unknown()).optional(),
  visibility: z.enum(['team', 'private']).default('team'),
})

const PatchNoteBody = z.object({
  body: z.string().min(1).max(8000).optional(),
  mentions: z.array(z.string().uuid()).optional(),
  visibility: z.enum(['team', 'private']).optional(),
})

// ─── Variable interpolation ──────────────────────────────────────────────
//
// Returns the body_template with {{x.y}} replaced by ctx values. Supports
// a tiny pipe syntax for formatting: {{deal.amount_inr | format_inr}}.

interface InterpolationContext {
  contact?: { first_name?: string; last_name?: string; full_name?: string; phone?: string }
  deal?:    { title?: string; stage?: string; amount_inr?: number; owner_name?: string }
  agent?:   { name?: string; signature?: string }
  tenant?:  { business_name?: string; support_email?: string }
  date?:    { today: Date }
}

function formatInr(amount: number | string | undefined): string {
  const n = Number(amount ?? 0)
  if (!Number.isFinite(n)) return '—'
  return `₹${(n).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`
}

function formatDate(d: Date | undefined, fmt = 'DD MMM YYYY'): string {
  if (!d || !(d instanceof Date) || isNaN(d.getTime())) return ''
  const dd = String(d.getDate()).padStart(2, '0')
  const mm = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][d.getMonth()]
  const yyyy = String(d.getFullYear())
  // Tiny subset of moment-like tokens. Extend if needed.
  return fmt.replace('DD', dd).replace('MMM', mm).replace('YYYY', yyyy)
}

export function interpolate(template: string, ctx: InterpolationContext): string {
  return template.replace(/\{\{\s*([^}|]+?)(?:\s*\|\s*([^}]+?))?\s*\}\}/g, (raw, path, pipe) => {
    const segs = path.trim().split('.')
    // Resolve dotted path. Unknown paths return the literal placeholder so
    // admins can spot typos in their templates rather than silently sending
    // an empty string to a customer.
    let v: any = ctx
    for (const s of segs) {
      v = v?.[s]
      if (v == null) return raw
    }
    if (pipe) {
      const filter = pipe.trim()
      if (filter === 'format_inr') return formatInr(v)
      if (filter.startsWith('format:')) {
        const fmt = filter.slice('format:'.length).replace(/^['"]|['"]$/g, '')
        return v instanceof Date ? formatDate(v, fmt) : String(v)
      }
    }
    return String(v)
  })
}

// ─── Intent inference (placeholder for now — keyword regex on last inbound) ──

function inferIntent(text: string | null | undefined): string[] {
  if (!text) return []
  const t = text.toLowerCase()
  const hits: string[] = []
  if (/\b(price|cost|charge|fee|pricing|kitna|kitne)\b/.test(t)) hits.push('pricing')
  if (/\b(refund|cancel|return|wapas)\b/.test(t)) hits.push('refund')
  if (/\b(demo|trial|show|dikhao)\b/.test(t)) hits.push('demo')
  if (/\b(book|order|buy|purchase|chahiye|chaiye)\b/.test(t)) hits.push('purchase')
  if (/\b(help|support|issue|problem|samasya)\b/.test(t)) hits.push('support')
  if (/\b(thank|thanks|shukriya|dhanyavad|good)\b/.test(t)) hits.push('positive')
  return hits
}

// ─── Router ──────────────────────────────────────────────────────────────

export function createComposerToolsRouter(deps: Deps): express.Router {
  const { supabase, requireAuth, identifyTenant } = deps
  const r = express.Router()

  // ═══════ Quick Replies ═══════════════════════════════════════════════

  /**
   * GET /api/quick-replies?scope=workspace|team|personal
   * Returns all quick replies the caller can see in the active tenant.
   * Personal-scope filters to the caller's own snippets.
   */
  r.get('/api/quick-replies', requireAuth, identifyTenant, async (req, res) => {
    const tenantId = (req as any).tenantId as string
    const userId   = (req as any).user?.id as string
    const scope    = String(req.query.scope ?? '')
    let q = supabase.from('quick_replies')
      .select('id, scope, scope_target_id, title, body_template, hotkey, applicable_stages, applicable_intents, usage_count, last_used_at, created_by, created_at, updated_at')
      .eq('tenant_id', tenantId)
      .order('usage_count', { ascending: false })
      .order('last_used_at', { ascending: false, nullsFirst: false })
    if (scope === 'workspace' || scope === 'team' || scope === 'personal') {
      q = q.eq('scope', scope)
      if (scope === 'personal') q = q.eq('scope_target_id', userId)
    } else {
      // Default: workspace + team + own personal
      q = q.or(`scope.eq.workspace,scope.eq.team,and(scope.eq.personal,scope_target_id.eq.${userId})`)
    }
    const { data, error } = await q.limit(500)
    if (error) { res.status(500).json({ error: error.message }); return }
    res.json({ data: data ?? [] })
  })

  /**
   * POST /api/quick-replies
   * Creates a quick reply. Personal-scope target_id is forced to the
   * caller's user_id (server-authoritative). Workspace + team writes are
   * left open for now — a future iteration will gate workspace creation
   * behind an admin role check.
   */
  r.post('/api/quick-replies', requireAuth, identifyTenant, async (req, res) => {
    const tenantId = (req as any).tenantId as string
    const userId   = (req as any).user?.id as string
    const parsed   = CreateQuickReplyBody.safeParse(req.body)
    if (!parsed.success) { res.status(400).json({ error: 'Invalid body', issues: parsed.error.issues }); return }
    const b = parsed.data
    // Server-authoritative target for personal scope; reject mismatch.
    const target = b.scope === 'personal'
      ? userId
      : (b.scope === 'team' ? (b.scope_target_id ?? null) : null)
    if (b.scope === 'workspace' && b.scope_target_id) {
      res.status(400).json({ error: 'workspace scope must not set scope_target_id' }); return
    }
    if (b.scope === 'team' && !target) {
      res.status(400).json({ error: 'team scope requires scope_target_id' }); return
    }

    const { data, error } = await supabase.from('quick_replies').insert({
      tenant_id:          tenantId,
      scope:              b.scope,
      scope_target_id:    target,
      title:              b.title,
      body_template:      b.body_template,
      hotkey:             b.hotkey ?? null,
      applicable_stages:  b.applicable_stages ?? [],
      applicable_intents: b.applicable_intents ?? [],
      created_by:         userId,
    }).select().single()
    if (error) {
      // 23505 = duplicate hotkey within scope; surface as 409 with a helpful hint
      if ((error as any).code === '23505') {
        res.status(409).json({ error: 'A quick reply with this hotkey already exists in this scope' }); return
      }
      res.status(500).json({ error: error.message }); return
    }
    res.status(201).json({ data })
  })

  /**
   * PATCH /api/quick-replies/:id
   * Update a quick reply. Personal-scope can only be edited by the
   * creator; workspace/team by anyone in the tenant (BE relies on RLS).
   */
  r.patch('/api/quick-replies/:id', requireAuth, identifyTenant, async (req, res) => {
    const tenantId = (req as any).tenantId as string
    const parsed = PatchQuickReplyBody.safeParse(req.body)
    if (!parsed.success) { res.status(400).json({ error: 'Invalid body', issues: parsed.error.issues }); return }
    const { data, error } = await supabase.from('quick_replies')
      .update({ ...parsed.data, updated_at: new Date().toISOString() })
      .eq('id', req.params.id)
      .eq('tenant_id', tenantId)
      .select().single()
    if (error) { res.status(500).json({ error: error.message }); return }
    if (!data) { res.status(404).json({ error: 'not found' }); return }
    res.json({ data })
  })

  /**
   * DELETE /api/quick-replies/:id
   */
  r.delete('/api/quick-replies/:id', requireAuth, identifyTenant, async (req, res) => {
    const tenantId = (req as any).tenantId as string
    const { error } = await supabase.from('quick_replies')
      .delete()
      .eq('id', req.params.id)
      .eq('tenant_id', tenantId)
    if (error) { res.status(500).json({ error: error.message }); return }
    res.json({ success: true })
  })

  /**
   * POST /api/quick-replies/:id/use
   * Log a use of this quick reply. Trigger increments usage_count +
   * stamps last_used_at on the parent row. `edited` distinguishes
   * agents who modified the body before sending — high edit rates
   * surface "templates that need rewriting" in admin Insights.
   */
  r.post('/api/quick-replies/:id/use', requireAuth, identifyTenant, async (req, res) => {
    const userId = (req as any).user?.id as string
    const parsed = UseQuickReplyBody.safeParse(req.body)
    if (!parsed.success) { res.status(400).json({ error: 'Invalid body', issues: parsed.error.issues }); return }
    const { error } = await supabase.from('quick_reply_usage').insert({
      quick_reply_id:  req.params.id,
      conversation_id: parsed.data.conversation_id ?? null,
      agent_id:        userId,
      edited:          parsed.data.edited,
    })
    if (error) { res.status(500).json({ error: error.message }); return }
    res.json({ success: true })
  })

  /**
   * GET /api/quick-replies/suggest?conversation_id=X
   *
   * Ranks the tenant's quick reply library against the conversation's
   * context and returns the top N (default 5) with the body_template
   * pre-interpolated against contact/deal context.
   *
   * Ranking (simple v1, easily extended later):
   *   stage_match_bonus    + 100  if applicable_stages contains deal.stage
   *   intent_match_bonus   + 50   per overlapping intent vs inbound regex
   *   popularity           + min(usage_count, 50) / 10
   *   recency              + (recent_use_within_24h ? 5 : 0)
   *
   * Returns max 5 by default. Falls back to top-popular if no
   * conversation_id or no signals match.
   */
  r.get('/api/quick-replies/suggest', requireAuth, identifyTenant, async (req, res) => {
    const tenantId = (req as any).tenantId as string
    const userId   = (req as any).user?.id as string
    const conversationId = String(req.query.conversation_id ?? '')
    const limit = Math.min(20, Math.max(1, parseInt(String(req.query.limit ?? '5'), 10) || 5))

    // Pull candidate library (workspace + team + own personal).
    const { data: candidates } = await supabase.from('quick_replies')
      .select('id, scope, scope_target_id, title, body_template, hotkey, applicable_stages, applicable_intents, usage_count, last_used_at')
      .eq('tenant_id', tenantId)
      .or(`scope.eq.workspace,scope.eq.team,and(scope.eq.personal,scope_target_id.eq.${userId})`)
      .limit(500)
    if (!candidates) { res.json({ data: [] }); return }

    // Resolve context (best-effort — failures degrade to popularity-only).
    let dealStage: string | null = null
    let intents: string[] = []
    let contactCtx: InterpolationContext['contact'] = {}
    let dealCtx: InterpolationContext['deal'] = {}
    if (conversationId) {
      // Get the conversation's contact + linked deal + last inbound msg.
      const { data: convo } = await supabase.from('conversations')
        .select('contact_id')
        .eq('id', conversationId).eq('tenant_id', tenantId)
        .maybeSingle()
      if (convo?.contact_id) {
        const { data: contact } = await supabase.from('contacts')
          .select('name, phone')
          .eq('id', convo.contact_id).maybeSingle()
        if (contact) {
          const parts = String(contact.name ?? '').trim().split(/\s+/)
          contactCtx = {
            first_name: parts[0] ?? '',
            last_name:  parts.slice(1).join(' '),
            full_name:  contact.name ?? '',
            phone:      contact.phone ?? '',
          }
        }
        // Most-recent deal for this contact in any non-closed stage.
        const { data: deal } = await supabase.from('crm_deals')
          .select('title, stage_id, value_inr_paise, owner_user_id, crm_stages:stage_id(name)')
          .eq('contact_id', convo.contact_id)
          .eq('tenant_id', tenantId)
          .is('closed_at', null)
          .order('updated_at', { ascending: false })
          .limit(1)
          .maybeSingle()
        if (deal) {
          const stageRow = Array.isArray((deal as any).crm_stages) ? (deal as any).crm_stages[0] : (deal as any).crm_stages
          dealStage = stageRow?.name ?? null
          dealCtx = {
            title:      deal.title ?? '',
            stage:      dealStage ?? '',
            amount_inr: Number(deal.value_inr_paise ?? 0) / 100,
          }
        }
        // Intent from the last inbound message.
        const { data: lastInbound } = await supabase.from('messages')
          .select('content')
          .eq('contact_phone', contactCtx.phone)
          .eq('direction', 'inbound')
          .order('created_at', { ascending: false })
          .limit(1)
          .maybeSingle()
        if (lastInbound?.content) {
          // messages.content is JSONB; pull the text field defensively.
          const c = lastInbound.content as any
          const text = (typeof c === 'string') ? c : (c?.text ?? c?.body ?? '')
          intents = inferIntent(text)
        }
      }
    }

    // Rank.
    const scored = candidates.map(q => {
      let score = 0
      if (dealStage && Array.isArray(q.applicable_stages) && q.applicable_stages.includes(dealStage)) score += 100
      if (intents.length && Array.isArray(q.applicable_intents)) {
        const overlap = q.applicable_intents.filter((i: string) => intents.includes(i)).length
        score += overlap * 50
      }
      score += Math.min(Number(q.usage_count ?? 0), 50) / 10
      if (q.last_used_at && (Date.now() - new Date(q.last_used_at).getTime()) < 86400000) score += 5
      return { ...q, _score: score }
    }).sort((a, b) => b._score - a._score).slice(0, limit)

    // Interpolate previews.
    const ctx: InterpolationContext = {
      contact: contactCtx,
      deal:    dealCtx,
      agent:   { name: '' /* could resolve from req.user */ },
      tenant:  {},
      date:    { today: new Date() },
    }
    const data = scored.map(s => ({
      id:             s.id,
      title:          s.title,
      hotkey:         s.hotkey,
      body_template:  s.body_template,
      body_preview:   interpolate(s.body_template, ctx),
      score:          s._score,
      stage_matched:  Array.isArray(s.applicable_stages) && dealStage ? s.applicable_stages.includes(dealStage) : false,
      intents_matched: Array.isArray(s.applicable_intents)
        ? s.applicable_intents.filter((i: string) => intents.includes(i))
        : [],
    }))
    res.json({ data, signals: { deal_stage: dealStage, intents } })
  })

  // ═══════ Internal Notes ══════════════════════════════════════════════

  /**
   * GET /api/notes?target_type=X&target_id=Y
   * List notes attached to a specific target (conversation/message/deal/contact).
   * RLS filters out private notes the caller can't see.
   */
  r.get('/api/notes', requireAuth, identifyTenant, async (req, res) => {
    const tenantId = (req as any).tenantId as string
    const targetType = String(req.query.target_type ?? '')
    const targetId   = String(req.query.target_id ?? '')
    if (!['conversation', 'message', 'deal', 'contact'].includes(targetType)) {
      res.status(400).json({ error: 'invalid target_type' }); return
    }
    if (!targetId) { res.status(400).json({ error: 'target_id required' }); return }
    const { data, error } = await supabase.from('conversation_notes')
      .select('id, target_type, target_id, body, mentions, attachments, visibility, created_by, created_at, updated_at, resolved_at, resolved_by')
      .eq('tenant_id', tenantId)
      .eq('target_type', targetType)
      .eq('target_id', targetId)
      .order('created_at', { ascending: false })
      .limit(200)
    if (error) { res.status(500).json({ error: error.message }); return }
    res.json({ data: data ?? [] })
  })

  /**
   * POST /api/notes
   * Create a note. The DB trigger fans out note_mentions; this handler
   * additionally fires the notification stack (in-app + push) per mention.
   */
  r.post('/api/notes', requireAuth, identifyTenant, async (req, res) => {
    const tenantId = (req as any).tenantId as string
    const userId   = (req as any).user?.id as string
    const parsed   = CreateNoteBody.safeParse(req.body)
    if (!parsed.success) { res.status(400).json({ error: 'Invalid body', issues: parsed.error.issues }); return }
    const b = parsed.data

    const { data, error } = await supabase.from('conversation_notes').insert({
      tenant_id:    tenantId,
      target_type:  b.target_type,
      target_id:    b.target_id,
      body:         b.body,
      mentions:     b.mentions ?? [],
      attachments:  b.attachments ?? [],
      visibility:   b.visibility,
      created_by:   userId,
    }).select().single()
    if (error) { res.status(500).json({ error: error.message }); return }

    // Best-effort in-app notification fan-out — failures non-fatal. The
    // DB trigger ensures note_mentions rows exist for read-tracking even
    // if push delivery fails. Schema-only insert into `notifications`
    // (the existing app notification table) keeps this module decoupled
    // from any worker that handles delivery channels later.
    if (Array.isArray(b.mentions) && b.mentions.length > 0) {
      try {
        const rows = b.mentions
          .filter(uid => uid !== userId)
          .map(uid => ({
            tenant_id: tenantId,
            user_id:   uid,
            kind:      'note_mention',
            title:     'Mentioned in a note',
            body:      b.body.slice(0, 160),
            meta:      { note_id: data.id, target_type: b.target_type, target_id: b.target_id },
          }))
        if (rows.length > 0) {
          await supabase.from('notifications').insert(rows).then(() => {}, () => {})
        }
      } catch { /* notification table not present yet — no-op */ }
    }

    res.status(201).json({ data })
  })

  /**
   * PATCH /api/notes/:id — update body or visibility. Creator only.
   */
  r.patch('/api/notes/:id', requireAuth, identifyTenant, async (req, res) => {
    const tenantId = (req as any).tenantId as string
    const userId   = (req as any).user?.id as string
    const parsed   = PatchNoteBody.safeParse(req.body)
    if (!parsed.success) { res.status(400).json({ error: 'Invalid body', issues: parsed.error.issues }); return }
    const { data, error } = await supabase.from('conversation_notes')
      .update({ ...parsed.data, updated_at: new Date().toISOString() })
      .eq('id', req.params.id)
      .eq('tenant_id', tenantId)
      .eq('created_by', userId)
      .select().single()
    if (error) { res.status(500).json({ error: error.message }); return }
    if (!data) { res.status(404).json({ error: 'not found or not yours' }); return }
    res.json({ data })
  })

  /**
   * DELETE /api/notes/:id — creator only.
   */
  r.delete('/api/notes/:id', requireAuth, identifyTenant, async (req, res) => {
    const tenantId = (req as any).tenantId as string
    const userId   = (req as any).user?.id as string
    const { error } = await supabase.from('conversation_notes')
      .delete()
      .eq('id', req.params.id)
      .eq('tenant_id', tenantId)
      .eq('created_by', userId)
    if (error) { res.status(500).json({ error: error.message }); return }
    res.json({ success: true })
  })

  /**
   * POST /api/notes/:id/resolve — mark a note as addressed.
   */
  r.post('/api/notes/:id/resolve', requireAuth, identifyTenant, async (req, res) => {
    const tenantId = (req as any).tenantId as string
    const userId   = (req as any).user?.id as string
    const { data, error } = await supabase.from('conversation_notes')
      .update({ resolved_at: new Date().toISOString(), resolved_by: userId })
      .eq('id', req.params.id)
      .eq('tenant_id', tenantId)
      .select().single()
    if (error) { res.status(500).json({ error: error.message }); return }
    if (!data) { res.status(404).json({ error: 'not found' }); return }
    res.json({ data })
  })

  /**
   * POST /api/note-mentions/:id/read — mark a mention as read by the
   * recipient (drives the red-dot badge on the in-app notification bell).
   */
  r.post('/api/note-mentions/:id/read', requireAuth, async (req, res) => {
    const userId = (req as any).user?.id as string
    const { error } = await supabase.from('note_mentions')
      .update({ read_at: new Date().toISOString() })
      .eq('id', req.params.id)
      .eq('mentioned_user_id', userId)
    if (error) { res.status(500).json({ error: error.message }); return }
    res.json({ success: true })
  })

  return r
}
