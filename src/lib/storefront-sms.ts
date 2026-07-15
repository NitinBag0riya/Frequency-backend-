/**
 * Storefront SMS gateway — Brevo transactional SMS (login OTP + order updates).
 *
 * Replaces the old MSG91 platform gateway. Brevo sends free-text SMS (no DLT
 * `template_id` in the API call itself), so we build the message body here from
 * the same inputs the callers already pass — the exported function names/shapes
 * are unchanged so `routes/storefront-domains.ts` keeps working.
 *
 * Single platform account: unlike MSG91 (tenant-key-first), Brevo SMS goes out
 * on Frequency's one Brevo account via env BREVO_API_KEY. There is no per-tenant
 * Brevo connector, so there's no tenant-key branch here.
 *
 * INDIA / DLT: TRAI still mandates DLT registration for India SMS — but with
 * Brevo that registration (sender ID + content template) lives in the Brevo
 * dashboard, matched server-side by Brevo, so the API call stays a plain
 * sender+content POST. Without a DLT-approved sender/template Brevo will reject
 * India sends; the caller then falls back to WhatsApp / on-screen code.
 *
 * Env:
 *   BREVO_API_KEY          — xkeysib-… (same key as email)
 *   BREVO_SMS_SENDER       — alphanumeric sender ID, ≤11 chars (e.g. "FREQNCY")
 *   BREVO_SMS_COUNTRY_CODE — default country code for bare local numbers (def "91")
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { brevoApiKey } from './email.js'

const BREVO_SMS_URL = 'https://api.brevo.com/v3/transactionalSMS/sms'

/** E.164-ish digits with country code, no leading '+' (Brevo's required format).
 *  A bare 10-digit number is assumed local and gets the default country code.
 *  Exported for tests. */
export function normRecipient(phone: string): string {
  let d = String(phone).replace(/\D/g, '')
  if (d.length === 10) d = (process.env.BREVO_SMS_COUNTRY_CODE || '91') + d
  return d
}

const senderId = () => (process.env.BREVO_SMS_SENDER || 'FREQNCY').slice(0, 11)

export interface SmsResult { ok: true; via: 'frequency' }

/** True when the platform Brevo SMS is configured. Lets callers cheaply decide
 *  whether to even attempt the SMS channel. */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export async function smsAvailable(_supabase?: SupabaseClient, _slug?: string): Promise<boolean> {
  return !!brevoApiKey()
}

async function postSms(recipient: string, content: string): Promise<SmsResult> {
  const apiKey = brevoApiKey()
  if (!apiKey) throw new Error('Brevo SMS not configured (set BREVO_API_KEY)')
  const r = await fetch(BREVO_SMS_URL, {
    method: 'POST',
    headers: { 'api-key': apiKey, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ sender: senderId(), recipient, content, type: 'transactional' }),
  })
  const body: any = await r.json().catch(() => ({}))
  if (!r.ok || body?.code) {
    throw new Error(`Brevo SMS send failed: ${body?.message || `${r.status} ${r.statusText}`}`)
  }
  return { ok: true, via: 'frequency' }
}

/**
 * Send a login OTP over Brevo SMS. We pass our own pre-generated `code` so the
 * storefront keeps owning verification.
 */
export async function sendSmsOtp(
  _supabase: SupabaseClient,
  args: { slug: string; phone: string; code: string },
): Promise<SmsResult> {
  const to = normRecipient(args.phone)
  if (!/^\d{10,15}$/.test(to)) throw new Error(`Invalid phone for SMS OTP: '${args.phone}'`)
  const code = String(args.code).trim()
  if (!/^\d{4,8}$/.test(code)) throw new Error('Invalid OTP code')
  return postSms(to, `${code} is your verification code. Do not share it with anyone.`)
}

/**
 * Send a transactional order-update SMS. `vars` carries the same fields the
 * storefront-api already builds ({ var1: order#, var2: status, var3: name }); we
 * render them into Brevo's free-text `content`. `templateId` is accepted for
 * signature compatibility and ignored (Brevo matches DLT templates server-side).
 */
export async function sendSmsOrderUpdate(
  _supabase: SupabaseClient,
  args: { slug: string; phone: string; vars: Record<string, string>; templateId?: string },
): Promise<SmsResult> {
  const to = normRecipient(args.phone)
  if (!/^\d{10,15}$/.test(to)) throw new Error(`Invalid phone for order SMS: '${args.phone}'`)
  const v = args.vars || {}
  const orderNo = v.var1 ? `#${v.var1}` : 'Your order'
  const status = v.var2 || 'updated'
  const who = v.var3 || 'your order'
  return postSms(to, `${orderNo} ${status} — ${who}.`)
}
