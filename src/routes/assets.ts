/**
 * Assets — tenant asset library (brand logos, images, video, any file).
 *
 * Upload flow: FE sends a multipart file → we stream it into the public
 * `assets` Storage bucket under `<tenant_id>/<uuid>-<name>` → mint the public
 * URL → insert an `assets` row { name, url, storage_path, type, ... } → return
 * it. The dashboard then references the URL anywhere (branding, mini-app, etc.).
 *
 * The service role does the upload (key never leaves the server); the bucket is
 * public-read so the returned URL works directly in the storefront/mini-app.
 */

import express from 'express'
import multer from 'multer'
import crypto from 'crypto'
import { SupabaseClient } from '@supabase/supabase-js'
import { apiError } from '../lib/api-error'

const BUCKET = 'assets'
const MAX_BYTES = 50 * 1024 * 1024   // 50 MB — matches the bucket's file_size_limit

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_BYTES, files: 1 } })

type Middleware = (req: express.Request, res: express.Response, next: express.NextFunction) => void | Promise<void>
interface Deps {
  supabase: SupabaseClient
  requireAuth: Middleware
  identifyTenant: Middleware
  checkPermission: (feature: string, action: 'view' | 'edit' | 'delete') => Middleware
}

/** Coarse asset type from mime, so the FE can pick the right preview. */
function typeFromMime(mime: string | undefined, override?: string): string {
  if (override && ['image', 'video', 'logo', 'audio', 'document', 'other'].includes(override)) return override
  const m = String(mime ?? '')
  if (m.startsWith('image/')) return 'image'
  if (m.startsWith('video/')) return 'video'
  if (m.startsWith('audio/')) return 'audio'
  if (m === 'application/pdf' || m.includes('word') || m.includes('sheet') || m.includes('presentation') || m.startsWith('text/')) return 'document'
  return 'other'
}

export function createAssetsRouter(deps: Deps): express.Router {
  const r = express.Router()
  const { supabase, requireAuth, identifyTenant, checkPermission } = deps

  // List the tenant's assets (optionally filtered by type).
  r.get('/api/assets', requireAuth, identifyTenant, checkPermission('settings', 'view'), async (req, res) => {
    try {
      let q = supabase.from('assets')
        .select('id, name, url, type, mime_type, size_bytes, storage_path, created_at')
        .eq('tenant_id', (req as any).tenantId)
        .order('created_at', { ascending: false })
        .limit(Math.min(Number(req.query.limit ?? 200), 500))
      if (req.query.type) q = q.eq('type', String(req.query.type))
      const { data, error } = await q
      if (error) { apiError(res, 500, 'list_failed', error.message); return }
      res.json(data ?? [])
    } catch (e: any) { apiError(res, 500, 'list_failed', e.message) }
  })

  // Upload a file → Storage → assets row. multipart field name: `file`.
  r.post('/api/assets',
    requireAuth, identifyTenant, checkPermission('settings', 'edit'),
    (req, res, next) => upload.single('file')(req, res, (err: any) => {
      if (err) { apiError(res, 400, 'upload_error', err.code === 'LIMIT_FILE_SIZE' ? 'File exceeds 50 MB limit' : err.message); return }
      next()
    }),
    async (req, res) => {
      try {
        const tenantId = (req as any).tenantId
        const userId = (req as any).user?.id as string | undefined
        const file = (req as any).file as { buffer: Buffer; originalname: string; mimetype: string; size: number } | undefined
        if (!file) { apiError(res, 400, 'no_file', 'No file uploaded (field name must be "file")'); return }

        const rawName = String((req.body?.name as string) || file.originalname || 'asset').slice(0, 200)
        const safe = (file.originalname || 'asset').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120)
        const path = `${tenantId}/${crypto.randomUUID()}-${safe}`
        const type = typeFromMime(file.mimetype, req.body?.type)

        const { error: upErr } = await supabase.storage.from(BUCKET).upload(path, file.buffer, {
          contentType: file.mimetype || 'application/octet-stream',
          upsert: false,
        })
        if (upErr) { apiError(res, 500, 'storage_upload_failed', upErr.message); return }

        // Branded CDN URL (assets.getfrequency.app proxies to the Supabase
        // public object) — matches uploadFile()/uploadBrandImage() on the FE.
        const url = `https://assets.getfrequency.app/${BUCKET}/${path}`

        const { data: row, error: insErr } = await supabase.from('assets').insert({
          tenant_id: tenantId, name: rawName, url, storage_path: path,
          type, mime_type: file.mimetype, size_bytes: file.size, created_by: userId ?? null,
        }).select('id, name, url, type, mime_type, size_bytes, storage_path, created_at').single()
        if (insErr) {
          // Roll back the orphaned object if the row insert failed.
          await supabase.storage.from(BUCKET).remove([path]).catch(() => {})
          apiError(res, 500, 'insert_failed', insErr.message); return
        }
        res.status(201).json(row)
      } catch (e: any) { apiError(res, 500, 'upload_failed', e.message) }
    })

  // Rename an asset (the display name only — the object/URL is immutable).
  r.patch('/api/assets/:id', requireAuth, identifyTenant, checkPermission('settings', 'edit'), async (req, res) => {
    try {
      const name = String((req.body?.name as string) ?? '').trim().slice(0, 200)
      if (!name) { apiError(res, 400, 'invalid_name', 'name required'); return }
      const { data, error } = await supabase.from('assets')
        .update({ name, updated_at: new Date().toISOString() })
        .eq('tenant_id', (req as any).tenantId).eq('id', String(req.params.id))
        .select('id, name, url, type').single()
      if (error) { apiError(res, 404, 'not_found', error.message); return }
      res.json(data)
    } catch (e: any) { apiError(res, 500, 'update_failed', e.message) }
  })

  // Delete: remove the stored object then the row.
  r.delete('/api/assets/:id', requireAuth, identifyTenant, checkPermission('settings', 'delete'), async (req, res) => {
    try {
      const { data: row } = await supabase.from('assets')
        .select('storage_path').eq('tenant_id', (req as any).tenantId).eq('id', String(req.params.id)).maybeSingle()
      if (!row) { apiError(res, 404, 'not_found', 'Asset not found'); return }
      await supabase.storage.from(BUCKET).remove([(row as any).storage_path]).catch(() => {})
      const { error } = await supabase.from('assets').delete().eq('tenant_id', (req as any).tenantId).eq('id', String(req.params.id))
      if (error) { apiError(res, 500, 'delete_failed', error.message); return }
      res.json({ ok: true })
    } catch (e: any) { apiError(res, 500, 'delete_failed', e.message) }
  })

  return r
}
