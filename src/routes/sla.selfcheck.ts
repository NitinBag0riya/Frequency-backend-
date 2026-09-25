/**
 * Route-level self-check for the SLA config role gate (docs/state/sla-role-check.md).
 * No DB — builds the real router with passthrough auth/tenant deps and a spy
 * `checkPermission` that tags the middleware it returns, then inspects
 * `router.stack` directly. Run: `npx tsx src/routes/sla.selfcheck.ts`
 *
 * Regression this catches: POST/DELETE /api/sla/config used to have no
 * permission gate at all, so any tenant member (not just owner/workspace_admin)
 * could write SLA policy. Deleting the `checkPermission('settings','edit')` call
 * in sla.ts makes (1), (2) and (4) below fail.
 */
import assert from 'node:assert/strict'
import express from 'express'
import { createSlaRouter } from './sla'

type Tag = { f: string; a: string }

function taggedCheckPermission(): (f: string, a: string) => express.RequestHandler {
  return (f: string, a: string) => {
    const mw: express.RequestHandler = (_req, res) => {
      res.status(403).json({ error: 'permission_denied (stub)', code: 'permission_denied' })
    }
    ;(mw as any).__tag = { f, a } satisfies Tag
    return mw
  }
}

function fakeSupabase(spy: { upsertCalled: boolean }) {
  return {
    from() {
      const builder: any = {
        select: () => builder,
        eq: () => builder,
        order: () => builder,
        is: () => builder,
        not: () => builder,
        limit: () => builder,
        single: async () => ({ data: null, error: null }),
        maybeSingle: async () => ({ data: null, error: null }),
        upsert: () => { spy.upsertCalled = true; return builder },
        delete: () => builder,
      }
      return builder
    },
  }
}

function findRouteStack(router: express.Router, path: string, method: 'get' | 'post' | 'delete') {
  const layer = (router as any).stack.find(
    (l: any) => l.route?.path === path && l.route.methods[method],
  )
  assert.ok(layer, `no route registered for ${method.toUpperCase()} ${path}`)
  return layer.route.stack as any[]
}

function tagsOf(stack: any[]): (Tag | undefined)[] {
  return stack.map((l) => (l.handle as any).__tag)
}

const spy = { upsertCalled: false }
const passthrough: express.RequestHandler = (_req, _res, next) => next()
const router = createSlaRouter({
  supabase: fakeSupabase(spy) as any,
  requireAuth: passthrough,
  identifyTenant: passthrough,
  checkPermission: taggedCheckPermission(),
})

// (1) POST /api/sla/config carries the settings/edit tag before the handler.
{
  const stack = findRouteStack(router, '/api/sla/config', 'post')
  const tags = tagsOf(stack)
  const idx = tags.findIndex((t) => t?.f === 'settings' && t?.a === 'edit')
  assert.ok(idx >= 0, 'POST /api/sla/config must be gated by checkPermission(settings, edit)')
  assert.ok(idx < stack.length - 1, 'the permission gate must run before the handler, not be the handler')
}

// (2) DELETE /api/sla/config/:id carries the same tag.
{
  const stack = findRouteStack(router, '/api/sla/config/:id', 'delete')
  const tags = tagsOf(stack)
  const idx = tags.findIndex((t) => t?.f === 'settings' && t?.a === 'edit')
  assert.ok(idx >= 0, 'DELETE /api/sla/config/:id must be gated by checkPermission(settings, edit)')
  assert.ok(idx < stack.length - 1, 'the permission gate must run before the handler, not be the handler')
  // Plan R1/contract: DELETE must check 'edit', never 'delete' — workspace_admin
  // has settings.delete=false, which would lock out the role the dashboard
  // shows the page to.
  assert.notEqual(tags[idx]?.a, 'delete', "DELETE must gate on 'edit', not 'delete'")
}

// (3) Both GET routes carry no permission tag — read stays open to any tenant member.
{
  const listStack = findRouteStack(router, '/api/sla/config', 'get')
  assert.ok(tagsOf(listStack).every((t) => !t), 'GET /api/sla/config must not be permission-gated')
  const breachesStack = findRouteStack(router, '/api/sla/breaches', 'get')
  assert.ok(tagsOf(breachesStack).every((t) => !t), 'GET /api/sla/breaches must not be permission-gated')
}

// (4) Running the POST stack in order stops at the 403 gate and never reaches
// the handler — the fake supabase `upsert` is never called.
;(async () => {
  const stack = findRouteStack(router, '/api/sla/config', 'post')
  const req: any = { body: {}, tenantId: 't-selfcheck', user: { id: 'u1' } }
  const res: any = {
    statusCode: 200,
    body: undefined,
    status(code: number) { this.statusCode = code; return this },
    json(body: unknown) { this.body = body; return this },
  }
  for (const layer of stack) {
    let calledNext = false
    await layer.handle(req, res, () => { calledNext = true })
    if (!calledNext) break // gate replied — stack stops here, matching real express
  }
  assert.equal(res.statusCode, 403, `expected the permission gate to short-circuit with 403, got ${res.statusCode}`)
  assert.equal(res.body?.code, 'permission_denied')
  assert.equal(spy.upsertCalled, false, 'handler must never run past a denied permission check — upsert was called')

  console.log('sla.selfcheck: OK')
})().catch((e) => { console.error('sla.selfcheck: FAIL', e); process.exit(1) })
