// Pure health-derivation helpers for the aggregator connector — no I/O, so they
// can be unit-checked in isolation (see aggregator-health.selfcheck.ts).

// Desktop liveness: the Frequency Desktop app is "online" iff it pinged us within
// the poll window (~90s). Heartbeat is bumped on every orders-ingest / pending poll.
export const HEARTBEAT_WINDOW_MS = 90_000

export function channelIsLive(lastSeenAt: string | null | undefined, now: number = Date.now()): boolean {
  if (!lastSeenAt) return false
  const t = new Date(lastSeenAt).getTime()
  return Number.isFinite(t) && (now - t) < HEARTBEAT_WINDOW_MS
}

// A channel (zomato/swiggy) is "connected" when the desktop is live AND we have
// ingested that channel's orders at least once — i.e. the merchant logged into it
// and it pulled data. Durable across surfaces; no in-memory desktop signal needed.
export const channelConnected = (online: boolean, everSeen: boolean): boolean => online && everSeen
