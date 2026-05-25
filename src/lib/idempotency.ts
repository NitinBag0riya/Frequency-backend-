/**
 * F4 — Idempotency-Key support for non-idempotent endpoints.
 *
 * Usage (in a route handler):
 *
 *   import { withIdempotency } from '../lib/idempotency'
 *
 *   app.post('/api/inbox/send', requireAuth, identifyTenant, async (req, res) => {
 *     await withIdempotency(req, res, 'POST /api/inbox/send', async () => {
 *       const result = await doTheActualSend(req)
 *       return { status: 200, body: result }
 *     })
 *   })
 *
 * Behaviour:
 *   - No Idempotency-Key header → handler runs normally, no caching.
 *   - Header present + first time → handler runs, response cached.
 *   - Header present + cached row found → cached status+body replayed,
 *     handler NOT re-run. This is the property that lets a client retry a
 *     failed-network send without double-charging WhatsApp credit.
 *
 * Cache scope: (tenant_id, key, endpoint). We include `endpoint` so a
 * client recycling the same key across e.g. /api/inbox/send and
 * /api/broadcasts/:id/send doesn't get the wrong cached payload.
 *
 * Retention: best-effort. The migration adds a created_at index so a cron
 * or manual purge can delete rows older than 24h. We tolerate insert
 * failures silently — if Supabase is down we'd rather send the message
 * twice than fail the legitimate request, given the typical send is
 * idempotent at the WhatsApp layer (Meta de-dupes by message_id).
 */
import { createHash } from 'crypto'
import type { Request, Response } from 'express'
import type { SupabaseClient } from '@supabase/supabase-js'

/**
 * Canonicalize + sha256 hash a request body. Without this, a buggy
 * client that reuses the same Idempotency-Key across DIFFERENT payloads
 * gets the first call's cached response replayed for every subsequent
 * send — second-Nth real messages never reach Meta. (Stripe documents
 * the same gotcha; their fix is a 409 when key+endpoint matches but
 * body differs.) Returns null on failure so caller can fall back to
 * legacy unhashed behaviour.
 */
function hashBody(body: unknown): string | null {
  try {
    // JSON.stringify is non-deterministic for object key order, but for
    // this purpose (comparing replays of the SAME request) the caller
    // sends the same shape every time, so stable ordering isn't required.
    // If a future caller mixes shapes, we'd swap in canonical-json.
    return createHash('sha256').update(JSON.stringify(body ?? null)).digest('hex')
  } catch {
    return null
  }
}

export interface HandlerResult {
  status: number
  body: unknown
}

/**
 * Pull the Idempotency-Key header in a normalized way. We accept both
 * spellings the client wild — `Idempotency-Key` (stripe convention) and
 * `X-Idempotency-Key` (some legacy SDKs). Truncate at 200 chars to keep
 * a malicious header from blowing up our PK width.
 */
function readKey(req: Request): string | null {
  const h = (req.header('idempotency-key') || req.header('x-idempotency-key')) ?? null
  if (!h) return null
  const trimmed = h.trim()
  if (trimmed.length === 0 || trimmed.length > 200) return null
  return trimmed
}

/**
 * Run `handler` with idempotency-key short-circuit.
 *
 * Returns the Response after `res.status(...).json(...)` is called. Callers
 * should `return` this so the route handler's control flow ends correctly.
 */
export async function withIdempotency(
  supabase: SupabaseClient,
  req: Request,
  res: Response,
  endpoint: string,
  handler: () => Promise<HandlerResult>,
): Promise<Response> {
  const tenantId = (req as any).tenantId as string | undefined
  const key = readKey(req)

  // No tenant or no key → behave as if idempotency wasn't requested.
  // (Anonymous endpoints without identifyTenant fall through here too.)
  if (!tenantId || !key) {
    const result = await handler()
    return res.status(result.status).json(result.body)
  }

  // Hash the request body so we can detect key-reuse-with-different-payload
  // and reject it explicitly (409) rather than silently replaying the
  // first call's cached response for an unrelated send.
  const bodyHash = hashBody((req as any).body)

  // Look up an existing cached response for this (tenant, key, endpoint).
  const { data: existing, error: lookupErr } = await supabase
    .from('idempotency_keys')
    .select('status_code, response_body, body_hash')
    .eq('tenant_id', tenantId)
    .eq('key', key)
    .eq('endpoint', endpoint)
    .maybeSingle()

  if (lookupErr) {
    // Treat lookup failures as cache miss — better to risk a duplicate
    // than to fail the user's request because the cache table is hot.
    console.warn(`[idempotency] lookup failed for ${endpoint}: ${lookupErr.message}`)
  } else if (existing) {
    const prevHash = (existing as any).body_hash as string | null
    if (prevHash && bodyHash && prevHash !== bodyHash) {
      // Same key, different payload → real bug in the client. Refuse
      // to replay a stale response that doesn't match the new request.
      return res.status(409).json({
        error: 'idempotency_key_reuse',
        message: 'This Idempotency-Key was already used with a different payload. Use a new key for distinct requests.',
      })
    }
    res.setHeader('X-Idempotent-Replay', 'true')
    return res.status((existing as any).status_code).json((existing as any).response_body)
  }

  // Cache miss → run the handler.
  const result = await handler()

  // Cache the outcome best-effort. We do this AFTER sending the response in
  // a fire-and-forget pattern would race with the test harness; keep it
  // pre-send so the next call sees a populated row. Failures don't surface
  // to the client — the original request already succeeded.
  try {
    await supabase.from('idempotency_keys').insert({
      tenant_id: tenantId,
      key,
      endpoint,
      body_hash: bodyHash,
      status_code: result.status,
      response_body: result.body as any,
    })
  } catch (err: any) {
    console.warn(`[idempotency] insert failed for ${endpoint}: ${err?.message}`)
  }

  return res.status(result.status).json(result.body)
}
