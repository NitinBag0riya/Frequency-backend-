/**
 * routes/r-redirect.ts — Public short-link redirect (P2 #19).
 *
 * GET /r/:token
 *   - Unauthenticated. This endpoint serves the recipient's click directly
 *     from the message body, so it MUST be open to the public internet.
 *   - Looks up broadcast_links by token (service role bypasses RLS).
 *   - 302 → original_url with Cache-Control: no-store (so a corporate proxy
 *     can't cache a redirect for one user and serve it to another).
 *   - Logs a broadcast_link_clicks row AFTER sending the response — the
 *     insert is fire-and-forget so the redirect latency is dominated by
 *     the SELECT only (target: <30ms p95).
 *
 * Privacy posture:
 *   - User-Agent string is HASHED (sha256, first 16 hex chars) before
 *     storage. Enough to dedupe unique-clicks-per-link without retaining
 *     the raw UA. DPDPA-friendly.
 *   - IP country code is read from X-Country-Code (Vercel/Cloudflare edge
 *     header). Raw IP is NEVER stored. No maxmind dep.
 *   - Referer is parsed down to its hostname; query string is discarded.
 *
 * Failure modes:
 *   - Token not found → 404 with a tenant-agnostic page (we don't want to
 *     leak whether a token exists by status code timing, but this is a
 *     short link, not a credentials endpoint — 404 is fine).
 *   - DB error on lookup → 502.
 *   - Insert failure on click log → swallowed + console.warn; the user
 *     still gets their redirect.
 */

import express from 'express'
import crypto from 'crypto'
import { SupabaseClient } from '@supabase/supabase-js'

interface Deps {
  supabase: SupabaseClient                          // MUST be the service role client (bypasses RLS).
}

export function createRedirectRouter(deps: Deps): express.Router {
  const r = express.Router()
  const { supabase } = deps

  r.get('/r/:token', async (req, res) => {
    const token = String(req.params.token ?? '')
    // Token shape gate — matches the DB CHECK constraint exactly. Cheap
    // way to reject bot-fuzz traffic without a DB round-trip.
    if (!/^[A-Za-z0-9]{6,16}$/.test(token)) {
      res.status(404).type('text/plain').send('Link not found.')
      return
    }

    const { data: link, error } = await supabase
      .from('broadcast_links')
      .select('id, tenant_id, broadcast_id, contact_id, original_url')
      .eq('token', token)
      .maybeSingle()

    if (error) {
      console.warn(`[r-redirect] db error for token=${token}: ${error.message}`)
      res.status(502).type('text/plain').send('Temporary error. Try again shortly.')
      return
    }
    if (!link) {
      res.status(404).type('text/plain').send('Link not found.')
      return
    }

    // Send the redirect FIRST so we never block the user on a click-log
    // insert. Cache-Control: no-store so intermediary proxies don't cache
    // a redirect from one click and serve it to a different recipient.
    res.setHeader('Cache-Control', 'no-store')
    res.setHeader('Referrer-Policy', 'no-referrer')
    res.redirect(302, link.original_url)

    // ── Click log (best-effort, fire-and-forget) ─────────────────────────
    // We deliberately don't await this. setImmediate detaches it from the
    // response cycle so even a slow Postgres insert can't show up as
    // increased redirect latency.
    setImmediate(() => {
      try {
        const ua = String(req.headers['user-agent'] ?? '')
        const userAgentHash = ua
          ? crypto.createHash('sha256').update(ua).digest('hex').slice(0, 16)
          : null

        // X-Country-Code is set by Vercel / Cloudflare at the edge. We
        // accept either header casing (Express lowercases anyway) and
        // gracefully degrade to null when missing (e.g. local dev).
        const rawCountry =
          (req.headers['x-country-code'] as string | undefined) ??
          (req.headers['x-vercel-ip-country'] as string | undefined) ??
          (req.headers['cf-ipcountry'] as string | undefined) ??
          null
        const ipCountryCode = rawCountry ? String(rawCountry).toUpperCase().slice(0, 2) : null

        const refererHeader = String(req.headers['referer'] ?? req.headers['referrer'] ?? '')
        let refererHost: string | null = null
        if (refererHeader) {
          try {
            refererHost = new URL(refererHeader).hostname.slice(0, 255)
          } catch {
            refererHost = null
          }
        }

        // The supabase builder returns a PromiseLike (no .catch), so wrap
        // it with Promise.resolve(...) before attaching a catch handler.
        Promise.resolve(
          supabase.from('broadcast_link_clicks').insert({
            tenant_id: link.tenant_id,
            link_id: link.id,
            broadcast_id: link.broadcast_id,
            contact_id: link.contact_id,
            user_agent_hash: userAgentHash,
            ip_country_code: ipCountryCode,
            referer_host: refererHost,
          })
        )
          .then(({ error: insErr }) => {
            if (insErr) console.warn(`[r-redirect] click log failed token=${token}: ${insErr.message}`)
          })
          .catch((err: unknown) => {
            console.warn(`[r-redirect] click log threw token=${token}:`, err)
          })
      } catch (e) {
        console.warn(`[r-redirect] click log outer throw token=${token}:`, e)
      }
    })
  })

  return r
}
