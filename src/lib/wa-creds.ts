/**
 * The single seam between "our WhatsApp" and "the merchant's WhatsApp".
 *
 * Two modes live behind one resolver:
 *
 *   platform — the tenant was onboarded through OUR Meta app via Embedded
 *              Signup (the Tech Provider model). They own the WABA and the
 *              number; we own the app, so inbound webhooks are signed with
 *              META_APP_SECRET and arrive on the shared /webhook/whatsapp.
 *
 *   byo      — the merchant already had their own Meta app. We store their
 *              app id + secret (encrypted) and they point that app's webhook
 *              at /webhook/whatsapp/:wa_webhook_token, so inbound signatures
 *              verify against THEIR secret.
 *
 * Outbound is identical in both modes — it has always used the per-tenant
 * access_token + phone_number_id — which is why adding BYO touches inbound
 * and credential storage only.
 *
 * Every caller that needs WhatsApp credentials should go through
 * resolveWaCreds() rather than reading tenants.* directly, so the platform/BYO
 * decision stays in exactly one place.
 */

import crypto from 'crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import { encryptSecret, decryptSecret } from './app-secrets'

const GRAPH = 'https://graph.facebook.com/v18.0'

export type WaMode = 'platform' | 'byo'

export interface WaCreds {
  tenantId: string
  mode: WaMode
  appId: string
  /** Verifies inbound webhook HMAC. Platform mode → env; BYO → decrypted. */
  appSecret: string
  wabaId: string | null
  phoneNumberId: string | null
  /** Decrypted long-lived token used as the Bearer on every Graph call. */
  accessToken: string | null
  webhookToken: string | null
}

/**
 * Tokens written before the at-rest encryption change are bare Meta strings;
 * encrypted ones are `iv:tag:ciphertext` base64 triples. A Meta access token
 * is URL-safe base64ish and never contains ':', so the shape is an unambiguous
 * discriminator and we can migrate lazily instead of running a backfill that
 * would have to touch every live tenant at once.
 */
const ENCRYPTED_RE = /^[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$/

export function readSecretValue(stored: string | null | undefined): string | null {
  if (!stored) return null
  if (!ENCRYPTED_RE.test(stored)) return stored // legacy plaintext row
  try {
    return decryptSecret(stored)
  } catch {
    // Wrong/rotated APP_CRED_KEY. Returning null makes the caller fail closed
    // with "not connected" rather than firing Graph calls with garbage.
    console.error('[wa-creds] decrypt failed — APP_CRED_KEY rotated without re-encrypt?')
    return null
  }
}

export const writeSecretValue = encryptSecret

/** Path segment for a BYO tenant's private inbound webhook URL. */
export function newWebhookToken(): string {
  return crypto.randomBytes(24).toString('base64url')
}

/**
 * Resolve the credentials for one tenant. `tenant` may be passed in when the
 * caller already has the row (webhook path) to avoid a second query.
 */
export async function resolveWaCreds(
  supabase: SupabaseClient,
  tenantId: string,
  tenant?: any,
): Promise<WaCreds | null> {
  let row = tenant
  if (!row) {
    const { data } = await supabase
      .from('tenants')
      .select('id, wa_mode, wa_app_id, wa_app_secret_enc, wa_webhook_token, waba_id, phone_number_id, access_token')
      .eq('id', tenantId)
      .maybeSingle()
    row = data
  }
  if (!row) return null

  const mode: WaMode = row.wa_mode === 'byo' ? 'byo' : 'platform'
  const appSecret = mode === 'byo'
    ? readSecretValue(row.wa_app_secret_enc)
    : (process.env.META_APP_SECRET || '')

  // A BYO tenant whose secret won't decrypt has no usable identity — treat it
  // as unresolved so inbound rejects and outbound reports "not connected",
  // instead of silently falling back to the platform app (which would verify
  // the wrong signature and leak our secret's trust boundary across tenants).
  if (!appSecret) return null

  return {
    tenantId: row.id,
    mode,
    appId: mode === 'byo' ? (row.wa_app_id || '') : (process.env.META_APP_ID || ''),
    appSecret,
    wabaId: row.waba_id ?? null,
    phoneNumberId: row.phone_number_id ?? null,
    accessToken: readSecretValue(row.access_token),
    webhookToken: row.wa_webhook_token ?? null,
  }
}

export interface WaCapability {
  ok: boolean
  error?: string
  wabaName?: string
  /** Meta's review state for the WABA itself. */
  accountReviewStatus?: string
  businessVerificationStatus?: string
  /** Per-number send quota tier, e.g. TIER_1K. The practical "plan". */
  messagingTier?: string
  qualityRating?: string
  displayPhone?: string
  verifiedName?: string
  numbers?: number
  checkedAt: string
}

/**
 * Ask Meta what this WABA can actually do. This is what makes mode selection
 * automatic instead of a toggle the merchant has to understand: if their own
 * WABA answers with a real tier and passes review, we use theirs; if the probe
 * fails, they belong on the platform app.
 *
 * Never throws — a probe failure is a finding, not an exception.
 */
export async function probeWabaCapability(wabaId: string, accessToken: string): Promise<WaCapability> {
  const checkedAt = new Date().toISOString()
  try {
    const [wabaRes, phoneRes] = await Promise.all([
      fetch(
        `${GRAPH}/${wabaId}?fields=name,account_review_status,business_verification_status`,
        { headers: { Authorization: `Bearer ${accessToken}` } },
      ),
      fetch(
        `${GRAPH}/${wabaId}/phone_numbers?fields=display_phone_number,verified_name,quality_rating,messaging_limit_tier`,
        { headers: { Authorization: `Bearer ${accessToken}` } },
      ),
    ])

    const waba: any = await wabaRes.json().catch(() => ({}))
    const phones: any = await phoneRes.json().catch(() => ({}))

    if (waba?.error) {
      return { ok: false, error: waba.error.message ?? 'WABA lookup failed', checkedAt }
    }

    const first = phones?.data?.[0]
    return {
      ok: true,
      wabaName: waba.name,
      accountReviewStatus: waba.account_review_status,
      businessVerificationStatus: waba.business_verification_status,
      messagingTier: first?.messaging_limit_tier,
      qualityRating: first?.quality_rating,
      displayPhone: first?.display_phone_number,
      verifiedName: first?.verified_name,
      numbers: phones?.data?.length ?? 0,
      checkedAt,
    }
  } catch (e: any) {
    return { ok: false, error: e?.message ?? 'probe failed', checkedAt }
  }
}

/** Constant-time HMAC check for Meta's x-hub-signature-256. */
export function verifyMetaSignature(
  body: Buffer,
  header: string | undefined,
  secret: string,
): boolean {
  if (!header || !secret) return false
  const prefix = 'sha256='
  if (!header.startsWith(prefix)) return false
  const provided = header.slice(prefix.length)
  const expected = crypto.createHmac('sha256', secret).update(body).digest('hex')
  if (provided.length !== expected.length) return false
  try {
    return crypto.timingSafeEqual(Buffer.from(provided, 'utf8'), Buffer.from(expected, 'utf8'))
  } catch {
    return false
  }
}
