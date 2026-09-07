/**
 * meta-business-assets.ts — Facebook Login for Business (FBLfB) callback for
 * the Meta Ads / Facebook Leads / basic Instagram flows.
 *
 * WHY:
 *   Classic dialog/oauth flow (routes/instagram.ts + routes/meta-ads.ts) fails
 *   with "URL Blocked — website does not match registered website(s)" because
 *   our Meta app (1556325079343162) doesn't have the classic Facebook Login
 *   product installed — only "Facebook Login for Business" for WhatsApp
 *   Embedded Signup. FBLfB uses FB.login({config_id}) client-side; Meta hosts
 *   the login and returns a one-time `code` via postMessage. This route
 *   accepts that code (POST body), exchanges it for a long-lived access
 *   token WITHOUT a redirect_uri (FBLfB doesn't use one), then dispatches
 *   to the same per-purpose upsert used by the classic callbacks.
 *
 * Config: config_id 1386194257050012 ("Frequency Business Assets"). WA stays
 * on its own config 1689367385736700 (separate wizard, untouched).
 * See reference_meta_business_assets_config memory for details.
 */

import express, { RequestHandler } from 'express'
import { SupabaseClient } from '@supabase/supabase-js'
import { encrypt } from '../crypto'

type Middleware = RequestHandler

interface Deps {
  supabase: SupabaseClient
  requireAuth: Middleware
  identifyTenant: Middleware
}

const GRAPH = 'https://graph.facebook.com/v18.0'

// Scope union across purposes — the actual scopes granted at auth time
// live on the FBLfB configuration in the Meta App Dashboard, not here.
// This constant only informs the `scope` column in tenant_integrations
// so downstream code (`hasScope(...)`) can reason about permissions.
const IG_SCOPES = 'instagram_basic,pages_show_list,pages_read_engagement,instagram_manage_insights'
const ADS_SCOPES = 'ads_management,ads_read,leads_retrieval,business_management,pages_show_list,pages_manage_ads'

export function createMetaBusinessAssetsRouter(deps: Deps): express.Router {
  const r = express.Router()
  const { supabase, requireAuth, identifyTenant } = deps

  // Unified callback for Instagram + Meta Ads (+ Leads, which piggybacks on
  // the Ads scope set). Dispatches on `purpose` so the FE has ONE endpoint
  // to call regardless of which connector it's authorising.
  r.post('/api/auth/meta_business_assets/callback', requireAuth, identifyTenant, async (req, res) => {
    const { code, purpose } = (req.body || {}) as { code?: string; purpose?: string }
    if (!code) return res.status(400).json({ error: 'code_required' })
    if (purpose !== 'instagram' && purpose !== 'meta_ads' && purpose !== 'leads') {
      return res.status(400).json({ error: 'invalid_purpose' })
    }

    const userId   = (req as any).user?.id  as string | undefined
    const tenantId = (req as any).tenantId  as string | undefined
    if (!userId || !tenantId) return res.status(401).json({ error: 'auth_required' })

    const appId     = process.env.META_APP_ID
    const appSecret = process.env.META_APP_SECRET
    if (!appId || !appSecret) return res.status(500).json({ error: 'meta_app_not_configured' })

    try {
      // FBLfB code exchange — no redirect_uri (unlike classic dialog/oauth,
      // which requires the exact URI that was passed at authorization time).
      const t1 = await fetch(
        `${GRAPH}/oauth/access_token?client_id=${appId}&client_secret=${appSecret}&code=${encodeURIComponent(code)}`
      ).then(r => r.json()) as any
      if (!t1?.access_token) throw new Error(t1?.error?.message ?? 'token_exchange_failed')

      // Access-token step is complete. For a System-User-token config with
      // "Never" expiry (see FBLfB wizard), no fb_exchange_token step is
      // needed — the token is already long-lived (until revoked). But the
      // exchange is idempotent so it stays as belt-and-braces for configs
      // that don't set Never.
      const t2 = await fetch(
        `${GRAPH}/oauth/access_token?grant_type=fb_exchange_token&client_id=${appId}&client_secret=${appSecret}&fb_exchange_token=${t1.access_token}`
      ).then(r => r.json()).catch(() => ({})) as any
      const userToken = t2?.access_token ?? t1.access_token

      // Per-purpose identity fetch + upsert. Mirrors the classic callbacks
      // (routes/instagram.ts, routes/meta-ads.ts) so downstream code that
      // reads tenant_integrations sees identical rows regardless of which
      // OAuth path was used.
      if (purpose === 'instagram') {
        const pages = await fetch(`${GRAPH}/me/accounts?fields=id,name,access_token,instagram_business_account&access_token=${userToken}`).then(r => r.json()) as any
        const linked = (pages?.data ?? []).find((p: any) => p.instagram_business_account?.id)
        if (!linked) return res.status(400).json({ error: 'no_ig_business_account', message: 'No Instagram Business account is linked to your Facebook Pages. Convert your IG account to Business + link it to a Page first.' })

        const igUserId  = linked.instagram_business_account.id as string
        const pageId    = linked.id as string
        const pageToken = linked.access_token as string

        let igUsername: string | null = null
        let igDisplayName: string | null = null
        try {
          const igMe = await fetch(`${GRAPH}/${igUserId}?fields=username,name&access_token=${pageToken}`).then(r => r.json()) as any
          if (igMe?.username) igUsername = igMe.username
          if (igMe?.name)     igDisplayName = igMe.name
        } catch (e: any) {
          console.warn(`[meta_business_assets:instagram] identity fetch failed (non-fatal): ${e?.message}`)
        }
        const brandLabel = igUsername ? `@${igUsername}` : (linked.name ?? `IG ${igUserId}`)

        const { error: upsertErr } = await supabase.from('tenant_integrations').upsert({
          tenant_id: tenantId, user_id: userId, key: 'instagram', status: 'active',
          access_token: encrypt(pageToken),
          scope: IG_SCOPES,
          brand_label: brandLabel,
          connected_at: new Date().toISOString(),
          metadata: {
            ig_user_id:      igUserId,
            ig_username:     igUsername,
            ig_display_name: igDisplayName,
            page_id:         pageId,
            page_name:       linked.name ?? null,
            auth_flow:       'fblfb',
          },
        }, { onConflict: 'tenant_id,key' })
        if (upsertErr) {
          console.error(`[meta_business_assets:instagram] DB upsert failed: ${upsertErr.message}`)
          return res.status(500).json({ error: 'db_upsert_failed', message: upsertErr.message })
        }
        return res.json({ ok: true, label: brandLabel })
      }

      // meta_ads / leads share the same upsert shape (Leads inherits its
      // access via the Ads scope set — `leads_retrieval` is already in the
      // ADS_SCOPES union, so both use the meta_ads integration row).
      const accounts = await fetch(`${GRAPH}/me/adaccounts?fields=id,name,currency,business&access_token=${userToken}`).then(r => r.json()) as any
      const accs = accounts?.data ?? []

      let metaUserName: string | null = null
      try {
        const me = await fetch(`${GRAPH}/me?fields=name&access_token=${userToken}`).then(r => r.json()) as any
        if (me?.name) metaUserName = me.name
      } catch (e: any) {
        console.warn(`[meta_business_assets:ads] identity fetch failed (non-fatal): ${e?.message}`)
      }

      const brandLabel =
        accs.length === 1
          ? (accs[0].name as string)
          : metaUserName
            ? `${metaUserName} — ${accs.length} ad account${accs.length === 1 ? '' : 's'}`
            : `${accs.length} ad account${accs.length === 1 ? '' : 's'}`

      const { error: upsertErr } = await supabase.from('tenant_integrations').upsert({
        tenant_id: tenantId, user_id: userId, key: 'meta_ads', status: 'active',
        access_token: encrypt(userToken),
        scope: ADS_SCOPES,
        brand_label: brandLabel,
        connected_at: new Date().toISOString(),
        metadata: {
          meta_user_name: metaUserName,
          ad_accounts: accs.map((a: any) => ({ id: a.id, name: a.name, currency: a.currency })),
          auth_flow: 'fblfb',
        },
      }, { onConflict: 'tenant_id,key' })
      if (upsertErr) {
        console.error(`[meta_business_assets:ads] DB upsert failed: ${upsertErr.message}`)
        return res.status(500).json({ error: 'db_upsert_failed', message: upsertErr.message })
      }

      // Mirror ad accounts into meta_ad_accounts (same as routes/meta-ads.ts).
      for (const a of accs) {
        await supabase.from('meta_ad_accounts').upsert({
          tenant_id: tenantId,
          ad_account_id: a.id,
          name: a.name ?? null,
          currency: a.currency ?? null,
          business_id: a.business?.id ?? null,
        }, { onConflict: 'ad_account_id' as any })
      }

      return res.json({ ok: true, label: brandLabel })
    } catch (err: any) {
      console.error(`[meta_business_assets] failed: ${err?.message}`)
      return res.status(500).json({ error: 'connect_failed', message: err?.message ?? String(err) })
    }
  })

  return r
}
