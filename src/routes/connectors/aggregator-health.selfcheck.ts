// Selfcheck: per-channel health derivation rules.
//   channel.connected = desktop live (fresh heartbeat) AND channel ever seen.
//   channelIsLive = lastSeen within HEARTBEAT_WINDOW_MS of `now`.
// Run: compile with tsc + `node aggregator-health.selfcheck.js` (see repo pattern).
import assert from 'node:assert'
import { channelIsLive, channelConnected, HEARTBEAT_WINDOW_MS } from './aggregator-health.js'

const NOW = 1_000_000_000_000
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString()

// channelIsLive
assert.equal(channelIsLive(null, NOW), false, 'no heartbeat → offline')
assert.equal(channelIsLive(undefined, NOW), false, 'undefined → offline')
assert.equal(channelIsLive(iso(10_000), NOW), true, '10s ago → live')
assert.equal(channelIsLive(iso(HEARTBEAT_WINDOW_MS - 1), NOW), true, 'just inside window → live')
assert.equal(channelIsLive(iso(HEARTBEAT_WINDOW_MS + 1), NOW), false, 'just outside window → offline')
assert.equal(channelIsLive('not-a-date', NOW), false, 'garbage → offline')

// connected = online && everSeen (the endpoint's rule)
assert.equal(channelConnected(true, true), true, 'live + seen → connected')
assert.equal(channelConnected(true, false), false, 'live but never seen this channel → not connected')
assert.equal(channelConnected(false, true), false, 'seen before but desktop offline → not connected')
assert.equal(channelConnected(false, false), false, 'neither → not connected')

console.log('✓ aggregator-health selfcheck passed')
