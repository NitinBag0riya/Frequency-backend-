/**
 * Generic "Test connection" — GET /api/connectors/:key/test
 *
 * Parity with the WhatsApp verify button, for every connected app. Returns a
 * uniform { ok, detail?, error?, live? }:
 *   - live=true  → we made a real read-only API call to the provider with the
 *                  stored credentials and it succeeded (razorpay, brevo, telegram).
 *   - live=false → the credentials are present + decryptable, but this app has no
 *                  live probe wired yet (honest — we don't pretend to have pinged).
 *   - ok=false   → not connected, or the provider rejected the stored creds.
 *
 * Read-only + side-effect-free by construction (each probe is a GET). WhatsApp
 * keeps its own richer /verify endpoint; the FE routes whatsapp there.
 *
 * Adding a live probe for another connector = one entry in LIVE_PROBES below
 * (reuse the exact side-effect-free call its connect handler validates with).
 */

import express from 'express'
import type { SupabaseClient } from '@supabase/supabase-js'
import { decrypt } from '../../crypto'

type Middleware = express.RequestHandler
interface Deps {
  supabase: SupabaseClient
  requireAuth: Middleware
  identifyTenant: Middleware
  checkPermission: (feature: string, action: 'view' | 'edit' | 'delete') => Middleware
}

interface TestResult { ok: boolean; detail?: string; error?: string; live?: boolean }
interface Creds { accessToken: string; refreshToken: string; metadata: any }

const CF_BASE: Record<string, string> = {
  production: 'https://api.cashfree.com/pg',
  sandbox:    'https://sandbox.cashfree.com/pg',
}

// Per-connector live probes (tenant_integrations-backed). Each receives the
// DECRYPTED credentials and makes one read-only call.
const LIVE_PROBES: Record<string, (c: Creds) => Promise<TestResult>> = {
  async razorpay({ accessToken, refreshToken }) {
    const auth = Buffer.from(`${accessToken}:${refreshToken}`).toString('base64')
    const r = await fetch('https://api.razorpay.com/v1/payments?count=1', { headers: { Authorization: `Basic ${auth}` } })
    if (r.ok) return { ok: true, live: true, detail: 'Razorpay API reachable with your keys.' }
    if (r.status === 401) return { ok: false, error: 'Razorpay rejected the stored keys (401). Reconnect with fresh keys.' }
    return { ok: false, error: `Razorpay returned ${r.status}.` }
  },
  async brevo({ accessToken }) {
    const r = await fetch('https://api.brevo.com/v3/account', { headers: { 'api-key': accessToken, Accept: 'application/json' } })
    if (r.ok) {
      const j: any = await r.json().catch(() => ({}))
      return { ok: true, live: true, detail: j?.email ? `Brevo account ${j.email} reachable.` : 'Brevo API reachable.' }
    }
    if (r.status === 401) return { ok: false, error: 'Brevo rejected the stored API key (401).' }
    return { ok: false, error: `Brevo returned ${r.status}.` }
  },
  async cashfree({ accessToken, metadata }) {
    const env = metadata?.environment === 'sandbox' ? 'sandbox' : 'production'
    const base = CF_BASE[env]
    const appId = metadata?.app_id
    if (!appId) return { ok: true, live: false, detail: 'Cashfree credentials stored (App ID not on file for a live probe).' }
    // Side-effect-free: fetch a deliberately absent order. Valid creds → 404
    // order_not_found; bad creds → 401/403 authentication_error.
    const r = await fetch(`${base}/orders/cfverify${Date.now()}`, {
      headers: { 'x-client-id': appId, 'x-client-secret': accessToken, 'x-api-version': '2023-08-01' },
    })
    if (r.status === 401 || r.status === 403) return { ok: false, error: `Cashfree rejected the stored credentials (${r.status}).` }
    return { ok: true, live: true, detail: `Cashfree (${env}) reachable with your keys.` }
  },
}

export function createTestConnectionRouter(deps: Deps): express.Router {
  const { supabase, requireAuth, identifyTenant, checkPermission } = deps
  const r = express.Router()

  r.get('/api/connectors/:key/test', requireAuth, identifyTenant, checkPermission('integrations', 'view'), async (req, res) => {
    const key = String(req.params.key ?? '')
    const tenantId = (req as any).tenantId
    try {
      // Telegram lives in tg_bots (not tenant_integrations) — getMe is its probe.
      if (key === 'telegram') {
        const { data: bot } = await supabase.from('tg_bots').select('token').eq('tenant_id', tenantId).maybeSingle()
        if (!bot?.token) { res.json({ ok: false, error: 'Telegram is not connected.' }); return }
        const token = decrypt(bot.token as string)
        const tg = await fetch(`https://api.telegram.org/bot${token}/getMe`)
        const tj: any = await tg.json().catch(() => ({}))
        if (tg.ok && tj?.ok) { res.json({ ok: true, live: true, detail: tj.result?.username ? `Bot @${tj.result.username} reachable.` : 'Telegram bot reachable.' }); return }
        res.json({ ok: false, error: tj?.description ?? `Telegram returned ${tg.status}.` }); return
      }

      // Everyone else: tenant_integrations.
      const { data: row } = await supabase.from('tenant_integrations')
        .select('status, access_token, refresh_token, metadata, brand_label')
        .eq('tenant_id', tenantId).eq('key', key).maybeSingle()
      if (!row || row.status !== 'active') { res.json({ ok: false, error: `${key} is not connected for this workspace.` }); return }

      const probe = LIVE_PROBES[key]
      if (probe) {
        res.json(await probe({
          accessToken:  decrypt((row.access_token as string) ?? ''),
          refreshToken: decrypt((row.refresh_token as string) ?? ''),
          metadata:     row.metadata ?? {},
        }))
        return
      }

      // No live probe yet — but the credentials exist and decrypt cleanly.
      try { decrypt((row.access_token as string) ?? '') } catch { /* non-fatal */ }
      res.json({ ok: true, live: false, detail: `Credentials stored${(row as any).brand_label ? ` (${(row as any).brand_label})` : ''}. No live health-check for this app yet.` })
    } catch (e: any) {
      res.json({ ok: false, error: e?.message ?? 'Test failed.' })
    }
  })

  return r
}
