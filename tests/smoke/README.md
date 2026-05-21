# Smoke harness — behavioral coverage for every critical API

## Why this exists

Static audits (read code, look for patterns) repeatedly passed while real
bugs shipped to staging — most recently the Google Sheets import bug
where the N+1 dedup query timed out and the response returned 200 anyway,
leaving the user with an empty table and no error. Code review cannot
catch that. Only actually hitting the endpoint and verifying DB state can.

This harness **exercises** every endpoint with realistic payloads, then
**verifies** the DB state after each call.

## Running

```bash
# Against local BE (recommended for dev)
npm run smoke:local

# Against deployed staging
npm run smoke:stage

# Custom base URL
npm run smoke -- --base https://api-stage.getfrequency.app

# Only a specific group (faster iteration)
npm run smoke -- --only sheets-import
npm run smoke -- --only sla,pii,ai

# Keep fixture data for manual inspection (no cleanup)
npm run smoke -- --no-cleanup
```

## What's covered today

| Group | Endpoints / behaviors |
|---|---|
| `health` | `GET /health` |
| `workflow-builder` | `GET /api/workflow-builder/picker-catalog` — confirms ≥8 categories + key field presence |
| `auth` | Auth gate works — unauthed → 401, authed → 200 |
| `sla` | List, create, idempotent upsert (NULLS NOT DISTINCT), breaches |
| `pii` | Default config seeding, `outbound_action` flip |
| `ai` | Settings seeding, QA wizard gate, knowledge add |
| `crm` | Stages auto-seed on first read, includes is_won/is_lost |
| `tables` | Create with columns, verify columns landed in DB |
| `sheets-import` | **Regression test for the N+1 bug.** Bulk-inserts 200 rows and asserts <10s — catches any future N+1 regression. |
| `auth-edge` | `/api/inbox/send` without auth, `/api/parse-workflow` with bad tenant |

## Adding a new test

Tests follow the `runTest(group, name, fn)` pattern. Each `fn` is
`async () => void` — throw to fail. Use `assert()` / `assertEq()` for
clarity.

```ts
await runTest('mygroup', 'description of what is tested', async () => {
  const r = await http('/api/my-endpoint', { userToken: fx.userToken, tenantId: fx.tenantId })
  assertEq(r.status, 200, 'response status')
  assert(r.body?.data?.id, 'response has id')
})
```

Things that go in the fixture (created once, reused, cleaned up):
- Test tenant (`tenants` row)
- Test user with owner role (`user_roles`)
- User session JWT (real Supabase auth)

Things that go in `fx.cleanupIds`:
```ts
fx.cleanupIds.push({ table: 'sla_configs', ids: [createdId] })
```
The runner deletes them in reverse insertion order at the end. Service-
role bypasses RLS.

## How this catches the Sheets import bug specifically

The `sheets-import` group inserts 200 rows in a single batch via the
same `lead_rows.insert(batch)` path the production mirror flow uses
(after the recent fix). Previously this path made **one round-trip per
row** (the N+1 dedup query) and timed out past ~100 rows. The smoke
test asserts the insert completes in under 10 seconds — if any future
change reintroduces an N+1, the test fails loudly.

It also catches:
- Column-insert failures (`tables` group verifies columns landed)
- Keyify collision regressions (would surface as `columns_count != requested`)
- Silent-failure regressions on the mirror endpoint (the response shape
  test would catch a missing `import` field)

## Limits / gaps

The current pass does NOT cover (planned for v2):
- WhatsApp message-send (would burn Meta credits)
- Razorpay sandbox-mode payment lifecycle
- AI test endpoint (would burn Anthropic tokens; ~₹2 per run)
- The actual Google Sheets OAuth flow (needs test Google account)
- E2E workflow execution (BullMQ-driven; harder to assert end-state)

For now those are exercised manually before each prod deploy. Adding
them to the smoke suite needs sandbox-mode credentials wired into the
test fixture.

## CI integration

`.github/workflows/smoke.yml` runs this on every push to `stage` against
the deployed staging BE. Failures block the deploy promotion to apex.
