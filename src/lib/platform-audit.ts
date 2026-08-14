/**
 * Platform audit log (spec Part I §1.2 — "Every mutation → platform audit log:
 * actor, capability, tenant, before→after JSON diff, reason, IP, timestamp").
 *
 * Writes to the existing `super_admin_audit` table (migration 017) extended with
 * `capability`, `before_json`, `after_json` (migration 20260814 — this feature).
 * Keeps the legacy `action` + `payload` columns populated so the existing
 * /api/super-admin/audit reader and tenant_audit_slice view keep working.
 *
 * Best-effort by contract: a failed audit insert is logged, never thrown — an
 * audit outage must not roll back a completed mutation. (The mutation itself is
 * still guarded + idempotent upstream.)
 */
import type express from 'express'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { PlatformCapability } from './platform-rbac'

type Json = Record<string, any> | null | undefined

/**
 * Shallow before→after diff: only keys whose value changed appear, each side
 * carrying its own value. Compared by JSON string so nested objects/arrays are
 * handled without a deep-equal dependency. Keeps audit rows small and readable.
 */
export function diffJson(before: Json, after: Json): { before: Record<string, any>; after: Record<string, any> } {
  const b = before ?? {}
  const a = after ?? {}
  const keys = new Set([...Object.keys(b), ...Object.keys(a)])
  const outB: Record<string, any> = {}
  const outA: Record<string, any> = {}
  for (const k of keys) {
    if (JSON.stringify((b as any)[k]) !== JSON.stringify((a as any)[k])) {
      outB[k] = (b as any)[k]
      outA[k] = (a as any)[k]
    }
  }
  return { before: outB, after: outA }
}

export interface PlatformAuditArgs {
  capability: PlatformCapability
  /** Machine action key (e.g. 'entitlement.set'); kept for the legacy reader. */
  action: string
  tenant_id?: string | null
  target_user_id?: string | null
  before?: Json
  after?: Json
  reason?: string | null
  /** Break-glass owner bypass — flagged red in the audit UI (spec §1.2). */
  break_glass?: boolean
}

/**
 * Record one platform mutation. Pulls actor + role + ip + user-agent off `req`
 * (populated by requireAuth + requirePlatformCapability).
 */
export async function recordPlatformAudit(
  supabase: SupabaseClient, req: express.Request, args: PlatformAuditArgs,
): Promise<void> {
  try {
    const user = (req as any).user
    const { before, after } = diffJson(args.before, args.after)
    await supabase.from('super_admin_audit').insert({
      actor_user_id:    user?.id ?? null,
      actor_role:       (req as any).platformRole ?? null,
      capability:       args.capability,
      action:           args.action,
      target_tenant_id: args.tenant_id ?? null,
      target_user_id:   args.target_user_id ?? null,
      before_json:      before,
      after_json:       after,
      // Legacy payload mirror: the diff + break-glass flag, so the existing
      // reader/slice keep showing something meaningful without a schema read.
      payload:          { before, after, ...(args.break_glass ? { break_glass: true } : {}) },
      reason:           args.reason ?? null,
      ip_address:       req.ip ?? null,
      user_agent:       req.get('user-agent') ?? null,
    })
  } catch (e) {
    console.error('[platform-audit] insert failed', e)
  }
}

/**
 * Wrap a mutation so the audit row is written from its real before/after state.
 *
 *   const row = await withAudit(supabase, req,
 *     { capability: 'tenant.entitlement.write', action: 'entitlement.set',
 *       tenant_id, reason, before: () => loadRow() },
 *     async () => { ...do the write...; return updatedRow },
 *   )
 *
 * `before` may be a value or a loader (run before the mutation). `extractAfter`
 * maps the fn's return value to the after-state (default: identity). The fn's
 * return value is passed straight back to the caller.
 */
export async function withAudit<R>(
  supabase: SupabaseClient, req: express.Request,
  opts: Omit<PlatformAuditArgs, 'after'> & { before?: Json | (() => Promise<Json> | Json) },
  fn: () => Promise<R>,
  extractAfter: (result: R) => Json = (r) => r as unknown as Json,
): Promise<R> {
  const before = typeof opts.before === 'function' ? await (opts.before as () => Promise<Json>)() : opts.before
  const result = await fn()
  await recordPlatformAudit(supabase, req, { ...opts, before, after: extractAfter(result) })
  return result
}
