/**
 * Frequency Desktop — first-login provisioning handshake (M1).
 *
 * The desktop app runs the Frequency web app AND logs the merchant into their
 * OWN Swiggy/Zomato dashboard in hidden webviews. For an EXISTING merchant the
 * bridge already streams orders under their logged-in Frequency session. For a
 * BRAND-NEW merchant there is no Frequency account yet — this module closes that
 * gap: from the business identity + outlet set the aggregator session exposes,
 * it IDEMPOTENTLY provisions a fresh HoReCa tenant + owner on the Enterprise
 * plan with one storefront outlet per PHYSICAL outlet — a location listed on both
 * Swiggy and Zomato under different ids is ONE outlet carrying both channel ids —
 * then returns a magic action-link the desktop loads to sign its Frequency web
 * view in, no password re-typed.
 *
 * Trust boundary: no Frequency session exists yet, so the HTTP route gates on a
 * shared desktop provisioning secret (same trust model as the storefront
 * X-Admin-Secret). This module only intends horeca + enterprise; role/plan are
 * NEVER taken from the client. All inputs are validated by zod at the route.
 *
 * The orchestration (`provisionTenant`) takes injectable deps so a framework-free
 * self-check can drive the whole flow through an in-memory fake and assert the
 * exact side effects (see desktop-provision.selfcheck.ts).
 */

import { z } from 'zod'
import type { SupabaseClient } from '@supabase/supabase-js'
import { ensureUniqueSlug } from '../lib/slug'

// Fixed by this flow — deliberately NOT client-controllable.
const INTEGRATION_KEY = 'aggregator_frequency_desktop'
const ENTERPRISE_PLAN_ID = 'enterprise'
const BUSINESS_TYPE = 'horeca'
const OWNER_EMAIL_DOMAIN = 'desktop.getfrequency.app'

export const PlatformSchema = z.enum(['swiggy', 'zomato'])
export type Platform = z.infer<typeof PlatformSchema>

// A delivery channel = one aggregator listing (platform + its resId). A physical
// outlet carries one per platform it's live on (typically Swiggy AND Zomato).
const ChannelSchema = z.object({
  platform: PlatformSchema,
  resId: z.string().trim().min(1).max(64),
})

// A PHYSICAL outlet: one real location, many delivery channels.
const OutletSchema = z.object({
  name: z.string().trim().min(1).max(120),
  address: z.string().trim().max(400).optional(),
  gst: z.string().trim().max(32).optional(),
  phone: z.string().trim().max(20).optional(),
  channels: z.array(ChannelSchema).min(1).max(8),
})

export const ProvisionPayloadSchema = z.object({
  businessName: z.string().trim().min(1).max(120),
  ownerEmail: z.string().trim().email().max(200).optional(),
  ownerPhone: z.string().trim().max(20).optional(),
  outlets: z.array(OutletSchema).min(1).max(200),
  // Optional captured menu snapshot(s); per-outlet import is deferred in M1 core
  // (the existing /menu/ingest path handles it once the tenant is logged in).
  menu: z.unknown().optional(),
})
export type ProvisionPayload = z.infer<typeof ProvisionPayloadSchema>
export type OutletInput = z.infer<typeof OutletSchema>
export type Channel = z.infer<typeof ChannelSchema>

export interface OutletMapping {
  outletId: string | null // storefront outlet id; null if storefront-api was unreachable
  name: string
  channels: Channel[] // the delivery channels attached to this one physical outlet
}

/** Resolve an inbound order's (platform, resId) to the physical outlet it belongs
 *  to. Mirrors the dashboard, which resolves via the outlet's swiggyResId/zomatoResId. */
export function outletIdForChannel(
  mapping: OutletMapping[],
  platform: Platform,
  resId: string,
): string | null {
  for (const m of mapping) {
    if (m.channels.some(c => c.platform === platform && c.resId === resId)) return m.outletId
  }
  return null
}

export interface ProvisionResult {
  ok: true
  created: boolean // false on an idempotent re-provision
  tenantId: string
  slug: string
  businessType: typeof BUSINESS_TYPE
  plan: typeof ENTERPRISE_PLAN_ID
  ownerUserId: string
  ownerEmail: string
  ownerEmailPlaceholder: boolean
  loginUrl: string | null
  outlets: OutletMapping[]
  outletsPending: boolean // true if any storefront outlet couldn't be created now
  integration: typeof INTEGRATION_KEY
}

export interface ProvisionDeps {
  /** Create ONE storefront outlet for `slug` from a physical outlet, returning its
   *  id. In prod this POSTs to storefront-api's admin outlet CRUD (setting BOTH
   *  swiggyResId + zomatoResId from the outlet's channels); the self-check injects
   *  a fake. */
  createOutlet: (slug: string, outlet: OutletInput) => Promise<{ id: string }>
  /** Mint a passwordless login link for the owner (magic action-link). */
  generateLoginLink: (email: string) => Promise<string | null>
  /** Resolve a unique tenant slug. Defaults to ensureUniqueSlug. */
  makeSlug?: (businessName: string, fallbackId: string) => Promise<string>
}

/** Every channel across every outlet as sorted `platform:resId` tokens — the
 *  canonical fingerprint of a merchant regardless of outlet/channel order. */
function channelTokens(outlets: { channels: Channel[] }[]): string[] {
  return outlets.flatMap(o => o.channels.map(c => `${c.platform}:${c.resId}`)).sort()
}

/** Stable idempotency key = ALL channel resIds (across all outlets), sorted and
 *  joined. A re-login triggered by ANY platform's order resolves to the same key
 *  → the same tenant, so re-provisioning creates zero duplicates. */
export function provisionKeyFor(outlets: { channels: Channel[] }[]): string {
  return channelTokens(outlets).join('|')
}

/** Derived placeholder owner email when the session exposed no real email. Keyed
 *  off the first (sorted) channel token so it's stable for the merchant. */
function derivedOwnerEmail(outlets: { channels: Channel[] }[]): string {
  const primary = (channelTokens(outlets)[0] ?? 'unknown').replace(':', '-')
  return `owner+${primary}@${OWNER_EMAIL_DOMAIN}`.toLowerCase()
}

/**
 * The orchestration. Idempotent on the platform business identity: a second
 * identical call returns the existing tenant and mints a fresh login link — it
 * never creates a duplicate tenant, owner, subscription, role, or outlet.
 */
export async function provisionTenant(
  supabase: SupabaseClient,
  payload: ProvisionPayload,
  deps: ProvisionDeps,
): Promise<ProvisionResult> {
  const outlets = payload.outlets
  const businessName = payload.businessName.trim()
  const key = provisionKeyFor(outlets)

  const emailIsPlaceholder = !payload.ownerEmail
  const ownerEmail = (payload.ownerEmail?.trim() || derivedOwnerEmail(outlets)).toLowerCase()

  // ── 1. Idempotency: has this business identity already been provisioned? ────
  // The desktop_provision_key lives on the aggregator integration row we write
  // at the end, so its presence is the "already done" marker. Filter in JS to
  // stay portable (no PostgREST json-operator coupling); the desktop-provisioned
  // set is small.
  // ponytail: JS-side filter over all frequency_desktop integrations. Ceiling:
  // fine at current tenant counts; index metadata->>desktop_provision_key and
  // switch to a server-side .eq if this ever gets large.
  const { data: existingRows } = await supabase
    .from('tenant_integrations')
    .select('tenant_id, metadata')
    .eq('key', INTEGRATION_KEY)
  const existing = (existingRows ?? []).find(
    (r: any) => r?.metadata?.desktop_provision_key === key,
  ) as { tenant_id: string; metadata: any } | undefined

  if (existing?.tenant_id) {
    const { data: t } = await supabase
      .from('tenants')
      .select('id, slug, user_id, business_type')
      .eq('id', existing.tenant_id)
      .maybeSingle()
    const existingEmail = existing.metadata?.owner_email || ownerEmail
    const loginUrl = await deps.generateLoginLink(existingEmail)
    return {
      ok: true,
      created: false,
      tenantId: existing.tenant_id,
      slug: (t as any)?.slug ?? '',
      businessType: BUSINESS_TYPE,
      plan: ENTERPRISE_PLAN_ID,
      ownerUserId: (t as any)?.user_id ?? '',
      ownerEmail: existingEmail,
      ownerEmailPlaceholder: !!existing.metadata?.owner_email_placeholder,
      loginUrl,
      outlets: (existing.metadata?.outlets as OutletMapping[]) ?? [],
      outletsPending: !!existing.metadata?.outlets_pending,
      integration: INTEGRATION_KEY,
    }
  }

  // ── 2. Owner auth user (get-or-create; email is the unique identity) ────────
  const ownerUserId = await getOrCreateOwnerUser(supabase, ownerEmail, key, emailIsPlaceholder)

  // ── 3. Tenant — reuse the onboarding shape (horeca, active, unique slug) ────
  const makeSlug = deps.makeSlug ?? ((name: string, fallbackId: string) => ensureUniqueSlug(supabase, name, fallbackId))
  const slug = await makeSlug(businessName, ownerUserId)
  const { data: tenant, error: tErr } = await supabase
    .from('tenants')
    .insert({ user_id: ownerUserId, business_name: businessName, slug, status: 'active', business_type: BUSINESS_TYPE })
    .select()
    .single()
  if (tErr || !tenant) throw new Error(`tenant insert failed: ${tErr?.message ?? 'no row'}`)
  const tenantId = (tenant as any).id as string

  // ── 4. Owner role (RBAC). The app derives owner from tenants.user_id, but we
  //    also write the assignment so member/RBAC listings see the owner. ────────
  const { data: ownerRole } = await supabase
    .from('role_definitions')
    .select('id')
    .eq('key', 'owner')
    .eq('scope', 'tenant')
    .maybeSingle()
  if ((ownerRole as any)?.id) {
    const { error: rErr } = await supabase.from('user_role_assignments').insert({
      user_id: ownerUserId,
      tenant_id: tenantId,
      role_id: (ownerRole as any).id,
      accepted_at: new Date().toISOString(),
    })
    // 23505 (already assigned) is non-fatal — idempotent re-runs land here.
    if (rErr && (rErr as any).code !== '23505') {
      console.warn(`[desktop-provision] owner role assign non-fatal: ${rErr.message}`)
    }
  }

  // ── 5. Enterprise subscription (all features/usage on). Upsert on tenant_id
  //    (one subscription per tenant). status=active so entitlements grant now. ─
  const { error: subErr } = await supabase.from('tenant_subscriptions').upsert(
    { tenant_id: tenantId, plan_id: ENTERPRISE_PLAN_ID, status: 'active', updated_at: new Date().toISOString() },
    { onConflict: 'tenant_id' },
  )
  if (subErr) throw new Error(`enterprise subscription failed: ${subErr.message}`)

  // ── 6. One storefront outlet per PHYSICAL outlet (both channel ids attached)
  //    + per-outlet channel mapping so inbound (platform,resId) resolves here. ──
  const mapping: OutletMapping[] = []
  let outletsPending = false
  for (const o of outlets) {
    try {
      const { id } = await deps.createOutlet(slug, o)
      mapping.push({ outletId: id, name: o.name, channels: o.channels })
    } catch (e: any) {
      // Never fail the whole provision on a storefront hiccup — record the outlet
      // unmapped so it can be reconciled; the tenant/enterprise/integration stand.
      outletsPending = true
      mapping.push({ outletId: null, name: o.name, channels: o.channels })
      const ids = o.channels.map(c => `${c.platform}:${c.resId}`).join(',')
      console.warn(`[desktop-provision] outlet create failed for [${ids}]: ${e?.message ?? e}`)
    }
  }

  // ── 7. Activate the aggregator integration + persist the idempotency ledger
  //    AND the authoritative resId↔outletId mapping (same DB as aggregator_orders
  //    so inbound orders keyed by resId resolve to the right storefront outlet).
  //    Mirrors the frequency-desktop/connect upsert exactly. ───────────────────
  const { error: iErr } = await supabase.from('tenant_integrations').upsert(
    {
      tenant_id: tenantId,
      user_id: ownerUserId,
      key: INTEGRATION_KEY,
      status: 'active',
      scope: 'order_management',
      brand_label: 'Zomato/Swiggy · Frequency Desktop',
      metadata: {
        source: 'frequency_desktop',
        desktop_provision_key: key,
        owner_email: ownerEmail,
        owner_email_placeholder: emailIsPlaceholder,
        outlets: mapping,
        outlets_pending: outletsPending,
      },
    },
    { onConflict: 'tenant_id,key' },
  )
  if (iErr) throw new Error(`integration activate failed: ${iErr.message}`)

  // ── 8. Branding + owner profile so the tenant shows its REAL name everywhere
  //    (storefront + dashboard) with zero manual setup. Fail-SOFT: a hiccup here
  //    must never abort a provision — the tenant/enterprise/integration already
  //    stand, and this is cosmetic identity that can be re-derived. ─────────────
  await applyBrandingAndProfile(supabase, {
    tenantId, ownerUserId, businessName, ownerPhone: payload.ownerPhone, outlets,
  })

  const loginUrl = await deps.generateLoginLink(ownerEmail)

  return {
    ok: true,
    created: true,
    tenantId,
    slug,
    businessType: BUSINESS_TYPE,
    plan: ENTERPRISE_PLAN_ID,
    ownerUserId,
    ownerEmail,
    ownerEmailPlaceholder: emailIsPlaceholder,
    loginUrl,
    outlets: mapping,
    outletsPending,
    integration: INTEGRATION_KEY,
  }
}

/**
 * Fail-soft: give the freshly-provisioned tenant its real identity so the
 * storefront + dashboard stop showing the default cafe name / placeholder email.
 *   • tenant_branding.display_name = businessName (+ address / support_phone from
 *     ownerPhone or the first outlet that has them). on-conflict(tenant_id) refresh.
 *   • profiles.full_name = businessName (+ wa_number from ownerPhone). on-conflict(id).
 * Each write is independently guarded — a missing column / RLS hiccup logs and is
 * skipped, never thrown, so provisioning always completes.
 */
async function applyBrandingAndProfile(
  supabase: SupabaseClient,
  args: { tenantId: string; ownerUserId: string; businessName: string; ownerPhone?: string; outlets: OutletInput[] },
): Promise<void> {
  const { tenantId, ownerUserId, businessName, ownerPhone, outlets } = args
  const address = outlets.find(o => o.address)?.address
  const supportPhone = ownerPhone || outlets.find(o => o.phone)?.phone

  try {
    const branding: Record<string, unknown> = { tenant_id: tenantId, display_name: businessName, updated_at: new Date().toISOString() }
    if (address) branding.address = address
    if (supportPhone) branding.support_phone = supportPhone
    const { error } = await supabase.from('tenant_branding').upsert(branding, { onConflict: 'tenant_id' })
    if (error) console.warn(`[desktop-provision] tenant_branding upsert non-fatal: ${error.message}`)
  } catch (e: any) {
    console.warn(`[desktop-provision] tenant_branding write skipped: ${e?.message ?? e}`)
  }

  try {
    // handle_new_user() auto-creates the profile on signup; upsert refreshes it
    // (and covers the race where the trigger hasn't fired yet).
    const profile: Record<string, unknown> = { id: ownerUserId, full_name: businessName, updated_at: new Date().toISOString() }
    if (ownerPhone) profile.wa_number = ownerPhone
    const { error } = await supabase.from('profiles').upsert(profile, { onConflict: 'id' })
    if (error) console.warn(`[desktop-provision] profile upsert non-fatal: ${error.message}`)
  } catch (e: any) {
    console.warn(`[desktop-provision] profile write skipped: ${e?.message ?? e}`)
  }
}

/** Create the owner auth user, or resolve the existing one if the email is taken. */
async function getOrCreateOwnerUser(
  supabase: SupabaseClient,
  email: string,
  provisionKey: string,
  emailIsPlaceholder: boolean,
): Promise<string> {
  const { data, error } = await supabase.auth.admin.createUser({
    email,
    email_confirm: true,
    user_metadata: {
      source: 'frequency_desktop',
      desktop_provision_key: provisionKey,
      owner_email_placeholder: emailIsPlaceholder,
    },
  })
  if (!error && (data as any)?.user?.id) return (data as any).user.id

  // Email already registered (merchant signed up before, or a race). Resolve it.
  // ponytail: listUsers is O(users) with no getUserByEmail in supabase-js.
  // Ceiling: acceptable at current scale; replace with a keyed lookup/RPC later.
  const wanted = email.toLowerCase()
  for (let page = 1; page <= 20; page++) {
    const { data: list } = await supabase.auth.admin.listUsers({ page, perPage: 200 })
    const users = (list as any)?.users ?? []
    const found = users.find((u: any) => (u.email ?? '').toLowerCase() === wanted)
    if (found) return found.id
    if (users.length < 200) break
  }
  throw new Error(`owner user create/resolve failed for ${email}: ${error?.message ?? 'not found'}`)
}
