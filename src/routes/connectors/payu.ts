/**
 * PayU connector — merchant key + salt (India payment gateway).
 *
 * PayU (PayU Money / PayU Biz) is a top Indian payment gateway. Integration is
 * hash-based: there's no bearer token. The merchant copies their Merchant Key +
 * Salt from the PayU dashboard (Settings → Merchant Key/Salt) and every request
 * is signed with sha512 over those values. Pure paste-key — works the moment a
 * merchant has key+salt (test keys are self-serve from the dashboard).
 *
 * Environments:
 *   production → checkout https://secure.payu.in/_payment ; info https://info.payu.in/merchant/postservice?form=2
 *   test       → checkout https://test.payu.in/_payment   ; info https://test.payu.in/merchant/postservice?form=2
 *
 * Verify: we issue a verify_payment command for a throwaway txnid with a hash
 * computed from key+salt. PayU re-validates that hash server-side, so a correct
 * key+salt returns status:1 (the txn simply isn't found) while a wrong salt
 * fails the hash check. This proves the SALT without moving any money.
 *
 * Capabilities:
 *   generate_payment_hash  (local) build the request hash + checkout fields/URL
 *   verify_payment         POST postservice  command=verify_payment
 *   refund_payment         POST postservice  command=cancel_refund_transaction
 */

import express from 'express'
import { z } from 'zod'
import crypto from 'crypto'
import { SupabaseClient } from '@supabase/supabase-js'
import { encrypt, decrypt } from '../../crypto'
import { validateBody } from '../../validation'

type Middleware = (req: express.Request, res: express.Response, next: express.NextFunction) => void | Promise<void>
interface Deps {
  supabase: SupabaseClient
  requireAuth: Middleware
  identifyTenant: Middleware
  checkPermission: (feature: string, action: 'view' | 'edit' | 'delete') => Middleware
}

const PAYU = {
  production: { pay: 'https://secure.payu.in/_payment', info: 'https://info.payu.in/merchant/postservice?form=2' },
  test:       { pay: 'https://test.payu.in/_payment',   info: 'https://test.payu.in/merchant/postservice?form=2' },
} as const

function sha512(s: string): string {
  return crypto.createHash('sha512').update(s).digest('hex')
}

const TokenSchema = z.object({
  merchant_key: z.string().min(2, 'Merchant Key is required'),
  salt:         z.string().min(8, 'Salt is required (32-char string from the PayU dashboard)'),
  environment:  z.enum(['production', 'test']).default('production'),
})

const PaymentHashSchema = z.object({
  txnid:       z.string().min(1, 'txnid is required (your unique transaction id)'),
  amount:      z.union([z.string(), z.number()]).transform(String),
  productinfo: z.string().min(1, 'productinfo is required'),
  firstname:   z.string().min(1, 'firstname is required'),
  email:       z.string().email('a valid email is required'),
  phone:       z.string().optional(),
  surl:        z.string().optional(),
  furl:        z.string().optional(),
  udf1: z.string().optional(), udf2: z.string().optional(), udf3: z.string().optional(),
  udf4: z.string().optional(), udf5: z.string().optional(),
}).passthrough()

const VerifySchema = z.object({
  txnid: z.string().min(1, 'txnid is required'),
}).passthrough()

const RefundSchema = z.object({
  mihpayid:      z.string().min(1, 'mihpayid (PayU payment id) is required'),
  refund_amount: z.union([z.string(), z.number()]).transform(String),
  token:         z.string().min(1, 'token is required (your unique refund reference)'),
}).passthrough()

/** Build the canonical PayU request hash: key|txnid|amount|productinfo|firstname|email|udf1..udf5||||||salt */
function paymentHash(key: string, salt: string, p: any): string {
  const u = (k: string) => (p[k] ?? '')
  const seq = `${key}|${p.txnid}|${p.amount}|${p.productinfo}|${p.firstname}|${p.email}|${u('udf1')}|${u('udf2')}|${u('udf3')}|${u('udf4')}|${u('udf5')}||||||${salt}`
  return sha512(seq)
}

/** Command hash for postservice calls: sha512(key|command|var1|salt) */
function commandHash(key: string, salt: string, command: string, var1: string): string {
  return sha512(`${key}|${command}|${var1}|${salt}`)
}

export function createPayuConnector(deps: Deps): express.Router {
  const r = express.Router()
  const { supabase, requireAuth, identifyTenant, checkPermission } = deps

  // ── Paste-key connect (hash-verify the salt, then persist) ────────────────
  r.post('/api/connectors/payu/connect-key',
    requireAuth, identifyTenant, checkPermission('integrations', 'edit'),
    validateBody(TokenSchema),
    async (req, res) => {
      const tenantId = (req as any).tenantId
      const userId = (req as any).user?.id as string | undefined
      if (!userId) { res.status(401).json({ error: 'auth missing user.id' }); return }

      const { merchant_key, salt, environment } = req.body as z.infer<typeof TokenSchema>
      const info = PAYU[environment].info
      const probeTxn = `cfverify${Date.now()}`
      const hash = commandHash(merchant_key, salt, 'verify_payment', probeTxn)
      const form = new URLSearchParams({ key: merchant_key, command: 'verify_payment', var1: probeTxn, hash })

      let body: any = {}
      try {
        const v = await fetch(info, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' }, body: form.toString() })
        body = await v.json().catch(() => ({}))
      } catch (e: any) {
        res.status(400).json({ error: `Could not reach PayU (${e?.message ?? 'network error'})` })
        return
      }
      // status:1 = request authenticated (hash matched) even though the probe
      // txn isn't found. A wrong salt fails the server-side hash check.
      const ok = String(body?.status) === '1'
      if (!ok) {
        res.status(400).json({ error: `PayU rejected these credentials — check the Merchant Key + Salt match the "${environment}" environment. ${body?.msg ? '(' + String(body.msg).slice(0, 120) + ')' : ''}` })
        return
      }

      const { error: upsertErr } = await supabase.from('tenant_integrations').upsert({
        tenant_id:    tenantId,
        user_id:      userId,
        key:          'payu',
        status:       'active',
        access_token: encrypt(salt),
        scope:        'payments',
        brand_label:  `PayU (${environment})`,
        metadata:     { auth_mode: 'hash', merchant_key, environment },
      }, { onConflict: 'tenant_id,key' })
      if (upsertErr) {
        console.error(`[payu connect] DB upsert failed: ${upsertErr.message}`)
        res.status(500).json({ error: 'Failed to persist connection: ' + upsertErr.message }); return
      }
      res.json({ success: true, environment })
    })

  // ── Capabilities ──────────────────────────────────────────────────────────
  const guardEdit = [requireAuth, identifyTenant, checkPermission('integrations', 'edit')]

  // Local: produce a signed hash + the exact fields/URL to launch checkout.
  r.post('/api/connectors/payu/payment-hash', ...guardEdit,
    validateBody(PaymentHashSchema),
    async (req, res) => {
      try {
        const { key, salt, payUrl } = await loadCreds(supabase, (req as any).tenantId)
        const p = req.body as z.infer<typeof PaymentHashSchema>
        const hash = paymentHash(key, salt, p)
        const fields: Record<string, string> = {
          key, txnid: p.txnid, amount: p.amount, productinfo: p.productinfo,
          firstname: p.firstname, email: p.email, hash,
        }
        if (p.phone) fields.phone = p.phone
        if (p.surl)  fields.surl  = p.surl
        if (p.furl)  fields.furl  = p.furl
        for (const k of ['udf1', 'udf2', 'udf3', 'udf4', 'udf5'] as const) if (p[k]) fields[k] = p[k] as string
        res.json({ hash, action: payUrl, fields })
      } catch (err: any) { res.status(500).json({ error: err.message }) }
    })

  r.post('/api/connectors/payu/verify', ...guardEdit,
    validateBody(VerifySchema),
    async (req, res) => {
      try {
        const { key, salt, infoUrl } = await loadCreds(supabase, (req as any).tenantId)
        const { txnid } = req.body as z.infer<typeof VerifySchema>
        const form = new URLSearchParams({ key, command: 'verify_payment', var1: txnid, hash: commandHash(key, salt, 'verify_payment', txnid) })
        const r2 = await fetch(infoUrl, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' }, body: form.toString() })
        const out = await r2.json().catch(() => ({})) as any
        if (String(out?.status) !== '1') { res.status(400).json({ error: out?.msg ? String(out.msg) : `PayU verify failed (${r2.status})` }); return }
        res.json(out)
      } catch (err: any) { res.status(500).json({ error: err.message }) }
    })

  r.post('/api/connectors/payu/refund', ...guardEdit,
    validateBody(RefundSchema),
    async (req, res) => {
      try {
        const { key, salt, infoUrl } = await loadCreds(supabase, (req as any).tenantId)
        const { mihpayid, refund_amount, token } = req.body as z.infer<typeof RefundSchema>
        const command = 'cancel_refund_transaction'
        // PayU command hash is over var1 (here the mihpayid).
        const form = new URLSearchParams({ key, command, var1: mihpayid, var2: token, var3: refund_amount, hash: commandHash(key, salt, command, mihpayid) })
        const r2 = await fetch(infoUrl, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' }, body: form.toString() })
        const out = await r2.json().catch(() => ({})) as any
        if (String(out?.status) !== '1') { res.status(400).json({ error: out?.msg ? String(out.msg) : `PayU refund failed (${r2.status})` }); return }
        res.json(out)
      } catch (err: any) { res.status(500).json({ error: err.message }) }
    })

  return r
}

/**
 * Exported so engine/connector-ops.ts can call PayU from workflow nodes.
 * Returns the merchant key, decrypted salt, and the environment URLs.
 */
export async function loadCreds(
  supabase: SupabaseClient, tenantId: string,
): Promise<{ key: string; salt: string; payUrl: string; infoUrl: string; environment: 'production' | 'test' }> {
  const { data: row } = await supabase.from('tenant_integrations')
    .select('access_token, metadata')
    .eq('tenant_id', tenantId).eq('key', 'payu').maybeSingle()
  if (!row?.access_token) throw new Error('PayU not connected')
  const md = (row.metadata as any) ?? {}
  if (!md.merchant_key) throw new Error('PayU connection missing merchant key — please reconnect')
  const environment: 'production' | 'test' = md.environment === 'test' ? 'test' : 'production'
  return { key: String(md.merchant_key), salt: decrypt(row.access_token), payUrl: PAYU[environment].pay, infoUrl: PAYU[environment].info, environment }
}

// Exposed for engine ops that need to recompute the canonical hashes.
export { paymentHash, commandHash }
