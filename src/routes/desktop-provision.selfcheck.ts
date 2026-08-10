/**
 * Runnable self-check for the Frequency Desktop provisioning handshake.
 * Run:  npx tsx src/routes/desktop-provision.selfcheck.ts
 * No framework — plain asserts. Exits non-zero on failure.
 *
 * Drives the real `provisionTenant` orchestration through an in-memory fake
 * Supabase + fake outlet creator, and asserts the exact side effects:
 *   1. A first call creates exactly ONE horeca tenant, owner user + owner role,
 *      an ACTIVE Enterprise subscription, TWO outlets with a resId↔outletId
 *      mapping, and the aggregator integration active, and returns a login link.
 *   2. A second IDENTICAL call is idempotent — no duplicate tenant/user/outlets/
 *      subscription; it returns the same tenant with created:false.
 *
 * Proves the provisioning LOGIC end-to-end. What it does NOT prove (needs a live
 * Swiggy/Zomato session): the desktop capture assembling a real ProvisionPayload,
 * and the magic-link actually signing the embedded web view in.
 */
import assert from 'node:assert/strict'
import { provisionTenant, provisionKeyFor, type ProvisionPayload } from './desktop-provision'

// ── In-memory fake Supabase ─────────────────────────────────────────────────
// Minimal fluent builder covering only the ops provisionTenant uses.
type Row = Record<string, any>
function makeFakeSupabase() {
  const tables: Record<string, Row[]> = {
    tenants: [],
    tenant_integrations: [],
    tenant_subscriptions: [],
    user_role_assignments: [],
    role_definitions: [{ id: 'role-owner-uuid', key: 'owner', scope: 'tenant', is_built_in: true }],
  }
  const authUsers: Row[] = []
  let seq = 0
  const uid = (p: string) => `${p}-${++seq}`

  function query(table: string) {
    const rows = tables[table] ?? (tables[table] = [])
    const filters: Array<[string, any]> = []
    const builder: any = {
      select() { return builder },
      eq(col: string, val: any) { filters.push([col, val]); return builder },
      match(rows2: Row[]) { return rows2.filter(r => filters.every(([c, v]) => r[c] === v)) },
      async maybeSingle() { return { data: builder.match(rows)[0] ?? null, error: null } },
      async single() {
        const m = builder.match(rows)
        return { data: m[0] ?? null, error: m[0] ? null : { message: 'no row', code: 'PGRST116' } }
      },
      insert(payload: Row | Row[]) {
        const items = Array.isArray(payload) ? payload : [payload]
        const inserted = items.map(it => {
          const row = { id: it.id ?? uid(table.slice(0, 3)), ...it }
          rows.push(row)
          return row
        })
        const term: any = {
          select() { return term },
          async single() { return { data: inserted[0], error: null } },
          then(res: any) { return Promise.resolve({ data: inserted, error: null }).then(res) },
        }
        return term
      },
      async upsert(payload: Row, opts?: { onConflict?: string }) {
        const keys = (opts?.onConflict ?? 'id').split(',').map(s => s.trim())
        const idx = rows.findIndex(r => keys.every(k => r[k] === payload[k]))
        if (idx >= 0) rows[idx] = { ...rows[idx], ...payload }
        else rows.push({ id: uid(table.slice(0, 3)), ...payload })
        return { error: null }
      },
      // Terminal await on a bare select (returns the filtered array).
      then(resolve: any) { return Promise.resolve({ data: builder.match(rows), error: null }).then(resolve) },
    }
    return builder
  }

  return {
    _tables: tables,
    _authUsers: authUsers,
    from: (table: string) => query(table),
    auth: {
      admin: {
        async createUser({ email }: any) {
          if (authUsers.find(u => u.email === email)) {
            return { data: { user: null }, error: { message: 'email already registered' } }
          }
          const user = { id: uid('user'), email }
          authUsers.push(user)
          return { data: { user }, error: null }
        },
        async listUsers() { return { data: { users: authUsers }, error: null } },
      },
    },
  } as any
}

// ── Deps: fake outlet creator + fake login link ─────────────────────────────
function makeDeps() {
  const created: Array<{ slug: string; name: string; resId: string; id: string }> = []
  let n = 0
  return {
    _created: created,
    createOutlet: async (slug: string, outlet: any) => {
      const id = 'o' + (++n).toString(16).padStart(6, '0')
      created.push({ slug, name: outlet.name, resId: outlet.resId, id })
      return { id }
    },
    generateLoginLink: async (email: string) => `https://getfrequency.app/verify?token=magic-for-${encodeURIComponent(email)}`,
    // Deterministic slug so we don't exercise ensureUniqueSlug's own queries here.
    makeSlug: async (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40),
  }
}

// ── Payload: a 2-outlet Swiggy merchant (no real email captured) ─────────────
const payload: ProvisionPayload = {
  platform: 'swiggy',
  businessName: 'Spice Route Cafe',
  outlets: [
    { platform: 'swiggy', resId: '778899', name: 'Spice Route — C Scheme', address: 'C Scheme, Jaipur', gst: '08AAAAA0000A1Z5', phone: '9876543210' },
    { platform: 'swiggy', resId: '112233', name: 'Spice Route — Vaishali', address: 'Vaishali Nagar, Jaipur', phone: '9811111111' },
  ],
}

async function main() {
  const supabase = makeFakeSupabase()
  const deps = makeDeps()

  // ── First provision ────────────────────────────────────────────────────────
  const r1 = await provisionTenant(supabase, payload, deps)

  assert.equal(r1.created, true, 'first call should create')
  assert.equal(r1.businessType, 'horeca', 'tenant must be horeca')
  assert.equal(r1.plan, 'enterprise', 'plan must be enterprise')
  assert.equal(supabase._tables.tenants.length, 1, 'exactly one tenant')
  assert.equal(supabase._tables.tenants[0].business_type, 'horeca')
  assert.equal(supabase._tables.tenants[0].status, 'active')
  assert.equal(supabase._authUsers.length, 1, 'exactly one owner auth user')
  assert.equal(supabase._tables.tenants[0].user_id, r1.ownerUserId, 'tenant owned by owner user')

  // Owner role assignment written with the owner role_definition.
  assert.equal(supabase._tables.user_role_assignments.length, 1, 'one owner role assignment')
  assert.equal(supabase._tables.user_role_assignments[0].role_id, 'role-owner-uuid', 'owner role id')
  assert.equal(supabase._tables.user_role_assignments[0].tenant_id, r1.tenantId)

  // Enterprise subscription, active.
  assert.equal(supabase._tables.tenant_subscriptions.length, 1, 'one subscription')
  assert.equal(supabase._tables.tenant_subscriptions[0].plan_id, 'enterprise')
  assert.equal(supabase._tables.tenant_subscriptions[0].status, 'active')

  // Two outlets + resId↔outletId mapping.
  assert.equal(deps._created.length, 2, 'two storefront outlets created')
  assert.equal(r1.outlets.length, 2, 'two mappings returned')
  assert.equal(r1.outletsPending, false, 'no pending outlets')
  const map1 = new Map(r1.outlets.map(o => [o.resId, o.outletId]))
  assert.ok(map1.get('778899'), 'resId 778899 mapped to an outlet id')
  assert.ok(map1.get('112233'), 'resId 112233 mapped to an outlet id')
  assert.notEqual(map1.get('778899'), map1.get('112233'), 'distinct outlet ids per resId')

  // Aggregator integration active + idempotency ledger + mapping persisted.
  const intg = supabase._tables.tenant_integrations
  assert.equal(intg.length, 1, 'one integration row')
  assert.equal(intg[0].key, 'aggregator_frequency_desktop')
  assert.equal(intg[0].status, 'active')
  assert.equal(intg[0].metadata.desktop_provision_key, provisionKeyFor('swiggy', payload.outlets))
  assert.equal(intg[0].metadata.outlets.length, 2, 'mapping persisted in integration metadata')
  assert.equal(intg[0].metadata.owner_email_placeholder, true, 'derived email flagged as placeholder')

  // Login handoff + placeholder email surfaced.
  assert.ok(r1.loginUrl && r1.loginUrl.includes('magic-for-'), 'login link minted')
  assert.equal(r1.ownerEmailPlaceholder, true, 'no real email captured → placeholder')
  assert.ok(r1.ownerEmail.endsWith('@desktop.getfrequency.app'), 'derived owner email domain')

  // ── Second IDENTICAL provision — must be idempotent ─────────────────────────
  const r2 = await provisionTenant(supabase, payload, deps)

  assert.equal(r2.created, false, 'second call must NOT create')
  assert.equal(r2.tenantId, r1.tenantId, 'same tenant returned')
  assert.equal(supabase._tables.tenants.length, 1, 'still exactly one tenant')
  assert.equal(supabase._authUsers.length, 1, 'still exactly one owner user')
  assert.equal(supabase._tables.tenant_subscriptions.length, 1, 'still one subscription')
  assert.equal(supabase._tables.user_role_assignments.length, 1, 'still one role assignment')
  assert.equal(deps._created.length, 2, 'no new outlets created on re-provision')
  assert.equal(supabase._tables.tenant_integrations.length, 1, 'still one integration')
  assert.ok(r2.loginUrl && r2.loginUrl.includes('magic-for-'), 're-login link minted')
  assert.equal(r2.outlets.length, 2, 'idempotent call returns the persisted mapping')

  // ── Idempotency key stability ───────────────────────────────────────────────
  assert.equal(
    provisionKeyFor('swiggy', payload.outlets),
    provisionKeyFor('swiggy', [...payload.outlets].reverse()),
    'provision key is order-independent (sorted primary resId)',
  )

  console.log('desktop-provision self-check: OK')
  console.log(`  tenant=${r1.slug} (${r1.tenantId})  owner=${r1.ownerEmail}`)
  console.log(`  outlets: ${r1.outlets.map(o => `${o.resId}→${o.outletId}`).join(', ')}`)
  console.log(`  key=${provisionKeyFor('swiggy', payload.outlets)}  idempotent 2nd call: created=${r2.created}`)
}

main().catch((e) => { console.error('desktop-provision self-check FAILED:', e); process.exit(1) })
