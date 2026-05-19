/**
 * Mobile push device registration (P0.10).
 *
 *   POST   /api/devices/register   upsert this user's Expo push token
 *   GET    /api/devices            list this user's registered devices
 *   DELETE /api/devices/:id        remove a device (sign-out-from-device)
 *
 * The mobile app (mobile/src/lib/push.ts) POSTs after sign-in fire-and-
 * forget — if this endpoint 5xx's, sign-in still proceeds. The DB has
 * `unique (user_id, expo_push_token)`, so re-registering on each app
 * launch upserts `last_seen_at` without creating duplicate rows.
 *
 * Auth posture:
 *   - requireAuth        — every endpoint, user must be signed in.
 *   - identifyTenant     — only on POST, so we can stamp tenant_id at
 *                          register time. GET / DELETE filter by user_id
 *                          alone (RLS gates the row to the owner anyway).
 *
 * Why tenant_id at all?
 *   For per-tenant analytics ("how many devices registered for tenant X?")
 *   and for the future case where a user belongs to multiple tenants on
 *   mobile — the row records which tenant context the device was
 *   registered under. RLS still scopes by user_id so this never leaks.
 */

import express from 'express'
import { SupabaseClient } from '@supabase/supabase-js'

import { validateBody, DeviceRegisterSchema } from '../validation'
import { apiError } from '../lib/api-error'

type Middleware = (req: express.Request, res: express.Response, next: express.NextFunction) => void | Promise<void>

interface Deps {
  supabase:       SupabaseClient
  requireAuth:    Middleware
  identifyTenant: Middleware
}

export function createDevicesRouter(deps: Deps): express.Router {
  const r = express.Router()
  const { supabase, requireAuth, identifyTenant } = deps

  // ── POST /api/devices/register ──────────────────────────────────────────
  // Upsert the Expo push token. Re-registering with the same (user, token)
  // refreshes last_seen_at + app_version. Returns { device_id } so the
  // mobile client can persist it for later DELETE (sign-out-from-device).
  r.post('/api/devices/register',
    requireAuth, identifyTenant, validateBody(DeviceRegisterSchema),
    async (req, res) => {
      const userId   = (req as any).user?.id as string | undefined
      const tenantId = (req as any).tenantId as string | undefined
      if (!userId || !tenantId) { apiError(res, 401, 'unauthorized', 'Auth + tenant required.'); return }

      const body = req.body as {
        expo_push_token: string
        platform:        'ios' | 'android' | 'web'
        app_version?:    string
        device_label?:   string
      }

      // UPSERT on the (user_id, expo_push_token) unique index. We do NOT
      // upsert on tenant_id — a device belongs to one human; the human
      // can move between tenants without the row moving.
      const { data, error } = await supabase.from('push_devices')
        .upsert({
          tenant_id:       tenantId,
          user_id:         userId,
          expo_push_token: body.expo_push_token,
          platform:        body.platform,
          app_version:     body.app_version ?? null,
          device_label:    body.device_label ?? null,
          last_seen_at:    new Date().toISOString(),
        }, { onConflict: 'user_id,expo_push_token' })
        .select('id')
        .single()

      if (error) {
        console.warn(`[devices.register] upsert failed for user=${userId}: ${error.message}`)
        apiError(res, 500, 'register_failed', 'Could not register device.')
        return
      }

      res.json({ device_id: data.id })
    },
  )

  // ── GET /api/devices ────────────────────────────────────────────────────
  // List the signed-in user's devices. Used by Settings → "Signed-in
  // devices" (mobile + web, future).
  r.get('/api/devices', requireAuth, async (req, res) => {
    const userId = (req as any).user?.id as string | undefined
    if (!userId) { apiError(res, 401, 'unauthorized', 'Auth required.'); return }

    const { data, error } = await supabase.from('push_devices')
      .select('id, platform, app_version, last_seen_at, device_label')
      .eq('user_id', userId)
      .order('last_seen_at', { ascending: false })

    if (error) {
      console.warn(`[devices.list] failed for user=${userId}: ${error.message}`)
      apiError(res, 500, 'list_failed', 'Could not list devices.')
      return
    }
    res.json({ devices: data ?? [] })
  })

  // ── DELETE /api/devices/:id ─────────────────────────────────────────────
  // User-initiated removal. RLS already enforces ownership at the DB
  // level; we filter by user_id again as defense-in-depth so the route
  // never depends on RLS alone.
  r.delete('/api/devices/:id', requireAuth, async (req, res) => {
    const userId = (req as any).user?.id as string | undefined
    if (!userId) { apiError(res, 401, 'unauthorized', 'Auth required.'); return }

    const id = String(req.params.id)
    const { error, count } = await supabase.from('push_devices')
      .delete({ count: 'exact' })
      .eq('id', id)
      .eq('user_id', userId)

    if (error) {
      console.warn(`[devices.delete] failed for user=${userId}, id=${id}: ${error.message}`)
      apiError(res, 500, 'delete_failed', 'Could not remove device.')
      return
    }
    if (!count) { apiError(res, 404, 'not_found', 'Device not found.'); return }

    res.status(204).send()
  })

  return r
}
