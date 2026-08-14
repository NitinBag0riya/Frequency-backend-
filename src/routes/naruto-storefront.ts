/**
 * naruto-storefront — the ONLY new backend surface the /naruto "Step 4 —
 * Storefront setup" console needs (spec §5 step 4). Everything else is REUSE:
 *
 *   • Theme / brand / hero / about-footer writes  → the existing platform-guarded
 *     proxy  r.all('/api/storefront/admin/*')  (storefront-domains.ts). A platform
 *     user targets the tenant with the X-Tenant-ID header; identifyTenant admits
 *     it (index.ts §0 "Platform-scoped role check"), so the operator edits that
 *     tenant's OWN storefront-api config with no new endpoint.
 *   • Add / delete / recheck custom domain          → the existing
 *     /api/storefront/domains* routes, same X-Tenant-ID targeting.
 *
 * Two things those reuses can't cover, added here (capability-gated via the
 * wave-1 platform guard, so a leaked FE bundle can't drive them):
 *   1. GET  domains for an ARBITRARY tenant — the tenant-facing list reads
 *      tenant_domains through RLS (own tenant only); a platform operator needs a
 *      service-client read of any tenant's domains.
 *   2. POST an audit row for a storefront-setup mutation — records the platform
 *      audit trail (actor · capability · tenant · before→after diff · reason · ip)
 *      via the wave-1 recordPlatformAudit helper, since the reused proxy/domain
 *      routes don't (yet) emit a platform-audit row for platform callers.
 *
 * WIRE(naruto): register in index.ts next to the other storefront routers, e.g.
 *   import { createNarutoStorefrontRouter } from './routes/naruto-storefront'
 *   app.use(createNarutoStorefrontRouter({ supabase, requireAuth }))
 * (mount ABOVE the catch-all 404; requireAuth is the same middleware already
 *  threaded into createStorefrontAppRouter / createStorefrontDomainsRouter.)
 *
 * WIRE(naruto): the reused proxy + domain routes could emit recordPlatformAudit
 * directly for platform callers (one call each in storefront-domains.ts, guarded
 * on (req as any).isSuperAdmin) — that would make the audit tamper-proof rather
 * than FE-driven. Left as a note to avoid editing that shared file in this wave.
 */
import express from 'express'
import type { SupabaseClient } from '@supabase/supabase-js'
import { requirePlatformCapability } from '../lib/platform-guard.js'
import { recordPlatformAudit } from '../lib/platform-audit.js'
import { PLATFORM_CAPABILITIES, type PlatformCapability } from '../lib/platform-rbac.js'

type Mw = (req: express.Request, res: express.Response, next: express.NextFunction) => void | Promise<void>
interface Deps { supabase: SupabaseClient; requireAuth: Mw }

// Storefront setup is part of the assisted onboarding wizard (spec §5), so the
// setup capability is onboarding.wizard.run (platform_owner + platform_onboarding).
const SETUP_CAP: PlatformCapability = 'onboarding.wizard.run'
const READ_CAP: PlatformCapability = 'tenant.read'

export function createNarutoStorefrontRouter({ supabase, requireAuth }: Deps): express.Router {
  const r = express.Router()

  // ── 1. List a tenant's custom domains + slug (service-client; any tenant) ────
  // Mirrors the FE `listDomains` shape (RLS blocks a cross-tenant direct read),
  // plus the tenant's routable `slug` — the PlatformTenant projection doesn't
  // carry it, and the QR/base-URL builder needs it. Read-only.
  r.get('/api/super-admin/storefront/:tenantId/domains',
    requireAuth, requirePlatformCapability(supabase, READ_CAP),
    async (req, res) => {
      const tenantId = String(req.params.tenantId)
      const [{ data: domains, error }, { data: t }] = await Promise.all([
        supabase.from('tenant_domains').select('*').eq('tenant_id', tenantId).order('created_at', { ascending: true }),
        supabase.from('tenants').select('slug').eq('id', tenantId).maybeSingle(),
      ])
      if (error) { res.status(500).json({ error: error.message }); return }
      res.json({ slug: (t as any)?.slug ?? null, domains: domains ?? [] })
    })

  // ── 2. Record a storefront-setup mutation to the platform audit log ─────────
  // The mutation itself already went through the reused platform-guarded proxy /
  // domain route; this writes the audit row. Capability defaults to SETUP_CAP;
  // the caller may name a tighter capability it actually used (validated).
  r.post('/api/super-admin/storefront/:tenantId/audit',
    requireAuth, requirePlatformCapability(supabase, SETUP_CAP),
    async (req, res) => {
      const tenantId = String(req.params.tenantId)
      const body = (req.body ?? {}) as {
        action?: string; capability?: string; reason?: string | null
        before?: Record<string, any> | null; after?: Record<string, any> | null
      }
      const capability = (PLATFORM_CAPABILITIES as readonly string[]).includes(body.capability ?? '')
        ? (body.capability as PlatformCapability) : SETUP_CAP
      await recordPlatformAudit(supabase, req, {
        capability,
        action: String(body.action || 'storefront.setup'),
        tenant_id: tenantId,
        before: body.before ?? null,
        after: body.after ?? null,
        reason: body.reason ?? null,
      })
      res.json({ ok: true })
    })

  return r
}
