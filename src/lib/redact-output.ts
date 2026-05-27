/**
 * redact-output — strip the highest-risk PII categories from
 * `workflow_executions.output` (and similar execution-log JSON
 * payloads) before they hit the database.
 *
 * Why we need this, even though we already have maskText() in
 * lib/pii-masking.ts: that helper is designed for *render-time* masking
 * on the inbox path, where the original plaintext stays on the
 * `messages` row and the mask happens server-side at /api/inbox/messages
 * read time. Execution logs are different —
 *
 *   1. They're append-only and read by tenant admins during debugging,
 *      so the unmask UX doesn't apply (no per-event approval flow).
 *   2. They can carry customer text via `collect_input` outputs, HTTP
 *      response bodies, and AI responder reply_text — all of which
 *      flow through unsanitised today.
 *   3. wacrm's 0.2.0 PII fix (their PR #123) explicitly redacts
 *      `flow_run_events.payload` for `reply_received` events: store
 *      length, not content. Same threat model here.
 *
 * Scope of redaction (intentionally narrow):
 *   - aadhaar (12-digit IDs — the most-sensitive Indian PII)
 *   - pan
 *   - bank_account
 *   - otp
 *
 * We do NOT redact phone / email / dob in execution logs by default
 * because they're often part of the *legitimate* workflow data
 * (a "collect_email" node literally has the customer's email as its
 * output — masking it would defeat the workflow's purpose). The four
 * categories above are categorically high-risk: an aadhaar number
 * has no business being in an execution log.
 *
 * Per-tenant configurability is out of scope for v1 — a tenant who
 * needs phone/email masked in logs as well can graduate to the
 * full pii_masking_config flow later. Hardcoding the high-risk set
 * means no DB roundtrip on the executor hot path (zero added latency).
 *
 * Idempotent: calling redactOutputForLogging twice on the same value
 * yields the same result (masked spans look the same to the regex
 * the second time around — the `XXXXXXXX (aadhaar)` chip is not a
 * 12-digit run, so it doesn't re-match).
 */

import { maskText, type PiiFieldType } from './pii-masking'

// Hot-path redaction set. Kept separate from pii_masking_config because:
//   - we don't want a tenant who turned off aadhaar masking IN THE INBOX
//     to also lose it in execution logs (different threat surface).
//   - we don't want to pay a DB roundtrip per node executed to load the
//     config; loading at worker boot wouldn't pick up tenant changes.
const REDACT_TYPES: PiiFieldType[] = ['aadhaar', 'pan', 'bank_account', 'otp']

// Max bytes we'll redact in a single string field. Strings larger than
// this are passed through unmodified — they're almost certainly NOT PII
// (file blobs, large HTML responses) and running multi-regex scans on
// them on every execution row would be a real CPU drain.
const MAX_REDACTABLE_STRING = 64 * 1024 // 64 KB

// Max depth we'll walk into a nested JSON value. Stops cycles and keeps
// the redactor from chewing on pathological payloads. Real workflow
// output is typically 1-3 levels deep.
const MAX_DEPTH = 6

function redactString(s: string): string {
  if (s.length > MAX_REDACTABLE_STRING) return s
  // maskText with hardcoded REDACT_TYPES and no overrides — same regex
  // implementation the inbox uses, just a different enabled set.
  const result = maskText(s, REDACT_TYPES)
  return result.masked
}

/**
 * Walk a JSON-shaped value and redact every string we find. Numbers,
 * booleans, null pass through. Arrays + objects recurse up to MAX_DEPTH.
 *
 * Returns a NEW value — never mutates the input. Callers should pass
 * the returned value to the DB; the original reference is intact for
 * in-memory use elsewhere in the executor (e.g. the worker's return
 * value, which is read by BullMQ but not persisted to Supabase).
 */
export function redactOutputForLogging<T = unknown>(value: T): T {
  return walk(value, 0) as T
}

function walk(v: unknown, depth: number): unknown {
  if (v == null) return v
  if (depth > MAX_DEPTH) return v
  if (typeof v === 'string')  return redactString(v)
  if (typeof v === 'number' || typeof v === 'boolean') return v
  if (Array.isArray(v)) {
    return v.map(item => walk(item, depth + 1))
  }
  if (typeof v === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      out[k] = walk(val, depth + 1)
    }
    return out
  }
  // Functions, symbols, etc. — not JSON-serialisable, pass through and
  // let the DB layer reject them rather than silently dropping.
  return v
}
