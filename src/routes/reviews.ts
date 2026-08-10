/**
 * Reviews & Ratings — unified inbox + analytics + low-rating alert.
 *
 * One normalised table (public.reviews) fed by three sources:
 *   • storefront — ours; real read + real reply (this app owns the surface).
 *   • zomato     — review LIST endpoint known; per-review ROW shape + reply
 *                  endpoint are capture-gated → reply is QUEUED, never faked.
 *   • swiggy     — only an AGGREGATE rating is exposed today → is_aggregate row;
 *                  per-review rows + reply stay disabled until captured.
 *
 * Honesty rule (docs/reviews-ratings-design.md §0): NEVER claim an aggregator
 * reply posted that we didn't verify from a live capture. Aggregator reply →
 * reply_status='queued'/'unsupported'. Only storefront replies go to 'sent'.
 *
 * Gating: HoReCa vertical (business_type='horeca') + role/plan via checkPermission.
 * Low-rating alert reuses emitNotification verbatim — no new dispatch code.
 *
 *   GET  /api/reviews                 inbox list (filters + pagination)
 *   GET  /api/reviews/analytics       R11 charts (avg/trend/dish/distribution/reply-rate)
 *   GET  /api/reviews/:id             detail
 *   POST /api/reviews/:id/reply       storefront=sent · aggregator=queued/unsupported
 *   POST /api/reviews/:id/draft-reply deterministic suggestion (recommendation only)
 *   POST /api/reviews/:id/status      new|seen|actioned|ignored
 *   POST /api/reviews/:id/tag         append operator tag
 *   POST /api/reviews/:id/link-complaint  set complaint_ref
 *   POST /api/reviews/ingest          server-to-server (storefront-api + future aggregator)
 */

import express from 'express'
import crypto from 'crypto'
import { SupabaseClient } from '@supabase/supabase-js'
import { emitNotification, tenantNotifyRecipients } from './notifications'

type Mw = (req: express.Request, res: express.Response, next: express.NextFunction) => void | Promise<void>

const SOURCES = ['storefront', 'zomato', 'swiggy'] as const
const REPLY_UNSUPPORTED: Record<string, boolean> = { zomato: true, swiggy: true }
const STATUSES = ['new', 'seen', 'actioned', 'ignored'] as const

// HoReCa theme label set (§7). Keyword → theme; first-match, cheap, deterministic.
const THEME_KEYWORDS: [string, RegExp][] = [
  ['taste',         /\b(taste|tasty|flavou?r|bland|delicious|yummy|spicy|salty|undercook|overcook|stale)\b/i],
  ['portion',       /\b(portion|quantity|small|tiny|less|little|size)\b/i],
  ['packaging',     /\b(packag|leak|spill|container|box|sealed|wrap)\b/i],
  ['delivery-time', /\b(late|delay|slow|wait|time|took .*hour|took .*hr)\b/i],
  ['temperature',   /\b(cold|warm|hot|luke ?warm|not hot)\b/i],
  ['price',         /\b(price|expensive|costly|overpriced|worth|money)\b/i],
  ['service',       /\b(service|staff|rude|behav|waiter|delivery boy|rider)\b/i],
  ['hygiene',       /\b(hygien|dirty|hair|insect|unclean|smell|rotten)\b/i],
  ['missing-item',  /\b(missing|forgot|didn'?t get|not received|wrong item|incomplete)\b/i],
]

// ── Pure normalisation helpers (unit-tested in reviews.selfcheck.ts) ─────────

/** Project a provider rating onto a 1–5 star integer. null rating → null stars. */
export function normalizeStars(rating: number | null | undefined, scale = 5): number | null {
  if (rating == null || !Number.isFinite(Number(rating))) return null
  const r = Number(rating)
  const projected = scale === 5 ? r : (r / scale) * 5
  return Math.max(1, Math.min(5, Math.round(projected)))
}

/** Floor sentiment from stars (§7): ≤2 negative, 3 neutral, ≥4 positive. */
export function deriveSentiment(stars: number | null): string | null {
  if (stars == null) return null
  if (stars <= 2) return 'negative'
  if (stars === 3) return 'neutral'
  return 'positive'
}

/** Extract HoReCa themes from free text. Empty array when no text / no match. */
export function deriveThemes(text: string | null | undefined): string[] {
  if (!text) return []
  const out: string[] = []
  for (const [theme, re] of THEME_KEYWORDS) if (re.test(text)) out.push(theme)
  return out
}

function snippet(text: string | null | undefined, n = 90): string {
  if (!text) return ''
  const t = String(text).trim()
  return t.length > n ? t.slice(0, n - 1) + '…' : t
}

// ── Ingest (shared by storefront mirror + future aggregator sync) ────────────

export interface ReviewInput {
  tenantId: string
  source: string
  sourceReviewId: string          // ALWAYS supplied (order id / review id / agg:<outlet>:<date>)
  orderRef?: string | null
  outletRef?: string | null
  rating?: number | null
  ratingScale?: number
  isAggregate?: boolean
  title?: string | null
  text?: string | null
  dishRatings?: any
  tags?: string[] | null
  customerName?: string | null
  customerRef?: string | null
  businessLine?: string | null
  sourceMeta?: any
  reviewAt?: string | null
}

/**
 * Upsert one review row (idempotent on unique(tenant,source,source_review_id))
 * and — for a real ≤3★ review — fire review.low via emitNotification.
 *
 * Dedupe is free: a replayed row upserts, so a status re-sync doesn't re-ring.
 * We only emit when the row is NEW and low (checked against the pre-upsert state).
 */
export async function ingestReview(supabase: SupabaseClient, input: ReviewInput): Promise<{ ok: boolean; id?: string; emitted?: boolean; error?: string }> {
  if (!input.tenantId || !SOURCES.includes(input.source as any) || !input.sourceReviewId) {
    return { ok: false, error: 'tenantId, valid source, and sourceReviewId required' }
  }
  const scale = input.ratingScale && input.ratingScale > 0 ? input.ratingScale : 5
  const isAgg = !!input.isAggregate
  const stars = normalizeStars(input.rating, scale)
  const text = input.text ? String(input.text).slice(0, 2000) : null
  const sentiment = text || stars != null ? deriveSentiment(stars) : null
  const theme = deriveThemes(text)

  // Was there already a row? (decides whether to emit — never re-alert a re-sync)
  const { data: existing } = await supabase.from('reviews')
    .select('id, reply_status')
    .eq('tenant_id', input.tenantId).eq('source', input.source).eq('source_review_id', input.sourceReviewId)
    .maybeSingle()

  const row: any = {
    tenant_id: input.tenantId,
    source: input.source,
    source_review_id: input.sourceReviewId,
    order_ref: input.orderRef ?? null,
    outlet_ref: input.outletRef ?? null,
    rating: input.rating ?? null,
    rating_scale: scale,
    stars,
    is_aggregate: isAgg,
    title: input.title ?? null,
    text,
    dish_ratings: input.dishRatings ?? null,
    tags: input.tags ?? null,
    customer_name: input.customerName ?? null,
    customer_ref: input.customerRef ?? null,
    business_line: input.businessLine ?? null,
    sentiment,
    theme,
    source_meta: input.sourceMeta ?? null,
    review_at: input.reviewAt ?? new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }

  const { data: saved, error } = await supabase.from('reviews')
    .upsert(row, { onConflict: 'tenant_id,source,source_review_id' })
    .select('id').single()
  if (error) { console.warn('[reviews] upsert failed:', error.message); return { ok: false, error: error.message } }

  // Real-time low-rating alert: only for a NEW, real (non-aggregate) ≤3★ review.
  let emitted = false
  if (!existing && !isAgg && stars != null && stars <= 3) {
    try {
      const recipients = await tenantNotifyRecipients(supabase, input.tenantId)
      // Gate to owner/admin/manager (§5) — captain/kitchen never get the review ping.
      const gated = await gateReviewRecipients(supabase, input.tenantId, recipients)
      if (gated.length) {
        const { data: t } = await supabase.from('tenants').select('name').eq('id', input.tenantId).maybeSingle()
        await emitNotification(supabase, {
          tenant_id: input.tenantId,
          event_key: 'review.low',
          recipient_user_ids: gated,
          data: {
            source: input.source, stars,
            text_snippet: snippet(text) || '(no comment)',
            customer_name: input.customerName || 'A customer',
            outlet: input.outletRef || (t as any)?.name || '',
            review_id: (saved as any).id,
          },
          link: `/reviews?open=${(saved as any).id}`,
        })
        emitted = true
      }
    } catch (e: any) { console.warn('[reviews] review.low emit failed:', e?.message ?? e) }
  }
  return { ok: true, id: (saved as any).id, emitted }
}

/**
 * Filter notification recipients to owner/admin/manager per spec §5. The tenant
 * OWNER (tenants.user_id) always qualifies; team members qualify only when their
 * role is a management role. captain/kitchen/others are dropped.
 */
async function gateReviewRecipients(supabase: SupabaseClient, tenantId: string, userIds: string[]): Promise<string[]> {
  if (!userIds.length) return []
  const { data: owner } = await supabase.from('tenants').select('user_id').eq('id', tenantId).maybeSingle()
  const ownerId = (owner as any)?.user_id
  const { data: rows } = await supabase.from('user_role_assignments')
    .select('user_id, role_definitions ( key )')
    .eq('tenant_id', tenantId).is('disabled_at', null).in('user_id', userIds)
  const MANAGER_ROLES = new Set(['owner', 'workspace_admin', 'sales_manager', 'marketing_manager', 'support_lead', 'finance', 'manager', 'admin'])
  const allowed = new Set<string>()
  if (ownerId && userIds.includes(ownerId)) allowed.add(ownerId)
  for (const r of (rows ?? []) as any[]) {
    const key = String(r.role_definitions?.key ?? '')
    if (MANAGER_ROLES.has(key)) allowed.add(r.user_id)
  }
  return userIds.filter(id => allowed.has(id))
}

/**
 * Daily digest (review.digest). Reuse the existing report/worker cron — call this
 * once per tenant per day (no idle worker). Counts today's reviews, avg stars,
 * and unanswered ≤3★. No-op when there's nothing to report.
 */
export async function reviewDailyDigest(supabase: SupabaseClient, tenantId: string): Promise<void> {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
  const { data: rows } = await supabase.from('reviews')
    .select('stars, is_aggregate, reply_status, review_at')
    .eq('tenant_id', tenantId).gte('review_at', since)
  const list = (rows ?? []).filter((r: any) => !r.is_aggregate && r.stars != null)
  if (!list.length) return
  const total = list.length
  const avg = list.reduce((n: number, r: any) => n + r.stars, 0) / total
  const unansweredLow = list.filter((r: any) => r.stars <= 3 && (r.reply_status === 'none' || r.reply_status === 'draft')).length
  const recipients = await gateReviewRecipients(supabase, tenantId, await tenantNotifyRecipients(supabase, tenantId))
  if (!recipients.length) return
  await emitNotification(supabase, {
    tenant_id: tenantId,
    event_key: 'review.digest',
    recipient_user_ids: recipients,
    data: { total, avg_stars: avg.toFixed(1), unanswered_low: unansweredLow },
    link: '/reviews?filter=low-unanswered',
  })
}

// ── Router ───────────────────────────────────────────────────────────────────

export function createReviewsRouter(supabase: SupabaseClient, requireAuth: Mw, identifyTenant: Mw, checkPermission: (f: string, a: 'view' | 'edit' | 'delete') => Mw) {
  const r = express.Router()

  // Hard vertical gate — HoReCa only (mirrors the aggregator connector's inline
  // business_type check). Runs after identifyTenant so tenantId is set.
  const horecaGate: Mw = async (req, res, next) => {
    const tenantId = (req as any).tenantId
    if (!tenantId) { res.status(401).json({ error: 'unauthorized' }); return }
    const { data: t } = await supabase.from('tenants').select('business_type').eq('id', tenantId).maybeSingle()
    const bt = String((t as any)?.business_type ?? '').toLowerCase()
    if (bt && bt !== 'horeca') { res.status(422).json({ error: 'Reviews & Ratings is available for HoReCa (restaurant) tenants only' }); return }
    next()
  }

  // Reuse the aggregator sibling's feature key ('integrations') so no new plan
  // feature is needed and HoReCa tenants with the aggregator surface pass. Role
  // specificity (owner/admin/manager) is enforced by the role→feature matrix.
  const view = [requireAuth, identifyTenant, horecaGate, checkPermission('integrations', 'view')]
  const edit = [requireAuth, identifyTenant, horecaGate, checkPermission('integrations', 'edit')]

  // ── Inbox list ──────────────────────────────────────────────────────────
  r.get('/api/reviews', ...view, async (req, res) => {
    const tenantId = (req as any).tenantId
    const q = req.query as Record<string, string>
    const page = Math.max(1, parseInt(q.page || '1', 10) || 1)
    const pageSize = Math.min(100, Math.max(1, parseInt(q.pageSize || '25', 10) || 25))
    const from = (page - 1) * pageSize

    let sel = supabase.from('reviews').select('*', { count: 'exact' }).eq('tenant_id', tenantId)
    if (q.source && SOURCES.includes(q.source as any)) sel = sel.eq('source', q.source)
    if (q.outlet) sel = sel.eq('outlet_ref', q.outlet)
    if (q.business_line) sel = sel.eq('business_line', q.business_line)
    if (q.reply_status) sel = sel.eq('reply_status', q.reply_status)
    if (q.status) sel = sel.eq('status', q.status)
    if (q.stars) sel = sel.eq('stars', parseInt(q.stars, 10))
    if (q.max_stars) sel = sel.lte('stars', parseInt(q.max_stars, 10))
    if (q.has_text === 'true') sel = sel.not('text', 'is', null)
    if (q.from) sel = sel.gte('review_at', q.from)
    if (q.to) sel = sel.lte('review_at', q.to)
    // The work queue: ≤3★ real reviews without a reply yet.
    if (q.filter === 'low-unanswered') {
      sel = sel.eq('is_aggregate', false).lte('stars', 3).in('reply_status', ['none', 'draft'])
    }

    const { data, error, count } = await sel
      .order('review_at', { ascending: false, nullsFirst: false })
      .range(from, from + pageSize - 1)
    if (error) { res.status(500).json({ error: error.message }); return }
    res.json({ reviews: data ?? [], total: count ?? 0, page, pageSize })
  })

  // ── Analytics (R11) ───────────────────────────────────────────────────────
  // Funnel-scoped aggregates only — no per-interaction tracking. Bounded window.
  r.get('/api/reviews/analytics', ...view, async (req, res) => {
    const tenantId = (req as any).tenantId
    const days = Math.min(365, Math.max(7, parseInt((req.query.days as string) || '30', 10) || 30))
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString()
    const { data, error } = await supabase.from('reviews')
      .select('source, stars, is_aggregate, reply_status, review_at, reply_at, dish_ratings, theme, sentiment')
      .eq('tenant_id', tenantId).gte('review_at', since)
    if (error) { res.status(500).json({ error: error.message }); return }
    res.json(buildAnalytics(data ?? []))
  })

  // ── Detail ────────────────────────────────────────────────────────────────
  r.get('/api/reviews/:id', ...view, async (req, res) => {
    const tenantId = (req as any).tenantId
    const { data, error } = await supabase.from('reviews')
      .select('*').eq('tenant_id', tenantId).eq('id', String(req.params.id)).maybeSingle()
    if (error) { res.status(500).json({ error: error.message }); return }
    if (!data) { res.status(404).json({ error: 'Review not found' }); return }
    res.json(data)
  })

  // ── Reply ─────────────────────────────────────────────────────────────────
  // storefront → real: reply persisted + status 'sent' (we own the surface; the
  // customer sees it via the storefront reply-render path). aggregator → 'queued'
  // / 'unsupported': composed but NEVER marked sent until a live reply capture
  // verifies the request contract. This is the honesty boundary — do not "fix" it
  // by defaulting aggregators to 'sent'.
  r.post('/api/reviews/:id/reply', ...edit, async (req, res) => {
    const tenantId = (req as any).tenantId
    const userId = (req as any).user?.id ?? null
    const body = String((req.body as any)?.reply_text ?? '').trim().slice(0, 2000)
    if (!body) { res.status(400).json({ error: 'reply_text required' }); return }
    const { data: rev } = await supabase.from('reviews')
      .select('id, source, is_aggregate').eq('tenant_id', tenantId).eq('id', String(req.params.id)).maybeSingle()
    if (!rev) { res.status(404).json({ error: 'Review not found' }); return }
    if ((rev as any).is_aggregate) { res.status(422).json({ error: 'Aggregate ratings have no individual review to reply to' }); return }

    const aggregator = REPLY_UNSUPPORTED[(rev as any).source]
    const reply_status = aggregator ? 'queued' : 'sent'
    const { data, error } = await supabase.from('reviews')
      .update({ reply_text: body, reply_status, reply_at: new Date().toISOString(), reply_by: userId, updated_at: new Date().toISOString() })
      .eq('tenant_id', tenantId).eq('id', String(req.params.id)).select('*').single()
    if (error) { res.status(500).json({ error: error.message }); return }
    res.json({
      review: data,
      queued: aggregator,
      message: aggregator
        ? `Reply saved. It will post once the ${(rev as any).source} reply channel is verified.`
        : 'Reply sent.',
    })
  })

  // ── Draft reply (recommendation only) ──────────────────────────────────────
  // Deterministic template from stars + theme — no LLM dep, no auto-send. The
  // operator edits before it goes out. Reuse the copilot/LLM seam later if desired.
  r.post('/api/reviews/:id/draft-reply', ...edit, async (req, res) => {
    const tenantId = (req as any).tenantId
    const { data: rev } = await supabase.from('reviews')
      .select('stars, theme, customer_name, text').eq('tenant_id', tenantId).eq('id', String(req.params.id)).maybeSingle()
    if (!rev) { res.status(404).json({ error: 'Review not found' }); return }
    res.json({ draft: draftReply(rev as any) })
  })

  // ── Status / tag / complaint link ──────────────────────────────────────────
  r.post('/api/reviews/:id/status', ...edit, async (req, res) => {
    const tenantId = (req as any).tenantId
    const status = String((req.body as any)?.status ?? '')
    if (!STATUSES.includes(status as any)) { res.status(400).json({ error: `status must be one of ${STATUSES.join('|')}` }); return }
    const { data, error } = await supabase.from('reviews')
      .update({ status, updated_at: new Date().toISOString() })
      .eq('tenant_id', tenantId).eq('id', String(req.params.id)).select('*').single()
    if (error) { res.status(error.code === 'PGRST116' ? 404 : 500).json({ error: error.message }); return }
    res.json(data)
  })

  r.post('/api/reviews/:id/tag', ...edit, async (req, res) => {
    const tenantId = (req as any).tenantId
    const tag = String((req.body as any)?.tag ?? '').trim().slice(0, 40)
    if (!tag) { res.status(400).json({ error: 'tag required' }); return }
    const { data: rev } = await supabase.from('reviews')
      .select('tags').eq('tenant_id', tenantId).eq('id', String(req.params.id)).maybeSingle()
    if (!rev) { res.status(404).json({ error: 'Review not found' }); return }
    const tags = Array.from(new Set([...((rev as any).tags ?? []), tag]))
    const { data, error } = await supabase.from('reviews')
      .update({ tags, updated_at: new Date().toISOString() })
      .eq('tenant_id', tenantId).eq('id', String(req.params.id)).select('*').single()
    if (error) { res.status(500).json({ error: error.message }); return }
    res.json(data)
  })

  r.post('/api/reviews/:id/link-complaint', ...edit, async (req, res) => {
    const tenantId = (req as any).tenantId
    const complaint_ref = String((req.body as any)?.complaint_ref ?? '').trim().slice(0, 120) || null
    const { data, error } = await supabase.from('reviews')
      .update({ complaint_ref, updated_at: new Date().toISOString() })
      .eq('tenant_id', tenantId).eq('id', String(req.params.id)).select('*').single()
    if (error) { res.status(error.code === 'PGRST116' ? 404 : 500).json({ error: error.message }); return }
    res.json(data)
  })

  // ── Server-to-server ingest ────────────────────────────────────────────────
  // Called by storefront-api's feedback mirror (and, later, the aggregator sync).
  // Authenticated by the shared storefront admin secret — NOT a user session —
  // same model as /api/storefront/order-sync. Fires review.low on ≤3★.
  r.post('/api/reviews/ingest', async (req, res) => {
    if (!ingestSecretOk(req)) { res.status(401).json({ ok: false, error: 'unauthorized' }); return }
    const b = (req.body ?? {}) as any
    let tenantId: string | null = b.tenantId ?? null
    // Storefront posts a slug (it doesn't know the uuid) — resolve like order-sync.
    if (!tenantId && b.slug) {
      const { data: t } = await supabase.from('tenants').select('id').eq('slug', String(b.slug)).maybeSingle()
      tenantId = (t as any)?.id ?? null
    }
    if (!tenantId) { res.status(404).json({ ok: false, error: 'unknown tenant' }); return }
    const out = await ingestReview(supabase, { ...b, tenantId })
    if (!out.ok) { res.status(400).json({ ok: false, error: out.error }); return }
    res.json({ ok: true, id: out.id, emitted: out.emitted })
  })

  return r
}

// ── helpers ──────────────────────────────────────────────────────────────────

function ingestSecretOk(req: express.Request): boolean {
  const expected = process.env.STOREFRONT_ADMIN_SECRET || 'dev-admin'
  const got = req.header('X-Admin-Secret') || ''
  const a = Buffer.from(got, 'utf8')
  const b = Buffer.from(expected, 'utf8')
  return a.length === b.length && crypto.timingSafeEqual(a, b)
}

/** Deterministic reply suggestion — recommendation only, operator edits before send. */
export function draftReply(rev: { stars: number | null; theme?: string[] | null; customer_name?: string | null }): string {
  const name = rev.customer_name && rev.customer_name !== 'A customer' ? ` ${rev.customer_name.split(' ')[0]}` : ''
  if (rev.stars != null && rev.stars >= 4) {
    return `Thank you so much${name}! We're thrilled you enjoyed your order and can't wait to serve you again.`
  }
  const theme = (rev.theme ?? [])[0]
  const apology: Record<string, string> = {
    'delivery-time': 'the delay — we\'re working with our team to get orders out faster',
    'temperature': 'the food not reaching you hot — we\'re reviewing our packaging and dispatch',
    'packaging': 'the packaging issue — we\'re fixing this with our kitchen',
    'missing-item': 'the missing item — please reach out and we\'ll make it right',
    'taste': 'that the dish didn\'t meet your expectations — we\'d love another chance to get it right',
    'portion': 'the portion size — we\'re taking this back to the kitchen',
    'service': 'the service experience — this isn\'t our standard and we\'re addressing it',
    'hygiene': 'this — hygiene is our top priority and we\'re investigating immediately',
    'price': 'that it didn\'t feel worth it — your feedback on value is noted',
  }
  const tail = theme && apology[theme] ? apology[theme] : 'that your experience fell short — we\'d love to make it right'
  return `We're really sorry${name} about ${tail}. Please reach out to us directly so we can fix this for you.`
}

/** Build the R11 analytics payload from a bounded set of review rows. */
export function buildAnalytics(rows: any[]) {
  const real = rows.filter(r => !r.is_aggregate && r.stars != null)

  // Avg + count by source (aggregate rows included for source-level avg).
  const bySource: Record<string, { count: number; sum: number; agg?: number }> = {}
  for (const r of rows) {
    const s = (bySource[r.source] ||= { count: 0, sum: 0 })
    if (r.is_aggregate) { if (r.stars != null) s.agg = r.stars; continue }
    if (r.stars != null) { s.count++; s.sum += r.stars }
  }
  const avgBySource = Object.entries(bySource).map(([source, v]) => ({
    source, count: v.count, avg: v.count ? +(v.sum / v.count).toFixed(2) : (v.agg ?? null), is_aggregate: v.count === 0 && v.agg != null,
  }))

  // Stars distribution (histogram).
  const distribution = [1, 2, 3, 4, 5].map(star => ({ star, count: real.filter(r => r.stars === star).length }))

  // Rating trend by day.
  const byDay: Record<string, { sum: number; count: number }> = {}
  for (const r of real) {
    const day = String(r.review_at ?? '').slice(0, 10)
    if (!day) continue
    const d = (byDay[day] ||= { sum: 0, count: 0 })
    d.sum += r.stars; d.count++
  }
  const trend = Object.entries(byDay).sort(([a], [b]) => a.localeCompare(b))
    .map(([day, v]) => ({ day, avg: +(v.sum / v.count).toFixed(2), count: v.count }))

  // Dish-level best/worst from dish_ratings (Zomato-only until Swiggy exposes it).
  const dishAgg: Record<string, { sum: number; count: number }> = {}
  for (const r of rows) {
    for (const d of (Array.isArray(r.dish_ratings) ? r.dish_ratings : [])) {
      const name = d?.item ?? d?.name
      const st = Number(d?.stars ?? d?.rating)
      if (!name || !Number.isFinite(st)) continue
      const a = (dishAgg[name] ||= { sum: 0, count: 0 })
      a.sum += st; a.count++
    }
  }
  const dishes = Object.entries(dishAgg).map(([item, v]) => ({ item, avg: +(v.sum / v.count).toFixed(2), count: v.count }))
    .sort((a, b) => a.avg - b.avg)

  // Reply-rate + median response time (minutes) by source — we own these stamps.
  const replyBySource: Record<string, { total: number; replied: number; deltas: number[] }> = {}
  for (const r of real) {
    const s = (replyBySource[r.source] ||= { total: 0, replied: 0, deltas: [] })
    s.total++
    if (r.reply_at) {
      s.replied++
      const dt = (new Date(r.reply_at).getTime() - new Date(r.review_at).getTime()) / 60000
      if (Number.isFinite(dt) && dt >= 0) s.deltas.push(dt)
    }
  }
  const replyStats = Object.entries(replyBySource).map(([source, v]) => ({
    source, reply_rate: v.total ? +(v.replied / v.total).toFixed(2) : 0, median_response_min: median(v.deltas),
  }))

  // Negative themes ranked (weekly "themes dragging your rating").
  const themeCount: Record<string, number> = {}
  for (const r of real.filter(r => r.stars <= 3)) for (const t of (r.theme ?? [])) themeCount[t] = (themeCount[t] ?? 0) + 1
  const themes = Object.entries(themeCount).map(([theme, count]) => ({ theme, count })).sort((a, b) => b.count - a.count)

  return {
    total: real.length,
    avg_overall: real.length ? +(real.reduce((n, r) => n + r.stars, 0) / real.length).toFixed(2) : null,
    unanswered_low: real.filter(r => r.stars <= 3 && (r.reply_status === 'none' || r.reply_status === 'draft')).length,
    avg_by_source: avgBySource,
    distribution,
    trend,
    dishes_worst: dishes.slice(0, 5),
    dishes_best: [...dishes].reverse().slice(0, 5),
    reply_stats: replyStats,
    themes,
  }
}

function median(xs: number[]): number | null {
  if (!xs.length) return null
  const s = [...xs].sort((a, b) => a - b)
  const m = Math.floor(s.length / 2)
  return Math.round(s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2)
}
