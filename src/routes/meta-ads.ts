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
import { encrypt, decrypt, randomToken } from '../crypto'

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
    const state = Buffer.from(JSON.stringify({ userId, tenantId, csrf: randomToken(8) })).toString('base64url')
    const params = new URLSearchParams({
      client_id: appId, redirect_uri: redirectUri, response_type: 'code',
      scope: SCOPES, state,
    })
    res.redirect(`https://www.facebook.com/v18.0/dialog/oauth?${params.toString()}`)
  })

  r.get('/api/auth/meta_ads/callback', async (req, res) => {
    const { code, state, error } = req.query as Record<string, string>
    if (error || !code) { res.type('html').send(closePopupHtml(`Authorization cancelled${error ? `: ${error}` : ''}`)); return }
    let parsed: { userId: string; tenantId: string }
    try { parsed = JSON.parse(Buffer.from(state, 'base64url').toString()) }
    catch { res.status(400).type('html').send(closePopupHtml('Invalid state')); return }

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

      await supabase.from('tenant_integrations').upsert({
        tenant_id: parsed.tenantId, key: 'meta_ads', status: 'active',
        access_token: encrypt(userToken),
        scope: SCOPES,
        brand_label: accs.length === 1 ? accs[0].name : `${accs.length} ad accounts`,
        connected_at: new Date().toISOString(),
        metadata: { ad_accounts: accs.map((a: any) => ({ id: a.id, name: a.name, currency: a.currency })) },
      })
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
    // Leads land in `leads` (lead_table-backed). Surface those that came in
    // through Meta Lead Ads — tagged with source='meta_lead_ad'.
    const tenantId = (req as any).tenantId
    const { data, error } = await supabase.from('leads')
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

async function getMetaAdsConnection(supabase: SupabaseClient, tenantId: string) {
  const { data } = await supabase.from('tenant_integrations')
    .select('access_token').eq('tenant_id', tenantId).eq('key', 'meta_ads').maybeSingle()
  if (!data?.access_token) return null
  return { token: decrypt(data.access_token) }
}

function closePopupHtml(message: string, ok = false): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${ok ? 'Connected' : 'Error'}</title></head><body style="font-family:DM Sans,system-ui;background:#0d1117;color:#fff;padding:24px;text-align:center;">
    <h2>${ok ? '✓ Connected' : '⚠ '}${message}</h2>
    <p style="opacity:.6">This window will close…</p>
    <script>
      try { window.opener?.postMessage({ ok: ${ok}, message: ${JSON.stringify(message)} }, '*') } catch(e){}
      setTimeout(() => { try { window.close(); } catch(e){} }, 1500);
    </script></body></html>`
}
