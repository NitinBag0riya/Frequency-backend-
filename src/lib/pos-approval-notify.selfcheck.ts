/**
 * Runnable self-check for the POS approval-request notify seam (Phase 3
 * P3-INT-NOTIFY: POST /api/internal/pos-approval-request).
 * Run:  npx tsx src/lib/pos-approval-notify.selfcheck.ts
 * No framework — plain asserts, fetch + supabase faked. Exits non-zero on failure.
 *
 * Covers:
 *   1. verifyInternalSecret — the exact guard the route uses: rejects a
 *      wrong secret, an absent header, and (fail-closed) an unset env secret;
 *      accepts a matching one.
 *   2. dispatchPosApprovalRequest resolves each manager email to a Supabase
 *      auth user, then fires BOTH sendExpoPush and sendWaNotification with
 *      the right recipient + plain-word title/body — proven by faking
 *      supabase + global fetch so the REAL sender functions run without
 *      touching the network, not by swapping them out.
 *   3. An unresolvable email is skipped, not thrown, and does not stop the
 *      next manager's dispatch.
 *   4. WhatsApp send reuses the already-approved `frequency_notification`
 *      template name — never a new/custom template.
 */
import assert from 'node:assert/strict'
import { verifyInternalSecret, dispatchPosApprovalRequest, buildApprovalMessage } from './pos-approval-notify'

// ── 1. verifyInternalSecret — same fail-closed timing-safe guard as the route ──
assert.equal(verifyInternalSecret(undefined, 'anything'), false, 'unset secret env fails closed')
assert.equal(verifyInternalSecret('', 'anything'), false, 'empty secret env fails closed')
assert.equal(verifyInternalSecret('s3cret-abc', ''), false, 'absent header fails')
assert.equal(verifyInternalSecret('s3cret-abc', 's3cret-abd'), false, 'wrong secret rejected')
assert.equal(verifyInternalSecret('s3cret-abc', 's3cret'), false, 'length-mismatched secret rejected')
assert.equal(verifyInternalSecret('s3cret-abc', 's3cret-abc'), true, 'matching secret accepted')

// ── message copy: plain words, no jargon ────────────────────────────────────
{
  const { title, body } = buildApprovalMessage('cancel_bill', { billNo: 'A-142', amountInr: 1240, requestedBy: 'Ravi' })
  assert.equal(title, 'PIN needed: Cancel bill #A-142')
  assert.equal(body, 'PIN needed: Cancel bill #A-142 (₹1240) — Ravi is asking')
}

// ── 2/3/4. dispatchPosApprovalRequest: fake supabase (auth.admin + tables) + fetch ──
async function main() {
  const AUTH_USERS: Record<string, { id: string }> = {
    'priya@maplemortar.test': { id: 'user-priya' },
    'anil@maplemortar.test':  { id: 'user-anil' },
    // 'ghost@maplemortar.test' intentionally absent — unresolvable manager.
  }

  const calls: { url: string; body: any }[] = []
  ;(globalThis as any).fetch = async (url: string, init: any) => {
    calls.push({ url, body: JSON.parse(init.body) })
    if (url.includes('exp.host')) {
      // Expo batch response: one ok ticket per message in the batch.
      const batch = JSON.parse(init.body)
      return { ok: true, json: async () => ({ data: batch.map(() => ({ status: 'ok' })) }) } as any
    }
    // Meta Graph API send.
    return { ok: true, json: async () => ({ messages: [{ id: 'wamid.123' }] }) } as any
  }

  const fake: any = {
    auth: {
      admin: {
        listUsers: async ({ page }: { page: number }) => {
          if (page > 1) return { data: { users: [] }, error: null }
          return {
            data: { users: Object.entries(AUTH_USERS).map(([email, u]) => ({ email, id: u.id })) },
            error: null,
          }
        },
      },
    },
    from(table: string) {
      const b: any = {
        _table: table,
        select: () => b,
        eq(col: string, val: any) { b[`_eq_${col}`] = val; return b },
        maybeSingle: async () => {
          if (table === 'push_devices') return { data: null, error: null } // unused (select returns array below)
          if (table === 'profiles') {
            return { data: { wa_number: '+919876543210' }, error: null }
          }
          if (table === 'tenants') {
            return { data: { phone_number_id: 'pnid-1', access_token: 'plain:test-token', status: 'connected' }, error: null }
          }
          if (table === 'wa_templates') {
            return { data: { status: 'approved', rejection_reason: null }, error: null }
          }
          return { data: null, error: null }
        },
        // push_devices .select().eq() is awaited directly (no .maybeSingle()) in expo-push.ts.
        then(resolve: any) {
          if (table === 'push_devices') {
            resolve({ data: [{ id: 'dev-1', expo_push_token: `ExponentPushToken[${b._eq_user_id}]`, platform: 'ios' }], error: null })
          } else {
            resolve({ data: null, error: null })
          }
        },
      }
      return b
    },
  }

  const out = await dispatchPosApprovalRequest(fake, {
    tenantId: 'tenant-1',
    action: 'cancel_bill',
    context: { billNo: 'A-142', amountInr: 1240, requestedBy: 'Ravi' },
    managerEmails: ['priya@maplemortar.test', 'ghost@maplemortar.test', 'anil@maplemortar.test'],
  })

  // ── 3. unresolvable email skipped, not thrown, doesn't stop the others ──────
  assert.equal(out.notified, 2, 'both resolvable managers notified')
  assert.deepEqual(out.skipped, ['ghost@maplemortar.test'], 'unresolvable manager skipped, not thrown')

  // ── 2. both channels fired, once per resolved manager, right recipient ──────
  const pushCalls = calls.filter(c => c.url.includes('exp.host'))
  const waCalls = calls.filter(c => c.url.includes('graph.facebook.com'))
  assert.equal(pushCalls.length, 2, 'sendExpoPush fired once per resolved manager')
  assert.equal(waCalls.length, 2, 'sendWaNotification fired once per resolved manager')

  const pushTokens = pushCalls.flatMap(c => c.body.map((m: any) => m.to)).sort()
  assert.deepEqual(pushTokens, ['ExponentPushToken[user-anil]', 'ExponentPushToken[user-priya]'].sort(),
    'push targets the resolved manager\'s own devices')
  for (const c of pushCalls) {
    const msg = c.body[0]
    assert.equal(msg.title, 'PIN needed: Cancel bill #A-142')
    assert.match(msg.body, /Ravi is asking/)
  }

  // ── 4. WA reuses the approved `frequency_notification` template — no new one ─
  for (const c of waCalls) {
    assert.equal(c.body.type, 'template')
    assert.equal(c.body.template.name, 'frequency_notification', 'reuses the existing approved template, not a new one')
    assert.equal(c.body.to, '919876543210')
    const params = c.body.template.components[0].parameters
    assert.equal(params[0].text, 'PIN needed: Cancel bill #A-142')
  }

  // ── best-effort: a failing channel for one manager never blocks the other ──
  const originalFetch = (globalThis as any).fetch
  ;(globalThis as any).fetch = async (url: string, init: any) => {
    if (url.includes('exp.host')) throw new Error('network down')
    return originalFetch(url, init)
  }
  const out2 = await dispatchPosApprovalRequest(fake, {
    tenantId: 'tenant-1',
    action: 'free_bill',
    context: {},
    managerEmails: ['priya@maplemortar.test'],
  })
  assert.equal(out2.notified, 1, 'push throwing does not stop the manager being counted / WA attempted')

  console.log('pos-approval-notify.selfcheck: OK')
  console.log('  secret guard rejects wrong/absent/unset, accepts match · resolves emails -> users -> push+WA ' +
    'with right recipient/copy · unresolvable email skipped not thrown · reuses frequency_notification template')
}

main().catch((e) => { console.error('pos-approval-notify self-check FAILED:', e); process.exit(1) })
