/**
 * Naruto Platform OS — tenant lifecycle (§4) + create-tenant / onboarding Step 1 (§5).
 *
 * Mounted at root; every route carries its own /api/naruto/* path (mirrors the
 * super-admin router). Guarded by `requirePlatformCapability` and audited via
 * `recordPlatformAudit` — the capability model of Part I §1.
 *
 *   POST /api/naruto/tenants                          create tenant   (onboarding.wizard.run)
 *   GET  /api/naruto/tenants/:id/lifecycle            state + time-in-state + signals (tenant.read)
 *   POST /api/naruto/tenants/:id/recompute-lifecycle  force a recompute (tenant.read)
 *
 * CREATE reuses the existing provisioning rails rather than forking them:
 *   • lib/slug.ensureUniqueSlug           — the same slug minting as /api/onboarding
 *                                           and desktop-provision.
 *   • the exact provisioning SEQUENCE documented in routes/desktop-provision.ts
 *     (owner auth user → tenant insert → owner role assignment → active/trial
 *      subscription → branding + profile). Entitlements are NOT seeded: they
 *      resolve automatically from plan_features × vertical via lib/entitlements —
 *      creating the subscription on the right plan is what grants them.
 * It intentionally does NOT call desktop-provision's `provisionTenant`, which is
 * aggregator-coupled (hardcoded horeca + enterprise, requires ≥1 outlet with
 * Swiggy/Zomato channels, idempotency keyed on channel resIds) and so cannot
 * create a salon/d2c/etc tenant on an arbitrary plan. The owner-user helper here
 * is a fresh ~15-liner because provenance differs (source: 'naruto_platform', not
 * 'frequency_desktop').
 */

import express from 'express'
import { z } from 'zod'
import type { SupabaseClient } from '@supabase/supabase-js'
import { ensureUniqueSlug } from '../lib/slug'
import { requirePlatformCapability } from '../lib/platform-guard'
import { recordPlatformAudit } from '../lib/platform-audit'
import { recomputeTenantLifecycle, gatherSignals, computeLifecycleState } from '../lib/tenant-lifecycle'

type Middleware = (req: express.Request, res: express.Response, next: express.NextFunction) => void | Promise<void>

interface Deps {
  supabase: SupabaseClient
  requireAuth: Middleware
}

// Canonical verticals (spec §5 Step 1). The five business GROUPS the entitlements
// engine gates on (lib/entitlements.businessGroup) — not the long raw-type list.
const VERTICALS = ['horeca', 'salon', 'real_estate', 'd2c', 'other'] as const

const CreateTenantSchema = z.object({
  businessName: z.string().trim().min(1).max(120),
  vertical: z.enum(VERTICALS),
  planId: z.string().trim().min(1).max(64).optional(),
  trialDays: z.number().int().min(0).max(90).optional(),
  ownerName: z.string().trim().min(1).max(80),
  ownerEmail: z.string().trim().email().max(200),
  ownerPhone: z.string().trim().max(20).optional(),
  gstin: z.string().trim().max(20).optional(),
  address: z.string().trim().max(400).optional(),
  timezone: z.string().trim().max(64).optional(),
  currency: z.string().trim().max(8).optional(),
  reason: z.string().trim().max(400).optional(),
})
type CreateTenantInput = z.infer<typeof CreateTenantSchema>

/** Create the owner auth user, or resolve the existing one if the email is taken.
 *  Mirrors desktop-provision's helper but tags provenance as operator-created. */
async function getOrCreateOwnerUser(
  supabase: SupabaseClient, email: string, fullName: string,
): Promise<string> {
  const wanted = email.toLowerCase()
  const { data, error } = await supabase.auth.admin.createUser({
    email: wanted,
    email_confirm: true,
    user_metadata: { source: 'naruto_platform', full_name: fullName },
  })
  if (!error && (data as any)?.user?.id) return (data as any).user.id

  // Email already registered — resolve it. (supabase-js has no getUserByEmail.)
  // ponytail: O(users) listUsers scan. Ceiling: fine at current scale; swap for
  // a keyed RPC lookup if the user table grows large.
  for (let page = 1; page <= 20; page++) {
    const { data: list } = await supabase.auth.admin.listUsers({ page, perPage: 200 })
    const users = (list as any)?.users ?? []
    const found = users.find((u: any) => (u.email ?? '').toLowerCase() === wanted)
    if (found) return found.id
    if (users.length < 200) break
  }
  throw new Error(`owner user create/resolve failed for ${email}: ${error?.message ?? 'not found'}`)
}

async function createTenant(supabase: SupabaseClient, input: CreateTenantInput) {
  const businessName = input.businessName.trim()
  const ownerEmail = input.ownerEmail.trim().toLowerCase()

  // ── 1. Owner auth user (get-or-create; email is the unique identity) ────────
  const ownerUserId = await getOrCreateOwnerUser(supabase, ownerEmail, input.ownerName.trim())

  // ── Idempotency: a double-submit for the same owner + business must not spawn
  //    a duplicate workspace. Return the existing active one instead. ──────────
  const { data: dupe } = await supabase.from('tenants')
    .select('id, slug, business_name, business_type, status, lifecycle_state, state_entered_at')
    .eq('user_id', ownerUserId)
    .eq('business_name', businessName)
    .neq('status', 'deleted')
    .maybeSingle()
  if (dupe) return { tenant: dupe, ownerUserId, created: false }

  // ── 2. Tenant row (same shape as /api/onboarding + billing identity) ────────
  const slug = await ensureUniqueSlug(supabase, businessName, ownerUserId)
  const insert: Record<string, unknown> = {
    user_id: ownerUserId,
    business_name: businessName,
    slug,
    status: 'active',
    business_type: input.vertical,
    lifecycle_state: 'provisioned',
    state_entered_at: new Date().toISOString(),
    timezone: input.timezone || 'Asia/Kolkata',
    currency: input.currency || 'INR',
  }
  if (input.gstin) insert.gstin = input.gstin
  if (ownerEmail) insert.billing_email = ownerEmail
  if (input.address) insert.billing_address = input.address

  const { data: tenant, error: tErr } = await supabase.from('tenants')
    .insert(insert).select().single()
  if (tErr || !tenant) throw new Error(`tenant insert failed: ${tErr?.message ?? 'no row'}`)
  const tenantId = (tenant as any).id as string

  // ── 3. Owner role. RBAC assignment (member listings) + legacy user_roles row
  //    (so identifyTenant resolves the owner on their first login). ────────────
  const { data: ownerRole } = await supabase.from('role_definitions')
    .select('id').eq('key', 'owner').eq('scope', 'tenant').maybeSingle()
  if ((ownerRole as any)?.id) {
    const { error: rErr } = await supabase.from('user_role_assignments').insert({
      user_id: ownerUserId, tenant_id: tenantId,
      role_id: (ownerRole as any).id, accepted_at: new Date().toISOString(),
    })
    if (rErr && (rErr as any).code !== '23505') {
      console.warn(`[naruto-create] owner role assign non-fatal: ${rErr.message}`)
    }
  }
  {
    const { error: urErr } = await supabase.from('user_roles')
      .insert({ user_id: ownerUserId, tenant_id: tenantId, role: 'admin' })
    if (urErr && (urErr as any).code !== '23505') {
      console.warn(`[naruto-create] legacy user_roles insert non-fatal: ${urErr.message}`)
    }
  }

  // ── 4. Subscription — grants default entitlements (plan_features × vertical).
  //    Trial when trialDays given, else active. Only when a plan is chosen. ─────
  if (input.planId) {
    const trialing = (input.trialDays ?? 0) > 0
    const sub: Record<string, unknown> = {
      tenant_id: tenantId,
      plan_id: input.planId,
      status: trialing ? 'trial' : 'active',  // 'trial' is the value the check-constraint + trial-ending worker use
      updated_at: new Date().toISOString(),
    }
    if (trialing) {
      sub.trial_ends_at = new Date(Date.now() + (input.trialDays as number) * 86_400_000).toISOString()
    }
    const { error: sErr } = await supabase.from('tenant_subscriptions')
      .upsert(sub, { onConflict: 'tenant_id' })
    if (sErr) throw new Error(`subscription failed: ${sErr.message}`)
  }

  // ── 5. Branding + owner profile (fail-soft cosmetic identity). ──────────────
  try {
    const branding: Record<string, unknown> = {
      tenant_id: tenantId, display_name: businessName, updated_at: new Date().toISOString(),
    }
    if (input.address) branding.address = input.address
    if (input.ownerPhone) branding.support_phone = input.ownerPhone
    const { error } = await supabase.from('tenant_branding').upsert(branding, { onConflict: 'tenant_id' })
    if (error) console.warn(`[naruto-create] branding upsert non-fatal: ${error.message}`)
  } catch (e: any) { console.warn(`[naruto-create] branding skipped: ${e?.message ?? e}`) }
  try {
    const profile: Record<string, unknown> = {
      id: ownerUserId, full_name: input.ownerName.trim(), updated_at: new Date().toISOString(),
    }
    if (input.ownerPhone) profile.wa_number = input.ownerPhone
    const { error } = await supabase.from('profiles').upsert(profile, { onConflict: 'id' })
    if (error) console.warn(`[naruto-create] profile upsert non-fatal: ${error.message}`)
  } catch (e: any) { console.warn(`[naruto-create] profile skipped: ${e?.message ?? e}`) }

  return { tenant, ownerUserId, created: true }
}

export function createNarutoTenantsRouter(deps: Deps): express.Router {
  const r = express.Router()
  const { supabase, requireAuth } = deps

  // ─── Create tenant (onboarding Step 1) ──────────────────────────────────────
  r.post('/api/naruto/tenants',
    requireAuth, requirePlatformCapability(supabase, 'onboarding.wizard.run'),
    async (req, res) => {
      const parsed = CreateTenantSchema.safeParse(req.body ?? {})
      if (!parsed.success) {
        res.status(400).json({ error: 'Invalid input', details: parsed.error.flatten() }); return
      }
      try {
        const { tenant, ownerUserId, created } = await createTenant(supabase, parsed.data)
        const t = tenant as any
        if (created) {
          await recordPlatformAudit(supabase, req, {
            capability: 'onboarding.wizard.run',
            action: 'tenant.create',
            tenant_id: t.id,
            target_user_id: ownerUserId,
            before: null,
            after: {
              business_name: t.business_name, business_type: parsed.data.vertical,
              plan_id: parsed.data.planId ?? null, trial_days: parsed.data.trialDays ?? 0,
              owner_email: parsed.data.ownerEmail, slug: t.slug,
            },
            reason: parsed.data.reason ?? null,
          })
        }
        res.status(created ? 201 : 200).json({ tenant, ownerUserId, created })
      } catch (e: any) {
        console.error('[naruto-create] failed:', e?.message ?? e)
        res.status(500).json({ error: e?.message ?? 'Create failed' })
      }
    })

  // ─── Lifecycle: current state + time-in-state + the signal trace ────────────
  r.get('/api/naruto/tenants/:id/lifecycle',
    requireAuth, requirePlatformCapability(supabase, 'tenant.read'),
    async (req, res) => {
      const id = String(req.params.id)
      const { data: t } = await supabase.from('tenants')
        .select('id, lifecycle_state, state_entered_at').eq('id', id).maybeSingle()
      if (!t) { res.status(404).json({ error: 'Tenant not found' }); return }
      const signals = await gatherSignals(supabase, id)
      res.json({
        tenantId: id,
        state: (t as any).lifecycle_state ?? null,
        // Live recompute for the trace, so the drawer shows the state the current
        // signals imply (may differ from the stored value until next recompute).
        computed: signals ? computeLifecycleState(signals) : null,
        stateEnteredAt: (t as any).state_entered_at ?? null,
        timeInStateMs: (t as any).state_entered_at
          ? Date.now() - new Date((t as any).state_entered_at).getTime() : null,
        signals,
      })
    })

  // ─── Lifecycle: force a recompute (idempotent; persists only on change) ──────
  // On-event hook surface too — call recomputeTenantLifecycle(supabase, id)
  // directly from event sites (see WIRE note below) rather than over HTTP.
  r.post('/api/naruto/tenants/:id/recompute-lifecycle',
    requireAuth, requirePlatformCapability(supabase, 'tenant.read'),
    async (req, res) => {
      const id = String(req.params.id)
      try {
        const result = await recomputeTenantLifecycle(supabase, id)
        if (!result) { res.status(404).json({ error: 'Tenant not found' }); return }
        res.json(result)
      } catch (e: any) {
        res.status(500).json({ error: e?.message ?? 'Recompute failed' })
      }
    })

  return r
}

// ─── WIRE(naruto) — mounting + scheduling + event hooks ───────────────────────
// 1. Mount (flowgpt-server/src/index.ts, near the other createXRouter mounts
//    ~line 5983, next to createSuperAdminRouter):
//        app.use(createNarutoTenantsRouter({ supabase, requireAuth }))
//    (Router declares full /api/naruto/* paths, so mount at root — no prefix.)
// 2. Nightly recompute (flowgpt-server/src/queue.ts): register a daily repeatable
//    `system.cron` job that calls recomputeAllTenants(supabase). Reuse the
//    existing singleton cron poller (~queue.ts:304) — do NOT add a new worker.
// 3. On-event recompute hooks — call recomputeTenantLifecycle(supabase, tenantId)
//    (fire-and-forget, .catch(console.error)) at these existing sites so state is
//    fresh between nightly runs:
//      • order placed/settled — order lifecycle writers (aggregator + storefront)
//      • tenant suspend / reactivate — routes/super-admin.ts (:213 / :236)
//      • last-active touch — lib/last-active.ts (throttled; optional)
//      • go-live checklist completion — §8 wave, when it lands
