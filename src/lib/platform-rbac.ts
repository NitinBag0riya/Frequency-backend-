/**
 * Platform RBAC — capability model for the /naruto Platform OS (spec Part I §1).
 *
 * SINGLE SOURCE OF TRUTH for "which platform role can do what". Roles are DATA,
 * not a `super_admin` boolean. Each of the six scoped roles maps to a set of
 * capability strings; the pure `can(capability, scope)` helper is used on BOTH
 * the server (enforcement — see platform-guard.ts) and the FE (cosmetic gating —
 * mirror at dashboard src/lib/platform-rbac.ts).
 *
 * BACK-COMPAT (critical): the legacy `super_admin` role (user_roles, tenant_id
 * IS NULL) and the pre-existing platform role keys all normalize onto the six
 * canonical roles via LEGACY_ROLE_ALIAS, so current /naruto access keeps working
 * unchanged. `super_admin` → `platform_owner` (god-mode, capability '*').
 *
 * This module is pure (no express, no supabase) so it stays trivially testable
 * and shareable. Keep it in lockstep with the FE copy.
 */

// ── Capability vocabulary ────────────────────────────────────────────────────
// Format: <domain>.<subject>[.<action>]. `.read`/`.write` verbs where a domain
// has both; single verbs (e.g. tenant.suspend, secret.reveal) where the action
// IS the capability. Add here + grant to roles below; never invent capability
// strings ad hoc in route files.
export const PLATFORM_CAPABILITIES = [
  // Tenants
  'tenant.read',
  'tenant.write',                 // create / edit tenant config
  'tenant.suspend',
  'tenant.delete',                // soft-delete (never hard-delete from UI)
  'tenant.export',
  'tenant.impersonate',           // time-boxed, reason-gated, read-only by default
  // Entitlements
  'tenant.entitlement.read',
  'tenant.entitlement.write',
  'entitlement.bulk.write',       // cross-tenant bulk ops (reversible 24h)
  // Plans / subscriptions
  'plan.read',
  'plan.pricing.write',           // edit plan definitions / pricing / limits
  'plan.assign.write',            // change a tenant's plan / extend trial
  // Platform governance
  'platform_team.write',          // manage the platform team (assign platform roles)
  'role.read',
  'role.write',                   // edit role definitions
  'feature.registry.read',
  'feature.registry.write',       // edit the feature registry
  'feature_flag.write',
  'announcement.write',
  'approval_rule.write',
  // Onboarding
  'onboarding.wizard.run',
  'onboarding.import.run',
  'onboarding.seed.write',
  // Payments / money
  'payments.read',
  'payments.route_account.write', // Razorpay Route / payout account changes
  'payments.split.write',
  'payments.refund.write',
  'payments.killswitch.write',    // disable online payments (degrade to COD)
  // Support console
  'diagnostics.read',
  'support.fix.run',              // one-click fixes (resync, replay, re-issue QR…)
  'support.session.revoke',
  'support.invite.resend',
  // Cross-cutting
  'audit.read',
  'secret.reveal',                // reveal masked secrets (re-auth + logs secret.reveal)
] as const

export type PlatformCapability = typeof PLATFORM_CAPABILITIES[number]

// ── Canonical roles (spec §1.1) ──────────────────────────────────────────────
export const PLATFORM_ROLE_KEYS = [
  'platform_owner',
  'platform_admin',
  'platform_finance',
  'platform_onboarding',
  'platform_support',
  'platform_readonly',
] as const

export type PlatformRoleKey = typeof PLATFORM_ROLE_KEYS[number]

/** '*' = every capability (owner god-mode). Otherwise an explicit grant list. */
export const PLATFORM_ROLES: Record<PlatformRoleKey, { label: string; capabilities: '*' | PlatformCapability[] }> = {
  platform_owner: {
    label: 'Platform Owner',
    capabilities: '*',
  },
  platform_admin: {
    // Owns tenants, entitlements, plans, roles, flags, announcements, approval
    // rules. Blocked from: platform team mgmt, tenant deletion, payout account
    // changes.
    label: 'Platform Admin',
    capabilities: [
      'tenant.read', 'tenant.write', 'tenant.suspend', 'tenant.export', 'tenant.impersonate',
      'tenant.entitlement.read', 'tenant.entitlement.write', 'entitlement.bulk.write',
      'plan.read', 'plan.pricing.write', 'plan.assign.write',
      'role.read', 'role.write',
      'feature.registry.read', 'feature.registry.write', 'feature_flag.write',
      'announcement.write', 'approval_rule.write',
      'payments.read', 'payments.split.write', 'payments.refund.write', 'payments.killswitch.write',
      'diagnostics.read', 'support.fix.run', 'support.session.revoke', 'support.invite.resend',
      'audit.read',
    ],
  },
  platform_finance: {
    // Payments, gateway config, Route accounts, splits, payouts, refunds, plan
    // pricing, revenue. Blocked from: feature config, impersonation.
    label: 'Platform Finance',
    capabilities: [
      'tenant.read',
      'plan.read', 'plan.pricing.write',
      'payments.read', 'payments.route_account.write', 'payments.split.write',
      'payments.refund.write', 'payments.killswitch.write',
      'audit.read', 'secret.reveal',
    ],
  },
  platform_onboarding: {
    // Create tenants, run onboarding wizard, imports, go-live checklist, seed
    // data. Blocked from: plan pricing, payments config, deletion.
    label: 'Platform Onboarding',
    capabilities: [
      'tenant.read', 'tenant.write', 'tenant.export',
      'tenant.entitlement.read',
      'plan.read', 'plan.assign.write',
      'feature.registry.read',
      'onboarding.wizard.run', 'onboarding.import.run', 'onboarding.seed.write',
      'support.invite.resend',
      'diagnostics.read', 'audit.read',
    ],
  },
  platform_support: {
    // Read tenant config, impersonate (time-boxed, reason-gated), diagnostics,
    // one-click fixes, resend invites. Blocked from: plan/entitlement/payment
    // writes.
    label: 'Platform Support',
    capabilities: [
      'tenant.read', 'tenant.impersonate',
      'tenant.entitlement.read',
      'plan.read',
      'feature.registry.read',
      'payments.read',
      'diagnostics.read', 'support.fix.run', 'support.session.revoke', 'support.invite.resend',
      'audit.read',
    ],
  },
  platform_readonly: {
    // View all except credentials and raw PII. Blocked from: any write.
    label: 'Platform Read-only',
    capabilities: [
      'tenant.read',
      'tenant.entitlement.read',
      'plan.read',
      'role.read',
      'feature.registry.read',
      'payments.read',
      'diagnostics.read',
      'audit.read',
    ],
  },
}

// ── Legacy → canonical mapping (back-compat) ─────────────────────────────────
// `super_admin`: the legacy user_roles platform row → owner (CRITICAL: keeps
// current /naruto access working). The other keys are the pre-existing
// role_definitions platform seeds (migration 018) mapped to the nearest new
// role so any live assignment keeps a sensible capability set.
// ponytail: engineering had feature_flag+queue admin with no clean equivalent in
// the six-role model → mapped to support (diagnostics/fixes). Revisit if an
// explicit platform_ops role is ever added.
export const LEGACY_ROLE_ALIAS: Record<string, PlatformRoleKey> = {
  super_admin: 'platform_owner',
  platform_owner: 'platform_owner',
  customer_success: 'platform_support',
  billing_ops: 'platform_finance',
  engineering: 'platform_support',
  trust_safety: 'platform_admin',
  platform_sales: 'platform_readonly',
}

/** Normalize any role key (canonical, legacy, or super_admin) → canonical, or null. */
export function normalizeRole(key: string | null | undefined): PlatformRoleKey | null {
  if (!key) return null
  if ((PLATFORM_ROLE_KEYS as readonly string[]).includes(key)) return key as PlatformRoleKey
  return LEGACY_ROLE_ALIAS[key] ?? null
}

/** The full capability set for a role key (canonical or legacy). */
export function capabilitiesFor(key: string | null | undefined): Set<PlatformCapability> {
  const role = normalizeRole(key)
  if (!role) return new Set()
  const caps = PLATFORM_ROLES[role].capabilities
  return caps === '*' ? new Set(PLATFORM_CAPABILITIES) : new Set(caps)
}

/** Scope the actor's platform context is evaluated in — a role key or {role}. */
export type PlatformScope = PlatformRoleKey | string | null | undefined | { role: string | null | undefined }

/**
 * The one gate. `can(capability, scope)` — usable on both server and client.
 * `scope` is the caller's platform role key (or a { role } object). Server-side
 * enforcement resolves the role from user_role_assignments; client gating passes
 * the role it already knows. Cosmetic on the client — the server is authority.
 */
export function can(capability: PlatformCapability, scope: PlatformScope): boolean {
  const key = typeof scope === 'object' && scope !== null ? scope.role : scope
  return capabilitiesFor(key).has(capability)
}
