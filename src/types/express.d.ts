/**
 * Express Request module augmentation.
 *
 * Every middleware that attaches state to the request object — the
 * requireAuth chain, identifyTenant, the impersonation guard, the
 * Razorpay webhook raw-body capture — does so via (req as any).field = ...
 * because Express's Request type doesn't know about our custom fields.
 *
 * This file teaches TypeScript about them. Once it's in the include
 * graph (which tsconfig.json does via src/**), req.tenantId / req.user /
 * etc. are typed on every express.Request — no per-handler cast needed.
 *
 * Why not remove the existing (req as any).x casts? They keep working at
 * runtime. Mass-rewriting 389 cast sites is high blast-radius and gives
 * no behavior change. New code can rely on the typed surface; existing
 * casts can be tidied opportunistically when those routes are touched.
 *
 * Audit context: the cross-domain audit flagged the (req as any).tenantId
 * pattern as a code-smell that hides "missing identifyTenant middleware"
 * bugs at compile time. With this augmentation, future req.tenantId reads
 * on routes that forgot the middleware will at least be typed
 * (string | undefined) so the linter / reviewer can flag them.
 */

import 'express'
import type { User } from '@supabase/supabase-js'

declare global {
  namespace Express {
    interface Request {
      // The Supabase auth user. Set by requireAuth middleware after
      // supabase.auth.getUser(token). Missing if the route is unauthed
      // (public webhooks, /health, etc.) — always guard before reading
      // sub-properties.
      //
      // Typed as User (the supabase shape) rather than a custom interface
      // so downstream code that already uses user.email, user.id,
      // user.app_metadata continues to type-check correctly.
      user?: User

      // The active tenant for this request. Set by identifyTenant from
      // the X-Tenant-ID header (or, for some routes, inferred from the
      // user's primary tenant). Missing on public + super-admin-platform
      // routes that operate cross-tenant.
      tenantId?: string

      // Role of the user WITHIN the active tenant. One of
      // owner | admin | member | viewer | ... — the canonical list is in
      // migration 015 (RBAC v1) / 017 (super-admin extension).
      userRole?: string

      // Stable key for the user's role, used by checkPermission() lookups.
      // Distinct from userRole because some legacy code paths normalize
      // roles to a key (e.g. agency_admin → admin) while keeping the
      // display label separate.
      userRoleKey?: string

      // Subset of app keys this user is allowed to manage at the tenant
      // level. Driven by the per-role allowed_apps column. Used by the
      // connector + integration routes to gate "Connect" actions.
      userAllowedApps?: string[]

      // Data scope — tenant (default) or own (the user only sees rows
      // they personally created). Honored by the leads / conversations
      // list endpoints.
      userDataScope?: 'tenant' | 'own' | string

      // Plan tier of the tenant — starter | growth | scale | etc.
      // Surfaced on the request so feature-gating doesn't have to re-query
      // the plan table per endpoint.
      userPlan?: string

      // Platform-scope role for super-admins (Naruto console). Distinct
      // from userRole which is tenant-scoped. Migration 017 introduced
      // the platform-scope row in user_role_assignments.
      platformRole?: string

      // True iff the user has ANY platform-scope role assignment OR is
      // in the legacy super_admin role (user_roles, tenant_id IS NULL).
      // Set by the platform-guard middleware.
      isSuperAdmin?: boolean

      // Set when a super-admin is impersonating a tenant for support.
      // The audit trail (migration 029) records every impersonation event
      // with the original user id (impersonatorId) and the tenant being
      // acted on (impersonatedTenantId).
      impersonatorId?: string

      // The tenant the impersonator is currently acting as.
      impersonatedTenantId?: string

      // Impersonation read-only flag. When true, the impersonator can
      // VIEW the tenant's data but mutations are blocked at the route
      // layer. Lets support diagnose without changing anything.
      impersonationReadOnly?: boolean

      // Raw request body, populated by the Razorpay webhook verifier
      // (express.json with verify option). Needed because HMAC signature
      // verification must run against the EXACT bytes the upstream sent —
      // req.body is the parsed JSON and loses whitespace / key-order
      // fidelity. Same trick is used for the Shopify webhook (migration
      // 078 / src/routes/shopify-webhook.ts).
      rawBody?: Buffer | string

      // Some early middlewares attach a request id for log correlation.
      // Generated upstream of routes, read by error handlers. Optional
      // because not every code path attaches it (CLI smoke scripts, etc).
      id?: string
    }
  }
}

// Empty export so TypeScript treats this as a module, which is required
// for declare global augmentation to apply.
export {}
