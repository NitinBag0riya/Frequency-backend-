/**
 * Per-tenant usage / quota inspection — read-side for the future self-serve
 * billing page. Returns the same numbers `checkAndConsumeQuota` sees so the
 * UI's "you're at X / Y today" matches exactly what blocks the next send.
 *
 *   GET  /api/usage                  → snapshot of all quotas for caller's tenant
 *   GET  /api/usage/notifications    → recent quota.approaching/exhausted log
 *
 * No mutations — read-only. checkPermission('settings','view') gates both
 * endpoints; same convention as routes/tenant-audit.ts (the 'billing'
 * feature key isn't in every plan's `features`, but 'settings' is).
 *
 * Why surface this here vs piggybacking on /api/billing/usage:
 *   /api/billing/usage already exists and returns MONTHLY counters joined
 *   off the messages / contacts tables (one query per metric, slow-ish but
 *   accurate). /api/usage is the DAILY view, sourced directly from the
 *   Redis token-bucket counters that gate sends — sub-millisecond, and
 *   refreshed in real time as each send fires. The two complement each
 *   other; this endpoint is what the "rate-limit bar" widget consumes.
 */

import express from 'express'
import { SupabaseClient } from '@supabase/supabase-js'
import type IORedis from 'ioredis'
import { getUsageSnapshot } from '../lib/quota'

type Middleware = (req: express.Request, res: express.Response, next: express.NextFunction) => void | Promise<void>

interface Deps {
  supabase: SupabaseClient
  redis:    IORedis
  requireAuth: Middleware
  identifyTenant: Middleware
  checkPermission: (feature: string, action: 'view' | 'edit' | 'delete') => Middleware
}

export function createUsageRouter(deps: Deps): express.Router {
  const r = express.Router()
  const { supabase, redis, requireAuth, identifyTenant, checkPermission } = deps

  // ── GET /api/usage ───────────────────────────────────────────────────────
  // Returns the live token-bucket counts for every quota the caller's plan
  // defines. Shape:
  //
  //   {
  //     tenant_id, plan,
  //     quotas: {
  //       messages_per_day:    { used, cap, percent, resets_at },
  //       messages_per_minute: { ... },
  //       broadcasts_per_day:  { ... },
  //       ai_requests_per_day: { ... }
  //     }
  //   }
  //
  // `cap === -1` means unlimited (Scale / Enterprise); the FE renders this
  // as "Unlimited" rather than a progress bar. `percent === -1` is the
  // parallel signal for unlimited.
  r.get('/api/usage',
    requireAuth, identifyTenant, checkPermission('settings', 'view'),
    async (req, res) => {
      const tenantId = (req as any).tenantId
      try {
        const snapshot = await getUsageSnapshot(supabase, redis, tenantId)
        res.json(snapshot)
      } catch (e: any) {
        res.status(500).json({ error: e?.message ?? 'usage snapshot failed' })
      }
    },
  )

  // ── GET /api/usage/notifications ─────────────────────────────────────────
  // Returns the last 30 days of quota.approaching / quota.exhausted events
  // for the caller's tenant. Powers the "previous warnings" panel on the
  // billing page — same data feeds the in-app bell, but this is a flat
  // chronological list filtered to billing events.
  r.get('/api/usage/notifications',
    requireAuth, identifyTenant, checkPermission('settings', 'view'),
    async (req, res) => {
      const tenantId = (req as any).tenantId
      const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()
      const { data, error } = await supabase
        .from('quota_notification_log')
        .select('id, quota_key, bucket_date, level, fired_at, current_usage, cap')
        .eq('tenant_id', tenantId)
        .gte('fired_at', since)
        .order('fired_at', { ascending: false })
        .limit(100)
      if (error) {
        res.status(500).json({ error: error.message }); return
      }
      res.json(data ?? [])
    },
  )

  return r
}
