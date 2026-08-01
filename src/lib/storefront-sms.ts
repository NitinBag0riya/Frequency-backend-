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
 *   MSG91_OTP_TEMPLATE_ID   — MSG91 flow id for the OTP content template  (var1 = code)
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
async function postFlow(templateId: string, mobile: string, vars: Record<string, string>): Promise<SmsResult> {
  const key = authKey()
  if (!key) throw new Error('MSG91 SMS not configured (set MSG91_AUTH_KEY)')
  if (!templateId) throw new Error('MSG91 template_id not set (register the DLT content template + MSG91 flow)')

  const recipient: Record<string, string> = { mobiles: mobile, ...vars }
  const payload: Record<string, unknown> = { template_id: templateId, short_url: '0', recipients: [recipient] }
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
 * storefront keeps owning verification. DLT template: "{#var#} is your
 * verification code…" → var1 = code.
 */
export async function sendSmsOtp(
  _supabase: SupabaseClient,
  args: { slug: string; phone: string; code: string },
): Promise<SmsResult> {
  const to = normRecipient(args.phone)
  if (!/^\d{10,15}$/.test(to)) throw new Error(`Invalid phone for SMS OTP: '${args.phone}'`)
  const code = String(args.code).trim()
  if (!/^\d{4,8}$/.test(code)) throw new Error('Invalid OTP code')
  return postFlow(process.env.MSG91_OTP_TEMPLATE_ID || '', to, { var1: code })
}

/**
 * Send a transactional order-update SMS. `vars` carries the fields the
 * storefront-api builds ({ var1: order#, var2: status, var3: name }). The DLT
 * order template is SINGLE-variable — "{#var#} - Frequency" (brand literal in
 * the template) — so we compose the status line here into var1, kept short to
 * stay inside the DLT per-variable budget (~30 chars). `templateId` lets the
 * caller override the flow id per-tenant.
 * ponytail: dropped the store-name var — the platform brand "Frequency" is
 * already the literal suffix, and one var registers/sends far more reliably than
 * three (the DLT content editor mis-parses multi-var content).
 */
export async function sendSmsOrderUpdate(
  _supabase: SupabaseClient,
  args: { slug: string; phone: string; vars: Record<string, string>; templateId?: string },
): Promise<SmsResult> {
  const to = normRecipient(args.phone)
  if (!/^\d{10,15}$/.test(to)) throw new Error(`Invalid phone for order SMS: '${args.phone}'`)
  const v = args.vars || {}
  const orderNo = v.var1 ? String(v.var1) : ''
  const status = v.var2 ? String(v.var2) : 'updated'
  const line = (orderNo ? `Order ${orderNo} is now ${status}` : `Your order is now ${status}`).slice(0, 30)
  const templateId = args.templateId || process.env.MSG91_ORDER_TEMPLATE_ID || ''
  return postFlow(templateId, to, { var1: line })
}
