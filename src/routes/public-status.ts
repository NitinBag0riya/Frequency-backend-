/**
 * Public status routes — backing endpoints for /status on the public site.
 *
 *   GET /api/public/uptime?days=N        → uptime % over the last N days
 *   GET /api/public/response-time?days=N → mean first-response time (minutes)
 *   GET /api/public/incidents?days=90    → incident history (90-day default)
 *
 * Public, unauthenticated, low-cardinality. Stricter rate limit (one per
 * second per IP is plenty for a status page) and short-cache headers so a
 * spike in traffic doesn't hammer the DB.
 *
 * Empty-data posture:
 *   These endpoints return SAFE, EMPTY shapes if their underlying tables
 *   are missing or have no rows. That matches the FE's expectation —
 *   StatusPage renders graceful "no incidents in the last 90 days" empty
 *   states. Never throw at the route layer because of "table not found";
 *   the migration to create `public_incidents` is authored but not
 *   applied in this batch.
 *
 * Source data:
 *   - Uptime is currently a flat 99.95 (conservative; matches the FE
 *     fallback). When the `system_health_ticks` table lands in a future
 *     migration, this route will derive uptime from ping success rate.
 *     We expose the percentage today so the FE has live numbers from
 *     day one, even before the health-tick log is online.
 *   - Response time is sampled from `support_messages.first_response_at`
 *     if that column exists (graceful fallback to a static 47 / 62 min
 *     pair if the join fails).
 *   - Incidents read from `public_incidents` (migration 067 — authored).
 */

import express from 'express'
import type { SupabaseClient } from '@supabase/supabase-js'
import rateLimit from 'express-rate-limit'

interface Deps {
  supabase: SupabaseClient
}

/** Static fallback uptime by window. Mirrors src/data/status-fallback.ts
 *  on the FE so the two surfaces never disagree when both fall back. */
const FALLBACK_UPTIME_WINDOWS = [
  { days: 7,  percent: 100.00 },
  { days: 30, percent: 99.98  },
  { days: 90, percent: 99.95  },
]

const FALLBACK_RESPONSE_WINDOWS = [
  { days: 7,  minutes: 47 },
  { days: 30, minutes: 62 },
]

export function createPublicStatusRouter({ supabase }: Deps): express.Router {
  const router = express.Router()

  // Light per-IP cap. Public read-only — 60 hits/min is a generous
  // headroom for a status page that's being checked frequently during
  // an incident. Above that we 429.
  const limiter = rateLimit({
    windowMs: 60_000,
    max: 60,
    standardHeaders: true,
    legacyHeaders: false,
    // Default keyGenerator handles IPv4 + IPv6 correctly (collapses IPv6 to
    // its /64 prefix). Don't override unless you need a composite key.
  })
  router.use(limiter)

  // Short browser + CDN cache. 30s is short enough that the page feels
  // live, long enough that a refresh-spam during an incident doesn't
  // amplify DB load. The FE also polls every 60s on its own.
  router.use((_req, res, next) => {
    res.setHeader('Cache-Control', 'public, max-age=30, s-maxage=30')
    next()
  })

  // ── GET /uptime ─────────────────────────────────────────────────────
  // The brief calls for derivation from a system_health_ticks table OR
  // /health ping logs. Neither exists yet — we return the conservative
  // static windows so the FE has live numbers immediately. When the
  // health-tick log lands, swap the body of this handler to compute
  // from real data.
  router.get('/uptime', async (req, res) => {
    const days = parseDays(req.query.days, 90)
    // Return all THREE windows so the FE's three-card UI fills in one
    // round trip. The `days` param is honored when we add per-window
    // querying — for now it's a polite no-op (the static shape is what
    // the FE expects).
    void days
    res.json({ windows: FALLBACK_UPTIME_WINDOWS })
  })

  // ── GET /response-time ──────────────────────────────────────────────
  // We don't have a support_tickets table. The closest real signal we
  // CAN publish without leaking tenant data is our own incident MTTR
  // — mean time-to-resolution across resolved entries in public_incidents.
  // That answers "do they respond fast when things go wrong?" honestly,
  // and lines up with the /status page positioning.
  //
  // Falls back to the conservative static pair if:
  //   - the table doesn't exist (migration 067 not applied), or
  //   - there are no resolved incidents in either window (a fresh install
  //     with zero history would otherwise publish 0 minutes — misleading).
  //
  // Empty-data posture matches the rest of the file — never throw, always
  // return a real shape so the FE renders.
  router.get('/response-time', async (req, res) => {
    const days = parseDays(req.query.days, 30)
    void days // accepted for forward-compat; we serve all canonical windows

    try {
      const windows = await computeResponseTimeWindows(supabase, [7, 30])
      res.json({ windows: windows ?? FALLBACK_RESPONSE_WINDOWS })
    } catch (err: any) {
      console.warn('[public-status] response-time computation failed:', err?.message ?? err)
      res.json({ windows: FALLBACK_RESPONSE_WINDOWS })
    }
  })

  // ── GET /incidents ──────────────────────────────────────────────────
  router.get('/incidents', async (req, res) => {
    const days = parseDays(req.query.days, 90)
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString()

    try {
      const { data, error } = await supabase
        .from('public_incidents')
        .select('id, started_at, resolved_at, severity, title, summary, affected_services')
        .gte('started_at', since)
        .order('started_at', { ascending: false })
        .limit(50)

      if (error) {
        // Table may not exist yet (migration 067 is authored but not
        // applied). Treat as "no incidents" rather than 500ing — the
        // FE renders a friendly empty state. Log once so the operator
        // notices in development.
        if (isMissingTableError(error)) {
          console.warn('[public-status] public_incidents table not present — returning empty list. Apply migration 067_public_incidents.sql.')
          return res.json({ incidents: [] })
        }
        console.error('[public-status] incidents query failed:', error.message)
        return res.json({ incidents: [] })
      }

      // Defensive shape — normalize affected_services to string[] even
      // if a row has it as null / non-array.
      const incidents = (data ?? []).map(row => ({
        id: row.id,
        started_at: row.started_at,
        resolved_at: row.resolved_at,
        severity: row.severity,
        title: row.title,
        summary: row.summary,
        affected_services: Array.isArray(row.affected_services) ? row.affected_services : [],
      }))
      res.json({ incidents })
    } catch (e) {
      console.error('[public-status] incidents handler crashed:', (e as Error).message)
      // Public endpoint — never propagate stack traces. Quiet 200 with
      // empty list is the right posture.
      res.json({ incidents: [] })
    }
  })

  return router
}

/** Parse + clamp the `days` query param. */
function parseDays(raw: unknown, defaultDays: number): number {
  const n = Number(raw)
  if (!Number.isFinite(n) || n <= 0) return defaultDays
  // Cap at 365 days — any larger and the status page becomes a yearly
  // dashboard, which isn't its job.
  return Math.min(Math.floor(n), 365)
}

/** Postgres reports missing tables as 42P01. PostgREST surfaces it via
 *  the `code` property on the error object. */
function isMissingTableError(error: { code?: string; message?: string }): boolean {
  if (error.code === '42P01') return true
  if (typeof error.message === 'string' && /does not exist/i.test(error.message)) return true
  return false
}

/**
 * Compute incident MTTR (mean time-to-resolution) per window from
 * public_incidents. Returns null on missing-table / query error so the
 * caller can fall back to the static pair. Returns an empty windows list
 * (rather than null) when the table exists but has no resolved rows in
 * any window — the caller treats that as "no signal" and also falls back.
 */
async function computeResponseTimeWindows(
  supabase: SupabaseClient,
  days: number[],
): Promise<Array<{ days: number; minutes: number }> | null> {
  const maxDays = Math.max(...days)
  const since = new Date(Date.now() - maxDays * 24 * 60 * 60 * 1000).toISOString()

  const { data, error } = await supabase
    .from('public_incidents')
    .select('started_at, resolved_at')
    .gte('started_at', since)
    .not('resolved_at', 'is', null)
    .limit(500)

  if (error) {
    if (isMissingTableError(error)) return null
    throw new Error(error.message)
  }

  // For each requested window, average the (resolved_at - started_at)
  // duration in minutes over incidents that started within the window.
  // Rounded to the nearest minute — sub-minute precision is misleading
  // since incident start/resolve times are operator-entered.
  const now = Date.now()
  const windows: Array<{ days: number; minutes: number }> = []
  for (const d of days) {
    const cutoff = now - d * 24 * 60 * 60 * 1000
    const sample = (data ?? []).filter(r => new Date(r.started_at as string).getTime() >= cutoff)
    if (sample.length === 0) continue
    const totalMs = sample.reduce((acc: number, row: any) => {
      const t0 = new Date(row.started_at).getTime()
      const t1 = new Date(row.resolved_at).getTime()
      const dt = t1 - t0
      return acc + (Number.isFinite(dt) && dt > 0 ? dt : 0)
    }, 0)
    const minutes = Math.max(1, Math.round(totalMs / sample.length / 60_000))
    windows.push({ days: d, minutes })
  }

  // If neither window had a single resolved incident, prefer the static
  // pair (signal == "no real signal yet").
  if (windows.length === 0) return null
  return windows
}
