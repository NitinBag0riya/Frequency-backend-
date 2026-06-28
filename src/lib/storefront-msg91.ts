/**
 * Storefront MSG91 SMS gateway — login OTP + transactional order messages.
 *
 * Key resolution (per the platform rule "tenant's own key first, Frequency's as
 * fallback"):
 *   1. the TENANT's own connected MSG91 Auth Key (tenant_integrations, key='msg91'), else
 *   2. Frequency's platform Auth Key (env MSG91_AUTH_KEY).
 *
 * INDIA / DLT: every transactional + OTP SMS must reference a DLT-approved
 * `template_id` (TRAI mandate). Template IDs are env-configurable platform-wide
 * (MSG91_OTP_TEMPLATE_ID / MSG91_ORDER_TEMPLATE_ID) with an optional per-tenant
 * override stored in the connector's metadata (otp_template_id / order_template_id)
 * for tenants sending on their own DLT registration. Without a template_id the send
 * throws and the caller falls back to its next channel (WhatsApp / on-screen).
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { decrypt } from '../crypto.js'

const MSG91_BASE = 'https://control.msg91.com'

interface Resolved { authKey: string; via: 'tenant' | 'frequency'; meta: Record<string, any> }

/** Tenant's own MSG91 key (decrypted) → else the platform key from env. */
async function resolveKey(supabase: SupabaseClient, slug: string): Promise<Resolved | null> {
  const { data: t } = await supabase.from('tenants').select('id').eq('slug', slug).maybeSingle()
  const tenantId = (t as any)?.id
  if (tenantId) {
    const { data: row } = await supabase.from('tenant_integrations')
      .select('access_token, metadata, status').eq('tenant_id', tenantId).eq('key', 'msg91').maybeSingle()
    if (row?.access_token && (row as any).status !== 'disconnected') {
      try { return { authKey: decrypt(row.access_token), via: 'tenant', meta: (row as any).metadata || {} } }
      catch { /* corrupt cipher — fall through to platform key */ }
    }
  }
  if (process.env.MSG91_AUTH_KEY) return { authKey: process.env.MSG91_AUTH_KEY, via: 'frequency', meta: {} }
  return null
}

const normMobile = (phone: string) => String(phone).replace(/^\+/, '').replace(/\D/g, '').trim()

export interface Msg91Result { ok: true; via: 'tenant' | 'frequency' }

/**
 * Send a login OTP over MSG91 SMS (we pass our own pre-generated `code` so the
 * storefront keeps owning verification). Uses MSG91 v5 OTP API.
 */
export async function sendMsg91Otp(
  supabase: SupabaseClient,
  args: { slug: string; phone: string; code: string },
): Promise<Msg91Result> {
  const to = normMobile(args.phone)
  if (!/^\d{10,15}$/.test(to)) throw new Error(`Invalid phone for MSG91 OTP: '${args.phone}'`)
  const code = String(args.code).trim()
  if (!/^\d{4,8}$/.test(code)) throw new Error('Invalid OTP code')

  const k = await resolveKey(supabase, args.slug)
  if (!k) throw new Error('MSG91 not configured (no tenant key and no platform MSG91_AUTH_KEY)')
  const templateId = k.meta.otp_template_id || process.env.MSG91_OTP_TEMPLATE_ID
  if (!templateId) throw new Error('MSG91 OTP template_id not set (a DLT-approved template is required)')

  const qs = new URLSearchParams({ template_id: String(templateId), mobile: to, otp: code })
  const r = await fetch(`${MSG91_BASE}/api/v5/otp?${qs.toString()}`, {
    method: 'POST',
    headers: { authkey: k.authKey, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({}),
  })
  const body: any = await r.json().catch(() => ({}))
  if (!r.ok || body?.type === 'error') {
    throw new Error(`MSG91 OTP send failed (${k.via}): ${body?.message || `${r.status} ${r.statusText}`}`)
  }
  return { ok: true, via: k.via }
}

/**
 * Send a transactional order-update SMS over MSG91's flow/template API. `vars`
 * maps template variables (e.g. { var1: 'ORD-1234', var2: 'Shipped' }) — the
 * exact names must match the DLT template's variables.
 */
export async function sendMsg91Sms(
  supabase: SupabaseClient,
  args: { slug: string; phone: string; vars: Record<string, string>; templateId?: string },
): Promise<Msg91Result> {
  const to = normMobile(args.phone)
  if (!/^\d{10,15}$/.test(to)) throw new Error(`Invalid phone for MSG91 SMS: '${args.phone}'`)

  const k = await resolveKey(supabase, args.slug)
  if (!k) throw new Error('MSG91 not configured (no tenant key and no platform MSG91_AUTH_KEY)')
  const templateId = args.templateId || k.meta.order_template_id || process.env.MSG91_ORDER_TEMPLATE_ID
  if (!templateId) throw new Error('MSG91 order template_id not set (a DLT-approved template is required)')

  const r = await fetch(`${MSG91_BASE}/api/v5/flow/`, {
    method: 'POST',
    headers: { authkey: k.authKey, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ template_id: String(templateId), short_url: 0, recipients: [{ mobiles: to, ...args.vars }] }),
  })
  const body: any = await r.json().catch(() => ({}))
  if (!r.ok || body?.type === 'error') {
    throw new Error(`MSG91 SMS send failed (${k.via}): ${body?.message || `${r.status} ${r.statusText}`}`)
  }
  return { ok: true, via: k.via }
}

/** True when SOME MSG91 key is resolvable for this slug (tenant or platform). Lets
 *  callers cheaply decide whether to even attempt the SMS channel. */
export async function msg91Available(supabase: SupabaseClient, slug: string): Promise<boolean> {
  return !!(await resolveKey(supabase, slug))
}
