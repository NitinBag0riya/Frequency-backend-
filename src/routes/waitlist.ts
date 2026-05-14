/**
 * Waitlist routes — public-facing pre-launch capture.
 *
 *   POST /api/waitlist        → record email + phone, dedup by lower(email)
 *   GET  /api/waitlist/count  → public count for landing-page social proof
 *
 * Why a dedicated router:
 *   This is the ONLY public-write endpoint with no tenant or auth context.
 *   Isolating it makes security review obvious and lets us apply a stricter
 *   per-IP rate limit than the global authed-API limiter.
 *
 * Spam controls:
 *   - per-IP rate limit (10 signups/min)
 *   - server-side email + phone shape validation
 *   - sha256(ip) stored for retroactive abuse analysis (no plaintext IP)
 *   - Postgres unique on lower(email) → duplicate signups silently 200
 *
 * No CAPTCHA today (visitor-friction tradeoff). Add Turnstile/hCaptcha if
 * organized spam appears — both are free-tier and one verify call here.
 */

import express from 'express'
import type { SupabaseClient } from '@supabase/supabase-js'
import crypto from 'crypto'
import rateLimit from 'express-rate-limit'
import { z } from 'zod'
import { apiError } from '../lib/api-error'

interface Deps {
  supabase: SupabaseClient
}

const SignupSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
  phone: z.string().trim().min(4).max(32)
    .regex(/^[+\d][\d\s().\-]{3,31}$/, 'Phone looks invalid')
    .optional(),
  source: z.string().trim().max(64).optional(),
})

function hashIp(ip: string): string {
  return crypto.createHash('sha256').update(ip).digest('hex')
}

export function createWaitlistRouter({ supabase }: Deps): express.Router {
  const router = express.Router()

  // Per-IP cap is intentional and tight — there is zero legitimate reason
  // for a single IP to fire >10 signups/min.
  const signupLimiter = rateLimit({
    windowMs: 60_000,
    max: 10,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => req.ip ?? 'unknown',
    message: { error: { code: 'rate_limited', message: 'Too many waitlist signups from this IP. Try again in a minute.' } },
  })

  // ── GET /count — exposed via SECURITY DEFINER fn so we don't leak rows ─
  router.get('/count', async (_req, res) => {
    const { data, error } = await supabase.rpc('waitlist_count')
    if (error) {
      console.error('[waitlist] count rpc failed:', error.message)
      // Don't leak DB error; FE just hides social-proof badge if this fails.
      return apiError(res, 503, 'count_unavailable', 'Waitlist count temporarily unavailable')
    }
    res.json({ count: typeof data === 'number' ? data : 0 })
  })

  // ── POST / — signup ─────────────────────────────────────────────────────
  router.post('/', signupLimiter, async (req, res) => {
    const parsed = SignupSchema.safeParse(req.body)
    if (!parsed.success) {
      return apiError(res, 400, 'invalid_payload', 'Please enter a valid email (and optional phone).', parsed.error.flatten())
    }
    const { email, phone, source } = parsed.data
    const ip = req.ip ?? 'unknown'
    const ua  = (req.header('user-agent') ?? '').slice(0, 512)
    const ref = (req.header('referer') ?? '').slice(0, 512)

    const { error } = await supabase.from('waitlist').insert({
      email,
      phone: phone ?? null,
      source: source ?? 'apex_landing',
      ip_hash: hashIp(ip),
      user_agent: ua || null,
      referrer:   ref || null,
    })

    if (error) {
      // Postgres unique-violation → silent dedup success. We deliberately
      // never tell the visitor whether their email is already on the list
      // (mild PII-existence-leak prevention).
      if ((error as any).code === '23505') {
        return res.status(200).json({ ok: true, deduped: true })
      }
      console.error('[waitlist] insert failed:', error.message, 'code=', (error as any).code)
      return apiError(res, 503, 'signup_failed', 'Could not save your signup. Please try again.')
    }

    return res.status(201).json({ ok: true })
  })

  return router
}
