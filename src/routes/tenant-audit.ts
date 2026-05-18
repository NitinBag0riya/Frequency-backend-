/**
 * Tenant audit log endpoint — read-side for the AuditLogPage FE.
 *
 * Mounts:
 *   GET /api/audit?page=N&pageSize=N&actor=…&action=…&from=ISO&to=ISO
 *     → { data, total, page, pageSize }
 *
 * Backing table: public.tenant_audit (migration 035_wa_calling.sql §10).
 * Append-only, populated by SECURITY DEFINER append_tenant_audit() called
 * from WA-calling features (recording.playback, transcript.export,
 * retention_policy.change, consent_default.change, cross_border_flag.toggle,
 * erasure.request, erasure.complete). Per DPDP §6 — 7-year retention.
 *
 * Row enrichment:
 *   actor_email  ← auth.users.email   (batched via auth.admin.listUsers)
 *   actor_name   ← public.profiles.full_name (batched via in() on actor_ids)
 *   payload      ← aliased from after_value so the FE's existing
 *                  read-models keep working without a new column.
 *
 * Auth:
 *   requireAuth + identifyTenant + checkPermission('settings', 'view').
 *   Spec called for 'audit' as the permission key, but that key isn't in
 *   any plan's `features` array (only platform plans have it — see
 *   018_seed_super_admin_defaults.sql), so the plan-whitelist check at
 *   step 4 of checkPermission would 402 every tenant. 'settings' is in
 *   every plan AND workspace_admin/owner already have settings.view, so
 *   the audit log slots into the existing Workspace Settings perimeter
 *   without a migration. (Adding 'audit' to plan features would be the
 *   right long-term fix; deferred to a separate migration PR.)
 *
 * Why a separate router file (vs in index.ts): keeps the index.ts route
 * registration block focused on legacy + cross-cutting concerns; per-feature
 * routers compose cleanly via createTenantAuditRouter(deps).
 */

import express from 'express'
import { SupabaseClient } from '@supabase/supabase-js'

type Middleware = (req: express.Request, res: express.Response, next: express.NextFunction) => void | Promise<void>

interface Deps {
  supabase: SupabaseClient
  requireAuth: Middleware
  identifyTenant: Middleware
  checkPermission: (feature: string, action: 'view' | 'edit' | 'delete') => Middleware
}

const MAX_PAGE_SIZE = 200
const DEFAULT_PAGE_SIZE = 50

// Loose row shape — matches the public.tenant_audit columns.
interface TenantAuditRow {
  id:            string
  tenant_id:     string
  actor_id:      string | null
  actor_role:    string | null
  action:        string
  entity_type:   string | null
  entity_id:     string | null
  justification: string | null
  ticket_ref:    string | null
  before_value:  any
  after_value:   any
  ip_address:    string | null
  user_agent:    string | null
  created_at:    string
}

export function createTenantAuditRouter(deps: Deps): express.Router {
  const r = express.Router()
  const { supabase, requireAuth, identifyTenant, checkPermission } = deps

  r.get('/api/audit',
    requireAuth, identifyTenant, checkPermission('settings', 'view'),
    async (req, res) => {
      try {
        const tenantId = (req as any).tenantId as string
        if (!tenantId) { res.status(400).json({ error: 'tenant_id missing on request' }); return }

        // ── Pagination ────────────────────────────────────────────────────
        const page     = Math.max(1, parseIntOr(req.query.page, 1))
        const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, parseIntOr(req.query.pageSize, DEFAULT_PAGE_SIZE)))
        const from     = (page - 1) * pageSize
        const to       = from + pageSize - 1

        // ── Filters ───────────────────────────────────────────────────────
        // `actor` accepts either a uuid (exact match on actor_id) OR an
        // email/name fragment — for the email case we resolve the matching
        // user_ids upfront via auth.admin.listUsers (capped at 200, matches
        // existing teams.ts pattern). Empty string → no filter.
        const actorFilter  = trimOr(req.query.actor,  null)
        const actionFilter = trimOr(req.query.action, null)
        const fromIso      = trimOr(req.query.from,   null)
        const toIso        = trimOr(req.query.to,     null)

        let actorIdSet: string[] | null = null
        if (actorFilter) {
          if (isUuid(actorFilter)) {
            actorIdSet = [actorFilter]
          } else {
            // Email / name partial match — pull the auth.users batch and
            // filter client-side. 200-user cap covers all realistic tenants.
            const { data: { users = [] } = {} as any } =
              await (supabase as any).auth.admin.listUsers({ perPage: 200 })
            const needle = actorFilter.toLowerCase()
            const matchingUserIds = (users as any[])
              .filter(u => (u.email ?? '').toLowerCase().includes(needle))
              .map(u => u.id)

            // Also union profile.full_name matches so "priya" finds rows
            // whose actor has no email but a profile name.
            const { data: profileMatches } = await supabase.from('profiles')
              .select('id, full_name')
              .ilike('full_name', `%${actorFilter}%`)
              .limit(200)
            const profileIds = (profileMatches ?? []).map((p: any) => p.id)

            actorIdSet = Array.from(new Set([...matchingUserIds, ...profileIds]))
            // If the filter matched zero users, short-circuit with an empty
            // result — saves a pointless query.
            if (actorIdSet.length === 0) {
              res.json({ data: [], total: 0, page, pageSize })
              return
            }
          }
        }

        // ── Build the query ───────────────────────────────────────────────
        // Two queries:
        //   1. count(*) with the same filters → `total` for pagination
        //   2. paginated data slice
        // Supabase-js's { count: 'exact' } on a SELECT does both in one
        // round-trip, but only for the same page slice. We need the total
        // across all pages → two queries. Both are cheap thanks to the
        // tenant_audit_(tenant|actor|action)_created_idx indexes.
        const buildQuery = (q: any) => {
          let chain = q.eq('tenant_id', tenantId)
          if (actorIdSet)    chain = chain.in('actor_id', actorIdSet)
          if (actionFilter)  chain = chain.eq('action', actionFilter)
          if (fromIso)       chain = chain.gte('created_at', fromIso)
          if (toIso)         chain = chain.lte('created_at', toIso)
          return chain
        }

        const { count: total, error: countErr } = await buildQuery(
          supabase.from('tenant_audit').select('id', { count: 'exact', head: true }),
        )
        if (countErr) {
          res.status(500).json({ error: `audit count: ${countErr.message}` })
          return
        }

        const { data: rows, error: rowsErr } = await buildQuery(
          supabase.from('tenant_audit').select('*'),
        ).order('created_at', { ascending: false }).range(from, to)
        if (rowsErr) {
          res.status(500).json({ error: `audit list: ${rowsErr.message}` })
          return
        }

        const rowList = (rows ?? []) as TenantAuditRow[]

        // ── Enrich with actor_email + actor_name (batched, no N+1) ────────
        const distinctActorIds = Array.from(
          new Set(rowList.map(r => r.actor_id).filter(Boolean)),
        ) as string[]

        const actorEmailMap = new Map<string, string>()
        const actorNameMap  = new Map<string, string>()

        if (distinctActorIds.length > 0) {
          // Names from profiles (single .in() query)
          const { data: profiles } = await supabase.from('profiles')
            .select('id, full_name')
            .in('id', distinctActorIds)
          for (const p of (profiles ?? []) as any[]) {
            if (p.full_name) actorNameMap.set(p.id, p.full_name)
          }

          // Emails from auth.users — auth.admin.listUsers is paginated; pull
          // the first 200 (same realistic-tenant assumption as actor filter).
          // If we later see tenants with >200 staff, swap to per-actor
          // auth.admin.getUserById() in a Promise.all batch.
          const { data: { users = [] } = {} as any } =
            await (supabase as any).auth.admin.listUsers({ perPage: 200 })
          for (const u of users as any[]) {
            if (u.id && u.email && distinctActorIds.includes(u.id)) {
              actorEmailMap.set(u.id, u.email)
            }
          }
        }

        // Final row shape — matches what the FE AuditLogPage expects.
        // `payload` is aliased from after_value (the table doesn't have a
        // dedicated payload column — see schema note below).
        const data = rowList.map(r => ({
          id:            r.id,
          action:        r.action,
          actor_id:      r.actor_id,
          actor_email:   r.actor_id ? (actorEmailMap.get(r.actor_id) ?? null) : null,
          actor_name:    r.actor_id ? (actorNameMap.get(r.actor_id)  ?? null) : null,
          actor_role:    r.actor_role,
          entity_type:   r.entity_type,
          entity_id:     r.entity_id,
          before_value:  r.before_value,
          after_value:   r.after_value,
          payload:       r.after_value,   // FE compatibility alias
          justification: r.justification,
          ticket_ref:    r.ticket_ref,
          ip_address:    r.ip_address,
          created_at:    r.created_at,
        }))

        res.json({ data, total: total ?? 0, page, pageSize })
      } catch (err: any) {
        res.status(500).json({ error: err?.message ?? String(err) })
      }
    })

  return r
}

// ── Local helpers ───────────────────────────────────────────────────────────

function parseIntOr(value: unknown, fallback: number): number {
  if (value == null) return fallback
  const n = parseInt(String(value), 10)
  return Number.isFinite(n) ? n : fallback
}

function trimOr(value: unknown, fallback: string | null): string | null {
  if (value == null) return fallback
  const s = String(value).trim()
  return s.length === 0 ? fallback : s
}

function isUuid(s: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s)
}
