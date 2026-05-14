/**
 * Connector router — public catalog + connection lifecycle.
 *
 *   GET  /api/connectors/registry         — list of all known connectors
 *                                          (live + planned). Drives AppsModal +
 *                                          Sidebar without hardcoding the FE.
 *   GET  /api/connectors/connections      — this tenant's connected apps with
 *                                          status (token expired? scope drift?),
 *                                          plus category / isChannel /
 *                                          channelFeatures so the FE can group
 *                                          by category in the sidebar.
 *   GET  /api/channels/connected          — message-channel filter tabs
 *                                          (subset of connections where
 *                                          isChannel === true).
 *   POST /api/connectors/:key/disconnect  — revoke locally; clears tokens.
 *
 * Per-connector OAuth start/callback + capability endpoints live in
 * routes/connectors/<key>.ts and are mounted from this file.
 */

import express from 'express'
import { SupabaseClient } from '@supabase/supabase-js'
import { CONNECTOR_REGISTRY, publicRegistry, getConnector } from '../../connectors/registry'
import { createAirtableConnector } from './airtable'
import { createRazorpayConnector } from './razorpay'
import { createShopifyConnector } from './shopify'
import { createSlackConnector } from './slack'
import { signOauthState } from '../../lib/oauth-state'

type Middleware = (req: express.Request, res: express.Response, next: express.NextFunction) => void | Promise<void>

interface Deps {
  supabase: SupabaseClient
  requireAuth: Middleware
  identifyTenant: Middleware
  checkPermission: (feature: string, action: 'view' | 'edit' | 'delete') => Middleware
}

export function createConnectorsRouter(deps: Deps): express.Router {
  const r = express.Router()
  const { supabase, requireAuth, identifyTenant, checkPermission } = deps

  // ── Public registry — used by FE AppsModal + Sidebar ──────────────────────
  r.get('/api/connectors/registry', (_req, res) => {
    res.json({ connectors: publicRegistry() })
  })

  /**
   * Build a uniform connection row (whether sourced from tenant_integrations,
   * the legacy `tenants` columns, or per-channel tables like tg_bots) so the
   * sidebar's CategorySections can group consistently.
   */
  function buildConnRow(args: {
    key: string
    status?: string
    brand_label?: string | null
    scope?: string | null
    last_used_at?: string | null
    token_expires_at?: string | null
    connected_at?: string | null
    metadata?: Record<string, unknown>
  }) {
    const def = getConnector(args.key)
    return {
      key:               args.key,
      name:              def?.name ?? args.key,
      category:          def?.category ?? 'other',
      isChannel:         !!def?.isChannel,
      channelFeatures:   def?.channelFeatures ?? [],
      status:            args.status ?? 'active',
      brand_label:       args.brand_label ?? null,
      scope:             args.scope ?? null,
      last_used_at:      args.last_used_at ?? null,
      token_expires_at:  args.token_expires_at ?? null,
      connected_at:      args.connected_at ?? null,
      metadata:          args.metadata ?? {},
      capabilities:      (def?.capabilities ?? []).filter(c => c.status !== 'planned'),
      icon:              def?.iconName ?? 'Box',
      color:             def?.brandColor ?? '#888',
    }
  }

  // ── List my tenant's connections with health flags ────────────────────────
  r.get('/api/connectors/connections',
    requireAuth, identifyTenant,
    async (req, res) => {
      const tenantId = (req as any).tenantId

      // 1. tenant_integrations rows (Airtable, Razorpay, Shopify, IG, Meta Ads, …)
      const { data: tiRows, error } = await supabase.from('tenant_integrations')
        .select('key, status, brand_label, scope, token_expires_at, last_used_at, metadata, connected_at')
        .eq('tenant_id', tenantId)
      if (error) { res.status(500).json({ error: error.message }); return }

      // Track keys we've already added so legacy-table synthesis below doesn't
      // produce duplicate rows when the same app exists in tenant_integrations
      // (e.g. google_sheets row + a legacy google_access_token on tenants).
      const seen = new Set<string>()
      const rows: ReturnType<typeof buildConnRow>[] = []

      for (const row of tiRows ?? []) {
        const expired = row.token_expires_at ? new Date(row.token_expires_at).getTime() < Date.now() : false
        rows.push(buildConnRow({
          key: row.key,
          status: expired ? 'expired' : (row.status ?? 'active'),
          brand_label: row.brand_label,
          scope: row.scope,
          last_used_at: row.last_used_at,
          token_expires_at: row.token_expires_at,
          connected_at: row.connected_at,
          metadata: row.metadata ?? {},
        }))
        seen.add(row.key)
      }

      // 2. tenants — WhatsApp + Google live here for legacy reasons. Skip any
      // key that's already been added from tenant_integrations. Critically:
      // gate WhatsApp on tenants.status === 'active' so a disconnected tenant
      // (waba_id is still present because it's NOT NULL) doesn't show up as
      // connected.
      const { data: tenant } = await supabase.from('tenants')
        .select('waba_id, display_phone, status, google_email, google_access_token')
        .eq('id', tenantId).maybeSingle()
      if (tenant?.waba_id && tenant.status === 'active' && !seen.has('whatsapp')) {
        rows.push(buildConnRow({ key: 'whatsapp', brand_label: tenant.display_phone ?? tenant.waba_id }))
        seen.add('whatsapp')
      }
      if (tenant?.google_access_token) {
        for (const k of ['google_drive', 'google_sheets', 'google_calendar', 'google_gmail']) {
          if (seen.has(k)) continue
          rows.push(buildConnRow({ key: k, brand_label: tenant.google_email ?? '' }))
          seen.add(k)
        }
      }

      // 3. tg_bots — Telegram lives in its own table
      const { data: tgBot } = await supabase.from('tg_bots')
        .select('bot_username, bot_id, created_at')
        .eq('tenant_id', tenantId).maybeSingle()
      if (tgBot?.bot_id && !seen.has('telegram')) {
        rows.push(buildConnRow({
          key: 'telegram',
          brand_label: tgBot.bot_username ? `@${tgBot.bot_username}` : `bot ${tgBot.bot_id}`,
          connected_at: tgBot.created_at,
        }))
      }

      res.json(rows)
    })

  // ── Channel filter tabs (Inbox / Contacts / Campaigns) ───────────────────
  // Returns ONLY the connectors marked as `isChannel`. FE renders these as
  // [All] [WhatsApp ●] [Instagram ●] [Telegram ●] tabs above each unified view.
  // Previously this did N+1 DB roundtrips (one per channel-connector). Now
  // batched into 3 parallel queries (tenants / tg_bots / tenant_integrations)
  // and resolved in memory — fires on every sidebar mount + tenant switch
  // so the savings add up.
  r.get('/api/channels/connected',
    requireAuth, identifyTenant,
    async (req, res) => {
      const tenantId = (req as any).tenantId

      const [tenantRes, tgRes, integrationsRes] = await Promise.all([
        supabase.from('tenants').select('waba_id, status').eq('id', tenantId).maybeSingle(),
        supabase.from('tg_bots').select('tenant_id').eq('tenant_id', tenantId).maybeSingle(),
        supabase.from('tenant_integrations').select('key, status').eq('tenant_id', tenantId),
      ])

      const tenant = tenantRes.data
      const tgConnected = !!tgRes.data
      const intActiveByKey = new Map<string, boolean>()
      for (const r of (integrationsRes.data ?? []) as any[]) {
        intActiveByKey.set(r.key, r.status === 'active' || r.status == null)
      }

      const channels: { key: string; name: string; brandColor: string; iconName: string; connected: boolean }[] = []
      for (const def of CONNECTOR_REGISTRY) {
        if (!def.isChannel) continue

        let connected = false
        if      (def.key === 'whatsapp') connected = !!tenant?.waba_id && tenant.status === 'active'
        else if (def.key === 'telegram') connected = tgConnected
        else                             connected = intActiveByKey.get(def.key) === true

        if (connected) {
          channels.push({
            key: def.key,
            name: def.name,
            brandColor: def.brandColor,
            iconName: def.iconName,
            connected: true,
          })
        }
      }

      res.json({ channels })
    })

  // ── Disconnect (revokes local; user revokes upstream from provider dashboard) ──
  // Three storage shapes have to be handled:
  //   1. tenant_integrations rows  → delete the row (Airtable, Razorpay, …)
  //   2. tg_bots                   → delete the bot row (Telegram)
  //   3. tenants.* legacy columns  → flip tenants.status to 'disconnected'
  //                                  (WhatsApp) or NULL google_* fields (Google).
  // The previous version only did (1), so clicking "Disconnect" on WhatsApp
  // returned 200 OK while leaving tenants.waba_id intact — the next read of
  // /api/connectors/connections still saw it as connected.
  // Disconnect is a destructive operation — gated by integrations:delete so
  // read-only roles (viewer / analyst / support_agent) can't yank a tenant's
  // WhatsApp / Google / Telegram out from under the team.
  r.post('/api/connectors/:key/disconnect',
    requireAuth, identifyTenant, checkPermission('integrations', 'delete'),
    async (req, res) => {
      const tenantId = (req as any).tenantId
      const key = String(req.params.key ?? '')

      // ── Channel-specific disconnect side effects ──
      if (key === 'telegram') {
        const { error } = await supabase.from('tg_bots').delete().eq('tenant_id', tenantId)
        if (error) { res.status(500).json({ error: error.message }); return }
      }

      if (key === 'whatsapp') {
        // tenants.waba_id is NOT NULL + UNIQUE — we can't null it out without a
        // schema change. Flipping status to 'disconnected' and clearing the
        // access_token is the supported route. The read endpoints below now
        // filter by status, so the channel disappears from the UI.
        const { error } = await supabase.from('tenants').update({
          status: 'disconnected',
          access_token: '',  // belt-and-braces: revoke local copy of the Meta token
          updated_at: new Date().toISOString(),
        }).eq('id', tenantId)
        if (error) { res.status(500).json({ error: error.message }); return }
        res.json({ success: true })
        return
      }

      if (key.startsWith('google_')) {
        // The four google_* keys all share one OAuth token on the tenants row.
        // Disconnecting any one of them revokes the shared credential, so all
        // four go away in /api/connectors/connections together — that's the
        // honest behaviour given how the token is stored.
        const { error } = await supabase.from('tenants').update({
          google_email:         null,
          google_access_token:  null,
          google_refresh_token: null,
          google_token_expiry:  null,
          updated_at: new Date().toISOString(),
        }).eq('id', tenantId)
        if (error) { res.status(500).json({ error: error.message }); return }
        res.json({ success: true })
        return
      }

      // ── Generic path: row in tenant_integrations ──
      const { error } = await supabase.from('tenant_integrations').delete()
        .eq('tenant_id', tenantId).eq('key', key)
      if (error) { res.status(500).json({ error: error.message }); return }
      res.json({ success: true })
    })

  // ── Mount per-connector routers ───────────────────────────────────────────
  // Each adds its own OAuth start/callback + capability endpoints under
  //   /api/auth/<key>/...
  //   /api/connectors/<key>/...
  r.use(createAirtableConnector(deps))
  r.use(createRazorpayConnector(deps))
  r.use(createShopifyConnector(deps))
  r.use(createSlackConnector(deps))

  // ── Google OAuth start routes — mounted inline (sub-router nesting causes
  // path-resolution quirks in Express when using full /api/auth/... paths) ────
  // All four Google app keys share the same combined scope; one token covers all.
  for (const googleKey of ['google_drive', 'google_sheets', 'google_calendar', 'google_gmail'] as const) {
    r.get(`/api/auth/${googleKey}/start`,
      requireAuth, identifyTenant,
      (req, res) => {
        const clientId = process.env.GOOGLE_CLIENT_ID
        if (!clientId || !process.env.GOOGLE_CLIENT_SECRET) {
          // Post back ok:false so the FE shows the actual error instead of
          // either a misleading "connected" toast or a "Window closed before
          // connection completed" timeout when the popup just closes silently.
          const message = 'Google OAuth not configured (GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET env vars missing on the server)'
          // B10: pin postMessage targetOrigin to FRONTEND_URL.
          const FRONTEND_ORIGIN = process.env.FRONTEND_URL || 'http://localhost:5173'
          res.status(503).type('html').send(`<!doctype html><html><head><meta charset="utf-8"><title>Google not configured</title></head><body style="font-family:DM Sans,system-ui;background:#0d1117;color:#fff;padding:24px;text-align:center;">
            <h2>⚠ Google OAuth not configured</h2>
            <p style="opacity:.6">This window will close…</p>
            <script>
              try { window.opener?.postMessage({ ok: false, message: ${JSON.stringify(message)} }, ${JSON.stringify(FRONTEND_ORIGIN)}) } catch(e){}
              setTimeout(() => { try { window.close(); } catch(e){} }, 1500);
            </script></body></html>`)
          return
        }
        const userId   = (req as any).user?.id   as string
        const tenantId = (req as any).tenantId   as string
        const redirectUri = process.env.GOOGLE_REDIRECT_URI || 'http://localhost:3001/api/auth/google/callback'
        // B4: signed state with 10-min TTL + nonce + bound connectorKey.
        const statePayload = signOauthState({ userId, tenantId, connectorKey: googleKey })
        const scopes = [
          'https://www.googleapis.com/auth/calendar',
          'https://www.googleapis.com/auth/spreadsheets',
          'https://www.googleapis.com/auth/drive.readonly',
          'https://www.googleapis.com/auth/drive.file',
          'https://www.googleapis.com/auth/gmail.modify',
          'email', 'profile',
        ].join(' ')
        const params = new URLSearchParams({
          client_id:     clientId,
          redirect_uri:  redirectUri,
          response_type: 'code',
          scope:         scopes,
          access_type:   'offline',
          prompt:        'consent',
          state:         statePayload,
        })
        console.log(`[google-connector] Starting OAuth for key=${googleKey} tenant=${tenantId}`)
        res.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`)
      })
  }

  return r
}
