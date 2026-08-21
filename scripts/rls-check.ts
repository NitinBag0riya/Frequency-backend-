// Every table created in `public` must have RLS turned on by some migration.
//
// Why this exists: Supabase's default privileges hand anon + authenticated full
// DML on every new table in `public`. RLS is the only thing standing between a
// new table and the anon key that ships in the browser bundle. Nine tables had
// drifted past that line before anyone noticed -- one migration at a time, never
// deliberately. This is the gate that catches the tenth.
//
//   npx tsx scripts/rls-check.ts     (exit 1 on an unprotected table)
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'supabase', 'migrations')
const sql = readdirSync(dir).filter(f => f.endsWith('.sql')).sort()
  .map(f => readFileSync(join(dir, f), 'utf8')).join('\n')
  .replace(/--[^\n]*/g, '')          // strip line comments; they mention table names
  .toLowerCase()

const created = new Set<string>()
for (const m of sql.matchAll(/create\s+table\s+(?:if\s+not\s+exists\s+)?(?:public\.)?"?([a-z0-9_]+)"?/g)) created.add(m[1])

// Enabled either by a direct ALTER or by the array-driven loop in the lockdown
// migration, which lists its tables as bare quoted strings.
const enabled = new Set<string>()
for (const m of sql.matchAll(/alter\s+table\s+(?:public\.)?"?([a-z0-9_]+)"?\s+enable\s+row\s+level\s+security/g)) enabled.add(m[1])
const loop = sql.match(/enable row level security', t\)/) ? sql.match(/foreach t in array array\[([^\]]+)\]/) : null
if (loop) for (const m of loop[1].matchAll(/'([a-z0-9_]+)'/g)) enabled.add(m[1])

// RLS enabled outside this repo's migrations -- some in the dashboard repo's own
// supabase/migrations, some by hand in Studio. All twelve confirmed
// relrowsecurity = true in prod on 2026-08-22. They stay listed rather than
// dropped so the gate still notices if one of them ever flips back.
//
// Add here WITH a reason and a verification -- never to silence a real gap.
const EXEMPT: Record<string, string> = {
  access_requests:            'RLS on in prod, 3 policies',
  aggregator_menu_actions:    'RLS on in prod, service-role only',
  invitation_codes:           'RLS on in prod, 3 policies',
  menu_channel_map:           'RLS on in prod, service-role only',
  orders:                     'RLS on in prod, 1 policy (created in the dashboard repo)',
  order_lines:                'RLS on in prod, 1 policy (created in the dashboard repo)',
  order_tenders:              'RLS on in prod, 1 policy (created in the dashboard repo)',
  storefront_app_builds:      'RLS on in prod, service-role only',
  storefront_app_credentials: 'RLS on in prod, service-role only',
  storefront_state:           'RLS on in prod, service-role only',
  tenant_branding:            'RLS on in prod, 1 policy',
  tenant_domains:             'RLS on in prod, 1 policy',
}

const gaps = [...created].filter(t => !enabled.has(t) && !(t in EXEMPT)).sort()

console.log(`rls-check: ${created.size} tables created across ${readdirSync(dir).filter(f => f.endsWith('.sql')).length} migrations, ${enabled.size} with RLS enabled`)
if (!gaps.length) { console.log('rls-check: passed — every table created here enables RLS ✓'); process.exit(0) }
console.error(`\nrls-check FAILED — ${gaps.length} table(s) created without enabling RLS:`)
for (const t of gaps) console.error(`  ✗ public.${t}`)
console.error('\nAdd `alter table public.<t> enable row level security;` plus the policies it needs,')
console.error('or list it in EXEMPT with a reason if it is meant to be world-readable.')
process.exit(1)
