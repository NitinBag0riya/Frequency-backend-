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

type Middleware = (req: express.Request, res: express.Response, next: express.NextFunction) => void | Promise<void>

interface Deps {
  supabase: SupabaseClient
  requireAuth: Middleware
  identifyTenant: Middleware
  checkPermission: (feature: string, action: 'view' | 'edit' | 'delete') => Middleware
}

export function createConnectorsRouter(deps: Deps): express.Router {
  const r = express.Router()
  const { supabase, requireAuth, identifyTenant } = deps

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
      // key that's already been added from tenant_integrations.
      const { data: tenant } = await supabase.from('tenants')
        .select('waba_id, display_phone, google_email, google_access_token')
        .eq('id', tenantId).maybeSingle()
      if (tenant?.waba_id && !seen.has('whatsapp')) {
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
  r.get('/api/channels/connected',
    requireAuth, identifyTenant,
    async (req, res) => {
      const tenantId = (req as any).tenantId
      const channels: { key: string; name: string; brandColor: string; iconName: string; connected: boolean }[] = []

      // For each channel-marked connector, decide if this tenant has it
      for (const def of CONNECTOR_REGISTRY) {
        if (!def.isChannel) continue

        let connected = false
        if (def.key === 'whatsapp') {
          const { data } = await supabase.from('tenants')
            .select('waba_id').eq('id', tenantId).maybeSingle()
          connected = !!data?.waba_id
        } else if (def.key === 'telegram') {
          const { data } = await supabase.from('tg_bots')
            .select('tenant_id').eq('tenant_id', tenantId).maybeSingle()
          connected = !!data
        } else {
          const { data } = await supabase.from('tenant_integrations')
            .select('status').eq('tenant_id', tenantId).eq('key', def.key).maybeSingle()
          connected = !!data && (data.status === 'active' || data.status == null)
        }

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
  r.post('/api/connectors/:key/disconnect',
    requireAuth, identifyTenant,
    async (req, res) => {
      const tenantId = (req as any).tenantId
      const key = req.params.key

      // Channel-specific disconnect side effects
      if (key === 'telegram') {
        await supabase.from('tg_bots').delete().eq('tenant_id', tenantId)
      }

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

  // ── Google OAuth start routes — mounted inline (sub-router nesting causes
  // path-resolution quirks in Express when using full /api/auth/... paths) ────
  // All four Google app keys share the same combined scope; one token covers all.
  for (const googleKey of ['google_drive', 'google_sheets', 'google_calendar', 'google_gmail'] as const) {
    r.get(`/api/auth/${googleKey}/start`,
      requireAuth, identifyTenant,
      (req, res) => {
        const clientId = process.env.GOOGLE_CLIENT_ID
        if (!clientId || !process.env.GOOGLE_CLIENT_SECRET) {
          res.status(503).type('html').send(`<!doctype html><html><head><meta charset="utf-8"><title>Google not configured</title></head><body>
            <h2>⚙️ Google OAuth not configured</h2>
            <p>Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET env vars.</p>
            <script>setTimeout(() => { try { window.close(); } catch(e){} }, 6000);</script>
            </body></html>`)
          return
        }
        const userId   = (req as any).user?.id   as string
        const tenantId = (req as any).tenantId   as string
        const redirectUri = process.env.GOOGLE_REDIRECT_URI || 'http://localhost:3001/api/auth/google/callback'
        const statePayload = Buffer.from(JSON.stringify({ userId, tenantId, connectorKey: googleKey })).toString('base64')
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
