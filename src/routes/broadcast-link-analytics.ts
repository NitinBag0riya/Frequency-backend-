/**
 * routes/broadcast-link-analytics.ts — Read-only analytics for the
 * click-tracking tables (P2 #19). Powers the "Click analytics" section
 * on BroadcastsPage in the FE.
 *
 * Three endpoints, all tenant-scoped via RLS on broadcast_links /
 * broadcast_link_clicks (migration 085). We use the request-scoped
 * supabase client (auth-bearer forwarded) so a tenant can never read
 * another tenant's clicks even if the broadcast_id is guessable.
 *
 *   GET /api/broadcasts/:id/links
 *     → [{ id, token, original_url, position, created_at,
 *          click_count, unique_clicks, last_clicked_at }]
 *     Per-link rollup for the broadcast detail panel. click_count is total
 *     clicks; unique_clicks dedupes by (contact_id, user_agent_hash) so a
 *     contact opening the link on phone + desktop counts once per device.
 *
 *   GET /api/broadcasts/:id/links/clicks?from=&to=
 *     → [{ link_id, contact_id, clicked_at, ip_country_code, referer_host }]
 *     Flat list for CSV export. Capped at 5,000 rows per call. Sorted
 *     newest-first.
 *
 *   GET /api/analytics/broadcast-clicks?days=30
 *     → { total_links, total_clicks, unique_clickers, top_urls:[...],
 *         clicks_by_day:[{ day, count }] }
 *     Cross-broadcast rollup for the analytics overview. Capped at 365 days.
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

// Hard caps so a misbehaving client (or a malicious tenant w/ a million
// clicks) can't OOM the API process.
const MAX_FLAT_CLICKS = 5_000
const MAX_OVERVIEW_DAYS = 365

export function createBroadcastLinkAnalyticsRouter(deps: Deps): express.Router {
  const r = express.Router()
  const { supabase, requireAuth, identifyTenant } = deps
  const guard = [requireAuth, identifyTenant]

  // ── GET /api/broadcasts/:id/links ───────────────────────────────────────
  // Per-link rollup: pull all broadcast_links for the broadcast, then
  // fetch their clicks and aggregate in-process. We keep the aggregation
  // in JS rather than in a SQL view because (a) broadcast link counts are
  // capped naturally by message length (a body fits maybe 5 URLs tops) so
  // the result-set is tiny, and (b) we'd rather not add another migration
  // for a view that doesn't carry RLS cleanly.
  r.get('/api/broadcasts/:id/links', ...guard, async (req, res) => {
    const broadcastId = String(req.params.id ?? '')
    if (!broadcastId) { res.status(400).json({ error: 'broadcast id required' }); return }

    const { data: links, error: lErr } = await supabase
      .from('broadcast_links')
      .select('id, token, original_url, position, created_at, broadcast_id, contact_id')
      .eq('broadcast_id', broadcastId)
      .order('position', { ascending: true })
      .limit(500)
    if (lErr) { res.status(500).json({ error: lErr.message }); return }
    if (!links || links.length === 0) { res.json([]); return }

    const linkIds = links.map(l => l.id)
    const { data: clicks, error: cErr } = await supabase
      .from('broadcast_link_clicks')
      .select('link_id, contact_id, user_agent_hash, clicked_at')
      .in('link_id', linkIds)
      .order('clicked_at', { ascending: false })
      .limit(50_000)
    if (cErr) { res.status(500).json({ error: cErr.message }); return }

    // Group by URL+position rather than by raw link_id — a broadcast with
    // 10k recipients has 10k broadcast_links rows for the same URL (one
    // per recipient), and the FE wants the URL-level rollup, not the
    // per-recipient rollup.
    type UrlBucket = {
      original_url: string
      position: number
      link_ids: Set<string>
      click_count: number
      unique_pairs: Set<string>
      last_clicked_at: string | null
      created_at: string
    }
    const buckets = new Map<string, UrlBucket>()
    for (const l of links) {
      const key = `${l.position}::${l.original_url}`
      let b = buckets.get(key)
      if (!b) {
        b = {
          original_url: l.original_url,
          position: l.position,
          link_ids: new Set<string>(),
          click_count: 0,
          unique_pairs: new Set<string>(),
          last_clicked_at: null,
          created_at: l.created_at,
        }
        buckets.set(key, b)
      }
      b.link_ids.add(l.id)
    }
    for (const c of clicks ?? []) {
      // Find the bucket the click belongs to.
      for (const b of buckets.values()) {
        if (!b.link_ids.has(c.link_id)) continue
        b.click_count += 1
        // Dedupe by (contact_id, user_agent_hash) — a phone+desktop split
        // counts as 2 uniques; same UA from the same contact counts as 1.
        const dedupe = `${c.contact_id ?? 'anon'}::${c.user_agent_hash ?? 'na'}`
        b.unique_pairs.add(dedupe)
        if (!b.last_clicked_at || c.clicked_at > b.last_clicked_at) {
          b.last_clicked_at = c.clicked_at
        }
        break
      }
    }

    const out = Array.from(buckets.values())
      .sort((a, b) => a.position - b.position)
      .map(b => ({
        original_url:    b.original_url,
        position:        b.position,
        recipients:      b.link_ids.size,
        click_count:     b.click_count,
        unique_clicks:   b.unique_pairs.size,
        last_clicked_at: b.last_clicked_at,
        created_at:      b.created_at,
      }))
    res.json(out)
  })

  // ── GET /api/broadcasts/:id/links/clicks ────────────────────────────────
  r.get('/api/broadcasts/:id/links/clicks', ...guard, async (req, res) => {
    const broadcastId = String(req.params.id ?? '')
    if (!broadcastId) { res.status(400).json({ error: 'broadcast id required' }); return }

    const from = parseDate(req.query.from)
    const to   = parseDate(req.query.to)

    let q = supabase
      .from('broadcast_link_clicks')
      .select('id, link_id, broadcast_id, contact_id, clicked_at, ip_country_code, referer_host')
      .eq('broadcast_id', broadcastId)
      .order('clicked_at', { ascending: false })
      .limit(MAX_FLAT_CLICKS)
    if (from) q = q.gte('clicked_at', from)
    if (to)   q = q.lte('clicked_at', to)

    const { data, error } = await q
    if (error) { res.status(500).json({ error: error.message }); return }
    res.json(data ?? [])
  })

  // ── GET /api/analytics/broadcast-clicks ─────────────────────────────────
  // Tenant-wide rollup over the last N days for the dashboard tile.
  r.get('/api/analytics/broadcast-clicks', ...guard, async (req, res) => {
    const tenantId = (req as any).tenantId as string | undefined
    if (!tenantId) { res.status(401).json({ error: 'tenant required' }); return }

    let days = Number(req.query.days ?? 30)
    if (!Number.isFinite(days) || days < 1) days = 30
    if (days > MAX_OVERVIEW_DAYS) days = MAX_OVERVIEW_DAYS
    const since = new Date(Date.now() - days * 86_400_000).toISOString()

    const [linksRes, clicksRes] = await Promise.all([
      supabase
        .from('broadcast_links')
        .select('id, original_url, broadcast_id, created_at')
        .eq('tenant_id', tenantId)
        .gte('created_at', since)
        .limit(50_000),
      supabase
        .from('broadcast_link_clicks')
        .select('link_id, contact_id, user_agent_hash, clicked_at')
        .eq('tenant_id', tenantId)
        .gte('clicked_at', since)
        .order('clicked_at', { ascending: false })
        .limit(100_000),
    ])
    if (linksRes.error)  { res.status(500).json({ error: linksRes.error.message });  return }
    if (clicksRes.error) { res.status(500).json({ error: clicksRes.error.message }); return }

    const links  = linksRes.data  ?? []
    const clicks = clicksRes.data ?? []

    // Map link_id → original_url for the top-URL rollup.
    const linkUrl = new Map<string, string>()
    for (const l of links) linkUrl.set(l.id, l.original_url)

    // Top URLs by click count.
    const urlCounts = new Map<string, number>()
    const uniquePairs = new Set<string>()
    const dayCounts = new Map<string, number>()
    for (const c of clicks) {
      const url = linkUrl.get(c.link_id)
      if (url) urlCounts.set(url, (urlCounts.get(url) ?? 0) + 1)
      uniquePairs.add(`${c.contact_id ?? 'anon'}::${c.user_agent_hash ?? 'na'}`)
      const day = String(c.clicked_at).slice(0, 10)
      dayCounts.set(day, (dayCounts.get(day) ?? 0) + 1)
    }

    const top_urls = Array.from(urlCounts.entries())
      .map(([url, count]) => ({ url, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10)

    const clicks_by_day = Array.from(dayCounts.entries())
      .map(([day, count]) => ({ day, count }))
      .sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0))

    res.json({
      total_links:     links.length,
      total_clicks:    clicks.length,
      unique_clickers: uniquePairs.size,
      top_urls,
      clicks_by_day,
    })
  })

  return r
}

function parseDate(v: any): string | null {
  if (!v) return null
  const s = String(v)
  // Accept either YYYY-MM-DD or full ISO. Bail on anything else.
  if (!/^\d{4}-\d{2}-\d{2}/.test(s)) return null
  const d = new Date(s)
  if (Number.isNaN(d.getTime())) return null
  return d.toISOString()
}
