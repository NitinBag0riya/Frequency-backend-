/**
 * Tiny security utilities — kept dependency-free so they're safe to import
 * from any route module without circular-dep risk.
 */

/**
 * Pick only the listed keys from an arbitrary request body. Used to stop
 * clients from sneaking `tenant_id`, `user_id`, `id`, `created_at`, status,
 * etc. into Supabase UPDATE/INSERT calls via spread (`{ ...req.body }`).
 *
 * Critically uses `Object.hasOwn` so prototype-polluted keys (`__proto__`,
 * `constructor`, etc.) can't sneak through — `if (k in body)` walks the
 * prototype chain and would let `{"__proto__":{"is_active":true}}` set
 * `is_active` on every subsequent allow-list pick for the rest of the
 * process lifetime.
 *
 * Also rejects arrays (since `Array.prototype.length` etc. are own props
 * but a body should be an object) and primitives.
 */
// Cached own-property check (ES2020-safe — `Object.hasOwn` is ES2022).
const hasOwn = Object.prototype.hasOwnProperty

export function pickAllowed<T extends Record<string, any>>(
  body: unknown,
  allowed: readonly (keyof T)[],
): Partial<T> {
  const out: Partial<T> = {}
  if (!body || typeof body !== 'object' || Array.isArray(body)) return out
  for (const k of allowed) {
    if (hasOwn.call(body, k as PropertyKey)) {
      (out as any)[k] = (body as any)[k]
    }
  }
  return out
}
