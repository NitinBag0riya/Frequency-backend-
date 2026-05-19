/**
 * Agency white-label routes (P1 #12).
 *
 * Single router that covers:
 *   - Agency lifecycle:         POST /api/agencies, GET /api/agencies/me, GET/PATCH /api/agencies/:id
 *   - Sub-accounts:             list / invite-by-email / accept / patch / soft-remove
 *   - Members:                  list / invite / accept / remove
 *   - Revshare ledger:          paginated list + summary
 *   - Payouts:                  list (writes done by the worker)
 *
 * Invites use stateless HMAC-signed tokens (no extra invite table needed —
 * the signed payload IS the durable state, and the agency_members /
 * agency_sub_accounts uniqueness constraints prevent double-accept replays).
 *
 * Auth model: every route is requireAuth. Member-only routes additionally
 * verify the calling user has an agency_members row for the agency id in
 * the URL, with role gates as marked on each handler.
 *
 * Service role on the supabase client given to this router — all writes go
 * through it so RLS's authenticated REVOKE on revshare/payouts doesn't
 * block legit BE writes, and so we can insert agency + owner-member atomically.
 */

import express from 'express'
import crypto from 'crypto'
import { SupabaseClient } from '@supabase/supabase-js'
import { z } from 'zod'
import { sendEmail } from '../lib/email'
import {
  ensureCustomer, createSubscription, cancelSubscription,
  createPlan, listSubscriptionPayments, createRefund,
} from '../lib/razorpay'

type Middleware = (req: express.Request, res: express.Response, next: express.NextFunction) => void | Promise<void>

interface Deps {
  supabase: SupabaseClient
  requireAuth: Middleware
}

// ── Invite token helpers ─────────────────────────────────────────────────────
// HMAC-SHA256 over the JSON-encoded payload. base64url for URL safety.
// Two flavours — sub-account invite (tenant_owner_email + agency_id) and
// member invite (agency_id + role + email). Same scheme, different payload.

interface SubAccountInvitePayload {
  v: 1
  kind: 'sub_account'
  agency_id: string
  tenant_owner_email: string
  invited_by: string
  exp: number // unix seconds
}

interface MemberInvitePayload {
  v: 1
  kind: 'member'
  agency_id: string
  email: string
  role: 'agency_owner' | 'agency_admin' | 'agency_operator'
  invited_by: string
  exp: number
}

/**
 * inviteSecret — resolves the HMAC key used to sign + verify invite
 * tokens (sub-account links + agency-member invites).
 *
 * Security audit 2026-05-19 (P0): the previous implementation fell back
 * to SUPABASE_SERVICE_ROLE_KEY when neither AGENCY_INVITE_SECRET nor
 * SUPABASE_JWT_SECRET was set. That made the service-role key a
 * load-bearing secret for an unrelated subsystem — rotating it would
 * silently invalidate every outstanding invite, and any code path
 * that logged an invite token would leak material derived from a
 * privileged secret. The hardened policy:
 *
 *   - **Production** (`NODE_ENV === 'production'`): AGENCY_INVITE_SECRET
 *     MUST be set and at least 32 characters. Throws (and fails the
 *     request 500) otherwise — operators get a loud failure at the
 *     first invite mint rather than a silent security regression.
 *
 *   - **Non-production**: still falls back to a dev-only literal so
 *     local smoke tests don't need extra env vars. NEVER use this in
 *     prod — the literal is checked-in source.
 *
 * Mirrors the pattern in super-admin.ts for IMPERSONATION_HMAC_SECRET.
 */
const DEV_FALLBACK_INVITE_SECRET = 'dev-only-invite-secret-do-not-use-in-prod'

function inviteSecret(): string {
  const explicit = process.env.AGENCY_INVITE_SECRET ?? process.env.SUPABASE_JWT_SECRET
  if (explicit) {
    if (process.env.NODE_ENV === 'production' && explicit.length < 32) {
      throw new Error('AGENCY_INVITE_SECRET must be >=32 chars in production')
    }
    return explicit
  }
  if (process.env.NODE_ENV === 'production') {
    throw new Error('AGENCY_INVITE_SECRET (>=32 chars) is required in production. Generate with: openssl rand -hex 32')
  }
  return DEV_FALLBACK_INVITE_SECRET
}

function signInvite(payload: SubAccountInvitePayload | MemberInvitePayload): string {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url')
  const sig = crypto.createHmac('sha256', inviteSecret()).update(body).digest('base64url')
  return `${body}.${sig}`
}

function verifyInvite<T extends SubAccountInvitePayload | MemberInvitePayload>(token: string, expectedKind: T['kind']): T | null {
  const [body, sig] = String(token).split('.')
  if (!body || !sig) return null
  const expected = crypto.createHmac('sha256', inviteSecret()).update(body).digest('base64url')
  // timingSafeEqual requires equal-length buffers.
  if (sig.length !== expected.length) return null
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null
  let payload: any
  try { payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) } catch { return null }
  if (payload?.v !== 1) return null
  if (payload?.kind !== expectedKind) return null
  if (typeof payload?.exp !== 'number' || payload.exp * 1000 < Date.now()) return null
  return payload as T
}

// ── Schema validation ────────────────────────────────────────────────────────
const CreateAgencyBody = z.object({
  name: z.string().trim().min(1).max(200),
  slug: z.string().trim().toLowerCase().regex(/^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/, 'slug must be 3-40 chars, lowercase alphanumeric + hyphens'),
  default_revshare_pct: z.number().min(0).max(100).optional(),
  agency_paid_by_default: z.boolean().optional(),
})

const PatchAgencyBody = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  default_revshare_pct: z.number().min(0).max(100).optional(),
  agency_paid_by_default: z.boolean().optional(),
  status: z.enum(['active', 'suspended', 'archived']).optional(),
  razorpay_customer_id: z.string().max(200).nullable().optional(),
})

const InviteSubAccountBody = z.object({
  tenant_owner_email: z.string().trim().toLowerCase().email(),
})

const PatchSubAccountBody = z.object({
  billing_owner: z.enum(['agency', 'tenant']).optional(),
  revshare_pct_override: z.number().min(0).max(100).nullable().optional(),
})

const InviteMemberBody = z.object({
  email: z.string().trim().toLowerCase().email(),
  role: z.enum(['agency_owner', 'agency_admin', 'agency_operator']),
})

// ── Role helpers ─────────────────────────────────────────────────────────────
async function getMembership(supabase: SupabaseClient, agencyId: string, userId: string) {
  const { data } = await supabase.from('agency_members')
    .select('id, role, accepted_at')
    .eq('agency_id', agencyId)
    .eq('user_id', userId)
    .maybeSingle()
  return data
}

function isAdminRole(role: string | undefined | null): boolean {
  return role === 'agency_owner' || role === 'agency_admin'
}

export function createAgencyRouter(deps: Deps): express.Router {
  const r = express.Router()
  const { supabase, requireAuth } = deps

  // ── POST /api/agencies ─────────────────────────────────────────────────
  // Create a new agency and seed the caller as agency_owner. Atomic via
  // service-role + the unique index on slug.
  r.post('/api/agencies', requireAuth, async (req, res) => {
    const userId = (req as any).user?.id
    const parsed = CreateAgencyBody.safeParse(req.body)
    if (!parsed.success) { res.status(400).json({ error: 'Invalid body', issues: parsed.error.issues }); return }

    const { name, slug, default_revshare_pct, agency_paid_by_default } = parsed.data
    const { data: agency, error: agErr } = await supabase.from('agencies').insert({
      name,
      slug,
      owner_user_id: userId,
      default_revshare_pct: default_revshare_pct ?? 30,
      agency_paid_by_default: agency_paid_by_default ?? true,
    }).select('*').single()
    if (agErr) {
      if ((agErr as any).code === '23505') { res.status(409).json({ error: 'slug already taken' }); return }
      res.status(500).json({ error: agErr.message }); return
    }

    // Seed the owner as a member. If this fails we leave the agency row —
    // the unique (agency_id, user_id) constraint means a retry is safe.
    const { error: memErr } = await supabase.from('agency_members').insert({
      agency_id: agency.id,
      user_id: userId,
      role: 'agency_owner',
      invited_by: userId,
      accepted_at: new Date().toISOString(),
    })
    if (memErr && (memErr as any).code !== '23505') {
      console.warn('[agency] owner member insert failed (non-fatal, will retry on next access):', memErr.message)
    }
    res.status(201).json({ agency })
  })

  // ── GET /api/agencies/me ───────────────────────────────────────────────
  // Every NON-archived agency the caller is a member of (any role). Used
  // by the workspace switcher to render the agency section. Archived
  // agencies (status='archived' via DELETE /api/agencies/:id) are filtered
  // out so they don't clutter the switcher dropdown; a separate
  // `/api/agencies/me?include_archived=1` query toggle could surface them
  // in a future archive-recovery UI without changing the default shape.
  r.get('/api/agencies/me', requireAuth, async (req, res) => {
    const userId = (req as any).user?.id
    const includeArchived = String(req.query.include_archived ?? '') === '1'
    const { data, error } = await supabase.from('agency_members')
      .select('role, accepted_at, invited_at, agencies:agency_id ( id, name, slug, status, default_revshare_pct )')
      .eq('user_id', userId)
    if (error) { res.status(500).json({ error: error.message }); return }
    const rows = (data ?? []).map((row: any) => ({
      role: row.role,
      accepted_at: row.accepted_at,
      invited_at: row.invited_at,
      ...(Array.isArray(row.agencies) ? row.agencies[0] : row.agencies),
    })).filter((a: any) => a?.id && (includeArchived || a.status !== 'archived'))
    res.json({ agencies: rows })
  })

  // ── GET /api/agencies/:id ──────────────────────────────────────────────
  r.get('/api/agencies/:id', requireAuth, async (req, res) => {
    const userId = (req as any).user?.id
    const agencyId = String(req.params.id)
    const member = await getMembership(supabase, agencyId, userId)
    if (!member) { res.status(403).json({ error: 'not a member' }); return }
    const { data, error } = await supabase.from('agencies').select('*').eq('id', agencyId).maybeSingle()
    if (error) { res.status(500).json({ error: error.message }); return }
    if (!data) { res.status(404).json({ error: 'not found' }); return }
    res.json({ agency: data, role: member.role })
  })

  // ── PATCH /api/agencies/:id ────────────────────────────────────────────
  r.patch('/api/agencies/:id', requireAuth, async (req, res) => {
    const userId = (req as any).user?.id
    const agencyId = String(req.params.id)
    const member = await getMembership(supabase, agencyId, userId)
    if (!member || !isAdminRole(member.role)) { res.status(403).json({ error: 'owner or admin only' }); return }

    const parsed = PatchAgencyBody.safeParse(req.body)
    if (!parsed.success) { res.status(400).json({ error: 'Invalid body', issues: parsed.error.issues }); return }
    if (Object.keys(parsed.data).length === 0) { res.status(400).json({ error: 'nothing to update' }); return }

    const { data, error } = await supabase.from('agencies')
      .update({ ...parsed.data, updated_at: new Date().toISOString() })
      .eq('id', agencyId)
      .select('*').single()
    if (error) { res.status(500).json({ error: error.message }); return }
    res.json({ agency: data })
  })

  // ── DELETE /api/agencies/:id ─────────────────────────────────────────────
  // Owner-only soft-archive. Audit punch-item — an agency could be created
  // via POST but had no API to deactivate. Soft-archive (status='archived')
  // rather than hard-delete because:
  //   - agency_revshare_entries + agency_payouts are append-only ledgers
  //     with FK to agencies — hard-delete cascades them, destroying audit.
  //   - sub-account links (agency_sub_accounts) carry billing history we
  //     don't want to lose just because the agency "ended".
  // The 'archived' status comes from agencies.status CHECK constraint
  // (migration 079: 'active' | 'suspended' | 'archived'). 'suspended' is
  // reserved for ops-driven holds; 'archived' is the user-driven close.
  // Re-opening an archived agency is intentionally NOT exposed via API —
  // would require a super-admin tool to avoid abuse vectors.
  r.delete('/api/agencies/:id', requireAuth, async (req, res) => {
    const userId = (req as any).user?.id
    const agencyId = String(req.params.id)
    const member = await getMembership(supabase, agencyId, userId)
    if (!member || member.role !== 'agency_owner') {
      res.status(403).json({ error: 'owner only — only the agency owner can archive an agency' })
      return
    }
    // Guard against archiving an agency that still has active sub-accounts.
    // The owner should remove (or transfer) them first — archiving while
    // sub-accounts are live would leave clients without a billing parent.
    const { count: liveSubs, error: countErr } = await supabase
      .from('agency_sub_accounts')
      .select('id', { count: 'exact', head: true })
      .eq('agency_id', agencyId)
      .is('removed_at', null)
    if (countErr) { res.status(500).json({ error: countErr.message }); return }
    if ((liveSubs ?? 0) > 0) {
      res.status(409).json({
        error: 'agency_has_live_sub_accounts',
        message: `Remove the ${liveSubs} active sub-account(s) before archiving the agency.`,
        live_count: liveSubs,
      })
      return
    }
    const { data, error } = await supabase.from('agencies')
      .update({ status: 'archived', updated_at: new Date().toISOString() })
      .eq('id', agencyId)
      .select('id, status, updated_at').single()
    if (error) { res.status(500).json({ error: error.message }); return }
    res.json({ success: true, agency: data })
  })

  // ── GET /api/agencies/:id/sub-accounts ─────────────────────────────────
  // Returns active sub-accounts joined with tenant business_name, current
  // plan MRR, and a lightweight YTD revshare sum so the FE table can
  // render without a second round-trip.
  r.get('/api/agencies/:id/sub-accounts', requireAuth, async (req, res) => {
    const userId = (req as any).user?.id
    const agencyId = String(req.params.id)
    const member = await getMembership(supabase, agencyId, userId)
    if (!member) { res.status(403).json({ error: 'not a member' }); return }

    const { data: subs, error } = await supabase.from('agency_sub_accounts')
      .select(`id, tenant_id, billing_owner, revshare_pct_override, added_at, removed_at,
               tenants:tenant_id ( id, business_name, slug, status, user_id )`)
      .eq('agency_id', agencyId)
      .is('removed_at', null)
      .order('added_at', { ascending: false })
    if (error) { res.status(500).json({ error: error.message }); return }

    // Best-effort MRR + revshare YTD + owner-email lookups — never block
    // the page if any single one fails. We pull subs first, then enrich
    // in parallel.
    const tenantIds = (subs ?? []).map((s: any) => s.tenant_id)
    const ownerUserIds = Array.from(new Set(
      (subs ?? []).map((s: any) => (Array.isArray(s.tenants) ? s.tenants[0] : s.tenants)?.user_id).filter(Boolean) as string[]
    ))
    let mrrByTenant: Record<string, number> = {}
    let revshareYtdByTenant: Record<string, number> = {}
    let emailByUser: Record<string, string> = {}
    let fullNameByUser: Record<string, string> = {}
    if (tenantIds.length > 0) {
      const [{ data: subsRows }, { data: rsRows }] = await Promise.all([
        supabase.from('tenant_subscriptions')
          .select('tenant_id, plans:plan_id ( monthly_price_inr )')
          .in('tenant_id', tenantIds),
        supabase.from('agency_revshare_entries')
          .select('tenant_id, revshare_amount_inr_paise')
          .eq('agency_id', agencyId)
          .in('tenant_id', tenantIds)
          .gte('period_start', new Date(new Date().getFullYear(), 0, 1).toISOString()),
      ])
      for (const row of (subsRows ?? []) as any[]) {
        const p = Array.isArray(row.plans) ? row.plans[0] : row.plans
        mrrByTenant[row.tenant_id] = Number(p?.monthly_price_inr ?? 0)
      }
      for (const row of (rsRows ?? []) as any[]) {
        revshareYtdByTenant[row.tenant_id] = (revshareYtdByTenant[row.tenant_id] ?? 0) + Number(row.revshare_amount_inr_paise ?? 0)
      }
    }
    // Resolve owner emails + full names via supabase.auth.admin (service
    // role only — never expose via PostgREST). One lookup per unique
    // owner; typically agencies have a handful of tenants so this is a
    // small fan-out. Failures are silent — the FE just shows "—".
    if (ownerUserIds.length > 0) {
      const lookups = await Promise.all(
        ownerUserIds.map(uid => supabase.auth.admin.getUserById(uid).catch(() => null))
      )
      for (let i = 0; i < ownerUserIds.length; i++) {
        const uid = ownerUserIds[i]
        const u = lookups[i]?.data?.user
        if (u?.email) emailByUser[uid] = u.email
        const fn = (u?.user_metadata as any)?.full_name
        if (typeof fn === 'string') fullNameByUser[uid] = fn
      }
    }

    const enriched = (subs ?? []).map((s: any) => {
      const t = Array.isArray(s.tenants) ? s.tenants[0] : s.tenants
      const ownerId = t?.user_id ?? null
      return {
        ...s,
        // Strip `user_id` from the public tenant shape — it's an internal
        // FK we don't want to bake into the FE type. Surface owner email
        // + full_name at the top level instead.
        tenant: t ? { id: t.id, business_name: t.business_name, slug: t.slug, status: t.status } : null,
        owner_email:     ownerId ? (emailByUser[ownerId] ?? null) : null,
        owner_full_name: ownerId ? (fullNameByUser[ownerId] ?? null) : null,
        mrr_inr: mrrByTenant[s.tenant_id] ?? 0,
        revshare_ytd_paise: revshareYtdByTenant[s.tenant_id] ?? 0,
      }
    })
    res.json({ sub_accounts: enriched })
  })

  // ── POST /api/agencies/:id/sub-accounts ─────────────────────────────────
  // Invite a tenant owner by email. The actual link only attaches once
  // the tenant owner clicks the email + accepts — consent gate.
  r.post('/api/agencies/:id/sub-accounts', requireAuth, async (req, res) => {
    const userId = (req as any).user?.id
    const agencyId = String(req.params.id)
    const member = await getMembership(supabase, agencyId, userId)
    if (!member || !isAdminRole(member.role)) { res.status(403).json({ error: 'owner or admin only' }); return }

    const parsed = InviteSubAccountBody.safeParse(req.body)
    if (!parsed.success) { res.status(400).json({ error: 'Invalid body', issues: parsed.error.issues }); return }

    const { data: agency } = await supabase.from('agencies').select('name, slug').eq('id', agencyId).maybeSingle()
    if (!agency) { res.status(404).json({ error: 'agency not found' }); return }

    // ── Sub-account limit enforcement (migration 088) ──────────────────────
    // The agency's active subscription (if any) caps how many sub-accounts can
    // be attached. No active sub → trial cap of 1. NULL max_sub_accounts on
    // the plan = unlimited (Scale tier has a soft fair-use of 100 enforced in
    // app code only; we treat NULL as "no DB-enforced cap").
    {
      const { data: activeSub } = await supabase.from('agency_subscriptions')
        .select('id, plan_id, status, plans:plan_id ( id, name, max_sub_accounts, agency_features )')
        .eq('agency_id', agencyId)
        .eq('status', 'active')
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle()
      const plan: any = activeSub
        ? (Array.isArray((activeSub as any).plans) ? (activeSub as any).plans[0] : (activeSub as any).plans)
        : null
      // Soft fair-use ceiling for the Scale tier (max_sub_accounts IS NULL).
      const fairUse = (plan?.agency_features && typeof plan.agency_features === 'object'
        ? Number((plan.agency_features as any).sub_accounts_fair_use ?? 0)
        : 0) || 100
      const max =
        !activeSub                                                   ? 1                  : // trial
        plan?.max_sub_accounts == null                                ? fairUse            : // unlimited (fair-use)
        Number(plan.max_sub_accounts)
      const { count } = await supabase.from('agency_sub_accounts')
        .select('id', { count: 'exact', head: true })
        .eq('agency_id', agencyId)
        .is('removed_at', null)
      const current = count ?? 0
      if (current >= max) {
        res.status(422).json({
          error:   'sub_account_limit_reached',
          current,
          max,
          plan:    activeSub ? plan?.id ?? null : null,
          message: activeSub
            ? `Your ${plan?.name ?? 'current'} plan supports ${max} sub-accounts. Upgrade to add more.`
            : 'Trial accounts can attach 1 sub-account. Upgrade to an agency plan to invite more.',
        })
        return
      }
    }

    const token = signInvite({
      v: 1, kind: 'sub_account',
      agency_id: agencyId,
      tenant_owner_email: parsed.data.tenant_owner_email,
      invited_by: userId,
      exp: Math.floor(Date.now() / 1000) + 7 * 24 * 60 * 60,
    })
    const acceptUrl = `${process.env.FRONTEND_URL ?? 'http://localhost:5173'}/agency-link/accept?token=${encodeURIComponent(token)}`

    try {
      await sendEmail({
        to: parsed.data.tenant_owner_email,
        subject: `${agency.name} invited you to connect your workspace`,
        html: `<p>Hi,</p><p><strong>${agency.name}</strong> has invited you to connect your Frequency workspace as a managed sub-account. You'll keep your account; they'll get a read-only view + (optionally) take over billing.</p><p><a href="${acceptUrl}" style="display:inline-block;background:#0F6E56;color:#fff;text-decoration:none;font-weight:600;padding:10px 20px;border-radius:8px">Review & accept</a></p><p>This link expires in 7 days. If you didn't expect this, ignore the email.</p>`,
        text: `${agency.name} invited you to connect your workspace.\n\nAccept: ${acceptUrl}\n\nLink expires in 7 days.`,
      })
    } catch (e: any) {
      // Surface but don't fail — the agency operator can re-send / share the URL manually.
      console.warn('[agency] sub-account invite email failed (non-fatal):', e?.message)
    }
    res.status(202).json({ success: true, accept_url: acceptUrl })
  })

  // ── POST /api/agency-links/accept ──────────────────────────────────────
  // Public-after-auth: the tenant owner clicks the email, signs in, FE
  // hits this with { token }. We verify the HMAC + tenant ownership and
  // attach the agency_sub_accounts row.
  r.post('/api/agency-links/accept', requireAuth, async (req, res) => {
    const userId = (req as any).user?.id
    const userEmail = String((req as any).user?.email ?? '').toLowerCase()
    const token = String(req.body?.token ?? '')
    if (!token) { res.status(400).json({ error: 'token required' }); return }

    const payload = verifyInvite<SubAccountInvitePayload>(token, 'sub_account')
    if (!payload) { res.status(400).json({ error: 'invalid or expired token' }); return }
    if (payload.tenant_owner_email !== userEmail) {
      res.status(403).json({ error: 'this invite is for a different email' }); return
    }

    // Find the tenant this user owns. We attach the FIRST tenant they own
    // — for SMBs that's the only one. Operator can refine via PATCH later.
    const { data: owned } = await supabase.from('tenants')
      .select('id, business_name')
      .eq('user_id', userId)
      .limit(2)
    if (!owned || owned.length === 0) {
      res.status(400).json({ error: 'no tenant found for this user' }); return
    }
    if (owned.length > 1) {
      res.status(409).json({ error: 'multiple tenants — pick one via the dashboard', candidates: owned })
      return
    }
    const tenantId = owned[0].id

    // Read agency.agency_paid_by_default so the initial billing_owner
    // reflects the agency's setup choice.
    const { data: agency } = await supabase.from('agencies')
      .select('agency_paid_by_default')
      .eq('id', payload.agency_id).maybeSingle()
    const defaultBillingOwner = agency?.agency_paid_by_default === false ? 'tenant' : 'agency'

    // Cap check at accept time too — defense in depth. Plan could have
    // downgraded between invite send and tenant click.
    {
      const { data: activeSub } = await supabase.from('agency_subscriptions')
        .select('id, plan_id, status, plans:plan_id ( id, name, max_sub_accounts, agency_features )')
        .eq('agency_id', payload.agency_id)
        .eq('status', 'active')
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle()
      const plan: any = activeSub
        ? (Array.isArray((activeSub as any).plans) ? (activeSub as any).plans[0] : (activeSub as any).plans)
        : null
      const fairUse = (plan?.agency_features && typeof plan.agency_features === 'object'
        ? Number((plan.agency_features as any).sub_accounts_fair_use ?? 0)
        : 0) || 100
      const max =
        !activeSub                                                   ? 1                  :
        plan?.max_sub_accounts == null                                ? fairUse            :
        Number(plan.max_sub_accounts)
      const { count } = await supabase.from('agency_sub_accounts')
        .select('id', { count: 'exact', head: true })
        .eq('agency_id', payload.agency_id)
        .is('removed_at', null)
      const current = count ?? 0
      // Permit restore-of-existing-row (current already counts it) but block
      // strict ADD when at or over the cap.
      const { data: existingRow } = await supabase.from('agency_sub_accounts')
        .select('id, agency_id, removed_at')
        .eq('tenant_id', (await supabase.from('tenants').select('id').eq('user_id', userId).limit(1).maybeSingle()).data?.id ?? '')
        .maybeSingle()
      const isFreshAdd = !existingRow || existingRow.removed_at !== null || existingRow.agency_id !== payload.agency_id
      if (isFreshAdd && current >= max) {
        res.status(422).json({
          error:   'sub_account_limit_reached',
          current,
          max,
          plan:    activeSub ? plan?.id ?? null : null,
          message: activeSub
            ? `This agency is at capacity (${current}/${max}) on its ${plan?.name ?? 'current'} plan. Ask them to upgrade.`
            : 'This agency hasn’t set up a plan yet (trial cap reached). Ask them to subscribe.',
        })
        return
      }
    }

    // Idempotent upsert. If a soft-removed row exists for this tenant we
    // restore it; else fresh insert. The unique index on tenant_id makes
    // direct insert error if any row exists, so go through update-first.
    const { data: existing } = await supabase.from('agency_sub_accounts')
      .select('id, agency_id, removed_at')
      .eq('tenant_id', tenantId).maybeSingle()
    if (existing) {
      if (existing.agency_id !== payload.agency_id && existing.removed_at === null) {
        res.status(409).json({ error: 'tenant already belongs to a different agency' }); return
      }
      const { data: restored, error: upErr } = await supabase.from('agency_sub_accounts')
        .update({
          agency_id: payload.agency_id,
          billing_owner: defaultBillingOwner,
          added_by: payload.invited_by,
          added_at: new Date().toISOString(),
          removed_at: null,
          updated_at: new Date().toISOString(),
        })
        .eq('id', existing.id)
        .select('*').single()
      if (upErr) { res.status(500).json({ error: upErr.message }); return }
      res.json({ sub_account: restored, restored: true }); return
    }

    const { data: inserted, error: insErr } = await supabase.from('agency_sub_accounts').insert({
      agency_id: payload.agency_id,
      tenant_id: tenantId,
      billing_owner: defaultBillingOwner,
      added_by: payload.invited_by,
    }).select('*').single()
    if (insErr) {
      if ((insErr as any).code === '23505') {
        res.status(409).json({ error: 'tenant already attached to an agency' }); return
      }
      res.status(500).json({ error: insErr.message }); return
    }
    res.json({ sub_account: inserted })
  })

  // ── PATCH /api/agencies/:id/sub-accounts/:tenant_id ────────────────────
  r.patch('/api/agencies/:id/sub-accounts/:tenant_id', requireAuth, async (req, res) => {
    const userId = (req as any).user?.id
    const agencyId = String(req.params.id)
    const tenantId = String(req.params.tenant_id)
    const member = await getMembership(supabase, agencyId, userId)
    if (!member || !isAdminRole(member.role)) { res.status(403).json({ error: 'owner or admin only' }); return }

    const parsed = PatchSubAccountBody.safeParse(req.body)
    if (!parsed.success) { res.status(400).json({ error: 'Invalid body', issues: parsed.error.issues }); return }
    if (Object.keys(parsed.data).length === 0) { res.status(400).json({ error: 'nothing to update' }); return }

    const { data, error } = await supabase.from('agency_sub_accounts')
      .update({ ...parsed.data, updated_at: new Date().toISOString() })
      .eq('agency_id', agencyId)
      .eq('tenant_id', tenantId)
      .is('removed_at', null)
      .select('*').maybeSingle()
    if (error) { res.status(500).json({ error: error.message }); return }
    if (!data) { res.status(404).json({ error: 'sub-account not found' }); return }
    res.json({ sub_account: data })
  })

  // ── DELETE /api/agencies/:id/sub-accounts/:tenant_id ────────────────────
  // Soft remove (stamps removed_at). Hard-remove would orphan revshare rows.
  r.delete('/api/agencies/:id/sub-accounts/:tenant_id', requireAuth, async (req, res) => {
    const userId = (req as any).user?.id
    const agencyId = String(req.params.id)
    const tenantId = String(req.params.tenant_id)
    const member = await getMembership(supabase, agencyId, userId)
    if (!member || !isAdminRole(member.role)) { res.status(403).json({ error: 'owner or admin only' }); return }

    const { error } = await supabase.from('agency_sub_accounts')
      .update({ removed_at: new Date().toISOString(), updated_at: new Date().toISOString() })
      .eq('agency_id', agencyId)
      .eq('tenant_id', tenantId)
      .is('removed_at', null)
    if (error) { res.status(500).json({ error: error.message }); return }
    res.json({ success: true })
  })

  // ── GET /api/agencies/:id/members ──────────────────────────────────────
  r.get('/api/agencies/:id/members', requireAuth, async (req, res) => {
    const userId = (req as any).user?.id
    const agencyId = String(req.params.id)
    const member = await getMembership(supabase, agencyId, userId)
    if (!member) { res.status(403).json({ error: 'not a member' }); return }

    const { data, error } = await supabase.from('agency_members')
      .select('id, user_id, role, invited_at, accepted_at')
      .eq('agency_id', agencyId)
      .order('invited_at', { ascending: false })
    if (error) { res.status(500).json({ error: error.message }); return }

    // Best-effort enrich with email from auth.users (admin API) — fall back
    // to raw user_id if unavailable so the page still renders.
    let withEmails: any[] = data ?? []
    try {
      const userIds = withEmails.map(m => m.user_id)
      const { data: users } = await (supabase as any).auth.admin.listUsers({ perPage: 200 })
      const map = new Map<string, string>()
      for (const u of (users?.users ?? []) as any[]) map.set(u.id, u.email)
      withEmails = withEmails.map(m => ({ ...m, email: map.get(m.user_id) ?? null }))
      void userIds
    } catch {
      // ignored — page still renders without emails
    }
    res.json({ members: withEmails })
  })

  // ── POST /api/agencies/:id/invite ──────────────────────────────────────
  r.post('/api/agencies/:id/invite', requireAuth, async (req, res) => {
    const userId = (req as any).user?.id
    const agencyId = String(req.params.id)
    const member = await getMembership(supabase, agencyId, userId)
    if (!member || !isAdminRole(member.role)) { res.status(403).json({ error: 'owner or admin only' }); return }

    const parsed = InviteMemberBody.safeParse(req.body)
    if (!parsed.success) { res.status(400).json({ error: 'Invalid body', issues: parsed.error.issues }); return }

    const { data: agency } = await supabase.from('agencies').select('name').eq('id', agencyId).maybeSingle()
    if (!agency) { res.status(404).json({ error: 'agency not found' }); return }

    const token = signInvite({
      v: 1, kind: 'member',
      agency_id: agencyId,
      email: parsed.data.email,
      role: parsed.data.role,
      invited_by: userId,
      exp: Math.floor(Date.now() / 1000) + 7 * 24 * 60 * 60,
    })
    const acceptUrl = `${process.env.FRONTEND_URL ?? 'http://localhost:5173'}/agency-invite/accept?token=${encodeURIComponent(token)}`

    try {
      await sendEmail({
        to: parsed.data.email,
        subject: `You're invited to ${agency.name} on Frequency`,
        html: `<p>You've been invited to join <strong>${agency.name}</strong> as <em>${parsed.data.role.replace(/_/g, ' ')}</em>.</p><p><a href="${acceptUrl}" style="display:inline-block;background:#0F6E56;color:#fff;text-decoration:none;font-weight:600;padding:10px 20px;border-radius:8px">Accept invite</a></p><p>This link expires in 7 days.</p>`,
        text: `Invited to ${agency.name} as ${parsed.data.role}.\n\nAccept: ${acceptUrl}\n\nLink expires in 7 days.`,
      })
    } catch (e: any) {
      console.warn('[agency] member invite email failed (non-fatal):', e?.message)
    }
    res.status(202).json({ success: true, accept_url: acceptUrl })
  })

  // ── POST /api/agency-invites/accept ────────────────────────────────────
  r.post('/api/agency-invites/accept', requireAuth, async (req, res) => {
    const userId = (req as any).user?.id
    const userEmail = String((req as any).user?.email ?? '').toLowerCase()
    const token = String(req.body?.token ?? '')
    if (!token) { res.status(400).json({ error: 'token required' }); return }

    const payload = verifyInvite<MemberInvitePayload>(token, 'member')
    if (!payload) { res.status(400).json({ error: 'invalid or expired token' }); return }
    if (payload.email !== userEmail) {
      res.status(403).json({ error: 'this invite is for a different email' }); return
    }

    const { data: inserted, error } = await supabase.from('agency_members').insert({
      agency_id: payload.agency_id,
      user_id: userId,
      role: payload.role,
      invited_by: payload.invited_by,
      accepted_at: new Date().toISOString(),
    }).select('*').single()
    if (error) {
      if ((error as any).code === '23505') { res.status(409).json({ error: 'already a member' }); return }
      res.status(500).json({ error: error.message }); return
    }
    res.json({ member: inserted })
  })

  // ── DELETE /api/agencies/:id/members/:member_id ────────────────────────
  r.delete('/api/agencies/:id/members/:member_id', requireAuth, async (req, res) => {
    const userId = (req as any).user?.id
    const agencyId = String(req.params.id)
    const memberId = String(req.params.member_id)
    const me = await getMembership(supabase, agencyId, userId)
    if (!me || !isAdminRole(me.role)) { res.status(403).json({ error: 'owner or admin only' }); return }

    // Refuse to delete the last owner — would orphan the agency.
    const { data: target } = await supabase.from('agency_members')
      .select('id, role, user_id').eq('id', memberId).eq('agency_id', agencyId).maybeSingle()
    if (!target) { res.status(404).json({ error: 'member not found' }); return }
    if (target.role === 'agency_owner') {
      const { count } = await supabase.from('agency_members')
        .select('id', { count: 'exact', head: true })
        .eq('agency_id', agencyId).eq('role', 'agency_owner')
      if ((count ?? 0) <= 1) { res.status(409).json({ error: 'cannot remove the last owner' }); return }
    }

    const { error } = await supabase.from('agency_members').delete().eq('id', memberId).eq('agency_id', agencyId)
    if (error) { res.status(500).json({ error: error.message }); return }
    res.json({ success: true })
  })

  // ── GET /api/agencies/:id/revshare ─────────────────────────────────────
  // Paginated ledger. Filters: status, from, to, tenant_id.
  r.get('/api/agencies/:id/revshare', requireAuth, async (req, res) => {
    const userId = (req as any).user?.id
    const agencyId = String(req.params.id)
    const member = await getMembership(supabase, agencyId, userId)
    if (!member) { res.status(403).json({ error: 'not a member' }); return }

    const page = Math.max(1, Number(req.query.page ?? 1) || 1)
    const pageSize = Math.min(200, Math.max(1, Number(req.query.pageSize ?? 50) || 50))
    const fromIso = req.query.from ? new Date(String(req.query.from)).toISOString() : null
    const toIso   = req.query.to   ? new Date(String(req.query.to)).toISOString()   : null
    const status  = req.query.status ? String(req.query.status) : null
    const tenantId = req.query.tenant_id ? String(req.query.tenant_id) : null

    let q = supabase.from('agency_revshare_entries')
      .select('id, tenant_id, invoice_id, period_start, period_end, base_amount_inr_paise, revshare_pct, revshare_amount_inr_paise, status, paid_at, created_at', { count: 'exact' })
      .eq('agency_id', agencyId)
      .order('period_start', { ascending: false })
      .range((page - 1) * pageSize, page * pageSize - 1)

    if (status)  q = q.eq('status', status)
    if (tenantId) q = q.eq('tenant_id', tenantId)
    if (fromIso) q = q.gte('period_start', fromIso)
    if (toIso)   q = q.lte('period_end', toIso)

    const { data, error, count } = await q
    if (error) { res.status(500).json({ error: error.message }); return }
    res.json({
      data: data ?? [],
      total: count ?? 0,
      page,
      pageSize,
      totalPages: count ? Math.ceil(count / pageSize) : 0,
    })
  })

  // ── GET /api/agencies/:id/revshare/summary ─────────────────────────────
  r.get('/api/agencies/:id/revshare/summary', requireAuth, async (req, res) => {
    const userId = (req as any).user?.id
    const agencyId = String(req.params.id)
    const member = await getMembership(supabase, agencyId, userId)
    if (!member) { res.status(403).json({ error: 'not a member' }); return }

    const ytdStart = new Date(new Date().getFullYear(), 0, 1).toISOString()

    const [{ data: accruedRows }, { data: paidRows }, { data: lastPayout }, { count: subCount }] = await Promise.all([
      supabase.from('agency_revshare_entries')
        .select('revshare_amount_inr_paise')
        .eq('agency_id', agencyId)
        .eq('status', 'accrued'),
      supabase.from('agency_revshare_entries')
        .select('revshare_amount_inr_paise')
        .eq('agency_id', agencyId)
        .eq('status', 'paid')
        .gte('paid_at', ytdStart),
      supabase.from('agency_payouts')
        .select('paid_at')
        .eq('agency_id', agencyId)
        .eq('status', 'paid')
        .order('paid_at', { ascending: false })
        .limit(1)
        .maybeSingle(),
      supabase.from('agency_sub_accounts')
        .select('id', { count: 'exact', head: true })
        .eq('agency_id', agencyId)
        .is('removed_at', null),
    ])

    const sumPaise = (rows: any[] | null): number =>
      (rows ?? []).reduce((acc, r) => acc + Number(r.revshare_amount_inr_paise ?? 0), 0)

    res.json({
      pending_payout_paise: sumPaise(accruedRows ?? null),
      paid_ytd_paise:       sumPaise(paidRows    ?? null),
      last_payout_at:       (lastPayout as any)?.paid_at ?? null,
      sub_account_count:    subCount ?? 0,
    })
  })

  // ─────────────────────────────────────────────────────────────────────
  // AGENCY BILLING (P1 #12 correction — migration 088)
  //
  // Mirrors the tenant billing flow in src/routes/billing.ts but scoped to
  // agencies. Tenant subs live in tenant_subscriptions; agency subs live in
  // agency_subscriptions. Invoice.paid webhook branches by which table the
  // razorpay_subscription_id resolves to.
  //
  // Routes:
  //   GET  /api/agency-plans                          — public; list of scope=agency plans
  //   GET  /api/agencies/:id/subscription             — member; active + plan summary
  //   POST /api/agencies/:id/billing/checkout         — owner; create Razorpay sub
  //   POST /api/agencies/:id/billing/refund           — owner; 14-day refund
  //   POST /api/agencies/:id/billing/cancel           — owner; cancel at period end
  // ─────────────────────────────────────────────────────────────────────

  /** Quarterly discount mirror of billing.ts. */
  const AGENCY_QUARTERLY_DISCOUNT_PCT = 0.10

  // ── GET /api/agency-plans ─────────────────────────────────────────────
  // Public. The pricing page lists agency tiers anonymously.
  r.get('/api/agency-plans', async (_req, res) => {
    const { data, error } = await supabase.from('plans')
      .select('id, name, max_sub_accounts, monthly_price_inr, price_inr_mo, price_inr_yr, features, agency_features, sort_order')
      .eq('scope', 'agency')
      .eq('is_active', true)
      .order('sort_order', { ascending: true })
    if (error) { res.status(500).json({ error: error.message }); return }
    res.json({ plans: data ?? [] })
  })

  // ── GET /api/agencies/:id/subscription ────────────────────────────────
  // Returns the most recent agency_subscriptions row (active preferred) +
  // the plan it points to. Used by the FE AgencyBillingPage to render the
  // "current plan" + sub-account usage card.
  r.get('/api/agencies/:id/subscription', requireAuth, async (req, res) => {
    const userId = (req as any).user?.id
    const agencyId = String(req.params.id)
    const member = await getMembership(supabase, agencyId, userId)
    if (!member) { res.status(403).json({ error: 'not a member' }); return }

    // Active preferred, else most recent.
    const { data: active } = await supabase.from('agency_subscriptions')
      .select('*, plans:plan_id ( id, name, max_sub_accounts, monthly_price_inr, price_inr_mo, price_inr_yr, agency_features )')
      .eq('agency_id', agencyId)
      .eq('status', 'active')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()
    let row: any = active
    if (!row) {
      const { data: anyRow } = await supabase.from('agency_subscriptions')
        .select('*, plans:plan_id ( id, name, max_sub_accounts, monthly_price_inr, price_inr_mo, price_inr_yr, agency_features )')
        .eq('agency_id', agencyId)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle()
      row = anyRow
    }

    // Current sub-account count for the usage bar.
    const { count: subAccountCount } = await supabase.from('agency_sub_accounts')
      .select('id', { count: 'exact', head: true })
      .eq('agency_id', agencyId)
      .is('removed_at', null)

    if (!row) {
      res.json({
        subscription: null,
        plan: null,
        sub_account_count: subAccountCount ?? 0,
        sub_account_max: 1, // trial cap
      })
      return
    }
    const plan = Array.isArray(row.plans) ? row.plans[0] : row.plans
    res.json({
      subscription: { ...row, plans: undefined },
      plan: plan ?? null,
      sub_account_count: subAccountCount ?? 0,
      sub_account_max: plan?.max_sub_accounts ?? null,
    })
  })

  // ── POST /api/agencies/:id/billing/checkout ───────────────────────────
  const AgencyCheckoutBody = z.object({
    plan_id:        z.enum(['agency_starter', 'agency_growth', 'agency_scale']),
    billing_period: z.enum(['monthly', 'quarterly', 'annual']).default('monthly'),
  })

  r.post('/api/agencies/:id/billing/checkout', requireAuth, async (req, res) => {
    const userId    = (req as any).user?.id
    const userEmail = (req as any).user?.email as string | undefined
    const agencyId  = String(req.params.id)
    const member    = await getMembership(supabase, agencyId, userId)
    if (!member || member.role !== 'agency_owner') {
      res.status(403).json({ error: 'agency owner only' }); return
    }
    const parsed = AgencyCheckoutBody.safeParse(req.body)
    if (!parsed.success) { res.status(400).json({ error: 'Invalid body', issues: parsed.error.issues }); return }
    const { plan_id, billing_period } = parsed.data

    // 1. Load the plan row.
    const { data: plan } = await supabase.from('plans')
      .select('id, name, scope, price_inr_mo, price_inr_yr, razorpay_plan_id_monthly, razorpay_plan_id_yearly, razorpay_plan_id_quarterly, agency_features')
      .eq('id', plan_id).maybeSingle()
    if (!plan)                       { res.status(404).json({ error: 'plan not found' }); return }
    if ((plan as any).scope !== 'agency') { res.status(400).json({ error: 'not an agency plan' }); return }

    const monthlyPaise = Number(plan.price_inr_mo ?? 0)
    if (monthlyPaise <= 0) { res.status(503).json({ error: `${plan.name} has no monthly price configured` }); return }

    // 2. Resolve the right Razorpay plan_id. Annual + monthly require
    // pre-provisioned columns (we don't auto-create here because agency
    // plans are few — admin provisions once in Razorpay dashboard). Quarterly
    // auto-provisioned on first checkout, exactly like the tenant flow.
    const planCol =
      billing_period === 'annual'    ? 'razorpay_plan_id_yearly'    :
      billing_period === 'quarterly' ? 'razorpay_plan_id_quarterly' :
                                       'razorpay_plan_id_monthly'
    let razorpayPlanId = (plan as any)[planCol] as string | null

    if (!razorpayPlanId && billing_period === 'quarterly') {
      try {
        const features: any = plan.agency_features ?? {}
        const quarterlyPaise = Number(features.quarterly_paise ?? 0)
                              || Math.round(monthlyPaise * 3 * (1 - AGENCY_QUARTERLY_DISCOUNT_PCT))
        const created = await createPlan({
          period:   'monthly',
          interval: 3,
          amount_paise: quarterlyPaise,
          name:        `Frequency ${plan.name} — Quarterly`,
          description: `${plan.name} agency plan, billed every 3 months (10% off monthly)`,
          notes:       { tier: plan_id, period: 'quarterly', scope: 'agency' },
        })
        razorpayPlanId = created.id
        await supabase.from('plans')
          .update({ razorpay_plan_id_quarterly: razorpayPlanId })
          .eq('id', plan_id)
      } catch (e: any) {
        console.error('[agency.checkout] quarterly plan creation failed', e?.message ?? e)
        res.status(502).json({ error: `Could not provision quarterly plan with Razorpay: ${e?.message ?? 'unknown error'}` })
        return
      }
    }
    if (!razorpayPlanId) {
      res.status(503).json({
        error: `${plan.name} (${billing_period}) isn't configured for online checkout yet — contact support to set it up.`,
      })
      return
    }

    try {
      // 3. Ensure Razorpay customer for this agency. Cache id on agencies row.
      const { data: agencyRow } = await supabase.from('agencies')
        .select('id, name, razorpay_customer_id').eq('id', agencyId).maybeSingle()
      if (!agencyRow) { res.status(404).json({ error: 'agency not found' }); return }
      let customerId = agencyRow.razorpay_customer_id ?? null
      if (!customerId) {
        const cust = await ensureCustomer({
          email:   userEmail ?? `agency-${agencyId}@frequency.in`,
          name:    agencyRow.name,
          notes:   { agency_id: agencyId, owner_user_id: userId },
        })
        customerId = cust.id
        await supabase.from('agencies').update({
          razorpay_customer_id: customerId,
          updated_at: new Date().toISOString(),
        }).eq('id', agencyId)
      }

      // 4. Total_count mirroring tenant rules.
      const totalCount =
        billing_period === 'annual'    ? 10  :
        billing_period === 'quarterly' ? 40  :
                                         120
      const sub = await createSubscription({
        plan_id:     razorpayPlanId,
        customer_id: customerId,
        notes:       { agency_id: agencyId, plan_id, billing_period, scope: 'agency' },
        total_count: totalCount,
      })

      // 5. Charge amount snapshot for the row. Annual uses price_inr_yr.
      const amountPaise =
        billing_period === 'annual'    ? Number(plan.price_inr_yr ?? 0) :
        billing_period === 'quarterly' ? Number((plan.agency_features as any)?.quarterly_paise ?? Math.round(monthlyPaise * 3 * (1 - AGENCY_QUARTERLY_DISCOUNT_PCT))) :
                                         monthlyPaise

      // 6. Persist agency_subscriptions row. New row per plan change (history).
      const { data: inserted, error: insErr } = await supabase.from('agency_subscriptions').insert({
        agency_id:                agencyId,
        plan_id,
        razorpay_subscription_id: sub.id,
        razorpay_customer_id:     customerId,
        status:                   'pending',
        billing_period,
        amount_inr_paise:         amountPaise,
      }).select('*').single()
      if (insErr) {
        console.error('[agency.checkout] insert agency_subscriptions failed', insErr.message)
        res.status(500).json({ error: insErr.message }); return
      }

      // 7. Stamp the agency.current_subscription_id pointer.
      await supabase.from('agencies').update({
        plan_id,
        current_subscription_id: inserted.id,
        updated_at: new Date().toISOString(),
      }).eq('id', agencyId)

      res.json({
        razorpay_key_id:          process.env.RAZORPAY_KEY_ID,
        razorpay_subscription_id: sub.id,
        razorpay_short_url:       sub.short_url,
        billing_period,
        subscription_id:          inserted.id,
      })
    } catch (e: any) {
      console.error('[agency.checkout]', e?.message ?? e)
      res.status(500).json({ error: e?.message ?? 'Checkout failed' })
    }
  })

  // ── POST /api/agencies/:id/billing/refund ─────────────────────────────
  // 14-day server-enforced window measured from agency_subscriptions.created_at
  // of the most recent (non-cancelled) row. Mirror of tenant flow.
  r.post('/api/agencies/:id/billing/refund', requireAuth, async (req, res) => {
    const userId = (req as any).user?.id
    const agencyId = String(req.params.id)
    const member = await getMembership(supabase, agencyId, userId)
    if (!member || member.role !== 'agency_owner') {
      res.status(403).json({ error: 'agency owner only' }); return
    }
    const reason = String(req.body?.reason ?? '').slice(0, 500) || undefined

    const { data: sub } = await supabase.from('agency_subscriptions')
      .select('id, razorpay_subscription_id, status, created_at, refund_initiated_at, refund_amount_inr_paise')
      .eq('agency_id', agencyId)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()
    if (!sub?.razorpay_subscription_id) {
      res.status(404).json({ error: 'No agency subscription to refund' }); return
    }
    if (sub.refund_initiated_at) {
      res.status(409).json({ error: 'A refund has already been initiated for this subscription' }); return
    }
    if (sub.status !== 'active' && sub.status !== 'pending') {
      res.status(400).json({ error: `Subscription is ${sub.status} — refund only available for active subscriptions` }); return
    }
    const ageMs = Date.now() - new Date(sub.created_at).getTime()
    const FOURTEEN_DAYS_MS = 14 * 24 * 60 * 60 * 1000
    if (ageMs > FOURTEEN_DAYS_MS) {
      res.status(400).json({ error: 'Subscription is past the 14-day refund window. Please contact support to discuss options.' })
      return
    }

    try {
      const payments = await listSubscriptionPayments(sub.razorpay_subscription_id)
      const captured = payments.find(p => p.status === 'captured')
      if (!captured) {
        try { await cancelSubscription(sub.razorpay_subscription_id, { atCycleEnd: false }) } catch { /* non-fatal */ }
        await supabase.from('agency_subscriptions').update({
          status:                  'cancelled',
          cancelled_at:            new Date().toISOString(),
          refund_initiated_at:     new Date().toISOString(),
          refund_amount_inr_paise: 0,
        }).eq('id', sub.id)
        res.json({
          success: true,
          refunded_paise: 0,
          message: 'Subscription cancelled — no payment had been captured yet, so there\'s nothing to refund.',
        })
        return
      }

      const refund = await createRefund({
        payment_id: captured.id,
        notes: { agency_id: agencyId, user_id: userId, reason: reason ?? 'within_14d_no_questions', source: 'in_app_agency_billing' },
      })
      try { await cancelSubscription(sub.razorpay_subscription_id, { atCycleEnd: false }) } catch { /* non-fatal */ }

      await supabase.from('agency_subscriptions').update({
        status:                  'cancelled',
        cancelled_at:            new Date().toISOString(),
        refund_initiated_at:     new Date().toISOString(),
        refund_amount_inr_paise: captured.amount,
        refund_razorpay_id:      refund.id,
      }).eq('id', sub.id)

      const amountDisplay = (captured.amount / 100).toLocaleString('en-IN')
      res.json({
        success: true,
        refund_id: refund.id,
        refunded_paise: captured.amount,
        status: refund.status,
        message: `Refund initiated. ₹${amountDisplay} will be returned within 5–7 business days.`,
      })
    } catch (e: any) {
      console.error('[agency.refund]', e?.message ?? e)
      res.status(500).json({ error: e?.message ?? 'Refund failed' })
    }
  })

  // ── POST /api/agencies/:id/billing/cancel ─────────────────────────────
  r.post('/api/agencies/:id/billing/cancel', requireAuth, async (req, res) => {
    const userId = (req as any).user?.id
    const agencyId = String(req.params.id)
    const member = await getMembership(supabase, agencyId, userId)
    if (!member || member.role !== 'agency_owner') {
      res.status(403).json({ error: 'agency owner only' }); return
    }
    const atCycleEnd = req.body?.at_cycle_end !== false

    const { data: sub } = await supabase.from('agency_subscriptions')
      .select('id, razorpay_subscription_id')
      .eq('agency_id', agencyId)
      .eq('status', 'active')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()
    if (!sub?.razorpay_subscription_id) {
      res.status(404).json({ error: 'No active subscription to cancel' }); return
    }

    try {
      await cancelSubscription(sub.razorpay_subscription_id, { atCycleEnd })
      await supabase.from('agency_subscriptions').update({
        cancelled_at: new Date().toISOString(),
        // status stays 'active' until period_end if scheduled; webhook flips it.
      }).eq('id', sub.id)
      res.json({ success: true, scheduled_at_cycle_end: atCycleEnd })
    } catch (e: any) {
      console.error('[agency.cancel]', e?.message ?? e)
      res.status(500).json({ error: e?.message ?? 'Cancel failed' })
    }
  })

  // ── GET /api/agencies/:id/payouts ──────────────────────────────────────
  r.get('/api/agencies/:id/payouts', requireAuth, async (req, res) => {
    const userId = (req as any).user?.id
    const agencyId = String(req.params.id)
    const member = await getMembership(supabase, agencyId, userId)
    if (!member) { res.status(403).json({ error: 'not a member' }); return }

    const { data, error } = await supabase.from('agency_payouts')
      .select('*')
      .eq('agency_id', agencyId)
      .order('period_start', { ascending: false })
      .limit(120)
    if (error) { res.status(500).json({ error: error.message }); return }
    res.json({ payouts: data ?? [] })
  })

  return r
}
