/**
 * touchLastActive — throttled writer for tenants.last_active_at.
 *
 * Called on every authed tenant-scoped request (from identifyTenant). Writes
 * at most once per tenant per THROTTLE_MS so the update is NOT chatty: a busy
 * tenant firing 100 req/min still produces one UPDATE every 10 minutes.
 *
 * Fire-and-forget: never blocks or fails the request. The throttle timestamp
 * is set BEFORE the write so a persistent DB error can't turn into a per-request
 * write storm (we simply skip until the window elapses again).
 *
 * ponytail: in-memory throttle map is per-process (resets on deploy) and grows
 * with distinct tenant count — bounded in practice by tenant cardinality. If
 * that ever matters, swap for an LRU or a Redis SETEX. Not needed today.
 */

import type { SupabaseClient } from '@supabase/supabase-js'

const THROTTLE_MS = 10 * 60 * 1000 // 10 minutes
const lastTouched = new Map<string, number>()

export function touchLastActive(sb: SupabaseClient, tenantId: string | undefined | null): void {
  if (!tenantId) return
  const now = Date.now()
  const prev = lastTouched.get(tenantId)
  if (prev && now - prev < THROTTLE_MS) return
  lastTouched.set(tenantId, now) // set first — a failed write must not retry every request
  void sb.from('tenants')
    .update({ last_active_at: new Date(now).toISOString() })
    .eq('id', tenantId)
    .then(({ error }) => {
      if (error) console.warn('[last-active] update failed', error.message)
    }, (e: unknown) => console.warn('[last-active] update threw', e))
}
