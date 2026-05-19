/**
 * Expo push-send helper.
 *
 * sendExpoPush(userId, payload) — fan out a notification to every push_devices
 * row registered for `userId`. Used by:
 *   • Inbound message handler (new WA/IG/TG message → ping assigned agents)
 *   • Broadcast worker         (broadcast finished → ping the author)  [future]
 *   • System events            (billing failure, breach alerts, …)     [future]
 *
 * Why Expo's push service and not direct APNs / FCM?
 *   The mobile app is built on Expo / EAS — it already has Expo's push
 *   credentials wired in. Going through `exp.host/--/api/v2/push/send`
 *   means we never store Apple / Google secrets server-side, and Expo
 *   handles the per-platform plumbing (priority, badge, sound, channel).
 *
 * Stale-token reaping:
 *   Expo's ticket response uses `DeviceNotRegistered` for tokens that
 *   have been uninstalled. We pull those out and DELETE from push_devices
 *   in the same call so the next fan-out skips them. Other ticket errors
 *   (`MessageTooBig`, `InvalidCredentials`, …) are logged but not deleted
 *   — the row may still be valid for the next payload.
 *
 * Best-effort contract:
 *   The caller is expected to wrap this in try/catch and never let a
 *   failed Expo push block the originating handler. We return
 *   { sent, failed } rather than throw so the caller can log without
 *   branching on exception types.
 *
 * EXPO_ACCESS_TOKEN:
 *   Optional. When set, the request gets `Authorization: Bearer <token>`
 *   and Expo validates the request against the project. This MUST be a
 *   server-side env var only — never bundle into FE or mobile.
 *
 * See: https://docs.expo.dev/push-notifications/sending-notifications/
 */

import type { SupabaseClient } from '@supabase/supabase-js'

const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send'
const BATCH_SIZE = 100 // Expo's hard limit per request.

export interface ExpoPushPayload {
  title: string
  body: string
  data?: Record<string, unknown>
  /**
   * Channel ID for Android — must match a channel registered on the
   * device. Mobile registers 'default' today; richer channels land in
   * a follow-up.
   */
  channel?: 'inbox' | 'broadcast' | 'system'
}

interface ExpoPushMessage {
  to: string
  title: string
  body: string
  data?: Record<string, unknown>
  priority: 'high' | 'default'
  channelId?: string
  sound?: 'default'
}

interface ExpoTicket {
  status: 'ok' | 'error'
  id?: string
  message?: string
  details?: { error?: string }
}

interface ExpoBatchResponse {
  data?: ExpoTicket[]
  errors?: unknown[]
}

export async function sendExpoPush(
  supabase: SupabaseClient,
  userId: string,
  payload: ExpoPushPayload,
): Promise<{ sent: number; failed: number }> {
  // 1. Fetch every device row for this user.
  const { data: devices, error } = await supabase.from('push_devices')
    .select('id, expo_push_token, platform')
    .eq('user_id', userId)
  if (error) {
    console.warn(`[expo-push] failed to fetch push_devices for user=${userId}: ${error.message}`)
    return { sent: 0, failed: 0 }
  }
  if (!devices || devices.length === 0) return { sent: 0, failed: 0 }

  // 2. Build Expo messages. Map our channel name → Android channelId
  // string. iOS ignores channelId; Android falls back to 'default' if
  // the named channel isn't registered on the device.
  const channelId = payload.channel ?? 'default'
  const messages: ExpoPushMessage[] = devices.map(d => ({
    to:        d.expo_push_token,
    title:     payload.title,
    body:      payload.body,
    data:      payload.data ?? {},
    priority:  'high',
    channelId,
    sound:     'default',
  }))

  // Map token → device row id for stale-token reaping below.
  const tokenToId = new Map<string, string>()
  for (const d of devices) tokenToId.set(d.expo_push_token, d.id as string)

  // 3. Send in batches of 100.
  const headers: Record<string, string> = {
    'Content-Type':    'application/json',
    'Accept':          'application/json',
    'Accept-Encoding': 'gzip, deflate',
  }
  if (process.env.EXPO_ACCESS_TOKEN) {
    headers['Authorization'] = `Bearer ${process.env.EXPO_ACCESS_TOKEN}`
  }

  let sent = 0
  let failed = 0
  const staleDeviceIds: string[] = []

  for (let i = 0; i < messages.length; i += BATCH_SIZE) {
    const batch = messages.slice(i, i + BATCH_SIZE)
    let json: ExpoBatchResponse | null = null
    try {
      const resp = await fetch(EXPO_PUSH_URL, {
        method:  'POST',
        headers,
        body:    JSON.stringify(batch),
      })
      json = (await resp.json()) as ExpoBatchResponse
      if (!resp.ok) {
        console.warn(`[expo-push] batch failed status=${resp.status}: ${JSON.stringify(json).slice(0, 500)}`)
        failed += batch.length
        continue
      }
    } catch (e: any) {
      console.warn(`[expo-push] batch fetch threw: ${e?.message ?? e}`)
      failed += batch.length
      continue
    }

    const tickets = json?.data ?? []
    for (let j = 0; j < tickets.length; j++) {
      const ticket = tickets[j]
      const msg = batch[j]
      if (ticket.status === 'ok') {
        sent++
      } else {
        failed++
        // `DeviceNotRegistered` means the user uninstalled the app or
        // revoked notifications. Reap the row so we don't keep retrying.
        if (ticket.details?.error === 'DeviceNotRegistered') {
          const id = tokenToId.get(msg.to)
          if (id) staleDeviceIds.push(id)
        } else {
          console.warn(`[expo-push] ticket error for token=${msg.to.slice(0, 30)}…: ${ticket.message}`)
        }
      }
    }
  }

  // 4. Reap stale tokens — best-effort, don't fail the call if delete errors.
  if (staleDeviceIds.length > 0) {
    const { error: delErr } = await supabase.from('push_devices')
      .delete()
      .in('id', staleDeviceIds)
    if (delErr) {
      console.warn(`[expo-push] stale-token reap failed: ${delErr.message}`)
    } else {
      console.log(`[expo-push] reaped ${staleDeviceIds.length} stale device(s)`)
    }
  }

  return { sent, failed }
}
