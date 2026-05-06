/**
 * Connector router — public catalog + connection lifecycle.
 *
 *   GET  /api/connectors/registry         — list of all known connectors
 *                                          (live + planned). Drives AppsModal +
 *                                          Sidebar without hardcoding the FE.
 *   GET  /api/connectors/connections      — this tenant's connected apps with
 *                                          status (token expired? scope drift?).
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
import { createGoogleConnector }  from './google'

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

  // ── List my tenant's connections with health flags ────────────────────────
  r.get('/api/connectors/connections',
    requireAuth, identifyTenant,
    async (req, res) => {
      const tenantId = (req as any).tenantId
      // NB: existing schema uses `connected_at` (from migration 005), not
      // `created_at`. We alias it on the way out so the FE shape is consistent
      // with other endpoints that DO use `created_at`.
      const { data, error } = await supabase.from('tenant_integrations')
        .select('key, status, brand_label, scope, token_expires_at, last_used_at, metadata, connected_at')
        .eq('tenant_id', tenantId)
      if (error) { res.status(500).json({ error: error.message }); return }

      const out = (data ?? []).map(row => {
        const def = getConnector(row.key)
        const expired = row.token_expires_at ? new Date(row.token_expires_at).getTime() < Date.now() : false
        return {
          key:            row.key,
          name:           def?.name ?? row.key,
          status:         expired ? 'expired' : (row.status ?? 'active'),
          brand_label:    row.brand_label,
          scope:          row.scope,
          last_used_at:   row.last_used_at,
          token_expires_at: row.token_expires_at,
          connected_at:   row.connected_at,
          metadata:       row.metadata,
          /** Capabilities for sidebar — filtered to live/stub (planned ones aren't surfaced in connected view) */
          capabilities:   (def?.capabilities ?? []).filter(c => c.status !== 'planned'),
          icon:           def?.iconName,
          color:          def?.brandColor,
        }
      })
      // Synthesize a row for WhatsApp + Google from the tenants table so the
      // sidebar treats them like first-class connections (they're stored on
      // tenants, not tenant_integrations, for legacy reasons).
      const { data: tenant } = await supabase.from('tenants')
        .select('waba_id, display_phone, google_email, google_access_token')
        .eq('id', tenantId).maybeSingle()
      if (tenant?.waba_id) {
        const def = getConnector('whatsapp')!
        out.push({
          key: 'whatsapp', name: def.name, status: 'active',
          brand_label: tenant.display_phone ?? tenant.waba_id,
          scope: '', last_used_at: null, token_expires_at: null, connected_at: null, metadata: {},
          capabilities: def.capabilities.filter(c => c.status !== 'planned'),
          icon: def.iconName, color: def.brandColor,
        })
      }
      if (tenant?.google_access_token) {
        for (const k of ['google_drive', 'google_sheets', 'google_calendar', 'google_gmail']) {
          const def = getConnector(k)
          if (!def) continue
          out.push({
            key: k, name: def.name, status: 'active',
            brand_label: tenant.google_email ?? '', scope: '',
            last_used_at: null, token_expires_at: null, connected_at: null, metadata: {},
            capabilities: def.capabilities.filter(c => c.status !== 'planned'),
            icon: def.iconName, color: def.brandColor,
          })
        }
      }
      res.json(out)
    })

  // ── Disconnect (revokes local; user revokes upstream from provider dashboard) ──
  r.post('/api/connectors/:key/disconnect',
    requireAuth, identifyTenant,
    async (req, res) => {
      const tenantId = (req as any).tenantId
      const { error } = await supabase.from('tenant_integrations').delete()
        .eq('tenant_id', tenantId).eq('key', req.params.key)
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
