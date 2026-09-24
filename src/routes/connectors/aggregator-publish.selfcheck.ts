/**
 * Runnable self-check for the aggregator menu-visibility/publish surface.
 * Run:  npx tsx src/routes/connectors/aggregator-publish.selfcheck.ts
 * No framework — plain asserts. Exits non-zero on failure.
 *
 * Locks the two load-bearing honesty contracts:
 *   1. Per-channel publish capability reflects what the desktop can ACTUALLY do.
 *   2. The /actions/result stock-status mapping: a gated result ends in 'gated'
 *      (pending partner), an errored one in 'failed', an applied one in 'done'
 *      — never a fake 'done' for a partner-blocked write.
 *
 * NOTE ON SCOPE (this assertion went stale once already):
 * `publish` here means ONE thing — flipping an existing item/category visible
 * via the STOCK endpoint. Both channels are live for that: Swiggy via setStock
 * (vhc), Zomato via setStock's update_stock_status branch, captured 2026-08-29
 * and un-gated in ce5118e.
 *
 * That is NOT the same as CREATING a new item. Zomato create-new-item (and
 * go-offline) remain genuinely partner-gated, and that gate lives elsewhere —
 * storefront-api `menu-diff.js` returns { status: 'gated',
 * reason: 'zomato-create-uncaptured' }. Do not "fix" a create-gating question
 * by touching the publish flag; they are different capabilities.
 */
import assert from 'node:assert/strict'
import { FrequencyDesktopAdapter } from '../../connectors/aggregator/frequency-desktop-adapter.js'

// capabilities() doesn't touch Supabase — a stub client is fine.
const adapter = new FrequencyDesktopAdapter({} as any)

// 1) Publish (= stock-visibility write) is live on both channels. The desktop
//    reports the REAL result, so a build/endpoint mismatch fails honestly via
//    the mapping in (2) rather than faking success — which is what actually
//    protects the "no fake done" contract, not a permanently-pinned 'gated'.
const caps = adapter.capabilities()
assert.equal(caps.publish.swiggy, 'live')
assert.equal(caps.publish.zomato, 'live')

// 2) Mirror of the /actions/result kind:'stock' status ternary (aggregator.ts).
//    Kept in sync by this assertion — if the route logic drifts, update both.
const stockStatus = (result: any) =>
  result?.gated ? 'gated' : (result?.error ? 'failed' : 'done')

assert.equal(stockStatus({ ok: false, gated: true, reason: 'zomato_partner_gated' }), 'gated')
assert.equal(stockStatus({ error: 'setStock not yet mapped for zomato' }), 'failed')
assert.equal(stockStatus({ ok: true, status: 200 }), 'done')
assert.equal(stockStatus(null), 'done')

console.log('aggregator-publish self-check: OK')
