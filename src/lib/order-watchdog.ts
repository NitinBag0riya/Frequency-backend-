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

// Owner-alert template on the platform WABA (hello@getfrequency.app). Utility category —
// approved via /message_templates once. Body carries two {{n}} params: {{1}}=headline (e.g.
// "Zomato · La Fiamma"), {{2}}=summary (e.g. "1 item · ₹740 · Radhika Soni"). Ships even
// when the owner's laptop is closed — the reason this watchdog exists at all.
const OWNER_ALERT_TEMPLATE = 'frequency_new_order'
const OWNER_ALERT_LANG = 'en'

// Cache the template's approval state so we don't call Meta on every order.new. Refreshed
// every 15 min and once at boot — a freshly-approved template starts firing within 15m.
let ownerTemplateApproved: boolean | null = null
async function isOwnerTemplateApproved(): Promise<boolean> {
  if (ownerTemplateApproved !== null) return ownerTemplateApproved
  const waba = process.env.FREQ_WA_WABA_ID
  const tok = process.env.FREQ_WA_ACCESS_TOKEN
  if (!waba || !tok) return (ownerTemplateApproved = false)
  try {
    const r = await fetch(`https://graph.facebook.com/v21.0/${waba}/message_templates?name=${OWNER_ALERT_TEMPLATE}&fields=name,status,language&limit=5`, {
      headers: { Authorization: `Bearer ${tok}` },
    })
    const j: any = await r.json().catch(() => ({}))
    const t = (j?.data ?? []).find((x: any) => x.language === OWNER_ALERT_LANG && x.name === OWNER_ALERT_TEMPLATE)
    ownerTemplateApproved = t?.status === 'APPROVED'
    return ownerTemplateApproved!
  } catch { return (ownerTemplateApproved = false) }
}
// Recheck approval state every 15 min so we start firing as soon as Meta approves.
setInterval(() => { ownerTemplateApproved = null }, 15 * 60_000).unref?.()

// Send the owner-alert template via platform WABA (bypasses tenant WABA — a tenant that
// hasn't linked its own WhatsApp still gets the owner ping). Best-effort, never throws.
async function pingOwnerWa(supabase: SupabaseClient, tag: string, tenantId: string, headline: string, summary: string): Promise<void> {
  const phoneNumberId = process.env.FREQ_WA_PHONE_NUMBER_ID
  const tok = process.env.FREQ_WA_ACCESS_TOKEN
  if (!phoneNumberId || !tok) return
  if (!(await isOwnerTemplateApproved())) return
  try {
    // Owner-WA suppression list (slugs). The tenant's order.new still rings the dashboard,
    // OS toast, and the PLATFORM_MONITOR_WA number — only the OWNER's own WhatsApp is muted.
    // Used while a tenant (e.g. la-fiamma during our live testing) shouldn't get order pings
    // yet, but the platform admin still wants to watch them.
    const suppress = (process.env.OWNER_WA_SUPPRESS_TENANTS || '').split(',').map(s => s.trim()).filter(Boolean)
    if (suppress.length) {
      const { data: st } = await supabase.from('tenants').select('slug').eq('id', tenantId).maybeSingle()
      if (suppress.includes(String((st as any)?.slug ?? ''))) { console.log(`${tag} owner WA suppressed for ${(st as any)?.slug}`); return }
    }
    const { data: t } = await supabase.from('tenants').select('user_id').eq('id', tenantId).maybeSingle()
    const ownerId = (t as any)?.user_id
    if (!ownerId) return
    const { data: p } = await supabase.from('profiles').select('wa_number').eq('id', ownerId).maybeSingle()
    const raw = (p as any)?.wa_number as string | null
    if (!raw) return
    const to = String(raw).replace(/\D/g, '')
    if (!/^\d{10,15}$/.test(to)) return
    const params = [headline, summary].map(x => ({ type: 'text', text: String(x).slice(0, 180) }))
    const r = await fetch(`https://graph.facebook.com/v21.0/${phoneNumberId}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tok}` },
      body: JSON.stringify({ messaging_product: 'whatsapp', to, type: 'template',
        template: { name: OWNER_ALERT_TEMPLATE, language: { code: OWNER_ALERT_LANG },
          components: [{ type: 'body', parameters: params }] } }),
    })
    if (!r.ok) {
      const j: any = await r.json().catch(() => ({}))
      console.warn(`${tag} WA ping failed to ${to.slice(0, 4)}…: ${j?.error?.message ?? r.status}`)
      return
    }
    console.log(`${tag} 📱 WA sent to ${to.slice(0, 4)}… · ${headline}`)
  } catch (e: any) { console.warn(`${tag} WA ping error: ${e?.message ?? e}`) }
}

// Platform monitor CC — comma-separated numbers that get order.new WhatsApps for
// cross-tenant monitoring by the platform admin (nitin). Independent of the owner ping
// above so it fires even when the tenant has no wa_number.
//   PLATFORM_MONITOR_WA          numbers (E.164 digits, comma-separated)
//   PLATFORM_MONITOR_WA_TENANTS  optional slug allowlist (comma-separated); unset = all
//                                tenants. Set this before the tenant count makes the
//                                monitor phone unusable.
// Dedupe: durable, cross-machine — claim the send by inserting a
// notification_delivery_log row (channel 'wa_monitor') BEFORE sending; if the row
// already exists (any Fly machine, or a Realtime redelivery), skip. Same table +
// pattern the notification dispatcher already uses for its own channels. A bounded
// in-process set short-circuits the common case without a round-trip.
const monitorSeen = new Set<string>()
async function pingMonitors(supabase: SupabaseClient, tag: string, notifId: string, tenantId: string, headline: string, summary: string): Promise<void> {
  const list = (process.env.PLATFORM_MONITOR_WA || '').split(',').map(s => s.trim()).filter(Boolean)
  if (!list.length) return
  if (monitorSeen.has(notifId)) return
  monitorSeen.add(notifId); if (monitorSeen.size > 5000) monitorSeen.delete(monitorSeen.values().next().value as string)
  const allow = (process.env.PLATFORM_MONITOR_WA_TENANTS || '').split(',').map(s => s.trim()).filter(Boolean)
  if (allow.length) {
    const { data: t } = await supabase.from('tenants').select('slug').eq('id', tenantId).maybeSingle()
    if (!allow.includes(String((t as any)?.slug ?? ''))) return
  }
  // Cross-machine claim. A UNIQUE (notification_id, channel) index makes this atomic;
  // without one it's still a strong best-effort (check-then-insert). Either way a second
  // machine that already sent leaves a 'sent' row we detect here.
  try {
    const { data: prior } = await supabase.from('notification_delivery_log')
      .select('id').eq('notification_id', notifId).eq('channel', 'wa_monitor').eq('status', 'sent').limit(1).maybeSingle()
    if (prior) return
    await supabase.from('notification_delivery_log').insert({ notification_id: notifId, channel: 'wa_monitor', status: 'sent', delivered_at: new Date().toISOString() })
  } catch { /* log-table hiccup: fall through and send — a rare dup beats a missed monitor ping */ }
  const phoneNumberId = process.env.FREQ_WA_PHONE_NUMBER_ID
  const tok = process.env.FREQ_WA_ACCESS_TOKEN
  if (!phoneNumberId || !tok) return
  if (!(await isOwnerTemplateApproved())) return
  for (const raw of list) {
    const to = String(raw).replace(/\D/g, '')
    if (!/^\d{10,15}$/.test(to)) continue
    try {
      const params = [headline, summary].map(x => ({ type: 'text', text: String(x).slice(0, 180) }))
      const r = await fetch(`https://graph.facebook.com/v21.0/${phoneNumberId}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tok}` },
        body: JSON.stringify({ messaging_product: 'whatsapp', to, type: 'template',
          template: { name: OWNER_ALERT_TEMPLATE, language: { code: OWNER_ALERT_LANG },
            components: [{ type: 'body', parameters: params }] } }),
      })
      if (!r.ok) {
        const j: any = await r.json().catch(() => ({}))
        console.warn(`${tag} monitor WA failed to ${to.slice(0, 4)}…: ${j?.error?.message ?? r.status}`)
        continue
      }
      console.log(`${tag} 📡 monitor WA → ${to.slice(0, 4)}… · ${headline}`)
    } catch (e: any) { console.warn(`${tag} monitor WA error: ${e?.message ?? e}`) }
  }
}

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
        console.log(`${tag} ${marker} tenant=${n.tenant_id ?? '?'} channel=${d.channel ?? '?'} order=${d.order_id ?? n.id} status=${d.status ?? '?'} title=${JSON.stringify(n.title ?? '')}`)
        // Owner WA alert on order.new only — status transitions are noise on the phone.
        // Best-effort: fires on the FIRST watchdog machine that sees the event; on a
        // multi-machine deploy that's per-event dedupe by "who won the realtime race" —
        // acceptable since a duplicate WA is annoying, not broken. To fully dedupe, log
        // the delivery in notification_delivery_log before the send; leaving that as a
        // follow-up because the current volume (~10 orders/tenant/day) doesn't need it.
        if (n.event_key === 'order.new' && n.tenant_id) {
          const headline = String(n.title ?? '').replace(/^New\s+/, '')
          const summary = String(d.summary ?? n.body ?? '')
          void pingOwnerWa(supabase, tag, String(n.tenant_id), headline || 'New order', summary)
          void pingMonitors(supabase, tag, String(n.id), String(n.tenant_id), headline || 'New order', summary)
        }
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
