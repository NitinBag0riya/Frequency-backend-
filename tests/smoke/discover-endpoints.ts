/**
 * Endpoint auto-discoverer.
 *
 * Parses every `app.METHOD('/api/...')` and `r.METHOD('/api/...')` call
 * across src/index.ts and src/routes/*.ts and returns a structured list.
 *
 * Used by tests/smoke/runner.ts to:
 *   - probe every authenticated GET endpoint with a real JWT and assert
 *     it doesn't return 404 / 500 (catches broken routes + panics)
 *   - assert every non-GET endpoint at least returns 401/405/400 when
 *     hit without a body (catches missing auth middleware regressions)
 *   - print a coverage matrix at the end so we can see what's tested vs
 *     what fell through to the auto-probe
 *
 * This file has zero runtime deps beyond Node fs/path. Safe to call
 * from the smoke runner or directly from `tsx tests/smoke/discover-endpoints.ts`.
 */

import { readFileSync, readdirSync, statSync } from 'fs'
import { join } from 'path'

export interface DiscoveredEndpoint {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  path: string
  file: string
  line: number
  /** True if the path contains a :param placeholder. */
  parameterized: boolean
}

const ROUTE_RE = /(?:^|\s)(?:app|r)\s*\.(get|post|put|patch|delete)\s*\(\s*['"`](\/api\/[^'"`]+)['"`]/g

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry.startsWith('.')) continue
    const p = join(dir, entry)
    const st = statSync(p)
    if (st.isDirectory()) yield* walk(p)
    else if (entry.endsWith('.ts')) yield p
  }
}

export function discoverEndpoints(): DiscoveredEndpoint[] {
  const root = join(__dirname, '..', '..', 'src')
  const out: DiscoveredEndpoint[] = []
  for (const file of walk(root)) {
    const src = readFileSync(file, 'utf8')
    const lines = src.split('\n')
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      ROUTE_RE.lastIndex = 0
      let m: RegExpExecArray | null
      while ((m = ROUTE_RE.exec(line)) !== null) {
        out.push({
          method: m[1].toUpperCase() as DiscoveredEndpoint['method'],
          path: m[2],
          file: file.replace(root + '/', ''),
          line: i + 1,
          parameterized: m[2].includes(':'),
        })
      }
    }
  }
  // Dedupe (same method+path can appear if mounted via two routers, take first).
  const seen = new Map<string, DiscoveredEndpoint>()
  for (const e of out) {
    const key = `${e.method} ${e.path}`
    if (!seen.has(key)) seen.set(key, e)
  }
  return [...seen.values()].sort((a, b) =>
    a.path === b.path ? a.method.localeCompare(b.method) : a.path.localeCompare(b.path)
  )
}

if (require.main === module) {
  const eps = discoverEndpoints()
  console.log(`Discovered ${eps.length} endpoints`)
  for (const e of eps) console.log(`  ${e.method.padEnd(6)} ${e.path}`)
}
