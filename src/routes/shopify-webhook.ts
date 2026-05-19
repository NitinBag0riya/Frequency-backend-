/**
 * Shopify webhook receiver (P1 #11).
 *
 *   POST /api/webhooks/shopify
 *     Public. Dispatches on the X-Shopify-Topic header. HMAC-verified
 *     against the per-store webhook_secret (set during OAuth install) OR
 *     the global SHOPIFY_API_SECRET (Shopify uses this for events delivered
 *     during a re-install handshake). Unverified payloads are dropped.
 *
 *   Topics handled:
 *     orders/create        → insert shopify_order_events + fire
 *                            `shopify_order_created` + (if COD) `shopify_cod_order`
 *     orders/paid          → insert + fire `shopify_order_paid`
 *     orders/cancelled     → insert + fire `shopify_order_cancelled`
 *     orders/fulfilled     → insert + fire `shopify_order_fulfilled`
 *     checkouts/create     → upsert shopify_abandoned_checkouts
 *     checkouts/update     → upsert (refresh abandoned_at)
 *     app/uninstalled      → stamp shopify_stores.uninstalled_at (NO row delete)
 *
 * Hardening:
 *   - HMAC verification is the FIRST thing we do. No DB read before verify
 *     except the lookup of the per-store webhook_secret.
 *   - We ALWAYS return 200 after parsing (per Shopify retry semantics — a
 *     non-200 triggers exponential retries and we don't want to silently
 *     reprocess the same event 19 times).
 *   - Inserts to shopify_order_events use the unique (store_id, order_id,
 *     topic) constraint to dedupe Shopify's at-least-once delivery.
 *   - Workflow triggers fire AFTER the insert, fire-and-forget, swallowing
 *     errors so a workflow bug never causes the webhook to 5xx.
 *
 * Wire shape:
 *   Shopify sends application/json; we mount express.json with a raw-body
 *   capture in src/index.ts so we can re-HMAC the EXACT bytes the sender
 *   signed (a re-serialised JSON.stringify would have different whitespace
 *   and break verification). The raw bytes live in `req.rawBody`.
 */

import express from 'express'
import crypto from 'crypto'
import { SupabaseClient } from '@supabase/supabase-js'
import { decrypt } from '../crypto'
import { fireShopifyTrigger } from '../engine/shopify-triggers'

interface Deps {
  supabase: SupabaseClient
}

/**
 * Convert Shopify's string price ("1499.00") → integer paise (149900). Lossy
 * past two decimal places, which is fine — INR has paise as the smallest unit.
 * Returns null for unparseable / missing input.
 */
function priceToInrPaise(raw: any): number | null {
  if (raw == null) return null
  const n = Number(String(raw).replace(/[, ]/g, ''))
  if (!Number.isFinite(n)) return null
  return Math.round(n * 100)
}

/** Best-effort COD detection — Shopify's payment_gateway_names and
 *  payment_details fields don't have a single canonical "is COD" flag. */
function looksLikeCOD(payload: any): boolean {
  const gateways = (payload?.payment_gateway_names ?? []) as string[]
  if (gateways.some(g => /cash[_ ]?on[_ ]?delivery|\bcod\b/i.test(String(g)))) return true
  const paymentDetails = payload?.payment_details ?? {}
  if (/cash[_ ]?on[_ ]?delivery|\bcod\b/i.test(JSON.stringify(paymentDetails))) return true
  if (String(payload?.financial_status ?? '').toLowerCase() === 'pending'
      && String(payload?.gateway ?? '').toLowerCase().includes('cod')) return true
  return false
}

function digitsOnly(phone: string | null | undefined): string | null {
  if (!phone) return null
  const d = String(phone).replace(/[^\d]/g, '')
  return d || null
}

function timingSafeStrEq(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  try {
    return crypto.timingSafeEqual(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'))
  } catch {
    return false
  }
}

/** Shopify HMAC: base64( HMAC-SHA256(rawBody, secret) ) compared to header. */
function verifyWebhookHmac(rawBody: Buffer | string, secret: string, providedHeader: string): boolean {
  if (!providedHeader) return false
  const buf = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody), 'utf8')
  const computed = crypto.createHmac('sha256', secret).update(buf).digest('base64')
  return timingSafeStrEq(computed, providedHeader)
}

export function createShopifyWebhookRouter(deps: Deps): express.Router {
  const r = express.Router()
  const { supabase } = deps

  r.post('/api/webhooks/shopify', async (req, res) => {
    // ── 1. Capture raw bytes (mounted with raw parser in index.ts) ─────────
    const rawBody: Buffer = (req as any).rawBody
      ?? (Buffer.isBuffer(req.body) ? req.body : Buffer.from(typeof req.body === 'string' ? req.body : JSON.stringify(req.body ?? {})))

    const topic  = String(req.header('x-shopify-topic') ?? '')
    const shop   = String(req.header('x-shopify-shop-domain') ?? '').toLowerCase()
    const hmac   = String(req.header('x-shopify-hmac-sha256') ?? '')

    if (!topic || !shop || !hmac) {
      // Shopify always sends these. If they're missing it's not Shopify.
      res.status(401).json({ error: 'missing shopify headers' })
      return
    }

    // ── 2. Find the store row to get its webhook_secret ───────────────────
    const { data: store, error: storeErr } = await supabase.from('shopify_stores')
      .select('id, tenant_id, webhook_secret')
      .eq('shop_domain', shop)
      .is('uninstalled_at', null)
      .maybeSingle()

    let verified = false
    if (store?.webhook_secret) {
      verified = verifyWebhookHmac(rawBody, store.webhook_secret, hmac)
    }
    // Fallback: during install + uninstall handshakes Shopify sometimes signs
    // with the app's shared secret. We accept that ONLY for app/uninstalled
    // (so an attacker can't forge orders/* events using the app secret).
    if (!verified && topic === 'app/uninstalled' && process.env.SHOPIFY_API_SECRET) {
      verified = verifyWebhookHmac(rawBody, process.env.SHOPIFY_API_SECRET, hmac)
    }
    if (!verified) {
      console.warn(`[shopify-webhook] HMAC verify FAILED topic=${topic} shop=${shop}`)
      // Return 401 (Shopify still considers the webhook delivered; the
      // 401 is for our own ops/auditing — Shopify retries on 5xx only).
      res.status(401).json({ error: 'invalid signature' })
      return
    }

    // ── 3. Parse JSON body ─────────────────────────────────────────────────
    let payload: any
    try {
      payload = JSON.parse(rawBody.toString('utf8') || '{}')
    } catch {
      // Verified bytes that don't parse as JSON — log + 200 to stop retries.
      console.warn(`[shopify-webhook] verified but JSON parse failed topic=${topic} shop=${shop}`)
      res.status(200).json({ ok: true })
      return
    }

    // Always 200 from here on (Shopify retry semantics).
    res.status(200).json({ ok: true })

    // ── 4. Dispatch by topic (best-effort, no throw escapes) ───────────────
    try {
      if (topic === 'app/uninstalled') {
        if (store?.id) {
          await supabase.from('shopify_stores')
            .update({ uninstalled_at: new Date().toISOString(), updated_at: new Date().toISOString() })
            .eq('id', store.id)
        }
        return
      }

      if (!store) {
        // We verified with… nothing? Should not happen given the check
        // above, but guard.
        console.warn(`[shopify-webhook] verified but no store row topic=${topic} shop=${shop}`)
        return
      }

      if (topic === 'checkouts/create' || topic === 'checkouts/update') {
        await handleCheckout(supabase, store, payload)
        return
      }

      if (topic.startsWith('orders/')) {
        await handleOrder(supabase, store, topic, payload)
        return
      }
    } catch (err: any) {
      console.warn(`[shopify-webhook] dispatch error topic=${topic} shop=${shop}: ${err?.message ?? err}`)
    }
  })

  return r
}

// ─── handlers ────────────────────────────────────────────────────────────────

async function handleOrder(
  supabase: SupabaseClient,
  store: { id: string; tenant_id: string },
  topic: string,
  payload: any,
): Promise<void> {
  const shopifyOrderId   = String(payload?.id ?? '')
  if (!shopifyOrderId) return
  const customer         = payload?.customer ?? {}
  const customerPhone    = digitsOnly(payload?.phone ?? customer?.phone ?? payload?.shipping_address?.phone ?? payload?.billing_address?.phone)
  const customerEmail    = String(payload?.email ?? customer?.email ?? '').toLowerCase() || null

  const eventRow = {
    tenant_id:            store.tenant_id,
    store_id:             store.id,
    shopify_order_id:     shopifyOrderId,
    shopify_order_number: payload?.name ?? null,
    topic,
    customer_email:       customerEmail,
    customer_phone:       customerPhone,
    customer_first_name:  customer?.first_name ?? payload?.shipping_address?.first_name ?? null,
    customer_last_name:   customer?.last_name  ?? payload?.shipping_address?.last_name  ?? null,
    total_inr_paise:      priceToInrPaise(payload?.total_price ?? payload?.current_total_price),
    currency:             payload?.currency ?? null,
    financial_status:     payload?.financial_status ?? null,
    fulfillment_status:   payload?.fulfillment_status ?? null,
    payment_method:       Array.isArray(payload?.payment_gateway_names) ? payload.payment_gateway_names.join(',') : null,
    raw_payload:          payload,
    received_at:          new Date().toISOString(),
  }

  // Idempotent insert. unique(store_id, shopify_order_id, topic) → dupe = 23505.
  const { data: inserted, error: insErr } = await supabase
    .from('shopify_order_events')
    .insert(eventRow)
    .select('id, customer_phone')
    .single()

  if (insErr) {
    // 23505 = unique violation = Shopify retry of an event we already have.
    // Anything else: log but don't propagate.
    if (!String(insErr.code ?? '').includes('23505')) {
      console.warn(`[shopify-webhook] order insert failed topic=${topic}: ${insErr.message}`)
    }
    return
  }

  // Try to attach to an existing contact (best-effort; failure non-fatal).
  let matchedContactId: string | null = null
  if (customerPhone) {
    const { data: contact } = await supabase.from('contacts')
      .select('id').eq('tenant_id', store.tenant_id).eq('phone', customerPhone).maybeSingle()
    if (contact?.id) {
      matchedContactId = contact.id
      await supabase.from('shopify_order_events').update({ matched_contact_id: contact.id }).eq('id', inserted!.id)
    }
  }

  // If this order matches an abandoned-checkout row by phone or email, stamp
  // its recovered_at so the poller stops nudging.
  if (topic === 'orders/create' || topic === 'orders/paid') {
    if (customerPhone || customerEmail) {
      const q = supabase.from('shopify_abandoned_checkouts')
        .update({ recovered_at: new Date().toISOString() })
        .eq('store_id', store.id)
        .is('recovered_at', null)
      if (customerPhone)      q.eq('customer_phone', customerPhone)
      else if (customerEmail) q.eq('customer_email', customerEmail)
      await q
    }
  }

  // Fire workflow triggers (fire-and-forget; never let a workflow bug 5xx us).
  const triggerType = ({
    'orders/create':    'shopify_order_created',
    'orders/paid':      'shopify_order_paid',
    'orders/cancelled': 'shopify_order_cancelled',
    'orders/fulfilled': 'shopify_order_fulfilled',
  } as const)[topic as 'orders/create' | 'orders/paid' | 'orders/cancelled' | 'orders/fulfilled']

  if (triggerType) {
    try {
      await fireShopifyTrigger(supabase, store.tenant_id, triggerType, {
        contactId: matchedContactId ?? customerPhone ?? customerEmail ?? `shopify:${shopifyOrderId}`,
        contactPhone: customerPhone,
        contactEmail: customerEmail,
        order_id:     shopifyOrderId,
        order_number: payload?.name ?? null,
        total_inr_paise: eventRow.total_inr_paise,
        currency:        eventRow.currency,
        financial_status: eventRow.financial_status,
        fulfillment_status: eventRow.fulfillment_status,
        raw:            payload,
      })
    } catch (err: any) {
      console.warn(`[shopify-webhook] trigger ${triggerType} failed: ${err?.message}`)
    }
  }

  // Bonus COD trigger — fires alongside orders/create when payment is COD.
  if (topic === 'orders/create' && looksLikeCOD(payload)) {
    try {
      await fireShopifyTrigger(supabase, store.tenant_id, 'shopify_cod_order', {
        contactId: matchedContactId ?? customerPhone ?? customerEmail ?? `shopify:${shopifyOrderId}`,
        contactPhone: customerPhone,
        contactEmail: customerEmail,
        order_id:     shopifyOrderId,
        order_number: payload?.name ?? null,
        total_inr_paise: eventRow.total_inr_paise,
        currency:        eventRow.currency,
        raw:            payload,
      })
    } catch (err: any) {
      console.warn(`[shopify-webhook] trigger shopify_cod_order failed: ${err?.message}`)
    }
  }
}

async function handleCheckout(
  supabase: SupabaseClient,
  store: { id: string; tenant_id: string },
  payload: any,
): Promise<void> {
  const checkoutId   = String(payload?.id ?? payload?.token ?? '')
  if (!checkoutId) return
  const customerPhone = digitsOnly(payload?.phone ?? payload?.shipping_address?.phone ?? payload?.billing_address?.phone)
  const customerEmail = String(payload?.email ?? '').toLowerCase() || null
  // Shopify's `abandoned_checkout_url` is the canonical recovery URL; fall
  // back to `web_url` for older payloads.
  const checkoutUrl   = String(payload?.abandoned_checkout_url ?? payload?.web_url ?? payload?.checkout_url ?? '')
  if (!checkoutUrl) return

  await supabase.from('shopify_abandoned_checkouts').upsert({
    tenant_id:           store.tenant_id,
    store_id:            store.id,
    shopify_checkout_id: checkoutId,
    checkout_url:        checkoutUrl,
    customer_phone:      customerPhone,
    customer_email:      customerEmail,
    customer_first_name: payload?.shipping_address?.first_name ?? payload?.billing_address?.first_name ?? null,
    total_inr_paise:     priceToInrPaise(payload?.total_price),
    abandoned_at:        payload?.updated_at ?? payload?.created_at ?? new Date().toISOString(),
    raw_payload:         payload,
  }, { onConflict: 'store_id,shopify_checkout_id' })
}
