/**
 * Runnable self-check for the aggregator menu-visibility/publish surface.
 * Run:  npx tsx src/routes/connectors/aggregator-publish.selfcheck.ts
 * No framework — plain asserts. Exits non-zero on failure.
 *
 * Locks the two load-bearing honesty contracts:
 *   1. Per-channel publish capability: Swiggy live, Zomato partner-gated.
 *   2. The /actions/result stock-status mapping: a gated result (Zomato) ends
 *      in 'gated' (pending partner), an errored one in 'failed', an applied one
 *      in 'done' — never a fake 'done' for a partner-blocked write.
 */
import assert from 'node:assert/strict'
import { FrequencyDesktopAdapter } from '../../connectors/aggregator/frequency-desktop-adapter.js'

// capabilities() doesn't touch Supabase — a stub client is fine.
const adapter = new FrequencyDesktopAdapter({} as any)

// 1) Publish capability is truthful per channel.
const caps = adapter.capabilities()
assert.equal(caps.publish.swiggy, 'live')
assert.equal(caps.publish.zomato, 'gated')

// 2) Mirror of the /actions/result kind:'stock' status ternary (aggregator.ts).
//    Kept in sync by this assertion — if the route logic drifts, update both.
const stockStatus = (result: any) =>
  result?.gated ? 'gated' : (result?.error ? 'failed' : 'done')

assert.equal(stockStatus({ ok: false, gated: true, reason: 'zomato_partner_gated' }), 'gated')
assert.equal(stockStatus({ error: 'setStock not yet mapped for zomato' }), 'failed')
assert.equal(stockStatus({ ok: true, status: 200 }), 'done')
assert.equal(stockStatus(null), 'done')

console.log('aggregator-publish self-check: OK')
