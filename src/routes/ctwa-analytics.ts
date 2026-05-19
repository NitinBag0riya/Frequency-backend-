/**
 * CTWA → WhatsApp attribution analytics endpoints.
 *
 * Two endpoints:
 *   GET  /api/analytics/ctwa?from=&to=
 *     → funnel totals + per-ad-set rollup
 *   POST /api/analytics/ctwa/:id/mark-converted
 *     → write conversion event (revenue + source)
 *
 * The funnel:
 *   ad spend (from meta_ad_campaigns)
 *     → conversations started (ctwa_attribution rows)
 *     → contacts who replied  (rows with replied_at not null)
 *     → contacts who paid     (rows with converted_at not null)
 *     → ROAS = revenue ÷ spend
 *
 * `ad spend` is sourced from meta_ad_campaigns.daily_budget × days in
 * range as a v1 estimate. Once a Meta Insights sync ships, this becomes
 * actual spend from the insights table.
 */

import express from 'express'
import type { SupabaseClient } from '@supabase/supabase-js'
import { z } from 'zod'
import { validateBody } from '../validation'

type Middleware = (req: express.Request, res: express.Response, next: express.NextFunction) => void | Promise<void>

interface Deps {
  supabase: SupabaseClient
  requireAuth: Middleware
  identifyTenant: Middleware
}

const MarkConvertedSchema = z.object({
  revenue_inr: z.number().int().nonnegative().max(1_000_000_000_000),  // up to ₹10 crore in paise
  source:      z.enum(['razorpay', 'lead_table', 'manual', 'webhook']).default('manual'),
}).strict()

export function createCtwaAnalyticsRouter(deps: Deps): express.Router {
  const r = express.Router()
  const { supabase, requireAuth, identifyTenant } = deps

  // ── GET /api/analytics/ctwa ───────────────────────────────────────────
  // Returns: funnel totals + per-ad-set rollup + date range used.
  // Defaults: from = 30 days ago (IST), to = now.
  r.get('/api/analytics/ctwa',
    requireAuth, identifyTenant,
    async (req, res) => {
      const tenantId = (req as any).tenantId as string

      // Parse range. Cap at 365 days so a runaway query doesn't blow up.
      const now = new Date()
      const defaultFrom = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000)
      const from = parseIsoSafe(req.query.from as string | undefined) ?? defaultFrom
      const to   = parseIsoSafe(req.query.to   as string | undefined) ?? now
      const rangeDays = Math.max(1, Math.min(365, Math.ceil((to.getTime() - from.getTime()) / (24*60*60*1000))))

      // 1. Pull all CTWA attribution rows in range.
      const { data: rows, error } = await supabase.from('ctwa_attribution')
        .select('id, meta_ad_id, meta_adset_id, meta_campaign_id, ctwa_clid, referral_headline, first_message_at, replied_at, converted_at, revenue_inr, conversion_source')
        .eq('tenant_id', tenantId)
        .gte('first_message_at', from.toISOString())
        .lte('first_message_at', to.toISOString())
        .order('first_message_at', { ascending: false })
        .limit(10_000)
      if (error) { res.status(500).json({ error: error.message }); return }

      const attribRows = rows ?? []

      // 2. Pull active ad campaigns to compute ad spend rollup.
      //    daily_budget × days in range = estimated spend per campaign.
      //    (Once a Meta Insights sync ships this becomes actual spend.)
      const campaignIds = Array.from(new Set(attribRows.map(r => r.meta_campaign_id).filter(Boolean))) as string[]
      let campaignSpendByCampaignId: Record<string, number> = {}
      let campaignNameById: Record<string, string> = {}
      if (campaignIds.length > 0) {
        const { data: campaigns } = await supabase.from('meta_ad_campaigns')
          .select('meta_campaign_id, name, daily_budget')
          .eq('tenant_id', tenantId)
          .in('meta_campaign_id', campaignIds)
        for (const c of campaigns ?? []) {
          const dailyINR = Number(c.daily_budget ?? 0)
          // Spend in PAISE for ROAS math symmetry with revenue.
          campaignSpendByCampaignId[c.meta_campaign_id] = Math.round(dailyINR * rangeDays * 100)
          campaignNameById[c.meta_campaign_id]          = c.name ?? c.meta_campaign_id
        }
      }

      // 3. Roll up per ad-set.
      type AdsetAgg = {
        meta_adset_id:    string | null
        meta_campaign_id: string | null
        ad_name:          string
        conversations:    number
        replied:          number
        conversions:      number
        revenue_paise:    number
        spend_paise:      number
      }
      const adsetMap = new Map<string, AdsetAgg>()
      for (const row of attribRows) {
        const key = row.meta_adset_id ?? row.meta_campaign_id ?? '__unknown__'
        const existing = adsetMap.get(key) ?? {
          meta_adset_id:    row.meta_adset_id ?? null,
          meta_campaign_id: row.meta_campaign_id ?? null,
          ad_name:          row.referral_headline ?? row.meta_adset_id ?? 'Unattributed',
          conversations:    0,
          replied:          0,
          conversions:      0,
          revenue_paise:    0,
          spend_paise:      0,
        }
        existing.conversations += 1
        if (row.replied_at)   existing.replied     += 1
        if (row.converted_at) existing.conversions += 1
        existing.revenue_paise += Number(row.revenue_inr ?? 0)
        adsetMap.set(key, existing)
      }
      // Distribute campaign-level spend evenly across each campaign's ad-sets.
      const adsetsByCampaign: Record<string, AdsetAgg[]> = {}
      for (const agg of adsetMap.values()) {
        const cid = agg.meta_campaign_id ?? '__unknown__'
        if (!adsetsByCampaign[cid]) adsetsByCampaign[cid] = []
        adsetsByCampaign[cid].push(agg)
      }
      for (const [cid, adsets] of Object.entries(adsetsByCampaign)) {
        const totalSpend = campaignSpendByCampaignId[cid] ?? 0
        if (totalSpend > 0 && adsets.length > 0) {
          const perAdset = Math.floor(totalSpend / adsets.length)
          adsets.forEach(a => { a.spend_paise = perAdset })
        }
      }
      const adsetRows = Array.from(adsetMap.values())
        .map(a => ({
          ...a,
          roas: a.spend_paise > 0 ? Number((a.revenue_paise / a.spend_paise).toFixed(2)) : null,
        }))
        // Sort by ROAS desc (rows without spend at the bottom).
        .sort((a, b) => {
          if (a.roas === null && b.roas === null) return b.revenue_paise - a.revenue_paise
          if (a.roas === null) return 1
          if (b.roas === null) return -1
          return b.roas - a.roas
        })

      // 4. Funnel totals.
      const totalConversations = attribRows.length
      const totalReplied       = attribRows.filter(r => r.replied_at).length
      const totalConversions   = attribRows.filter(r => r.converted_at).length
      const totalRevenuePaise  = attribRows.reduce((s, r) => s + Number(r.revenue_inr ?? 0), 0)
      const totalSpendPaise    = Object.values(campaignSpendByCampaignId).reduce((s, v) => s + v, 0)
      const overallRoas        = totalSpendPaise > 0 ? Number((totalRevenuePaise / totalSpendPaise).toFixed(2)) : null

      res.json({
        range: {
          from:        from.toISOString(),
          to:          to.toISOString(),
          range_days:  rangeDays,
        },
        funnel: {
          spend_paise:        totalSpendPaise,
          conversations:      totalConversations,
          replied:            totalReplied,
          conversions:        totalConversions,
          revenue_paise:      totalRevenuePaise,
          roas:               overallRoas,
        },
        adsets: adsetRows,
        empty:  totalConversations === 0,
      })
    })

  // ── POST /api/analytics/ctwa/:id/mark-converted ───────────────────────
  // Update a single attribution row with conversion data.
  // - id: ctwa_attribution.id (uuid)
  // - body: { revenue_inr, source }  (revenue_inr is in PAISE)
  // RLS prevents writes outside the caller's tenant.
  r.post('/api/analytics/ctwa/:id/mark-converted',
    requireAuth, identifyTenant,
    validateBody(MarkConvertedSchema),
    async (req, res) => {
      const tenantId = (req as any).tenantId as string
      const id = req.params.id
      const { revenue_inr, source } = req.body as z.infer<typeof MarkConvertedSchema>

      const { data, error } = await supabase.from('ctwa_attribution')
        .update({
          converted_at:      new Date().toISOString(),
          revenue_inr:       revenue_inr,
          conversion_source: source,
        })
        .eq('id', id)
        .eq('tenant_id', tenantId)
        .select('id, converted_at, revenue_inr, conversion_source')
        .maybeSingle()

      if (error) { res.status(500).json({ error: error.message }); return }
      if (!data) { res.status(404).json({ error: 'attribution row not found' }); return }
      res.json({ success: true, row: data })
    })

  return r
}

function parseIsoSafe(s: string | undefined): Date | null {
  if (!s) return null
  const d = new Date(s)
  if (Number.isNaN(d.getTime())) return null
  return d
}
