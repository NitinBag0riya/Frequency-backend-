/**
 * Compile-time smoke for src/types/express.d.ts module augmentation.
 *
 * Reads req.tenantId / req.user / etc. WITHOUT the (req as any) cast.
 * If the augmentation is wired correctly, this file type-checks clean.
 * If it isn't, tsc surfaces "Property 'tenantId' does not exist on type
 * Request" — which is the exact bug we're guarding against.
 *
 * Pure compile-time. No runtime execution intended.
 */

import type { Request, Response, NextFunction } from 'express'

// Each line below uses the typed surface from the augmentation. None of
// them are wrapped in (req as any) — that is the whole point.
export function smokeHandler(req: Request, res: Response, next: NextFunction): void {
  const t: string | undefined         = req.tenantId
  const userId: string | undefined    = req.user?.id
  const userEmail: string | undefined = req.user?.email
  const role: string | undefined      = req.userRole
  const roleKey: string | undefined   = req.userRoleKey
  const apps: string[] | undefined    = req.userAllowedApps
  const scope: string | undefined     = req.userDataScope
  const plan: string | undefined      = req.userPlan
  const platRole: string | undefined  = req.platformRole
  const isSu: boolean | undefined     = req.isSuperAdmin
  const imp: string | undefined       = req.impersonatorId
  const impTen: string | undefined    = req.impersonatedTenantId
  const impRo: boolean | undefined    = req.impersonationReadOnly
  const raw: Buffer | string | undefined = req.rawBody
  const rid: string | undefined       = req.id

  // Touch the locals so tsc considers them used.
  void [t, userId, userEmail, role, roleKey, apps, scope, plan, platRole, isSu, imp, impTen, impRo, raw, rid]
  void res
  next()
}
