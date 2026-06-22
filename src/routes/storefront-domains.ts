/**
 * storefront-domains — operator endpoints to connect a custom domain to a
 * tenant's storefront. The dashboard calls these (authenticated) instead of
 * writing tenant_domains directly, so the Vercel registration (which needs a
 * privileged token) happens SERVER-SIDE — the token never reaches the browser.
 *
 *   POST   /api/storefront/domains      { hostname }  → register on Vercel + record + return DNS config
 *   DELETE /api/storefront/domains/:id                → remove from Vercel + record
 *
 * Env (fly secrets on the API app):
 *   VERCEL_API_TOKEN          — a Vercel token with access to the storefront project
 *   VERCEL_TEAM_ID            — the Vercel team/scope id
 *   VERCEL_STOREFRONT_PROJECT — project name (default "frequency-storefront")
 */
import express from 'express'
import { SupabaseClient } from '@supabase/supabase-js'

type Mw = (req: express.Request, res: express.Response, next: express.NextFunction) => void | Promise<void>
interface Deps { supabase: SupabaseClient; requireAuth: Mw; identifyTenant: Mw }

const VTOKEN = process.env.VERCEL_API_TOKEN
const VTEAM = process.env.VERCEL_TEAM_ID
const VPROJECT = process.env.VERCEL_STOREFRONT_PROJECT || 'frequency-storefront'
const vercelConfigured = !!(VTOKEN && VTEAM)

async function vercel(method: string, path: string, body?: unknown): Promise<{ ok: boolean; status: number; json: any }> {
  const sep = path.includes('?') ? '&' : '?'
  const r = await fetch(`https://api.vercel.com${path}${sep}teamId=${VTEAM}`, {
    method,
    headers: { Authorization: `Bearer ${VTOKEN}`, 'Content-Type': 'application/json' },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  const json = await r.json().catch(() => ({}))
  return { ok: r.ok, status: r.status, json }
}

function normalizeHostname(raw: string): string {
  return String(raw || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/\.$/, '')
}
function isValidHostname(h: string): boolean {
  return /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(h) && h.length <= 253
}

export function createStorefrontDomainsRouter(deps: Deps): express.Router {
  const r = express.Router()
  const { supabase, requireAuth, identifyTenant } = deps

  r.post('/api/storefront/domains', requireAuth, identifyTenant, async (req, res) => {
    const tenantId = (req as any).tenantId
    const hostname = normalizeHostname((req.body as any)?.hostname)
    if (!isValidHostname(hostname)) { res.status(400).json({ error: 'Enter a valid domain, e.g. order.yourbrand.com' }); return }

    // 1. Register on Vercel so it serves the storefront + issues TLS. 409 = the
    //    domain is already on the project → fine (idempotent).
    if (vercelConfigured) {
      const add = await vercel('POST', `/v10/projects/${VPROJECT}/domains`, { name: hostname })
      if (!add.ok && add.status !== 409) {
        const msg = add.json?.error?.message || `Couldn't register the domain (${add.status}).`
        // 403/forbidden often means the domain belongs to another Vercel account.
        res.status(502).json({ error: msg }); return
      }
    }

    // 2. Record against the tenant. Unique on hostname → a domain can belong to
    //    exactly one storefront.
    const verification_token = `freq-verify-${Math.random().toString(36).slice(2, 10)}`
    const { data, error } = await supabase.from('tenant_domains')
      .insert({ tenant_id: tenantId, hostname, kind: 'custom', verification_token })
      .select('*').single()
    if (error) {
      const dup = (error as any).code === '23505'
      res.status(dup ? 409 : 500).json({ error: dup ? 'That domain is already connected.' : error.message })
      return
    }

    // 3. Ask Vercel what DNS records are required (so the UI can show the exact ones).
    let dns: any = null
    if (vercelConfigured) {
      const cfg = await vercel('GET', `/v9/projects/${VPROJECT}/domains/${encodeURIComponent(hostname)}/config`)
      if (cfg.ok) dns = cfg.json
    }
    res.json({ domain: data, dns })
  })

  r.delete('/api/storefront/domains/:id', requireAuth, identifyTenant, async (req, res) => {
    const tenantId = (req as any).tenantId
    const { data: row } = await supabase.from('tenant_domains')
      .select('hostname').eq('id', req.params.id).eq('tenant_id', tenantId).maybeSingle()
    if (row?.hostname && vercelConfigured) {
      await vercel('DELETE', `/v9/projects/${VPROJECT}/domains/${encodeURIComponent(row.hostname)}`) // best-effort
    }
    const { error } = await supabase.from('tenant_domains').delete().eq('id', req.params.id).eq('tenant_id', tenantId)
    if (error) { res.status(500).json({ error: error.message }); return }
    res.json({ ok: true })
  })

  return r
}
