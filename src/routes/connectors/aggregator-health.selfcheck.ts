// Selfcheck: per-channel health derivation rules.
//   channel.connected = desktop live (fresh heartbeat) AND a real order arrived
//   on the channel within RECENT_ORDER_WINDOW_MS (server-verifiable liveness).
//   Lifetime order history NEVER gates connected (the old everSeen lie).
// Run: compile with tsc + `node aggregator-health.selfcheck.js` (see repo pattern).
import assert from 'node:assert'
import { channelIsLive, channelConnected, orderRecent, HEARTBEAT_WINDOW_MS, RECENT_ORDER_WINDOW_MS } from './aggregator-health.js'

const NOW = 1_000_000_000_000
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString()

// channelIsLive
assert.equal(channelIsLive(null, NOW), false, 'no heartbeat → offline')
assert.equal(channelIsLive(undefined, NOW), false, 'undefined → offline')
assert.equal(channelIsLive(iso(10_000), NOW), true, '10s ago → live')
assert.equal(channelIsLive(iso(HEARTBEAT_WINDOW_MS - 1), NOW), true, 'just inside window → live')
assert.equal(channelIsLive(iso(HEARTBEAT_WINDOW_MS + 1), NOW), false, 'just outside window → offline')
assert.equal(channelIsLive('not-a-date', NOW), false, 'garbage → offline')

// orderRecent — a real order is only "recent" (proof of liveness) within the window
assert.equal(orderRecent(null, NOW), false, 'never got an order → not recent')
assert.equal(orderRecent(iso(5 * 60_000), NOW), true, 'order 5 min ago → recent')
assert.equal(orderRecent(iso(RECENT_ORDER_WINDOW_MS - 1), NOW), true, 'just inside window → recent')
assert.equal(orderRecent(iso(RECENT_ORDER_WINDOW_MS + 1), NOW), false, 'just outside window → NOT recent')
assert.equal(orderRecent(iso(2 * 24 * 60 * 60_000), NOW), false, 'order 2 days ago → NOT recent (the la-fiamma case)')

// connected = online && receiving-recently. Lifetime history is irrelevant here.
assert.equal(channelConnected(true, true), true, 'desktop live + order recent → connected')
assert.equal(channelConnected(true, false), false, 'desktop live but NO recent order → NOT connected (was falsely green on everSeen)')
assert.equal(channelConnected(false, true), false, 'recent order but desktop offline → not connected')
assert.equal(channelConnected(false, false), false, 'neither → not connected')

console.log('✓ aggregator-health selfcheck passed')
