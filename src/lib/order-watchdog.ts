/**
 * order-watchdog — cloud-side realtime tap on the notifications bus.
 *
 * Subscribes to postgres_changes on `notifications` and logs every `order.*` event
 * as it lands, structured for `flyctl logs -a frequency-api-prod | grep watchdog`.
 * Cheap: one Supabase Realtime channel (WebSocket), no polling, no DB queries per
 * event. Auto-reconnects on transient errors. Silent no-op if SUPABASE_URL /
 * SUPABASE_SERVICE_ROLE_KEY aren't set (e.g. local runs without envs).
 *
 * Idempotent to spawn multiple times per Fly machine — each opens its own channel
 * and each logs, so a 3-machine app produces 3 lines per event. That's fine: the
 * consumer (`grep | uniq -f 1` or the eye) dedupes on the `order_id`.
 *
 * WHY THIS EXISTS: silence used to mean "either nothing happened OR the pipeline
 * broke". Now silence is unambiguous — if this line isn't in the logs, no order
 * hit the notifications bus, no client ring is possible, and it's a server-side
 * bug (or nothing happened). Bearable version of the local dev watchdog that
 * lives in this session's memory, but running 24/7 in prod.
 */

import { SupabaseClient } from '@supabase/supabase-js'

export function startOrderWatchdog(supabase: SupabaseClient, opts: { machineId?: string } = {}): void {
  const tag = `[watchdog${opts.machineId ? ':' + opts.machineId.slice(0, 6) : ''}]`
  let attempts = 0
  const connect = () => {
    attempts++
    const ch = supabase.channel(`order-watchdog-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'notifications' }, (payload: any) => {
        const n = payload?.new
        if (!n?.event_key || typeof n.event_key !== 'string' || !n.event_key.startsWith('order.')) return
        const d = n.data || {}
        const marker = n.event_key === 'order.new' ? '🔔 NEW' : '↻ status'
        // Structured single line — parses on both eyeball and `awk`.
        console.log(`${tag} ${marker} tenant=${n.tenant_id ?? '?'} channel=${d.channel ?? '?'} order=${d.order_id ?? n.id} status=${d.status ?? '?'} title=${JSON.stringify(n.title ?? '')}`)
      })
      .subscribe((status: string) => {
        if (status === 'SUBSCRIBED') { attempts = 0; console.log(`${tag} SUBSCRIBED · listening for order.*`) }
        else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
          console.warn(`${tag} ${status} · reconnecting in ${Math.min(30, 2 ** attempts)}s`)
          void supabase.removeChannel(ch).catch(() => {})
          setTimeout(connect, Math.min(30_000, 2000 * 2 ** attempts))
        }
      })
  }
  connect()
}
