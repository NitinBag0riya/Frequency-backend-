/**
 * Worker: broadcast.batch
 *
 * Fans one broadcast out into N per-contact `message.send` jobs.
 *
 * Why a queue and not an inline for-loop?
 *   - Survives API-process restarts mid-broadcast (BullMQ persists jobs).
 *   - Per-message retries (5 attempts) handled uniformly by message-sender.
 *   - Tenant-scoped rate limiting in message-sender prevents Meta 429s.
 *   - Bull Board shows progress + failures live.
 *
 * Template variable mapping (roadmap §2.5):
 *   broadcasts.variable_map is a JSONB like:
 *     { "1": "name", "2": "attributes.city", "3": "phone" }
 *   For each contact, this resolves dotted paths and produces the ordered
 *   parameter array Meta expects.
 */

import '../env'
import { Worker, UnrecoverableError, Job } from 'bullmq'
import { createClient } from '@supabase/supabase-js'
import { Q, BroadcastBatchJob, connection, enqueueMessageSend } from '../queue'
import { checkAndConsumeQuota } from '../lib/quota'
// P1 #18 — saved-segment audience resolution. When broadcasts.segment_id is
// set, we use the segment-filter evaluator instead of the legacy tags shape.
import { buildSegmentQuery } from '../lib/segment-filter'
// P2 #19 — pre-send URL → short-link rewriter. Each recipient gets their
// own per-contact short link so a click maps to (broadcast, contact, URL).
// Plain-text bodies (TG/IG) are rewritten in-full; WA template params are
// rewritten only when the resolved value is itself a URL.
import { shortenBody, extractUrls } from '../lib/link-shortener'

const PUBLIC_BASE_URL = (process.env.PUBLIC_API_URL ?? 'http://localhost:3001').replace(/\/+$/, '')

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://yiicpndeggaedxobyopu.supabase.co'
const supabase = createClient(SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY!)

export function startBroadcastWorker() {
  const worker = new Worker<BroadcastBatchJob>(
    Q.broadcast,
    async (job: Job<BroadcastBatchJob>) => {
      const { broadcastId } = job.data

      // 1. Load broadcast + tenant in one trip.
      // P0.8: also pull `channel` so we can branch dispatch per-channel.
      // Legacy broadcast rows from before 016 have channel='whatsapp'
      // courtesy of the column default, so the fallback below is just a
      // belt-and-braces null guard.
      const { data: broadcast, error: bErr } = await supabase
        .from('broadcasts')
        .select('id, tenant_id, channel, template_name, audience, segment_id, variable_map, language, status')
        .eq('id', broadcastId)
        .maybeSingle()
      if (bErr) throw new Error(`load broadcast: ${bErr.message}`)
      if (!broadcast) throw new Error(`broadcast ${broadcastId} not found`)
      if (broadcast.status === 'sent' || broadcast.status === 'failed') {
        return { skipped: `status=${broadcast.status}` }
      }
      const channel = (broadcast as any).channel ?? 'whatsapp'

      // Credential gate is channel-specific. WhatsApp needs phone_number_id +
      // access_token; Telegram needs a row in tg_bots (handled by message-
      // sender's sendTelegram). Skip the WA credential check when we're
      // dispatching to a non-WA channel — otherwise a Telegram-only tenant
      // could never broadcast (P0.8).
      const { data: tenant } = await supabase.from('tenants')
        .select('id, access_token, phone_number_id')
        .eq('id', broadcast.tenant_id).maybeSingle()
      if (!tenant) {
        await markFailed(broadcast.id, 'tenant not found')
        throw new Error('tenant not found')
      }
      if (channel === 'whatsapp' && !tenant.access_token) {
        await markFailed(broadcast.id, 'tenant has no WhatsApp credentials')
        throw new Error('tenant has no WhatsApp credentials')
      }
      if (channel === 'telegram') {
        const { data: bot } = await supabase.from('tg_bots')
          .select('tenant_id').eq('tenant_id', broadcast.tenant_id).maybeSingle()
        if (!bot) {
          await markFailed(broadcast.id, 'tenant has no Telegram bot connected')
          throw new Error('tenant has no Telegram bot connected')
        }
      }

      // ── Per-tenant broadcast quota gate (migration 063 / lib/quota.ts) ─
      // Consumed BEFORE we resolve the audience + fan out so a tenant who
      // has exhausted their daily broadcast count gets a single clean
      // failure with reason instead of N per-message rate-limit rejections
      // cluttering /api/messages. The per-message quota still applies to
      // each fanned-out send (enforced in message-sender.ts).
      const bCheck = await checkAndConsumeQuota(
        supabase, connection, broadcast.tenant_id, 'broadcasts_per_day',
      )
      if (!bCheck.allowed) {
        const reason = bCheck.reason === 'feature_disabled'
          ? `Broadcasts are not included in your plan — upgrade to ${bCheck.upgrade_to ?? 'starter'}.`
          : `Daily broadcast quota reached (${bCheck.current_usage}/${bCheck.cap}); resets at ${bCheck.resets_at}.`
        await markFailed(broadcast.id, reason)
        throw new UnrecoverableError(reason)
      }

      // 2. Resolve audience → contact list.
      // P0.8: also pull telegram_id / instagram_id so we can route the send
      // to the channel-correct recipient address (TG bot needs chat_id;
      // IG needs IGSID; WA needs E.164 phone). For Telegram broadcasts we
      // additionally require telegram_id to be present — phone-only contacts
      // can't be reached over TG.
      // P1 #18 — when segment_id is set, use the saved-segment filter evaluator
      // instead of the legacy audience.tags shape. Segment wins if both are
      // present on the broadcast row (set by the FE composer's "Send to
      // segment" mode). Channel-specific reachability filters (telegram_id /
      // instagram_id NOT NULL) still apply on top so we don't try to TG-DM a
      // phone-only contact.
      let q: any
      if ((broadcast as any).segment_id) {
        const { data: seg, error: segErr } = await supabase.from('contact_segments')
          .select('id, filters, archived_at')
          .eq('id', (broadcast as any).segment_id)
          .eq('tenant_id', broadcast.tenant_id)
          .maybeSingle()
        if (segErr) throw new Error(`load segment: ${segErr.message}`)
        if (!seg || seg.archived_at) {
          await markFailed(broadcast.id, 'segment not found or archived')
          throw new UnrecoverableError('segment not found or archived')
        }
        const built = await buildSegmentQuery(supabase, broadcast.tenant_id, seg.filters)
        q = built.query.select('id, phone, name, email, telegram_id, instagram_id, attributes, tags')
        // Segments don't bake in an explicit status filter by default,
        // but broadcasts have always targeted active contacts only.
        q = q.eq('status', 'active')
      } else {
        q = supabase.from('contacts')
          .select('id, phone, name, email, telegram_id, instagram_id, attributes, tags')
          .eq('tenant_id', broadcast.tenant_id)
          .eq('status', 'active')
        const audience = (broadcast.audience ?? {}) as any
        if (audience.tags?.length)        q = q.overlaps('tags', audience.tags)
        if (audience.exclude_tags?.length) q = q.not('tags', 'ov', `{${audience.exclude_tags.join(',')}}`)
      }
      if (channel === 'telegram')  q = q.not('telegram_id', 'is', null)
      if (channel === 'instagram') q = q.not('instagram_id', 'is', null)

      const { data: contacts, error: cErr } = await q
      if (cErr) throw new Error(`load contacts: ${cErr.message}`)
      if (!contacts || contacts.length === 0) {
        await markFailed(broadcast.id, 'no contacts match audience')
        return { recipients: 0 }
      }

      // 3. Mark sending + record planned recipient count
      await supabase.from('broadcasts').update({
        status: 'sending',
        sent_at: new Date().toISOString(),
        stats: { queued: contacts.length, sent: 0, delivered: 0, read: 0, replied: 0, failed: 0 },
      }).eq('id', broadcast.id)

      // 4. Fan out — one message.send job per contact.
      //
      // Per-channel dispatch (P0.8):
      //   • whatsapp  → kind='template' (Meta requires an approved template
      //     for any out-of-session send; same as before).
      //   • telegram  → kind='text', body = broadcast.template_name (we
      //     reuse template_name as the message body for non-WA channels;
      //     see /api/telegram/broadcasts route). Telegram has no template
      //     gating — bots can DM any user who has /start-ed the bot, free.
      //   • instagram → kind='text', body = template_name. IG has its own
      //     24h messaging window but no template approval flow.
      const language = broadcast.language ?? 'en_US'
      const varMap = (broadcast.variable_map ?? {}) as Record<string, string>
      let enqueued = 0
      for (const contact of contacts) {
        try {
          if (channel === 'whatsapp') {
            const params = buildTemplateParams(varMap, contact)
            // P2 #19 — for each WA template parameter whose resolved value
            // is itself a URL, swap it for a per-recipient short link so
            // clicks attribute back to (broadcast, contact). Plain-text
            // params (names, cities, etc.) flow through untouched.
            const shortenedParams = await shortenWaParams(
              supabase, broadcast.tenant_id, broadcast.id, contact.id, params, PUBLIC_BASE_URL,
            )
            await enqueueMessageSend({
              tenantId: broadcast.tenant_id,
              to: contact.phone.replace(/^\+/, ''),
              channel: 'whatsapp',
              kind: 'template',
              template: { name: broadcast.template_name!, language, parameters: shortenedParams },
              broadcastId: broadcast.id,
              sessionId: null,
            })
          } else if (channel === 'telegram') {
            // template_name holds the raw text payload for non-WA channels.
            // We still do variable interpolation so {{name}} / {{1}} style
            // tokens in the broadcast body land each contact's data.
            const interpolated = interpolateBody(broadcast.template_name ?? '', varMap, contact)
            // P2 #19 — replace every URL in the body with a per-recipient
            // short link. shortenBody is a no-op when the body has zero URLs.
            const { body: text } = await shortenBody(supabase, {
              tenantId: broadcast.tenant_id,
              broadcastId: broadcast.id,
              contactId: contact.id,
              body: interpolated,
              publicBaseUrl: PUBLIC_BASE_URL,
            })
            await enqueueMessageSend({
              tenantId: broadcast.tenant_id,
              to: String(contact.telegram_id),
              channel: 'telegram',
              kind: 'text',
              text,
              broadcastId: broadcast.id,
              sessionId: null,
            })
          } else if (channel === 'instagram') {
            const interpolated = interpolateBody(broadcast.template_name ?? '', varMap, contact)
            const { body: text } = await shortenBody(supabase, {
              tenantId: broadcast.tenant_id,
              broadcastId: broadcast.id,
              contactId: contact.id,
              body: interpolated,
              publicBaseUrl: PUBLIC_BASE_URL,
            })
            await enqueueMessageSend({
              tenantId: broadcast.tenant_id,
              to: String(contact.instagram_id),
              channel: 'instagram',
              kind: 'text',
              text,
              broadcastId: broadcast.id,
              sessionId: null,
            })
          } else {
            console.warn(`[broadcast] unsupported channel=${channel} for broadcast=${broadcast.id}`)
            continue
          }
          enqueued++
        } catch (err: any) {
          console.warn(`[broadcast] failed to enqueue contact=${contact.id}: ${err.message}`)
        }
      }

      console.log(`[broadcast] ${broadcast.id} channel=${channel} fanned out ${enqueued}/${contacts.length}`)
      return { broadcastId: broadcast.id, channel, enqueued, totalContacts: contacts.length }
    },
    {
      connection,
      concurrency: Number(process.env.BROADCAST_CONCURRENCY ?? 3),
    }
  )

  worker.on('failed', (job, err) => {
    console.warn(`[worker:broadcast] ✗ job=${job?.id} — ${err.message}`)
  })
  console.log('[worker:broadcast] started')
  return worker
}

// ── helpers ──────────────────────────────────────────────────────────────────
async function markFailed(broadcastId: string, reason: string) {
  await supabase.from('broadcasts').update({
    status: 'failed',
    stats: { error: reason },
  }).eq('id', broadcastId)
}

/**
 * variable_map = { "1": "name", "2": "attributes.city", "3": "phone" }
 * → returns ['Rahul', 'Mumbai', '+919876543210'] in that order.
 *
 * Numeric keys are sorted; missing values become empty string so Meta
 * doesn't reject the template for missing params.
 */
function buildTemplateParams(varMap: Record<string, string>, contact: any): string[] {
  const numericKeys = Object.keys(varMap)
    .filter(k => /^\d+$/.test(k))
    .sort((a, b) => Number(a) - Number(b))
  return numericKeys.map(k => {
    const path = varMap[k]
    if (!path) return ''
    const val = resolvePath(contact, path)
    return val == null ? '' : String(val)
  })
}

function resolvePath(obj: any, path: string): any {
  return path.split('.').reduce((acc, part) => (acc == null ? acc : acc[part]), obj)
}

/**
 * Interpolate {{1}} / {{2}} / {{name}} / {{attributes.city}} tokens in a
 * non-WhatsApp broadcast body using the same variable_map shape as the WA
 * template fan-out (P0.8 — used by Telegram and Instagram broadcasts).
 *
 * Numeric tokens look up the variable_map (same as WA: { "1": "name" }).
 * Word/dotted tokens resolve directly against the contact via resolvePath
 * so authors can write {{name}} without bothering with index mapping when
 * they only have one variable.
 *
 * Missing values become empty strings — matches the WA params behaviour so
 * tenants don't get surprised by literal `{{1}}` showing up in a broadcast.
 */
function interpolateBody(body: string, varMap: Record<string, string>, contact: any): string {
  return body.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_match, raw) => {
    const key = String(raw).trim()
    // Numeric token? Look up the variable_map first.
    if (/^\d+$/.test(key)) {
      const path = varMap[key]
      if (!path) return ''
      const val = resolvePath(contact, path)
      return val == null ? '' : String(val)
    }
    // Word/dotted token — resolve directly against contact.
    const val = resolvePath(contact, key)
    return val == null ? '' : String(val)
  })
}

/**
 * P2 #19 — WA template parameter URL shortening.
 *
 * WA template params come through as an ordered string[] (one entry per
 * {{N}} slot). We can't rewrite the template body itself (Meta serves
 * that from their CDN), but we CAN replace any param whose resolved
 * value is a URL with a per-recipient short link. Click-tracking then
 * works on whatever Meta renders as the variable substitution.
 *
 * Conservative by design: a param value that has 0 detected URLs flows
 * through untouched. A param that is multiple words containing a URL
 * gets its URL replaced in-place (rare but covered).
 */
async function shortenWaParams(
  supabaseClient: typeof supabase,
  tenantId: string,
  broadcastId: string,
  contactId: string,
  params: string[],
  publicBaseUrl: string,
): Promise<string[]> {
  const out: string[] = []
  for (const raw of params) {
    if (!raw || extractUrls(raw).length === 0) { out.push(raw); continue }
    try {
      const { body } = await shortenBody(supabaseClient, {
        tenantId, broadcastId, contactId, body: raw, publicBaseUrl,
      })
      out.push(body)
    } catch (err: any) {
      // Failing-open here: if the shortener has a DB hiccup we'd rather
      // ship the original URL than fail the whole broadcast. The
      // broadcast_links insert is the audit trail — a missing row just
      // means that one recipient's click goes untracked, not that the
      // message fails to send.
      console.warn(`[broadcast] WA param shorten failed: ${err.message}`)
      out.push(raw)
    }
  }
  return out
}
