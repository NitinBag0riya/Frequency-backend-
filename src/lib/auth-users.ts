/**
 * auth.users lookups that don't silently stop at page 1.
 *
 * supabase-js has no getUserByEmail, and the Admin API ignores `?email=`, so
 * `listUsers({ perPage: 200 })` + find() looked fine until prod passed 200 users
 * — then anyone on page 2+ was "not found". Every lookup goes through here.
 */
type AdminSb = { auth: { admin: any } }

const PER_PAGE = 1000
// ponytail: full scan is O(users) — one call up to 1000 users, 50 pages = 50k cap.
// Upgrade path: a SECURITY DEFINER rpc on auth.users(lower(email)).
const MAX_PAGES = 50

/** Every auth user matching `pred`, across all pages. */
export async function scanAuthUsers(sb: AdminSb, pred: (u: any) => boolean): Promise<any[]> {
  const out: any[] = []
  for (let page = 1; page <= MAX_PAGES; page++) {
    const { data, error } = await sb.auth.admin.listUsers({ page, perPage: PER_PAGE })
    if (error) throw error
    const users: any[] = data?.users ?? []
    for (const u of users) if (pred(u)) out.push(u)
    if (users.length < PER_PAGE) break
  }
  return out
}

/** Case-insensitive exact email match, or null. */
export async function findAuthUserByEmail(sb: AdminSb, email: string): Promise<any | null> {
  const needle = String(email ?? '').trim().toLowerCase()
  if (!needle) return null
  for (let page = 1; page <= MAX_PAGES; page++) {
    const { data, error } = await sb.auth.admin.listUsers({ page, perPage: PER_PAGE })
    if (error) throw error
    const users: any[] = data?.users ?? []
    const hit = users.find(u => (u.email ?? '').toLowerCase() === needle)
    if (hit) return hit
    if (users.length < PER_PAGE) break
  }
  return null
}

/** id → user for a known id set (one getUserById per id; missing ids skipped). */
export async function authUsersByIds(sb: AdminSb, ids: string[]): Promise<Map<string, any>> {
  const uniq = Array.from(new Set(ids.filter(Boolean)))
  const map = new Map<string, any>()
  await Promise.all(uniq.map(async id => {
    const { data } = await sb.auth.admin.getUserById(id)
    if (data?.user) map.set(id, data.user)
  }))
  return map
}

/**
 * May an unauthenticated invite-token holder set this account's password?
 * Only the passwordless stub inviteUserByEmail creates, and only if nobody has
 * EVER signed in to it (every sign-in method stamps last_sign_in_at). A real,
 * used account is never writable here — no takeover.
 */
export function inviteStubClaimable(u: { invited_at?: string | null; last_sign_in_at?: string | null } | null | undefined): boolean {
  return !!u && !!u.invited_at && !u.last_sign_in_at
}
