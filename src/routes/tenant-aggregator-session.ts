/**
 * Tenant-scoped aggregator session storage.
 *
 * POST /api/tenant-aggregator-session — merchant JWT (guardEdit); encrypts + upserts
 * GET  /api/tenant-aggregator-session — merchant JWT (guardView); decrypts + returns
 *
 * Encryption: AES-256-GCM with a symmetric key from AGGREGATOR_SESSION_KEY (32-byte
 * base64 in env). Ciphertext envelope: base64(JSON({iv, tag, ct})). Rotating the
 * env key bumps AGGREGATOR_SESSION_KEY_VERSION; old rows fail decrypt and force a
 * fresh upload from the merchant's current install.
 *
 * The snapshot BODY is the same JSON shape that Frequency Desktop's
 * sessionCookieSnapshot.ts writes to disk locally — {[partition]: Cookie[]}.
 * Restore path on the desktop is unchanged: same set() loop, whether the
 * snapshot came from local disk or from this endpoint.
 */
import express from 'express'
import crypto from 'crypto'
import type { SupabaseClient } from '@supabase/supabase-js'

type Mw = (req: express.Request, res: express.Response, next: express.NextFunction) => void | Promise<void>

interface Deps {
  supabase: SupabaseClient
  guardView: Mw[]
  guardEdit: Mw[]
}

const KEY_VERSION = Number(process.env.AGGREGATOR_SESSION_KEY_VERSION ?? 1)

function getKey(): Buffer {
  const b64 = process.env.AGGREGATOR_SESSION_KEY
  if (!b64) throw new Error('AGGREGATOR_SESSION_KEY not set')
  const key = Buffer.from(b64, 'base64')
  if (key.length !== 32) throw new Error(`AGGREGATOR_SESSION_KEY must be 32 bytes (got ${key.length})`)
  return key
}

/** AES-256-GCM encrypt: returns base64(JSON({iv, tag, ct})). */
export function encryptSnapshot(plain: unknown): string {
  const key = getKey()
  const iv = crypto.randomBytes(12)                                // GCM standard 96-bit IV
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv)
  const ct = Buffer.concat([cipher.update(JSON.stringify(plain), 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  const env = JSON.stringify({ iv: iv.toString('base64'), tag: tag.toString('base64'), ct: ct.toString('base64') })
  return Buffer.from(env, 'utf8').toString('base64')
}

/** Inverse — returns the original JSON value, or null on tamper/wrong key. */
export function decryptSnapshot(enc: string): unknown | null {
  try {
    const env = JSON.parse(Buffer.from(enc, 'base64').toString('utf8'))
    const iv = Buffer.from(env.iv, 'base64')
    const tag = Buffer.from(env.tag, 'base64')
    const ct = Buffer.from(env.ct, 'base64')
    const decipher = crypto.createDecipheriv('aes-256-gcm', getKey(), iv)
    decipher.setAuthTag(tag)
    const plain = Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8')
    return JSON.parse(plain)
  } catch { return null }
}

/** Count cookies per partition — non-sensitive metadata for the FE. */
function countPerPartition(snap: any): Record<string, number> {
  if (!snap || typeof snap !== 'object') return {}
  const out: Record<string, number> = {}
  for (const [k, v] of Object.entries(snap)) {
    out[String(k)] = Array.isArray(v) ? v.length : 0
  }
  return out
}

export function createTenantAggregatorSessionRouter(deps: Deps): express.Router {
  const { supabase, guardView, guardEdit } = deps
  const r = express.Router()
  r.use(express.json({ limit: '5mb' }))     // cookie snapshots can be ~50-500 KB

  // Upload / refresh the tenant's aggregator session snapshot.
  //   Body: { snapshot: {[partition]: Cookie[]} }
  r.post('/api/tenant-aggregator-session', ...guardEdit, async (req, res) => {
    try {
      const tenantId = (req as any).tenantId
      const snap = (req.body as any)?.snapshot
      if (!snap || typeof snap !== 'object') {
        res.status(400).json({ error: 'body needs { snapshot: {[partition]: Cookie[]} }' })
        return
      }
      const encrypted = encryptSnapshot(snap)
      const counts = countPerPartition(snap)
      const now = new Date().toISOString()
      const { error } = await supabase.from('tenant_aggregator_sessions')
        .upsert({
          tenant_id: tenantId,
          snapshot_encrypted: encrypted,
          key_version: KEY_VERSION,
          counts,
          last_snapshot_at: now,
          updated_at: now,
        }, { onConflict: 'tenant_id' })
      if (error) { res.status(500).json({ error: error.message }); return }
      const total = Object.values(counts).reduce((n, k) => n + k, 0)
      res.json({ ok: true, cookies_saved: total, partitions: Object.keys(counts).length, key_version: KEY_VERSION })
    } catch (err: any) { res.status(err?.status ?? 500).json({ error: err.message }) }
  })

  // Fetch the tenant's aggregator session snapshot (decrypted).
  //   Response: { snapshot, key_version, counts, last_snapshot_at } | { snapshot: null }
  r.get('/api/tenant-aggregator-session', ...guardView, async (req, res) => {
    try {
      const tenantId = (req as any).tenantId
      const { data, error } = await supabase.from('tenant_aggregator_sessions')
        .select('snapshot_encrypted, key_version, counts, last_snapshot_at')
        .eq('tenant_id', tenantId).maybeSingle()
      if (error) { res.status(500).json({ error: error.message }); return }
      if (!data) { res.json({ snapshot: null }); return }
      if ((data as any).key_version !== KEY_VERSION) {
        // Encrypted with a rotated key — reject and force the merchant's current
        // install to upload a fresh snapshot with the new key.
        res.json({ snapshot: null, reason: 'key_version_mismatch' })
        return
      }
      const decrypted = decryptSnapshot((data as any).snapshot_encrypted)
      if (decrypted === null) {
        res.json({ snapshot: null, reason: 'decrypt_failed' })
        return
      }
      res.json({
        snapshot: decrypted,
        key_version: (data as any).key_version,
        counts: (data as any).counts,
        last_snapshot_at: (data as any).last_snapshot_at,
      })
    } catch (err: any) { res.status(err?.status ?? 500).json({ error: err.message }) }
  })

  return r
}
