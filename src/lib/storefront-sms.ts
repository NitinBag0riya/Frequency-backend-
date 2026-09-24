/**
 * Storefront SMS gateway — MSG91 transactional SMS (login OTP + order updates).
 *
 * India-first: MSG91 is natively integrated with TRAI DLT. Unlike Brevo (which
 * matched DLT server-side and sent free text), MSG91's v5 "Flow" API sends a
 * DLT-registered CONTENT TEMPLATE referenced by a MSG91 flow/template id, with
 * the message variables passed positionally as var1, var2, … The DLT header
 * (sender id) + content templates are registered on the DLT portal (SmartPing)
 * and mirrored into MSG91 as Flows; only the resulting ids live here as env.
 *
 * Email stays on Brevo (see lib/email.ts) — this module is SMS only.
 *
 * Single platform account: MSG91 goes out on Frequency's platform Auth Key
 * (env MSG91_AUTH_KEY). There is no per-tenant branch here — a tenant with its
 * own MSG91 key uses the per-tenant connector (routes/connectors/msg91.ts) for
 * workflow nodes, which is a separate path.
 * ponytail: platform-key only (no tenant-key-first fallback). Add one here if a
 * tenant ever needs order/OTP SMS from THEIR own DLT header + templates.
 *
 * The exported function names/shapes are unchanged from the Brevo version so
 * `routes/storefront-domains.ts` and `brevo.selfcheck.ts` keep working.
 *
 * Env:
 *   MSG91_AUTH_KEY          — platform Auth Key (MSG91 dashboard → Auth Key)
 *   MSG91_SENDER_ID         — DLT-approved 6-char header (e.g. "FREQNC")
 *   MSG91_OTP_TEMPLATE_ID   — MSG91 flow id for the OTP content template  (var1=code, var2=store name)
 *   MSG91_ORDER_TEMPLATE_ID — MSG91 flow id for the order content template (var1=order#, var2=status, var3=name)
 *   MSG91_COUNTRY_CODE      — default country code for bare local numbers (def "91")
 */
import type { SupabaseClient } from '@supabase/supabase-js'

const MSG91_FLOW_URL = 'https://control.msg91.com/api/v5/flow/'

/** E.164-ish digits WITH country code, no leading '+' (MSG91's `mobiles` format).
 *  A bare 10-digit number is assumed local and gets the default country code.
 *  Exported for tests. (Reads the legacy BREVO_SMS_COUNTRY_CODE too so the
 *  existing self-check keeps passing.) */
export function normRecipient(phone: string): string {
  let d = String(phone).replace(/\D/g, '')
  const cc = process.env.MSG91_COUNTRY_CODE || process.env.BREVO_SMS_COUNTRY_CODE || '91'
  if (d.length === 11 && d.startsWith('0')) d = d.slice(1) // drop leading STD 0 (India: 09876… → 9876…)
  if (d.length === 10) d = cc + d
  return d
}

const authKey = () => process.env.MSG91_AUTH_KEY || ''
const senderId = () => (process.env.MSG91_SENDER_ID || '').trim()

export interface SmsResult { ok: true; via: 'frequency' }

/** True when the platform MSG91 gateway is configured (auth key present). Lets
 *  callers cheaply decide whether to even attempt the SMS channel. */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export async function smsAvailable(_supabase?: SupabaseClient, _slug?: string): Promise<boolean> {
  return !!authKey()
}

/**
 * Send one DLT flow. `vars` are the template variables in order (var1, var2, …).
 * Throws on any non-success so the caller can fall back to WhatsApp / on-screen.
 */
async function postFlow(templateId: string, mobile: string, vars: Record<string, string>, opts?: { shortUrl?: boolean }): Promise<SmsResult> {
  const key = authKey()
  if (!key) throw new Error('MSG91 SMS not configured (set MSG91_AUTH_KEY)')
  if (!templateId) throw new Error('MSG91 template_id not set (register the DLT content template + MSG91 flow)')

  const recipient: Record<string, string> = { mobiles: mobile, ...vars }
  // short_url '1' lets MSG91 shorten a URL var (used by the team-invite join link);
  // OTP/order templates keep '0' (no link).
  const payload: Record<string, unknown> = { template_id: templateId, short_url: opts?.shortUrl ? '1' : '0', recipients: [recipient] }
  const sender = senderId()
  if (sender) payload.sender = sender

  const r = await fetch(MSG91_FLOW_URL, {
    method: 'POST',
    headers: { authkey: key, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(payload),
  })
  const body: any = await r.json().catch(() => ({}))
  // MSG91 success: HTTP 200 with { type: 'success', ... }. Failure: non-2xx or
  // { type: 'error', message } — surface the message so the fallback logs are useful.
  if (!r.ok || body?.type === 'error') {
    throw new Error(`MSG91 SMS send failed: ${body?.message || `${r.status} ${r.statusText}`}`)
  }
  return { ok: true, via: 'frequency' }
}

/**
 * Send a login OTP over MSG91. We pass our own pre-generated `code` so the
 * storefront keeps owning verification. DLT template "Frequency Login OTP v2":
 * "{#var#} is your {#var#} verification code. Do not share it with anyone. -
 * Frequency" → var1 = code, var2 = tenant store display name. The store name is
 * resolved by the caller (storefront-domains) and falls back to the brand.
 */
export async function sendSmsOtp(
  _supabase: SupabaseClient,
  args: { slug: string; phone: string; code: string; storeName?: string },
): Promise<SmsResult> {
  const to = normRecipient(args.phone)
  if (!/^\d{10,15}$/.test(to)) throw new Error(`Invalid phone for SMS OTP: '${args.phone}'`)
  const code = String(args.code).trim()
  if (!/^\d{4,8}$/.test(code)) throw new Error('Invalid OTP code')
  const store = (args.storeName || 'Frequency').trim().slice(0, 30) || 'Frequency'
  return postFlow(process.env.MSG91_OTP_TEMPLATE_ID || '', to, { var1: code, var2: store })
}

/**
 * Send a TEAM-INVITE join link over MSG91 — the SAME gateway/rail as the login
 * OTP (sendSmsOtp), so phone team-invites ride the proven DLT SMS path instead of
 * needing a separate WhatsApp template. DLT template "Frequency Team Invite":
 * "You're invited to join {#var#} on Frequency. Tap to accept: {#var#} - Frequency"
 * → var1 = org/store name, var2 = accept link (MSG91 short_url shortens it).
 * Register the content template on DLT + mirror as an MSG91 flow → its id in
 * MSG91_TEAM_INVITE_TEMPLATE_ID. Throws on failure so the caller can fall back to
 * WhatsApp / the on-screen accept link.
 */
export async function sendTeamInviteSms(
  _supabase: SupabaseClient,
  args: { phone: string; orgName?: string; acceptUrl: string },
): Promise<SmsResult> {
  const to = normRecipient(args.phone)
  if (!/^\d{10,15}$/.test(to)) throw new Error(`Invalid phone for invite SMS: '${args.phone}'`)
  const org = (args.orgName || 'Frequency').trim().slice(0, 30) || 'Frequency'
  const url = String(args.acceptUrl).trim()
  if (!url) throw new Error('Invite accept URL required')
  return postFlow(process.env.MSG91_TEAM_INVITE_TEMPLATE_ID || '', to, { var1: org, var2: url }, { shortUrl: true })
}

/**
 * Send a transactional order-update SMS. `vars` carries the fields the
 * storefront-api builds ({ var1: order#, var2: status, var3: name }). DLT
 * template "Frequency Order Update v2": "Order #{#var#} is {#var#} at {#var#}. -
 * Frequency" → var1 = order# (NUMBER tag → digits only), var2 = status,
 * var3 = store display name. storefront-api already supplies all three; the
 * caller backfills var3 (and clamps here) when it doesn't. `templateId` lets the
 * caller override the flow id per-tenant.
 */
export async function sendSmsOrderUpdate(
  _supabase: SupabaseClient,
  args: { slug: string; phone: string; vars: Record<string, string>; templateId?: string; storeName?: string },
): Promise<SmsResult> {
  const to = normRecipient(args.phone)
  if (!/^\d{10,15}$/.test(to)) throw new Error(`Invalid phone for order SMS: '${args.phone}'`)
  const v = args.vars || {}
  // var1 is tagged NUMBER on DLT — strip to digits ("#1088"/"ORD-1088" → "1088").
  const order = (v.var1 ? String(v.var1) : '').replace(/\D/g, '').slice(0, 12) || '0'
  const status = (v.var2 ? String(v.var2) : 'updated').trim().slice(0, 30) || 'updated'
  const store = (v.var3 || args.storeName || 'Frequency').trim().slice(0, 30) || 'Frequency'
  const templateId = args.templateId || process.env.MSG91_ORDER_TEMPLATE_ID || ''
  return postFlow(templateId, to, { var1: order, var2: status, var3: store })
}
