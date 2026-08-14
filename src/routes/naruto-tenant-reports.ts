/**
 * naruto-tenant-reports — the platform (/naruto §11) per-tenant "Reports & growth"
 * backend. It is a THIN, capability-gated proxy: it does NOT recompute a tenant's
 * P&L — the storefront-api already owns that in ONE place
 *   GET /admin/reports/unified   (see storefront-api/reports-unified.js)
 * which returns the full superset (summary / byChannel / byPayment / byDay /
 * byOutlet / topItems / comps / discounts / groups / detailRows + compare deltas).
 *
 * This module's only jobs are:
 *   1. resolve tenantId → { slug, vertical } from Supabase (storefront-api keys on slug),
 *   2. authorize the operator (payments.read — the report exposes GMV/revenue),
 *   3. forward the whitelisted report params to storefront-api with the admin secret
 *      (the dashboard never holds ADMIN_SECRET; the capability guard is the fence),
 *   4. audit the read (detailRows carry customer phone → §16 "log PII access").
 *
 * Everything else — Revenue / Catalog / Customers / Loyalty / Operations views and
 * the plain-English growth digest — is derived CLIENT-SIDE from this one response
 * (src/lib/naruto-tenant-reports.ts), so there is no second definition of the P&L.
 *
 * Endpoint (requireAuth + a platform capability):
 *   GET /api/super-admin/tenant-reports/:tenantId   payments.read
 *
 * WIRE(naruto): register in index.ts next to the other naruto routers (below
 *   createNarutoPlansRouter, ABOVE the catch-all 404):
 *     import { createNarutoTenantReportsRouter } from './routes/naruto-tenant-reports'
 *     app.use(createNarutoTenantReportsRouter({ supabase, requireAuth }))
 */
import express from 'express'
import type { SupabaseClient } from '@supabase/supabase-js'
import { requirePlatformCapability } from '../lib/platform-guard.js'
import { recordPlatformAudit } from '../lib/platform-audit.js'

type Mw = (req: express.Request, res: express.Response, next: express.NextFunction) => void | Promise<void>
interface Deps { supabase: SupabaseClient; requireAuth: Mw }

const SF_API = process.env.STOREFRONT_API_URL || 'http://localhost:5181'
const SF_SECRET = process.env.STOREFRONT_ADMIN_SECRET || 'dev-admin'

// Only these report params are forwarded — the storefront-api owns their meaning
// (identical to what the dashboard's own Reports page sends). Anything else is dropped.
const FORWARD = ['from', 'to', 'tzOffsetMin', 'groupBy', 'channels', 'status', 'payment', 'minValue', 'compare', 'outlet']

// Per-tenant unified report. X-Tenant = slug (cross-tenant is what makes this a
// PLATFORM view; the operator is already authorized upstream by the capability).
async function sfUnifiedReport(slug: string, qs: URLSearchParams): Promise<any> {
  const r = await fetch(`${SF_API}/admin/reports/unified?${qs}`, {
    headers: { 'X-Admin-Secret': SF_SECRET, 'X-Tenant': slug },
  })
  if (!r.ok) throw new Error(`storefront-api reports/unified → ${r.status}`)
  return r.json()
}

export function createNarutoTenantReportsRouter({ supabase, requireAuth }: Deps): express.Router {
  const r = express.Router()

  r.get('/api/super-admin/tenant-reports/:tenantId',
    requireAuth, requirePlatformCapability(supabase, 'payments.read'),
    async (req, res) => {
      const tenantId = String(req.params.tenantId)
      try {
        const { data: t } = await supabase.from('tenants')
          .select('slug, business_name, business_type')
          .eq('id', tenantId).maybeSingle()
        const slug = (t as any)?.slug
        if (!slug) { res.status(404).json({ error: 'unknown tenant' }); return }

        const qs = new URLSearchParams()
        for (const k of FORWARD) {
          const v = req.query[k]
          if (v != null && String(v) !== '') qs.set(k, String(v))
        }

        const report = await sfUnifiedReport(slug, qs)

        // Read audit — detailRows expose customer phone (PII). Best-effort; the
        // read still succeeds if the audit insert fails (see recordPlatformAudit).
        await recordPlatformAudit(supabase, req, {
          capability: 'payments.read',
          action: 'tenant.report.read',
          tenant_id: tenantId,
          before: {}, after: { range: report?.range ?? null },
          reason: 'view tenant reports',
        })

        res.set('Cache-Control', 'no-cache')
        res.json({
          tenant: {
            slug,
            name: (t as any)?.business_name ?? slug,
            vertical: (t as any)?.business_type ?? 'other',
          },
          report,
        })
      } catch (e: any) {
        res.status(502).json({ error: e?.message || 'tenant report unavailable' })
      }
    })

  return r
}
