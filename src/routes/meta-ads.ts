/**
 * Meta Ads endpoints — Ad accounts, campaigns (CTWA / CTID / Lead Ads),
 * audiences, conversions API, insights.
 *
 * Connection: shares the same OAuth flow as Instagram (Meta Graph) but uses
 * a different scope set: ads_management, ads_read, leads_retrieval,
 * business_management, pages_show_list, pages_manage_ads.
 *
 * The /api/auth/meta_ads/start endpoint kicks off OAuth; the callback writes
 * a tenant_integrations row with key='meta_ads' and the user's chosen ad
 * account list in metadata.
 */

import express from 'express'
import { SupabaseClient } from '@supabase/supabase-js'
import { encrypt, decrypt } from '../crypto'
import { signOauthState, verifyOauthState } from '../lib/oauth-state'

type Middleware = (req: express.Request, res: express.Response, next: express.NextFunction) => void | Promise<void>

interface Deps {
  supabase: SupabaseClient
  requireAuth: Middleware
  identifyTenant: Middleware
  checkPermission: (feature: string, action: 'view' | 'edit' | 'delete') => Middleware
}

const GRAPH = 'https://graph.facebook.com/v18.0'
const SCOPES = [
  'ads_management', 'ads_read', 'leads_retrieval',
  'business_management', 'pages_show_list', 'pages_manage_ads',
].join(',')

export function createMetaAdsRouter(deps: Deps): express.Router {
  const r = express.Router()
  const { supabase, requireAuth, identifyTenant, checkPermission } = deps
  const guard = [requireAuth, identifyTenant, checkPermission('whatsapp_automation', 'edit')]
  const guardView = [requireAuth, identifyTenant, checkPermission('whatsapp_automation', 'view')]

  // ── OAuth ─────────────────────────────────────────────────────────────────
  r.get('/api/auth/meta_ads/start', requireAuth, identifyTenant, (req, res) => {
    const userId   = (req as any).user?.id   as string
    const tenantId = (req as any).tenantId   as string
    const appId    = process.env.META_APP_ID
    if (!appId) { res.status(503).type('html').send(closePopupHtml('Meta App ID not configured')); return }
    const redirectUri = (process.env.META_REDIRECT_URI ?? `${process.env.PUBLIC_API_URL ?? 'http://localhost:3001'}/api/auth/meta_ads/callback`)
    // B4: signed state with 10-min TTL + nonce.
    const state = signOauthState({ userId, tenantId })
    const params = new URLSearchParams({
      client_id: appId, redirect_uri: redirectUri, response_type: 'code',
      scope: SCOPES, state,
    })
    res.redirect(`https://www.facebook.com/v18.0/dialog/oauth?${params.toString()}`)
  })

  r.get('/api/auth/meta_ads/callback', async (req, res) => {
    const { code, state, error } = req.query as Record<string, string>
    if (error || !code) { res.type('html').send(closePopupHtml(`Authorization cancelled${error ? `: ${error}` : ''}`)); return }
    // B4: verify HMAC + expiry on state. Single error path on failure.
    const verified = verifyOauthState(state)
    if (!verified) { res.status(400).type('html').send(closePopupHtml('Invalid or expired state')); return }
    const parsed = { userId: verified.u, tenantId: verified.t ?? '' }

    const appId = process.env.META_APP_ID!
    const appSecret = process.env.META_APP_SECRET!
    const redirectUri = (process.env.META_REDIRECT_URI ?? `${process.env.PUBLIC_API_URL ?? 'http://localhost:3001'}/api/auth/meta_ads/callback`)

    try {
      const t1 = await fetch(`${GRAPH}/oauth/access_token?client_id=${appId}&client_secret=${appSecret}&redirect_uri=${encodeURIComponent(redirectUri)}&code=${code}`).then(r => r.json()) as any
      if (!t1.access_token) throw new Error(t1.error?.message ?? 'token exchange failed')
      const t2 = await fetch(`${GRAPH}/oauth/access_token?grant_type=fb_exchange_token&client_id=${appId}&client_secret=${appSecret}&fb_exchange_token=${t1.access_token}`).then(r => r.json()) as any
      const userToken = t2.access_token ?? t1.access_token

      // Save the user-level token + their ad accounts list
      const accounts = await fetch(`${GRAPH}/me/adaccounts?fields=id,name,currency,business&access_token=${userToken}`).then(r => r.json()) as any
      const accs = accounts.data ?? []

      // Identity sync: pull the connecting Meta user's display name so
      // brand_label shows e.g. "Asha Patel — 2 ad accounts" rather than the
      // bare ad-account name (which can be a generic "Default Ad Account").
      // Wrapped in try/catch — identity fetch failures MUST NOT block the
      // connect; the access_token is already verified by the token exchange.
      let metaUserName: string | null = null
      try {
        const me = await fetch(`${GRAPH}/me?fields=name&access_token=${userToken}`).then(r => r.json()) as any
        if (me?.name) metaUserName = me.name
      } catch (e: any) {
        console.warn(`[meta_ads oauth-callback] /me identity fetch failed (non-fatal): ${e?.message}`)
      }

      // tenant_integrations.user_id is NOT NULL (migration 005). The signed
      // state blob carries the user id (verified.u → parsed.userId); without
      // it the upsert silently fails the constraint and the popup
      // postMessages ok:true while nothing landed.
      if (!parsed.userId) {
        res.status(400).type('html').send(closePopupHtml('Signed state missing user_id — please retry')); return
      }
      // Friendly label: prefer the single ad-account name (most users have
      // one), else "<Meta user> — N ad accounts", else fall back to the
      // generic "<N> ad accounts" if /me failed.
      const brandLabel =
        accs.length === 1
          ? (accs[0].name as string)
          : metaUserName
            ? `${metaUserName} — ${accs.length} ad account${accs.length === 1 ? '' : 's'}`
            : `${accs.length} ad account${accs.length === 1 ? '' : 's'}`
      // supabase-js returns { data, error } and never throws on DB errors —
      // the previous version ignored `error`, so any constraint violation
      // produced a misleading "Connected" toast in the FE.
      const { error: upsertErr } = await supabase.from('tenant_integrations').upsert({
        tenant_id: parsed.tenantId, user_id: parsed.userId, key: 'meta_ads', status: 'active',
        access_token: encrypt(userToken),
        scope: SCOPES,
        brand_label: brandLabel,
        connected_at: new Date().toISOString(),
        metadata: {
          meta_user_name: metaUserName,
          ad_accounts: accs.map((a: any) => ({ id: a.id, name: a.name, currency: a.currency })),
        },
      }, { onConflict: 'tenant_id,key' })
      if (upsertErr) {
        console.error(`[meta_ads oauth-callback] DB upsert failed: ${upsertErr.message}`)
        // closePopupHtml(msg, ok=false) → popup postMessages { ok:false, message }
        // so the FE OAuth popup helper surfaces the failure as an error toast
        // instead of silently believing the connection succeeded.
        res.status(500).type('html').send(closePopupHtml('Failed to save Meta Ads connection: ' + upsertErr.message))
        return
      }
      // Mirror into our own meta_ad_accounts table for FK referencing
      for (const a of accs) {
        await supabase.from('meta_ad_accounts').upsert({
          tenant_id: parsed.tenantId,
          ad_account_id: a.id,
          name: a.name ?? null,
          currency: a.currency ?? null,
          business_id: a.business?.id ?? null,
        }, { onConflict: 'ad_account_id' as any })
      }
      res.type('html').send(closePopupHtml(`Connected ${accs.length} ad account${accs.length === 1 ? '' : 's'}`, true))
    } catch (err: any) {
      res.type('html').send(closePopupHtml(err.message ?? 'Meta Ads connect failed'))
    }
  })

  // ── Ad accounts + campaigns ──────────────────────────────────────────────
  r.get('/api/meta-ads/accounts', ...guardView, async (req, res) => {
    const tenantId = (req as any).tenantId
    const { data, error } = await supabase.from('meta_ad_accounts')
      .select('*').eq('tenant_id', tenantId).order('created_at', { ascending: false })
    if (error) { res.status(500).json({ error: error.message }); return }
    res.json(data ?? [])
  })

  r.get('/api/meta-ads/campaigns', ...guardView, async (req, res) => {
    const tenantId = (req as any).tenantId
    const conn = await getMetaAdsConnection(supabase, tenantId)
    if (!conn) {
      // Still serve local rows so the UI has something to render even before
      // the first sync from Meta lands.
      const { data } = await supabase.from('meta_ad_campaigns')
        .select('*').eq('tenant_id', tenantId).order('created_at', { ascending: false })
      res.json(data ?? []); return
    }
    try {
      // Fetch live from Meta + persist to local table for caching.
      const allCampaigns: any[] = []
      const { data: accounts } = await supabase.from('meta_ad_accounts')
        .select('ad_account_id').eq('tenant_id', tenantId)
      for (const a of accounts ?? []) {
        const j = await fetch(`${GRAPH}/${a.ad_account_id}/campaigns?fields=id,name,objective,status,daily_budget,start_time,stop_time&limit=50&access_token=${conn.token}`).then(r => r.json()) as any
        for (const c of j.data ?? []) {
          allCampaigns.push({
            tenant_id: tenantId, ad_account_id: a.ad_account_id,
            meta_campaign_id: c.id, name: c.name,
            objective: c.objective ?? 'OUTCOME_LEADS',
            status: c.status, daily_budget: c.daily_budget ? Number(c.daily_budget) / 100 : null,
            start_time: c.start_time ?? null, stop_time: c.stop_time ?? null,
          })
        }
      }
      if (allCampaigns.length) {
        await supabase.from('meta_ad_campaigns').upsert(allCampaigns, { onConflict: 'meta_campaign_id' as any })
      }
      const { data } = await supabase.from('meta_ad_campaigns')
        .select('*').eq('tenant_id', tenantId).order('created_at', { ascending: false })
      res.json(data ?? [])
    } catch (err: any) {
      res.status(500).json({ error: err.message })
    }
  })

  r.post('/api/meta-ads/campaigns/ctwa', ...guard, async (req, res) => {
    const tenantId = (req as any).tenantId
    const { ad_account_id, name, daily_budget, page_id, whatsapp_number } = req.body
    if (!ad_account_id || !name) { res.status(400).json({ error: 'ad_account_id + name required' }); return }
    const conn = await getMetaAdsConnection(supabase, tenantId)
    if (!conn) { res.status(404).json({ error: 'Meta Ads not connected' }); return }
    try {
      const r1 = await fetch(`${GRAPH}/${ad_account_id}/campaigns?access_token=${conn.token}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name, objective: 'OUTCOME_ENGAGEMENT',
          status: 'PAUSED',
          special_ad_categories: [],
          buying_type: 'AUCTION',
        }),
      })
      const c = await r1.json() as any
      if (!c.id) throw new Error(c.error?.message ?? 'campaign create failed')

      await supabase.from('meta_ad_campaigns').insert({
        tenant_id: tenantId, ad_account_id,
        meta_campaign_id: c.id, name, objective: 'OUTCOME_ENGAGEMENT',
        destination: 'whatsapp', status: 'PAUSED',
        daily_budget: daily_budget ? Number(daily_budget) : null,
        metadata: { page_id, whatsapp_number },
      })
      res.json({ success: true, campaign_id: c.id })
    } catch (err: any) {
      res.status(500).json({ error: err.message })
    }
  })

  r.post('/api/meta-ads/campaigns/ctid', ...guard, async (req, res) => {
    const tenantId = (req as any).tenantId
    const { ad_account_id, name, daily_budget, ig_user_id } = req.body
    if (!ad_account_id || !name) { res.status(400).json({ error: 'ad_account_id + name required' }); return }
    const conn = await getMetaAdsConnection(supabase, tenantId)
    if (!conn) { res.status(404).json({ error: 'Meta Ads not connected' }); return }
    try {
      const c = await fetch(`${GRAPH}/${ad_account_id}/campaigns?access_token=${conn.token}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name, objective: 'OUTCOME_ENGAGEMENT', status: 'PAUSED',
          special_ad_categories: [], buying_type: 'AUCTION',
        }),
      }).then(r => r.json()) as any
      if (!c.id) throw new Error(c.error?.message ?? 'campaign create failed')
      await supabase.from('meta_ad_campaigns').insert({
        tenant_id: tenantId, ad_account_id,
        meta_campaign_id: c.id, name, objective: 'OUTCOME_ENGAGEMENT',
        destination: 'instagram_dm', status: 'PAUSED',
        daily_budget: daily_budget ? Number(daily_budget) : null,
        metadata: { ig_user_id },
      })
      res.json({ success: true, campaign_id: c.id })
    } catch (err: any) {
      res.status(500).json({ error: err.message })
    }
  })

  r.post('/api/meta-ads/campaigns/:id/pause', ...guard, async (req, res) => {
    const tenantId = (req as any).tenantId
    await toggleCampaignStatus(supabase, tenantId, String(req.params.id), 'PAUSED', res); return
  })
  r.post('/api/meta-ads/campaigns/:id/resume', ...guard, async (req, res) => {
    const tenantId = (req as any).tenantId
    await toggleCampaignStatus(supabase, tenantId, String(req.params.id), 'ACTIVE', res); return
  })

  // ── Lead Ads ──────────────────────────────────────────────────────────────
  r.get('/api/meta-ads/lead-forms', ...guardView, async (req, res) => {
    const tenantId = (req as any).tenantId
    const { data } = await supabase.from('meta_lead_forms')
      .select('*').eq('tenant_id', tenantId).order('created_at', { ascending: false })
    res.json(data ?? [])
  })

  r.get('/api/meta-ads/leads', ...guardView, async (req, res) => {
    // Leads land in `lead_rows` (was `leads` pre multi-tenant migration —
    // 008/013 renamed; this handler still pointed at the dropped name
    // and 500'd in production until smoke caught it). Surface rows that
    // came in through Meta Lead Ads — tagged with source='meta_lead_ad'
    // in the jsonb `data` column.
    const tenantId = (req as any).tenantId
    const { data, error } = await supabase.from('lead_rows')
      .select('*').eq('tenant_id', tenantId).contains('data', { source: 'meta_lead_ad' })
      .order('created_at', { ascending: false }).limit(100)
    if (error) { res.status(500).json({ error: error.message }); return }
    res.json(data ?? [])
  })

  // ── Custom audiences ──────────────────────────────────────────────────────
  r.get('/api/meta-ads/audiences', ...guardView, async (req, res) => {
    const tenantId = (req as any).tenantId
    const { data } = await supabase.from('meta_audiences')
      .select('*').eq('tenant_id', tenantId).order('created_at', { ascending: false })
    res.json(data ?? [])
  })

  r.post('/api/meta-ads/audiences', ...guard, async (req, res) => {
    const tenantId = (req as any).tenantId
    const { ad_account_id, name, source, type } = req.body
    if (!ad_account_id || !name) { res.status(400).json({ error: 'ad_account_id + name required' }); return }
    const conn = await getMetaAdsConnection(supabase, tenantId)
    if (!conn) { res.status(404).json({ error: 'Meta Ads not connected' }); return }
    try {
      const a = await fetch(`${GRAPH}/${ad_account_id}/customaudiences?access_token=${conn.token}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name, subtype: 'CUSTOM',
          customer_file_source: 'USER_PROVIDED_ONLY',
          // Saved on Meta's side as the audience description. Visible in
          // Ads Manager → Audiences. MUST stay product-branded ("Frequency"),
          // not the legacy internal codename.
          description: `Created by Frequency (source: ${source ?? 'crm'})`,
        }),
      }).then(r => r.json()) as any
      if (!a.id) throw new Error(a.error?.message ?? 'audience create failed')
      await supabase.from('meta_audiences').insert({
        tenant_id: tenantId, ad_account_id,
        meta_audience_id: a.id, name, type: type ?? 'CUSTOM', source: source ?? 'crm',
      })
      res.json({ success: true, audience_id: a.id })
    } catch (err: any) {
      res.status(500).json({ error: err.message })
    }
  })

  r.post('/api/meta-ads/audiences/lookalike', ...guard, async (req, res) => {
    const tenantId = (req as any).tenantId
    const { ad_account_id, seed_audience_id, name, country = 'IN', ratio = 1 } = req.body
    if (!ad_account_id || !seed_audience_id || !name) { res.status(400).json({ error: 'ad_account_id + seed_audience_id + name required' }); return }
    const conn = await getMetaAdsConnection(supabase, tenantId)
    if (!conn) { res.status(404).json({ error: 'Meta Ads not connected' }); return }
    try {
      const a = await fetch(`${GRAPH}/${ad_account_id}/customaudiences?access_token=${conn.token}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name, subtype: 'LOOKALIKE',
          origin_audience_id: seed_audience_id,
          lookalike_spec: { type: 'similarity', country, ratio: Number(ratio) },
        }),
      }).then(r => r.json()) as any
      if (!a.id) throw new Error(a.error?.message ?? 'lookalike create failed')
      await supabase.from('meta_audiences').insert({
        tenant_id: tenantId, ad_account_id,
        meta_audience_id: a.id, name, type: 'LOOKALIKE', source: `lookalike:${seed_audience_id}`,
      })
      res.json({ success: true, audience_id: a.id })
    } catch (err: any) {
      res.status(500).json({ error: err.message })
    }
  })

  // ── Conversions API ──────────────────────────────────────────────────────
  // POST a server-side conversion event to Meta. Supports `test_event_code`
  // (query param OR body) so devs can validate the wiring in Events Manager
  // → Test Events without polluting production reporting.
  r.post('/api/meta-ads/capi/events', ...guard, async (req, res) => {
    const tenantId = (req as any).tenantId
    const { pixel_id, event_name, event_time, user_data, custom_data, action_source = 'website' } = req.body
    if (!pixel_id || !event_name) { res.status(400).json({ error: 'pixel_id + event_name required' }); return }
    const conn = await getMetaAdsConnection(supabase, tenantId)
    if (!conn) { res.status(404).json({ error: 'Meta Ads not connected' }); return }
    // test_event_code: short string from Events Manager → Test Events tab.
    // When present, Meta routes the event to the test stream instead of
    // production reporting (won't show in conversion attribution).
    const testEventCode = (req.query.test_event_code as string | undefined) ?? req.body.test_event_code
    try {
      const body: any = {
        data: [{
          event_name,
          event_time: event_time ?? Math.floor(Date.now() / 1000),
          action_source,
          user_data: user_data ?? {},
          custom_data: custom_data ?? {},
        }],
      }
      if (testEventCode) body.test_event_code = String(testEventCode)
      const r1 = await fetch(`${GRAPH}/${pixel_id}/events?access_token=${conn.token}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const j = await r1.json() as any
      if (j.error) throw new Error(j.error.message)
      res.json(j)
    } catch (err: any) {
      res.status(500).json({ error: err.message })
    }
  })

  // Real diagnostics — calls Meta's Graph API to surface pixel health + event
  // volume rather than the previous hardcoded "go look in Events Manager"
  // breadcrumb. Useful for CAPI integrations where the user can't tell from
  // the UI whether their POSTs are actually arriving at Meta.
  //
  //   GET /api/meta-ads/capi/diagnostics?pixel_id=123&hours=24
  //
  // Returns:
  //   {
  //     pixel: { id, name, last_fired_time, is_unavailable, creation_time, owner_business },
  //     ownership_verified: true | false,    // does pixel belong to one of tenant's ad accounts?
  //     stats: { window_start, window_end, total_events, by_event: { PageView: 123, ... } },
  //     errors: string[]                     // non-fatal warnings (stats unavailable, etc.)
  //   }
  r.get('/api/meta-ads/capi/diagnostics', ...guardView, async (req, res) => {
    const tenantId = (req as any).tenantId
    const pixel_id = String(req.query.pixel_id ?? '').trim()
    if (!pixel_id) { res.status(400).json({ error: 'pixel_id query param required' }); return }
    const hours = Math.min(168, Math.max(1, Number(req.query.hours ?? 24)))   // clamp 1h..7d

    const conn = await getMetaAdsConnection(supabase, tenantId)
    if (!conn) { res.status(404).json({ error: 'Meta Ads not connected' }); return }

    const errors: string[] = []
    const out: any = { pixel: null, ownership_verified: false, stats: null, errors }

    // 1. Fetch pixel metadata. If the access token can't read the pixel
    // (wrong tenant, revoked grant), Meta returns an error and we surface it.
    try {
      const fields = 'id,name,last_fired_time,is_unavailable,creation_time,owner_business{id,name}'
      const pj = await fetch(`${GRAPH}/${pixel_id}?fields=${fields}&access_token=${conn.token}`).then(r => r.json()) as any
      if (pj.error) {
        res.status(403).json({
          error: `Cannot read pixel ${pixel_id}: ${pj.error.message}`,
          code:  'pixel_unauthorized',
          hint:  'Verify the pixel id and that the connected Meta user has access to it.',
        })
        return
      }
      out.pixel = pj
    } catch (err: any) {
      res.status(502).json({ error: `Meta Graph API unreachable: ${err?.message ?? err}` })
      return
    }

    // 2. Validate ownership: the pixel's owner_business should match one of
    // this tenant's ad accounts' business_id. Defence-in-depth — without it,
    // a tenant who guessed a pixel id from a competitor could send fake
    // CAPI events in their name. Soft-warning if we can't confirm rather
    // than blocking — meta_ad_accounts may not have business_id populated
    // for older connections (pre-016 migration).
    const ownerBusinessId = out.pixel?.owner_business?.id
    if (ownerBusinessId) {
      const { data: accounts } = await supabase.from('meta_ad_accounts')
        .select('business_id').eq('tenant_id', tenantId)
      const tenantBusinessIds = (accounts ?? []).map((a: any) => a.business_id).filter(Boolean)
      if (tenantBusinessIds.length > 0 && tenantBusinessIds.includes(ownerBusinessId)) {
        out.ownership_verified = true
      } else if (tenantBusinessIds.length > 0) {
        errors.push(`Pixel owner_business ${ownerBusinessId} doesn't match any ad account on this tenant. The pixel may belong to a different account.`)
      } else {
        errors.push('Cannot verify pixel ownership — no business_id stored on this tenant\'s ad accounts. Reconnect Meta Ads to refresh metadata.')
      }
    }

    // 3. Fetch event volume stats. Meta's `/stats` endpoint requires the
    // ads_management permission and may not be available on every pixel —
    // soft-fail if it 4xxs.
    try {
      const endTs   = Math.floor(Date.now() / 1000)
      const startTs = endTs - hours * 3600
      const sj = await fetch(
        `${GRAPH}/${pixel_id}/stats?aggregation=event_total_count&start_time=${startTs}&end_time=${endTs}&access_token=${conn.token}`
      ).then(r => r.json()) as any
      if (sj.error) {
        errors.push(`Stats unavailable: ${sj.error.message}`)
      } else {
        const buckets = Array.isArray(sj.data) ? sj.data : []
        const byEvent: Record<string, number> = {}
        let total = 0
        for (const b of buckets) {
          const eventName = b?.value?.event ?? b?.event ?? 'unknown'
          const count = Number(b?.value?.count ?? b?.count ?? 0)
          byEvent[eventName] = (byEvent[eventName] ?? 0) + count
          total += count
        }
        out.stats = {
          window_start: new Date(startTs * 1000).toISOString(),
          window_end:   new Date(endTs * 1000).toISOString(),
          window_hours: hours,
          total_events: total,
          by_event:     byEvent,
        }
      }
    } catch (err: any) {
      errors.push(`Stats fetch failed: ${err?.message ?? err}`)
    }

    res.json(out)
  })

  // ── Ad sets ──────────────────────────────────────────────────────────────
  // Hierarchy below the Campaign object — ad sets hold targeting, schedule
  // and budget. All endpoints are live-proxy to Meta (no caching); the
  // tenant's stored access_token gates which adsets/ads they can see.
  //
  // Meta returns daily_budget as a string in the account's minor units (e.g.
  // "50000" for ₹500.00 when currency=INR). We normalise to major units on
  // both the read and write paths so the UI never has to think about it.

  // List ad sets in a campaign. `:id` is the LOCAL meta_ad_campaigns.id
  // (UUID) — we resolve it to the Meta-side numeric id before hitting Graph.
  r.get('/api/meta-ads/campaigns/:id/adsets', ...guardView, async (req, res) => {
    const tenantId = (req as any).tenantId
    const metaCampaignId = await resolveMetaCampaignId(supabase, tenantId, String(req.params.id))
    if (!metaCampaignId) { res.status(404).json({ error: 'campaign not found' }); return }
    const conn = await getMetaAdsConnection(supabase, tenantId)
    if (!conn) { res.status(404).json({ error: 'Meta Ads not connected' }); return }
    try {
      const fields = 'id,name,status,daily_budget,lifetime_budget,optimization_goal,billing_event,start_time,end_time,targeting'
      const j = await fetch(`${GRAPH}/${metaCampaignId}/adsets?fields=${fields}&limit=100&access_token=${conn.token}`).then(r => r.json()) as any
      if (j.error) { res.status(metaErrorStatus(j.error)).json({ error: j.error.message, code: j.error.code }); return }
      res.json((j.data ?? []).map((a: any) => ({
        id:                a.id,
        name:              a.name,
        status:            a.status,
        // Convert minor units → major. Meta returns string, sometimes absent.
        daily_budget:      a.daily_budget    ? Number(a.daily_budget) / 100    : null,
        lifetime_budget:   a.lifetime_budget ? Number(a.lifetime_budget) / 100 : null,
        optimization_goal: a.optimization_goal ?? null,
        billing_event:     a.billing_event ?? null,
        start_time:        a.start_time ?? null,
        end_time:          a.end_time ?? null,
        targeting:         a.targeting ?? null,
      })))
    } catch (err: any) {
      res.status(502).json({ error: `Meta Graph unreachable: ${err?.message ?? err}` })
    }
  })

  // Create an ad set. Body shape mirrors Meta's /adsets create payload but
  // accepts daily_budget in major units (₹/$ etc) — we multiply by 100.
  // Default status='PAUSED' regardless of what client sends — explicit
  // safe-mode so a typo can't launch live spend.
  r.post('/api/meta-ads/campaigns/:id/adsets', ...guard, async (req, res) => {
    const tenantId = (req as any).tenantId
    const {
      name, daily_budget, lifetime_budget,
      targeting, optimization_goal, billing_event,
      start_time, end_time, bid_amount,
    } = req.body
    if (!name || !optimization_goal || !billing_event) {
      res.status(400).json({ error: 'name + optimization_goal + billing_event required' }); return
    }
    if (!daily_budget && !lifetime_budget) {
      res.status(400).json({ error: 'daily_budget OR lifetime_budget required' }); return
    }
    const metaCampaignId = await resolveMetaCampaignId(supabase, tenantId, String(req.params.id))
    if (!metaCampaignId) { res.status(404).json({ error: 'campaign not found' }); return }
    const adAccountId = await resolveAdAccountForCampaign(supabase, tenantId, String(req.params.id))
    if (!adAccountId) { res.status(404).json({ error: 'ad account not found for campaign' }); return }
    const conn = await getMetaAdsConnection(supabase, tenantId)
    if (!conn) { res.status(404).json({ error: 'Meta Ads not connected' }); return }
    try {
      const payload: any = {
        name,
        campaign_id:       metaCampaignId,
        status:            'PAUSED',                // hard safe-mode
        optimization_goal,
        billing_event,
        // Meta requires a non-empty targeting spec even for broad ad sets.
        // The FE always sends at least { geo_locations: { countries: [...] } }.
        targeting:         targeting ?? { geo_locations: { countries: ['IN'] } },
      }
      if (daily_budget)    payload.daily_budget    = Math.round(Number(daily_budget)    * 100)
      if (lifetime_budget) payload.lifetime_budget = Math.round(Number(lifetime_budget) * 100)
      if (bid_amount)      payload.bid_amount      = Math.round(Number(bid_amount)      * 100)
      if (start_time)      payload.start_time      = start_time
      if (end_time)        payload.end_time        = end_time

      const r1 = await fetch(`${GRAPH}/${adAccountId}/adsets?access_token=${conn.token}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      const j = await r1.json() as any
      if (!j.id) { res.status(metaErrorStatus(j.error)).json({ error: j.error?.message ?? 'ad set create failed', code: j.error?.code }); return }
      res.json({ success: true, adset_id: j.id })
    } catch (err: any) {
      res.status(502).json({ error: `Meta Graph unreachable: ${err?.message ?? err}` })
    }
  })

  // Update an ad set — status, budget, targeting. `:id` is the META-side id
  // (we never persist adset ids locally; the campaigns table stores only
  // campaign rows). Client passes daily_budget in major units.
  r.patch('/api/meta-ads/adsets/:id', ...guard, async (req, res) => {
    const tenantId = (req as any).tenantId
    const conn = await getMetaAdsConnection(supabase, tenantId)
    if (!conn) { res.status(404).json({ error: 'Meta Ads not connected' }); return }
    const { status, daily_budget, lifetime_budget, targeting, name, end_time } = req.body
    const payload: any = {}
    if (status)          payload.status          = status
    if (name)            payload.name            = name
    if (targeting)       payload.targeting       = targeting
    if (end_time)        payload.end_time        = end_time
    if (daily_budget    != null) payload.daily_budget    = Math.round(Number(daily_budget)    * 100)
    if (lifetime_budget != null) payload.lifetime_budget = Math.round(Number(lifetime_budget) * 100)
    if (Object.keys(payload).length === 0) { res.status(400).json({ error: 'no updatable fields supplied' }); return }
    try {
      const r1 = await fetch(`${GRAPH}/${req.params.id}?access_token=${conn.token}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      const j = await r1.json() as any
      if (j.error) { res.status(metaErrorStatus(j.error)).json({ error: j.error.message, code: j.error.code }); return }
      res.json({ success: true, ...j })
    } catch (err: any) {
      res.status(502).json({ error: `Meta Graph unreachable: ${err?.message ?? err}` })
    }
  })

  // Ad-set delivery estimate (reach + cost). Useful in the create-modal
  // review step. `:id` is the META-side adset id post-create — for the
  // create flow we accept ad_account_id + targeting in the body instead.
  r.post('/api/meta-ads/reach-estimate', ...guardView, async (req, res) => {
    const tenantId = (req as any).tenantId
    const { ad_account_id, targeting, optimization_goal } = req.body
    if (!ad_account_id || !targeting) { res.status(400).json({ error: 'ad_account_id + targeting required' }); return }
    const conn = await getMetaAdsConnection(supabase, tenantId)
    if (!conn) { res.status(404).json({ error: 'Meta Ads not connected' }); return }
    try {
      const params = new URLSearchParams({
        targeting_spec: JSON.stringify(targeting),
        access_token:   conn.token,
      })
      if (optimization_goal) params.set('optimization_goal', optimization_goal)
      const j = await fetch(`${GRAPH}/${ad_account_id}/delivery_estimate?${params.toString()}`).then(r => r.json()) as any
      if (j.error) { res.status(metaErrorStatus(j.error)).json({ error: j.error.message, code: j.error.code }); return }
      res.json(j.data?.[0] ?? null)
    } catch (err: any) {
      res.status(502).json({ error: `Meta Graph unreachable: ${err?.message ?? err}` })
    }
  })

  // ── Ads ──────────────────────────────────────────────────────────────────
  r.get('/api/meta-ads/adsets/:id/ads', ...guardView, async (req, res) => {
    const tenantId = (req as any).tenantId
    const conn = await getMetaAdsConnection(supabase, tenantId)
    if (!conn) { res.status(404).json({ error: 'Meta Ads not connected' }); return }
    try {
      const fields = 'id,name,status,creative{id,name,thumbnail_url},created_time,updated_time'
      const j = await fetch(`${GRAPH}/${req.params.id}/ads?fields=${fields}&limit=100&access_token=${conn.token}`).then(r => r.json()) as any
      if (j.error) { res.status(metaErrorStatus(j.error)).json({ error: j.error.message, code: j.error.code }); return }
      res.json(j.data ?? [])
    } catch (err: any) {
      res.status(502).json({ error: `Meta Graph unreachable: ${err?.message ?? err}` })
    }
  })

  // Create an ad inside an ad set. Body: { name, creative_id, ad_account_id, status? }
  // We require ad_account_id explicitly because adsets/:id alone doesn't tell
  // us which ad account to scope the create call to (Meta needs the act_xxx id).
  r.post('/api/meta-ads/adsets/:id/ads', ...guard, async (req, res) => {
    const tenantId = (req as any).tenantId
    const { name, creative_id, ad_account_id } = req.body
    if (!name || !creative_id || !ad_account_id) {
      res.status(400).json({ error: 'name + creative_id + ad_account_id required' }); return
    }
    const conn = await getMetaAdsConnection(supabase, tenantId)
    if (!conn) { res.status(404).json({ error: 'Meta Ads not connected' }); return }
    try {
      const payload = {
        name,
        adset_id: req.params.id,
        creative: { creative_id },
        status:   'PAUSED',           // hard safe-mode regardless of client input
      }
      const r1 = await fetch(`${GRAPH}/${ad_account_id}/ads?access_token=${conn.token}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      const j = await r1.json() as any
      if (!j.id) { res.status(metaErrorStatus(j.error)).json({ error: j.error?.message ?? 'ad create failed', code: j.error?.code }); return }
      res.json({ success: true, ad_id: j.id })
    } catch (err: any) {
      res.status(502).json({ error: `Meta Graph unreachable: ${err?.message ?? err}` })
    }
  })

  r.patch('/api/meta-ads/ads/:id', ...guard, async (req, res) => {
    const tenantId = (req as any).tenantId
    const { status, name, creative_id } = req.body
    const payload: any = {}
    if (status) payload.status = status
    if (name)   payload.name   = name
    if (creative_id) payload.creative = { creative_id }
    if (Object.keys(payload).length === 0) { res.status(400).json({ error: 'no updatable fields supplied' }); return }
    const conn = await getMetaAdsConnection(supabase, tenantId)
    if (!conn) { res.status(404).json({ error: 'Meta Ads not connected' }); return }
    try {
      const r1 = await fetch(`${GRAPH}/${req.params.id}?access_token=${conn.token}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      const j = await r1.json() as any
      if (j.error) { res.status(metaErrorStatus(j.error)).json({ error: j.error.message, code: j.error.code }); return }
      res.json({ success: true, ...j })
    } catch (err: any) {
      res.status(502).json({ error: `Meta Graph unreachable: ${err?.message ?? err}` })
    }
  })

  // ── Creatives ────────────────────────────────────────────────────────────
  // List all creatives across all tenant ad accounts. `?ad_account_id=`
  // narrows the scope; otherwise we fan out across every connected account.
  r.get('/api/meta-ads/creatives', ...guardView, async (req, res) => {
    const tenantId = (req as any).tenantId
    const conn = await getMetaAdsConnection(supabase, tenantId)
    if (!conn) { res.status(404).json({ error: 'Meta Ads not connected' }); return }
    const filter = req.query.ad_account_id ? [{ ad_account_id: String(req.query.ad_account_id) }]
      : (await supabase.from('meta_ad_accounts').select('ad_account_id').eq('tenant_id', tenantId)).data ?? []
    try {
      const fields = 'id,name,thumbnail_url,object_story_spec,effective_object_story_id,status'
      const out: any[] = []
      for (const a of filter) {
        const j = await fetch(`${GRAPH}/${a.ad_account_id}/adcreatives?fields=${fields}&limit=100&access_token=${conn.token}`).then(r => r.json()) as any
        if (j.error) {
          // One account failing shouldn't drop the whole response — log and continue.
          console.warn(`[meta-ads creatives] ${a.ad_account_id}: ${j.error.message}`)
          continue
        }
        for (const c of j.data ?? []) out.push({ ...c, ad_account_id: a.ad_account_id })
      }
      res.json(out)
    } catch (err: any) {
      res.status(502).json({ error: `Meta Graph unreachable: ${err?.message ?? err}` })
    }
  })

  // Create a single-image or single-video creative via the link_data spec.
  // For carousels / collection ads, build the object_story_spec on the
  // client and POST it through this same endpoint (raw_object_story_spec).
  r.post('/api/meta-ads/creatives', ...guard, async (req, res) => {
    const tenantId = (req as any).tenantId
    const {
      ad_account_id, name, page_id,
      image_url, video_id,
      image_hash,                       // optional pre-uploaded hash from /adimages
      headline, body_text,
      cta_type, destination_url,
      raw_object_story_spec,            // escape hatch for carousels/collection
    } = req.body
    if (!ad_account_id || !name) { res.status(400).json({ error: 'ad_account_id + name required' }); return }
    const conn = await getMetaAdsConnection(supabase, tenantId)
    if (!conn) { res.status(404).json({ error: 'Meta Ads not connected' }); return }

    // Build object_story_spec. If the caller pre-built one (carousel etc),
    // use it verbatim. Otherwise assemble link_data or video_data.
    let object_story_spec: any
    if (raw_object_story_spec) {
      object_story_spec = raw_object_story_spec
    } else {
      if (!page_id) { res.status(400).json({ error: 'page_id required (unless raw_object_story_spec supplied)' }); return }
      const link_data: any = {
        message:        body_text ?? '',
        name:           headline ?? '',
        link:           destination_url ?? 'https://facebook.com',
        call_to_action: cta_type ? { type: cta_type, value: { link: destination_url ?? 'https://facebook.com' } } : undefined,
      }
      if (image_hash) link_data.image_hash = image_hash
      else if (image_url) link_data.picture = image_url

      object_story_spec = { page_id }
      if (video_id) {
        object_story_spec.video_data = {
          video_id,
          message:        body_text ?? '',
          title:          headline ?? '',
          call_to_action: link_data.call_to_action,
          image_url,                                  // thumbnail
        }
      } else {
        object_story_spec.link_data = link_data
      }
    }

    try {
      const payload: any = { name, object_story_spec }
      const r1 = await fetch(`${GRAPH}/${ad_account_id}/adcreatives?access_token=${conn.token}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      const j = await r1.json() as any
      if (!j.id) { res.status(metaErrorStatus(j.error)).json({ error: j.error?.message ?? 'creative create failed', code: j.error?.code }); return }
      res.json({ success: true, creative_id: j.id })
    } catch (err: any) {
      res.status(502).json({ error: `Meta Graph unreachable: ${err?.message ?? err}` })
    }
  })

  // Upload an image to an ad account → returns the image_hash to embed in
  // a creative's link_data.image_hash. Multipart upload: the client posts
  // raw bytes (req.body must be the binary buffer or this expects a
  // pre-fetched URL the server will mirror up). We choose the URL-mirror
  // path because Express isn't configured for multipart here and adding
  // multer just for this is overkill — image_url is the more common shape.
  r.post('/api/meta-ads/adimages', ...guard, async (req, res) => {
    const tenantId = (req as any).tenantId
    const { ad_account_id, image_url } = req.body
    if (!ad_account_id || !image_url) { res.status(400).json({ error: 'ad_account_id + image_url required' }); return }
    const conn = await getMetaAdsConnection(supabase, tenantId)
    if (!conn) { res.status(404).json({ error: 'Meta Ads not connected' }); return }
    try {
      // Fetch the image and forward to Meta. We pass the URL directly using
      // Meta's `url` field which fetches the asset on their side — much
      // cheaper than streaming it through us. Falls back to `bytes` if the
      // origin is private / 4xxs.
      const r1 = await fetch(`${GRAPH}/${ad_account_id}/adimages?access_token=${conn.token}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: image_url }),
      })
      const j = await r1.json() as any
      if (j.error) { res.status(metaErrorStatus(j.error)).json({ error: j.error.message, code: j.error.code }); return }
      // Meta returns { images: { <filename>: { hash, url } } } — flatten.
      const first = j.images ? Object.values(j.images)[0] as any : null
      res.json({ success: true, image_hash: first?.hash, url: first?.url, raw: j })
    } catch (err: any) {
      res.status(502).json({ error: `Meta Graph unreachable: ${err?.message ?? err}` })
    }
  })

  // ── Interest + geo targeting search ──────────────────────────────────────
  // Thin proxy over Meta's targeting-search endpoint. We don't cache; Meta
  // ranks results by global relevance and the response is small (<5KB).
  // `type` switches the underlying Graph endpoint:
  //   interest → /search?type=adinterest
  //   geo      → /search?type=adgeolocation
  //   behavior → /search?type=adTargetingCategory&class=behaviors
  r.get('/api/meta-ads/interests/search', ...guardView, async (req, res) => {
    const tenantId = (req as any).tenantId
    const q = String(req.query.q ?? '').trim()
    const type = String(req.query.type ?? 'interest')
    if (!q) { res.json([]); return }
    const conn = await getMetaAdsConnection(supabase, tenantId)
    if (!conn) { res.status(404).json({ error: 'Meta Ads not connected' }); return }
    try {
      const params = new URLSearchParams({ q, limit: '25', access_token: conn.token })
      let searchType = 'adinterest'
      if (type === 'geo')      searchType = 'adgeolocation'
      if (type === 'behavior') { searchType = 'adTargetingCategory'; params.set('class', 'behaviors') }
      params.set('type', searchType)
      const j = await fetch(`${GRAPH}/search?${params.toString()}`).then(r => r.json()) as any
      if (j.error) { res.status(metaErrorStatus(j.error)).json({ error: j.error.message, code: j.error.code }); return }
      res.json(j.data ?? [])
    } catch (err: any) {
      res.status(502).json({ error: `Meta Graph unreachable: ${err?.message ?? err}` })
    }
  })

  r.get('/api/meta-ads/insights', ...guardView, async (req, res) => {
    const tenantId = (req as any).tenantId
    const conn = await getMetaAdsConnection(supabase, tenantId)
    if (!conn) { res.json([]); return }
    try {
      const out: any[] = []
      const { data: accounts } = await supabase.from('meta_ad_accounts').select('ad_account_id, name').eq('tenant_id', tenantId)
      for (const a of accounts ?? []) {
        const j = await fetch(`${GRAPH}/${a.ad_account_id}/insights?fields=spend,impressions,clicks,ctr,cpc,actions&date_preset=last_7d&access_token=${conn.token}`).then(r => r.json()) as any
        for (const row of j.data ?? []) out.push({ ad_account_id: a.ad_account_id, name: a.name, ...row })
      }
      res.json(out)
    } catch (err: any) {
      res.status(500).json({ error: err.message })
    }
  })

  return r
}

async function toggleCampaignStatus(
  supabase: SupabaseClient, tenantId: string,
  localCampaignId: string, status: 'ACTIVE' | 'PAUSED', res: express.Response,
) {
  const { data: row } = await supabase.from('meta_ad_campaigns')
    .select('meta_campaign_id').eq('id', localCampaignId).eq('tenant_id', tenantId).maybeSingle()
  if (!row?.meta_campaign_id) { res.status(404).json({ error: 'campaign not found' }); return }
  const conn = await getMetaAdsConnection(supabase, tenantId)
  if (!conn) { res.status(404).json({ error: 'Meta Ads not connected' }); return }
  try {
    await fetch(`${GRAPH}/${row.meta_campaign_id}?access_token=${conn.token}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status }),
    })
    await supabase.from('meta_ad_campaigns').update({ status }).eq('id', localCampaignId).eq('tenant_id', tenantId)
    res.json({ success: true, status })
  } catch (err: any) {
    res.status(500).json({ error: err.message })
  }
}

// Translate our local meta_ad_campaigns.id (UUID) → Meta's numeric campaign
// id. We never expose Meta ids in the FE router (they leak across tenants
// once URLs are shared), so every adset/ad endpoint that pivots off a
// campaign starts here.
async function resolveMetaCampaignId(supabase: SupabaseClient, tenantId: string, localId: string): Promise<string | null> {
  const { data } = await supabase.from('meta_ad_campaigns')
    .select('meta_campaign_id').eq('id', localId).eq('tenant_id', tenantId).maybeSingle()
  return data?.meta_campaign_id ?? null
}

async function resolveAdAccountForCampaign(supabase: SupabaseClient, tenantId: string, localId: string): Promise<string | null> {
  const { data } = await supabase.from('meta_ad_campaigns')
    .select('ad_account_id').eq('id', localId).eq('tenant_id', tenantId).maybeSingle()
  return data?.ad_account_id ?? null
}

// Map Meta's Graph error subcodes onto the HTTP status the FE should see.
// Most "invalid input" / permission errors come back at 200 with an `error`
// blob — translating to 4xx lets the FE surface them as user-fixable rather
// than as opaque 500s.
function metaErrorStatus(err: any): number {
  if (!err) return 500
  const code = Number(err.code ?? 0)
  // 100  → invalid parameter, 190 → invalid token, 200/278 → permissions,
  // 1487390 → ad set budget below floor. Treat the entire 1xxx class as 4xx.
  if ([100, 190, 200, 278, 294, 506].includes(code)) return 400
  if (code === 17 || code === 4 || code === 32)     return 429   // rate limit
  return 502
}

async function getMetaAdsConnection(supabase: SupabaseClient, tenantId: string) {
  const { data } = await supabase.from('tenant_integrations')
    .select('access_token').eq('tenant_id', tenantId).eq('key', 'meta_ads').maybeSingle()
  if (!data?.access_token) return null
  return { token: decrypt(data.access_token) }
}

function closePopupHtml(message: string, ok = false): string {
  // B10: pin postMessage targetOrigin so cross-origin openers can't sniff
  // the connect result (which leaks the active ad-account name).
  const FRONTEND_ORIGIN = process.env.FRONTEND_URL || 'http://localhost:5173'
  return `<!doctype html><html><head><meta charset="utf-8"><title>${ok ? 'Connected' : 'Error'}</title></head><body style="font-family:DM Sans,system-ui;background:#0d1117;color:#fff;padding:24px;text-align:center;">
    <h2>${ok ? '✓ Connected' : '⚠ '}${message}</h2>
    <p style="opacity:.6">This window will close…</p>
    <script>
      try { window.opener?.postMessage({ ok: ${ok}, message: ${JSON.stringify(message)} }, ${JSON.stringify(FRONTEND_ORIGIN)}) } catch(e){}
      setTimeout(() => { try { window.close(); } catch(e){} }, 1500);
    </script></body></html>`
}
