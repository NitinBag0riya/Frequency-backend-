/**
 * Notifications router + emit() helper.
 *
 *   GET    /api/notifications                  bell dropdown list (unread first)
 *   GET    /api/notifications/unread-count     just the badge counter
 *   POST   /api/notifications/:id/read         mark single read
 *   POST   /api/notifications/mark-all-read    mark all read
 *   POST   /api/notifications/:id/archive      archive
 *
 *   GET    /api/notifications/preferences      list this user's prefs (joined w/ event types)
 *   PATCH  /api/notifications/preferences      upsert prefs
 *   GET    /api/notifications/event-types      catalog
 *
 *   POST   /api/notifications/test             super-admin / engineer: smoke-test fire
 *
 * The `emitNotification(supabase, args)` helper is exported and called from
 * elsewhere (broadcast worker, payment webhook, team accept-invite, etc.) to
 * actually create rows. It interpolates the event's title/body templates,
 * checks user prefs, and writes to notifications + delivery_log.
 */

import express from 'express'
import { SupabaseClient } from '@supabase/supabase-js'

type Middleware = (req: express.Request, res: express.Response, next: express.NextFunction) => void | Promise<void>

interface Deps {
  supabase: SupabaseClient
  requireAuth: Middleware
  identifyTenant: Middleware
}

export function createNotificationsRouter(deps: Deps): express.Router {
  const r = express.Router()
  const { supabase, requireAuth, identifyTenant } = deps

  // ── List notifications ────────────────────────────────────────────────────
  r.get('/api/notifications', requireAuth, async (req, res) => {
    const userId = (req as any).user.id
    const { archived, limit = '50' } = req.query as Record<string, string>
    const lim = Math.min(200, Math.max(1, parseInt(limit, 10) || 50))
    let q = supabase.from('notifications')
      .select('*')
      .eq('recipient_user_id', userId)
      .order('created_at', { ascending: false })
      .limit(lim)
    if (archived === 'true')  q = q.not('archived_at', 'is', null)
    if (archived === 'false') q = q.is('archived_at', null)
    const { data, error } = await q
    if (error) { res.status(500).json({ error: error.message }); return }
    res.json(data ?? [])
  })

  r.get('/api/notifications/unread-count', requireAuth, async (req, res) => {
    const userId = (req as any).user.id
    const { count, error } = await supabase.from('notifications')
      .select('id', { count: 'exact', head: true })
      .eq('recipient_user_id', userId)
      .is('read_at', null)
      .is('archived_at', null)
    if (error) { res.status(500).json({ error: error.message }); return }
    res.json({ count: count ?? 0 })
  })

  r.post('/api/notifications/:id/read', requireAuth, async (req, res) => {
    const userId = (req as any).user.id
    const { error } = await supabase.from('notifications')
      .update({ read_at: new Date().toISOString() })
      .eq('id', String(req.params.id)).eq('recipient_user_id', userId)
    if (error) { res.status(500).json({ error: error.message }); return }
    res.json({ success: true })
  })

  r.post('/api/notifications/mark-all-read', requireAuth, async (req, res) => {
    const userId = (req as any).user.id
    const { error } = await supabase.from('notifications')
      .update({ read_at: new Date().toISOString() })
      .eq('recipient_user_id', userId).is('read_at', null)
    if (error) { res.status(500).json({ error: error.message }); return }
    res.json({ success: true })
  })

  r.post('/api/notifications/:id/archive', requireAuth, async (req, res) => {
    const userId = (req as any).user.id
    const { error } = await supabase.from('notifications')
      .update({ archived_at: new Date().toISOString() })
      .eq('id', String(req.params.id)).eq('recipient_user_id', userId)
    if (error) { res.status(500).json({ error: error.message }); return }
    res.json({ success: true })
  })

  // ── Preferences ───────────────────────────────────────────────────────────
  r.get('/api/notifications/preferences', requireAuth, async (req, res) => {
    const userId = (req as any).user.id
    const tid = (req.headers['x-tenant-id'] as string) || null
    const [{ data: types }, { data: prefs }] = await Promise.all([
      supabase.from('notification_event_types').select('*').eq('is_active', true).order('category, key'),
      supabase.from('notification_preferences').select('*').eq('user_id', userId),
    ])
    // Merge defaults with overrides per (event_key, tenant_id)
    const out = (types ?? []).map(t => {
      const override = (prefs ?? []).find((p: any) => p.event_key === t.key && p.tenant_id === tid) ??
                        (prefs ?? []).find((p: any) => p.event_key === t.key && !p.tenant_id)
      return {
        ...t,
        channels: override?.channels ?? t.default_channels,
        digest_frequency: override?.digest_frequency ?? 'instant',
        is_muted: override?.is_muted ?? false,
        quiet_hours: override?.quiet_hours ?? null,
        has_override: !!override,
      }
    })
    res.json(out)
  })

  r.patch('/api/notifications/preferences', requireAuth, identifyTenant, async (req, res) => {
    const userId = (req as any).user.id
    const tenantId = (req as any).tenantId
    const { event_key, channels, digest_frequency, is_muted, quiet_hours } = req.body
    if (!event_key) { res.status(400).json({ error: 'event_key required' }); return }
    const patch: any = { user_id: userId, tenant_id: tenantId, event_key, updated_at: new Date().toISOString() }
    if (channels)         patch.channels = channels
    if (digest_frequency) patch.digest_frequency = digest_frequency
    if (typeof is_muted === 'boolean') patch.is_muted = is_muted
    if (quiet_hours)      patch.quiet_hours = quiet_hours
    const { data, error } = await supabase.from('notification_preferences').upsert(patch, { onConflict: 'user_id,tenant_id,event_key' as any }).select().single()
    if (error) { res.status(500).json({ error: error.message }); return }
    res.json(data)
  })

  r.get('/api/notifications/event-types', requireAuth, async (_req, res) => {
    const { data, error } = await supabase.from('notification_event_types').select('*').eq('is_active', true).order('category, key')
    if (error) { res.status(500).json({ error: error.message }); return }
    res.json(data ?? [])
  })

  // ── Test fire (engineering / super-admin) ────────────────────────────────
  r.post('/api/notifications/test', requireAuth, identifyTenant, async (req, res) => {
    const userId = (req as any).user.id
    const tenantId = (req as any).tenantId
    const { event_key = 'system.platform_announcement', data = {} } = req.body
    const n = await emitNotification(supabase, {
      tenant_id: tenantId,
      event_key,
      recipient_user_ids: [userId],
      data: { title: 'Test notification', body: 'This is a test from /api/notifications/test', ...data },
    })
    res.json({ success: true, notifications: n })
  })

  return r
}

// ── Public helper used by other routers / workers ──────────────────────────
/**
 * Fire a notification to one or more users. Reads the event template, fills
 * variables, checks each recipient's preferences, writes notifications +
 * delivery_log. Returns the inserted rows.
 *
 * Supabase Realtime auto-pushes the new rows to any subscribed FE clients
 * (NotificationBell.tsx subscribes by recipient_user_id), so the bell badge
 * updates instantly.
 */
export async function emitNotification(
  supabase: SupabaseClient,
  args: {
    tenant_id?: string | null
    event_key: string
    recipient_user_ids: string[]
    data?: Record<string, any>
    link?: string | null
  }
): Promise<any[]> {
  if (!args.recipient_user_ids.length) return []

  const { data: type } = await supabase.from('notification_event_types')
    .select('*').eq('key', args.event_key).maybeSingle()
  if (!type) {
    console.warn(`[notifications] unknown event_key: ${args.event_key}`)
    return []
  }
  if (!type.is_active) return []

  const ctx = args.data ?? {}
  const title = interpolate(type.title_template, ctx)
  const body = type.body_template ? interpolate(type.body_template, ctx) : null

  // Prefs lookup (one query, all recipients)
  const { data: prefs } = await supabase.from('notification_preferences')
    .select('user_id, tenant_id, channels, is_muted, digest_frequency, quiet_hours')
    .in('user_id', args.recipient_user_ids)
    .eq('event_key', args.event_key)

  // Build inserts + parallel array tracking which channels each user opted
  // into. We dispatch in_app via the row insert (FE picks it up via Realtime
  // subscription) and email out-of-band via Resend after the insert lands.
  const inserts: any[] = []
  const channelsByUser: string[][] = []
  for (const userId of args.recipient_user_ids) {
    const pref = (prefs ?? []).find((p: any) => p.user_id === userId && p.tenant_id === args.tenant_id) ??
                 (prefs ?? []).find((p: any) => p.user_id === userId && !p.tenant_id)
    const channels = (pref?.channels ?? type.default_channels) as string[]
    if (pref?.is_muted) continue
    if (!channels.includes('in_app')) continue
    inserts.push({
      tenant_id: args.tenant_id ?? null,
      recipient_user_id: userId,
      event_key: args.event_key,
      title, body,
      link: args.link ?? null,
      data: ctx,
      severity: type.severity,
    })
    channelsByUser.push(channels)
  }

  if (inserts.length === 0) return []
  const { data: created, error } = await supabase.from('notifications').insert(inserts).select()
  if (error) {
    console.error('[notifications] insert failed', error.message)
    return []
  }

  // ── Channel dispatch ──────────────────────────────────────────────────
  // Log in_app deliveries inline (these "delivered" the moment the row
  // landed — FE Realtime will push them next render). Email goes async
  // via Resend; failures get a 'failed' delivery log row but don't block.
  const inAppLog = (created ?? []).map(n => ({
    notification_id: n.id, channel: 'in_app' as const, status: 'delivered' as const, delivered_at: new Date().toISOString(),
  }))
  if (inAppLog.length) await supabase.from('notification_delivery_log').insert(inAppLog)

  // Email — only for users whose channels include 'email'. Dispatched in
  // parallel; per-recipient errors are logged independently.
  const wantsEmail = (created ?? []).map((_n, i) => channelsByUser[i]?.includes('email') ?? false)
  if (wantsEmail.some(Boolean)) {
    void dispatchEmails(supabase, created ?? [], wantsEmail, args.tenant_id ?? null).catch(e =>
      console.warn('[notifications] email dispatch crashed:', e?.message ?? e))
  }

  return created ?? []
}

/**
 * Send emails for the just-inserted notification rows. Resolves user emails
 * via per-id Auth admin lookups (only for users we've validated belong to
 * this tenant), renders the email body, sends via Resend, logs success/
 * failure to notification_delivery_log keyed by notification_id.
 *
 * Fire-and-forget from emitNotification — never blocks the in-app delivery
 * which is the real-time path users see.
 *
 * SECURITY: caller-supplied `recipient_user_ids` is FILTERED against tenant
 * membership before email lookup. Without this, a caller that mis-scoped
 * a query (e.g., forgot `.eq('tenant_id')` when fetching assignees) could
 * silently email arbitrary users from the global auth pool.
 *
 * SCALE: previously used bulk listUsers({perPage: 1000}) which silently
 * dropped recipients beyond page 1 once the global auth pool exceeded 1000
 * users. Now: per-id getUserById, bounded by the validated-recipient count
 * (typically ≤team size, ≤50 in practice).
 */
async function dispatchEmails(
  supabase: SupabaseClient,
  notifications: any[],
  wantsEmail: boolean[],
  tenantId: string | null,
): Promise<void> {
  // Lazy-import so the email module's env-var check doesn't fire at boot
  // (we want a graceful degradation: in-app keeps working even if Resend
  // isn't configured).
  let sendEmail: typeof import('../lib/email').sendEmail
  let renderNotificationEmail: typeof import('../lib/email').renderNotificationEmail
  try {
    const mod = await import('../lib/email')
    sendEmail = mod.sendEmail
    renderNotificationEmail = mod.renderNotificationEmail
  } catch (e: any) {
    console.warn('[notifications] email module load failed:', e?.message ?? e)
    return
  }

  const userIds = Array.from(new Set(
    notifications.filter((_, i) => wantsEmail[i]).map(n => n.recipient_user_id as string),
  ))
  if (userIds.length === 0) return

  // ── Validate recipients belong to this tenant ────────────────────────
  // Caller passed recipient_user_ids. They might have mis-scoped a query.
  // Build allowed set = {tenant owner} ∪ {user_role_assignments rows where
  // tenant_id matches}. Anything outside is dropped + logged.
  // Platform-scoped notifications (tenant_id == null, e.g. announcements
  // to platform admins) skip this check — the caller for those is super-
  // admin code which has already authorised the recipient list.
  const allowedUsers = new Set<string>()
  if (tenantId) {
    const [{ data: tenant }, { data: roleRows }] = await Promise.all([
      supabase.from('tenants').select('user_id').eq('id', tenantId).maybeSingle(),
      supabase.from('user_role_assignments')
        .select('user_id').eq('tenant_id', tenantId).is('disabled_at', null),
    ])
    if (tenant?.user_id) allowedUsers.add(tenant.user_id)
    for (const r of (roleRows ?? []) as any[]) if (r.user_id) allowedUsers.add(r.user_id)
  }
  const validatedIds = tenantId
    ? userIds.filter(id => allowedUsers.has(id))
    : userIds  // platform-scoped: trust caller
  if (validatedIds.length < userIds.length) {
    const dropped = userIds.filter(id => !validatedIds.includes(id))
    console.warn(`[notifications] dropped ${dropped.length} non-tenant recipients before email send`,
      { tenant_id: tenantId, dropped_user_ids: dropped })
  }
  if (validatedIds.length === 0) return

  // ── Resolve emails (per-id, bounded by validated recipient count) ────
  const userEmails = new Map<string, string>()
  await Promise.all(validatedIds.map(async (id) => {
    try {
      const { data: { user } = {} as any } = await (supabase as any).auth.admin.getUserById(id)
      if (user?.email) userEmails.set(id, user.email)
    } catch (e: any) {
      console.warn(`[notifications] getUserById ${id} failed:`, e?.message ?? e)
    }
  }))

  const logs: any[] = []
  await Promise.all(notifications.map(async (n, i) => {
    if (!wantsEmail[i]) return
    if (!validatedIds.includes(n.recipient_user_id)) {
      logs.push({ notification_id: n.id, channel: 'email', status: 'skipped', error_message: 'recipient not in tenant' })
      return
    }
    const to = userEmails.get(n.recipient_user_id)
    if (!to) {
      logs.push({ notification_id: n.id, channel: 'email', status: 'skipped', error_message: 'no email on record' })
      return
    }
    // Skip if we already sent for this notification id — covers the rare
    // case where Resend's 24h idempotency window has expired but we
    // somehow re-call dispatchEmails for the same notification (e.g. a
    // worker restart that re-enqueues an already-handled job).
    const { data: prior } = await supabase.from('notification_delivery_log')
      .select('id').eq('notification_id', n.id).eq('channel', 'email').eq('status', 'sent').limit(1).maybeSingle()
    if (prior) {
      logs.push({ notification_id: n.id, channel: 'email', status: 'skipped', error_message: 'already sent' })
      return
    }

    const { html, text } = renderNotificationEmail({ title: n.title, body: n.body, link: n.link })
    try {
      const result = await sendEmail({
        to,
        subject: n.title,
        html, text,
        // Idempotency key includes notification id so retries dedup at Resend.
        idempotency_key: `notif-${n.id}`,
      })
      logs.push({
        notification_id: n.id, channel: 'email', status: 'sent',
        delivered_at:    new Date().toISOString(),
        metadata:        { resend_id: result.id },
      })
    } catch (e: any) {
      logs.push({
        notification_id: n.id, channel: 'email', status: 'failed',
        error_message: (e?.message ?? String(e)).slice(0, 500),
      })
    }
  }))
  if (logs.length) await supabase.from('notification_delivery_log').insert(logs)
}

function interpolate(template: string, vars: Record<string, any>): string {
  return template.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, path) => {
    const v = path.split('.').reduce((acc: any, k: string) => acc?.[k], vars)
    return v == null ? '' : String(v)
  })
}
