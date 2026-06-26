/**
 * Storefront login OTP over WhatsApp.
 *
 * The customer mini-app (storefront-api) generates a login code and asks the
 * main API to deliver it over WhatsApp. We send a WhatsApp AUTHENTICATION
 * template (code in the body + the one-tap/copy button) using:
 *   1. the TENANT's own connected WhatsApp (tenants.phone_number_id/access_token), or
 *   2. Frequency's platform WhatsApp as a fallback (env FREQ_WA_PHONE_NUMBER_ID
 *      + FREQ_WA_ACCESS_TOKEN) when the tenant hasn't connected one.
 *
 * The template name/lang are env-configurable and must be an APPROVED
 * authentication template on the sending WABA. If delivery fails, the caller
 * (storefront-api) falls back to its on-screen demo code, so login never breaks.
 */
import type { SupabaseClient } from '@supabase/supabase-js'

const GRAPH = 'https://graph.facebook.com/v18.0'
const OTP_TEMPLATE = process.env.WA_OTP_TEMPLATE_NAME || 'frequency_login_code'
const OTP_LANG = process.env.WA_OTP_TEMPLATE_LANG || 'en_US'

export interface OtpSendResult { ok: true; via: 'tenant' | 'frequency'; waMessageId: string | null }

export async function sendStorefrontOtp(
  supabase: SupabaseClient,
  args: { slug: string; phone: string; code: string },
): Promise<OtpSendResult> {
  const to = String(args.phone).replace(/^\+/, '').replace(/\D/g, '').trim()
  if (!/^\d{10,15}$/.test(to)) throw new Error(`Invalid phone for OTP: '${args.phone}'`)
  const code = String(args.code).trim()
  if (!/^\d{4,8}$/.test(code)) throw new Error('Invalid OTP code')

  // Resolve the tenant's own WhatsApp creds by storefront slug.
  const { data: tenant } = await supabase.from('tenants')
    .select('phone_number_id, access_token, status')
    .eq('slug', args.slug).maybeSingle()

  let creds: { phoneNumberId: string; accessToken: string; via: 'tenant' | 'frequency' } | null = null
  if (tenant?.phone_number_id && tenant?.access_token && (tenant as any).status !== 'disconnected') {
    creds = { phoneNumberId: tenant.phone_number_id, accessToken: tenant.access_token, via: 'tenant' }
  } else if (process.env.FREQ_WA_PHONE_NUMBER_ID && process.env.FREQ_WA_ACCESS_TOKEN) {
    creds = { phoneNumberId: process.env.FREQ_WA_PHONE_NUMBER_ID, accessToken: process.env.FREQ_WA_ACCESS_TOKEN, via: 'frequency' }
  }
  if (!creds) throw new Error('No WhatsApp sender available (tenant not connected and no Frequency fallback configured)')

  // WhatsApp authentication-template send: the code goes in the body param AND
  // the button param (one-tap autofill / copy code).
  const payload = {
    messaging_product: 'whatsapp',
    to,
    type: 'template',
    template: {
      name: OTP_TEMPLATE,
      language: { code: OTP_LANG },
      components: [
        { type: 'body', parameters: [{ type: 'text', text: code }] },
        { type: 'button', sub_type: 'url', index: 0, parameters: [{ type: 'text', text: code }] },
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
      throw new Error(`OTP template '${OTP_TEMPLATE}' (${OTP_LANG}) is not approved on the ${creds.via} WABA — create an AUTHENTICATION template and wait for Meta approval.`)
    }
    throw new Error(`WhatsApp OTP send failed (${creds.via}): ${msg}`)
  }
  return { ok: true, via: creds.via, waMessageId: body?.messages?.[0]?.id ?? null }
}
