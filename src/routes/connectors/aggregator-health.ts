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

// A channel (zomato/swiggy) counts as live/"receiving" ONLY on server-verifiable
// proof it is working RIGHT NOW: the desktop is live (fresh heartbeat) AND a real
// order landed on this channel within the recent window. An order arriving is
// undeniable proof the session was logged in and pulling. We deliberately do NOT
// use lifetime order history ("ever seen") — that stays green forever after a single
// historical order even while the channel's session is dead (needs_login) and no
// orders can flow, which is a lie with real business impact (missed orders). The
// precise logged-in/needs_login truth lives in the desktop app; until it reports that
// per-channel on its authenticated poll, recent order flow is the honest signal.
export const RECENT_ORDER_WINDOW_MS = 90 * 60_000 // 90 min

export function orderRecent(lastOrderAt: string | null | undefined, now: number = Date.now()): boolean {
  if (!lastOrderAt) return false
  const t = new Date(lastOrderAt).getTime()
  return Number.isFinite(t) && (now - t) < RECENT_ORDER_WINDOW_MS
}

// online = desktop app is live; receiving = a real order arrived recently on this channel.
export const channelConnected = (online: boolean, receiving: boolean): boolean => online && receiving
