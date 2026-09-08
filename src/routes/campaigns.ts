/**
 * Campaigns — bulk WhatsApp template send from the HQ campaign builder.
 *
 * POST /api/campaigns/wa-send
 *   Body: { cohortId?, templateName, templateLanguage?, templateBody,
 *           recipients: [{name?, phone}], parameters?: string[] }
 *   Response: { queued, sent, failed, campaignId }
 *
 * Auth + tenant-scoped. Uses the tenant's resolved WA credentials
 * (resolveWaCreds — platform sender falls back when the tenant has no BYO WABA,
 * exactly like every other outbound path in this codebase).
 *
 * ── Contract with the sender ──────────────────────────────────────────────────
 * Templates must be Meta-approved. `templateBody` is stored on the campaigns
 * row for audit only — the actual send uses `templateName` + `templateLanguage`
 * + positional `parameters`, which is what Meta's Graph accepts. Per-message
 * rows land in `messages` with status=sent|failed so the existing inbox reads
 * pick them up unchanged.
 *
 * Hard cap 200 recipients per request. Larger cohorts should be paged by the
 * FE (a 200-cap is cheaper than fighting for a queue right now).
 */

import express from 'express'
import type { SupabaseClient } from '@supabase/supabase-js'
import { resolveWaCreds, readSecretValue } from '../lib/wa-creds'

type Mw = (req: express.Request, res: express.Response, next: express.NextFunction) => void | Promise<void>

const GRAPH = 'https://graph.facebook.com/v18.0'
const MAX_RECIPIENTS = 200

/** Normalise Indian mobile numbers to Meta's expected E.164 without '+'.
 *  10-digit → prefix 91; already 12-digit starting with 91 → left alone. */
function toWaPhone(raw: string): string | null {
  const digits = String(raw ?? '').replace(/\D/g, '')
  if (digits.length === 10) return '91' + digits
  if (digits.length === 12 && digits.startsWith('91')) return digits
  if (digits.length >= 10 && digits.length <= 15) return digits
  return null
}

export function createCampaignsRouter(
  supabase: SupabaseClient,
  requireAuth: Mw,
  identifyTenant: Mw,
  checkPermission: (f: string, a: 'view' | 'edit' | 'delete') => Mw,
) {
  const router = express.Router()
  // Reuses the 'broadcasts' permission (already whitelisted through
  // PERMISSION_KEY_ALIASES.whatsapp_automation) — a campaign IS a broadcast.
  const send = [requireAuth, identifyTenant, checkPermission('broadcasts', 'edit')]

  router.post('/campaigns/wa-send', ...send, async (req, res) => {
    const tenantId = (req as any).tenantId as string
    const userEmail = (req as any).user?.email ?? null
    const b = (req.body ?? {}) as any

    const templateName = String(b.templateName ?? '').trim()
    const templateBody = String(b.templateBody ?? '').trim()
    const language     = String(b.templateLanguage ?? 'en_US').trim()
    const cohortId     = b.cohortId ? String(b.cohortId).slice(0, 128) : null
    const parameters   = Array.isArray(b.parameters) ? b.parameters.map((p: any) => String(p ?? '')) : []
    const recipientsIn = Array.isArray(b.recipients) ? b.recipients : []

    if (!templateName) return res.status(400).json({ error: 'templateName required (Meta-approved template)' })
    if (!templateBody) return res.status(400).json({ error: 'templateBody required (audit text)' })
    if (!recipientsIn.length) return res.status(400).json({ error: 'recipients required' })
    if (recipientsIn.length > MAX_RECIPIENTS)
      return res.status(400).json({ error: `too many recipients (max ${MAX_RECIPIENTS} per request)` })

    // Deduplicate + validate before doing anything expensive.
    const seen = new Set<string>()
    const recipients: { name: string | null; phone: string }[] = []
    for (const r of recipientsIn as any[]) {
      const phone = toWaPhone(r?.phone)
      if (!phone || seen.has(phone)) continue
      seen.add(phone)
      recipients.push({ name: typeof r?.name === 'string' ? r.name.trim() || null : null, phone })
    }
    if (!recipients.length) return res.status(400).json({ error: 'no valid recipients (need 10-digit phones)' })

    const creds = await resolveWaCreds(supabase, tenantId)
    if (!creds?.accessToken || !creds?.phoneNumberId) {
      return res.status(409).json({ error: 'WhatsApp not connected for this tenant' })
    }

    // Audit row up front (sent_count updated at the end).
    const { data: campaign, error: campErr } = await supabase.from('wa_broadcast_log').insert({
      tenant_id: tenantId,
      cohort_id: cohortId,
      template_body: templateBody,
      sent_count: 0,
      sent_by: userEmail,
    }).select('id').single()
    if (campErr) return res.status(500).json({ error: campErr.message })

    const components = parameters.length > 0
      ? [{ type: 'body', parameters: parameters.map((v: string) => ({ type: 'text', text: v })) }]
      : []

    let sent = 0
    let failed = 0
    // Sequential send — Meta rate-limits per number; a Promise.all fan-out at
    // 200 concurrent requests routinely trips 4xx and the retry cost is worse
    // than the wall-clock cost. Upgrade path: hand off to broadcast-worker for
    // cohorts > MAX_RECIPIENTS.
    for (const r of recipients) {
      const payload = {
        messaging_product: 'whatsapp', to: r.phone, type: 'template',
        template: { name: templateName, language: { code: language }, components },
      }
      const { data: msgRow } = await supabase.from('messages').insert({
        tenant_id: tenantId, channel: 'whatsapp', direction: 'outbound',
        contact_phone: r.phone, content: payload, status: 'queued',
      }).select('id').single()

      try {
        const resp = await fetch(`${GRAPH}/${creds.phoneNumberId}/messages`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${creds.accessToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(payload),
        })
        const data: any = await resp.json().catch(() => ({}))
        if (!resp.ok || data?.error) {
          const detail = data?.error?.message || `WA send failed (${resp.status})`
          if (msgRow?.id) await supabase.from('messages').update({
            status: 'failed', content: { ...payload, error: detail },
          }).eq('id', msgRow.id)
          failed++
          continue
        }
        if (msgRow?.id && data?.messages?.[0]?.id) {
          await supabase.from('messages').update({
            platform_message_id: data.messages[0].id, status: 'sent',
          }).eq('id', msgRow.id)
        }
        sent++
      } catch (e: any) {
        if (msgRow?.id) await supabase.from('messages').update({
          status: 'failed', content: { ...payload, error: String(e?.message ?? e) },
        }).eq('id', msgRow.id)
        failed++
      }
    }

    await supabase.from('wa_broadcast_log').update({ sent_count: sent }).eq('id', campaign.id)
    res.json({ campaignId: campaign.id, queued: recipients.length, sent, failed })
  })

  return router
}
