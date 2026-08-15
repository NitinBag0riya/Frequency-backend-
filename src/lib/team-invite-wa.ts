/**
 * Deliver a team-invite JOIN LINK over WhatsApp.
 *
 * Reuses the canonical credential seam (`resolveWaCreds`) — the same resolver
 * that powers notifications/OTP — so a tenant's own connected WhatsApp is used
 * when present and the Frequency platform number (FREQ_WA_*) is the fallback.
 * We do NOT open a second sender path here.
 *
 * Cold outbound to a never-messaged number is outside WhatsApp's 24h service
 * window, so this MUST be an APPROVED TEMPLATE (a plain text send would be
 * rejected). The template is expected to carry a URL button whose dynamic
 * suffix is the opaque invite token, e.g. button URL configured as
 *   https://<app>/accept-invite?token={{1}}
 * with one body param for the org name. Template name/lang are env-configurable.
 *
 * Never fabricates success: throws on any Graph error so the caller can fall
 * back to surfacing the accept link for the admin to share manually (mirrors
 * the storefront OTP "delivery is best-effort, flow never breaks" pattern).
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { resolveWaCreds } from './wa-creds'

const GRAPH = 'https://graph.facebook.com/v18.0'
const INVITE_TEMPLATE = process.env.WA_TEAM_INVITE_TEMPLATE || 'team_invite'
const INVITE_LANG = process.env.WA_TEAM_INVITE_TEMPLATE_LANG || 'en_US'

export interface InviteWaResult { ok: true; via: 'tenant' | 'frequency'; waMessageId: string | null }

export async function sendTeamInviteWa(
  supabase: SupabaseClient,
  args: { tenantId: string; phone: string; token: string; orgName: string },
): Promise<InviteWaResult> {
  const to = String(args.phone).replace(/^\+/, '').replace(/\D/g, '').trim()
  if (!/^\d{10,15}$/.test(to)) throw new Error(`Invalid phone for invite: '${args.phone}'`)

  const creds = await resolveWaCreds(supabase, args.tenantId)
  if (!creds?.phoneNumberId || !creds?.accessToken) {
    throw new Error('No WhatsApp sender available (tenant not connected and no Frequency fallback configured)')
  }
  // Platform fallback fills phoneNumberId from FREQ_WA_* env; distinguish for logs.
  const via: 'tenant' | 'frequency' =
    creds.phoneNumberId === process.env.FREQ_WA_PHONE_NUMBER_ID ? 'frequency' : 'tenant'

  const payload = {
    messaging_product: 'whatsapp',
    to,
    type: 'template',
    template: {
      name: INVITE_TEMPLATE,
      language: { code: INVITE_LANG },
      components: [
        { type: 'body', parameters: [{ type: 'text', text: args.orgName }] },
        { type: 'button', sub_type: 'url', index: 0, parameters: [{ type: 'text', text: args.token }] },
      ],
    },
  }

  const r = await fetch(`${GRAPH}/${creds.phoneNumberId}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${creds.accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
  const body: any = await r.json().catch(() => ({}))
  if (!r.ok || body?.error) {
    const msg = body?.error?.message ?? `${r.status} ${r.statusText}`
    if (body?.error?.code === 132001) {
      throw new Error(`Invite template '${INVITE_TEMPLATE}' (${INVITE_LANG}) is not approved on the ${via} WABA — create it with a URL button and wait for Meta approval.`)
    }
    throw new Error(`WhatsApp invite send failed (${via}): ${msg}`)
  }
  return { ok: true, via, waMessageId: body?.messages?.[0]?.id ?? null }
}
