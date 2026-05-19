/**
 * lib/pii-masking.ts — Detect + mask sensitive personal data in inbox messages.
 *
 * Phase 1B of the post-deploy roadmap (docs/ROADMAP.md). Render-time
 * only: message bodies STAY plaintext in storage, mask is applied when
 * the BE serializes for an agent who isn't in the tenant's
 * unmask_roles. Per-message metadata about detected PII fields is
 * returned alongside the masked text so the FE can render tap-to-unmask
 * chips without re-running the regex client-side.
 *
 * ─── Detection ──────────────────────────────────────────────────────────
 *
 * Regex-driven for v1 (good enough for the Indian regulated fields and
 * easy to audit). Optional per-tenant override via
 * pii_masking_config.regex_overrides[field_type] lets BFSI/insurance
 * tenants tighten patterns (e.g. their policy number prefix).
 *
 * Field types + sources:
 *   aadhaar         — 12-digit Indian biometric ID, often space-grouped
 *   pan             — 10-char permanent account number (5A4N1A)
 *   bank_account    — long digit-run (9-18); fuzzy by design
 *   ifsc            — 11-char bank code (4A0[6N])
 *   phone           — Indian mobile + international fallback
 *   email           — standard pattern
 *   dob             — DD/MM/YYYY and natural-language fallback
 *   policy_number   — alnum 6+; default permissive, tighten via override
 *   transaction_id  — alnum 10+; default permissive
 *   otp             — context-aware ("OTP is 1234", "code: 567890")
 *
 * The detector is intentionally permissive — false positives are mostly
 * harmless (an agent taps unmask to see the actual value, no audit
 * regret) while false negatives leak PII (compliance risk). We err
 * toward false-positives.
 *
 * ─── Masking ────────────────────────────────────────────────────────────
 *
 * Each detected span is replaced with a glyph string of the same length
 * (or a fixed sentinel: '████████'). The FE doesn't see the original
 * value — only the field type + a synthetic field_index per message.
 *
 * Returns: { masked: string, fields: DetectedField[] } so the FE can
 * render chips inline (and later use the field_index to request unmask
 * for a specific field on the message).
 *
 * ─── Unmask audit ───────────────────────────────────────────────────────
 *
 * The unmask path lives in routes/pii.ts. This module exports the hash
 * function (sha256 hex) so the audit log records "this agent saw this
 * specific value" without storing the value itself.
 */

import crypto from 'crypto'

export type PiiFieldType =
  | 'aadhaar'
  | 'pan'
  | 'bank_account'
  | 'ifsc'
  | 'phone'
  | 'email'
  | 'dob'
  | 'policy_number'
  | 'transaction_id'
  | 'otp'

export interface DetectedField {
  /** Stable per-message synthetic index (1..N). Used by the FE to
   *  request unmask of a SPECIFIC field without sending the original
   *  value over the wire. */
  field_index: number
  /** Which detector matched. */
  field_type: PiiFieldType
  /** Span boundaries in the ORIGINAL (unmasked) text — useful for the
   *  FE to highlight or for later analytics. */
  start: number
  end: number
  /** sha256 hex of the unmasked value. Stored on unmask in
   *  pii_unmask_log so audit can verify "this agent saw this specific
   *  number" without persisting the value. */
  value_hash: string
}

export interface MaskResult {
  /** The text with detected spans replaced by a fixed-width glyph. */
  masked: string
  /** Detected fields, indexed 1..N in detection order (left-to-right). */
  fields: DetectedField[]
}

// ─── Default regex set ───────────────────────────────────────────────────
//
// Group 0 of each pattern is the whole match — we don't use capture
// groups so callers can rely on the full match boundaries.

const DEFAULT_PATTERNS: Record<PiiFieldType, RegExp> = {
  // 12-digit Aadhaar, optionally in 4-4-4 grouping. We don't validate the
  // Verhoeff checksum at v1; that's a tighten-up if false positives hurt.
  aadhaar:        /\b(?:\d{4}[\s-]?){2}\d{4}\b/g,

  // PAN: 5 alpha + 4 digit + 1 alpha (case-insensitive).
  pan:            /\b[A-Z]{5}[0-9]{4}[A-Z]\b/gi,

  // Bank account: 9-18 digit run NOT preceded/followed by a digit. The
  // outer \b would let "+9198XXXXXXXX" leak; we add a manual boundary.
  bank_account:   /(?<!\d)\d{9,18}(?!\d)/g,

  // IFSC: 4 alpha + '0' + 6 alphanumeric.
  ifsc:           /\b[A-Z]{4}0[A-Z0-9]{6}\b/gi,

  // Phone: Indian +91 / 10-digit / international. Wide pattern, tightened
  // by the messages context (most matches in WA inbox ARE phones).
  phone:          /(?:\+?\d{1,3}[\s-]?)?(?:\d{10}|\d{3}[\s-]?\d{3}[\s-]?\d{4})/g,

  // Email — RFC-lite but more than sufficient for inbox.
  email:          /\b[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}\b/g,

  // Dates resembling DOB: DD/MM/YYYY, DD-MM-YYYY, YYYY-MM-DD. We DON'T
  // mask short dates like "15 Aug" — too many false positives in
  // conversational context. The FE shows a chip; agent decides.
  dob:            /\b(?:\d{1,2}[\/\-.]\d{1,2}[\/\-.]\d{2,4}|\d{4}[\/\-.]\d{1,2}[\/\-.]\d{1,2})\b/g,

  // Policy number: 6-20 alnum, MUST contain at least one letter to skip
  // pure-digit runs (those go through bank_account / phone instead).
  policy_number:  /\b(?=\w*[A-Za-z])(?=\w*\d)[A-Z0-9]{6,20}\b/g,

  // Transaction id: 10+ alnum mixed, often txn_ / pay_ / inv_ prefix.
  transaction_id: /\b(?:txn|pay|inv|order|ref)[_-]?[A-Z0-9]{8,}\b/gi,

  // OTP — context-anchored. We match the digit run AFTER an OTP/code
  // keyword so we don't redact every 4-6 digit number in the chat.
  otp:            /(?:\b(?:otp|code|pin|password|password is|verification)\b[\s:is]{0,8}?)(\d{4,8})\b/gi,
}

/** sha256 hex of a string (canonical for audit logging). */
export function piiValueHash(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex')
}

/**
 * Run the configured detectors against `text`. Returns the masked
 * rendition + per-span metadata.
 *
 * @param text             the raw message body
 * @param enabledTypes     subset of detectors to run (from
 *                         pii_masking_config.enabled_types)
 * @param regexOverrides   tenant-specific overrides keyed by field_type;
 *                         each value parsed as `new RegExp(str, 'g')`
 *                         (or 'gi' if the override contains [A-Z] but
 *                         no /i flag — we keep the default case
 *                         sensitivity per field_type below)
 */
export function maskText(
  text: string,
  enabledTypes: PiiFieldType[],
  regexOverrides: Partial<Record<PiiFieldType, string>> = {},
): MaskResult {
  if (!text) return { masked: '', fields: [] }

  // Build a non-overlapping span list across all enabled detectors.
  // We resolve overlaps by giving the LONGER match priority (so a
  // 12-digit Aadhaar wins over a 10-digit "phone" inside it).
  interface RawSpan { type: PiiFieldType; start: number; end: number; value: string }
  const spans: RawSpan[] = []
  for (const type of enabledTypes) {
    const override = regexOverrides[type]
    let re: RegExp
    try {
      re = override
        ? new RegExp(override, override.includes('/g') ? '' : 'g')
        : new RegExp(DEFAULT_PATTERNS[type].source, DEFAULT_PATTERNS[type].flags)
    } catch {
      re = DEFAULT_PATTERNS[type]   // bad override → fall back to default
    }
    let m: RegExpExecArray | null
    re.lastIndex = 0
    while ((m = re.exec(text)) !== null) {
      // OTP detector captures the actual digit run in group 1; everything
      // else uses the whole match.
      const value = (type === 'otp' && m[1]) ? m[1] : m[0]
      const matchStart = (type === 'otp' && m[1]) ? m.index + m[0].indexOf(m[1]) : m.index
      spans.push({
        type,
        start: matchStart,
        end:   matchStart + value.length,
        value,
      })
      // Defensive: prevent infinite loops on zero-length matches.
      if (m.index === re.lastIndex) re.lastIndex++
    }
  }

  // Sort by start; resolve overlaps by keeping the longer span.
  spans.sort((a, b) => a.start - b.start || (b.end - b.start) - (a.end - a.start))
  const winners: RawSpan[] = []
  for (const s of spans) {
    const last = winners[winners.length - 1]
    if (!last || s.start >= last.end) {
      winners.push(s)
    } else if (s.end - s.start > last.end - last.start) {
      // Replace last with the longer match.
      winners[winners.length - 1] = s
    }
  }

  // Build the masked string + the DetectedField metadata list.
  let masked = ''
  let cursor = 0
  const fields: DetectedField[] = []
  let idx = 0
  for (const w of winners) {
    masked += text.slice(cursor, w.start)
    masked += GLYPH    // fixed-width sentinel
    cursor = w.end
    idx += 1
    fields.push({
      field_index: idx,
      field_type:  w.type,
      start:       w.start,
      end:         w.end,
      value_hash:  piiValueHash(w.value),
    })
  }
  masked += text.slice(cursor)

  return { masked, fields }
}

/** Fixed-width sentinel used in place of any detected value. The FE
 *  renders this as a chip with the field_type label. */
export const GLYPH = '████████'

/**
 * Look up the original value at a specific field_index inside `text`.
 * Used by the unmask endpoint to return the actual value once an agent
 * has been audited. Idempotent — recomputes detection from the source
 * string so we never need to cache plaintext-with-spans on the server.
 *
 * Returns null if field_index is out of bounds OR if the detection no
 * longer surfaces the field (e.g. message was edited).
 */
export function lookupOriginal(
  text: string,
  fieldIndex: number,
  enabledTypes: PiiFieldType[],
  regexOverrides: Partial<Record<PiiFieldType, string>> = {},
): { value: string; field_type: PiiFieldType } | null {
  const { fields } = maskText(text, enabledTypes, regexOverrides)
  const f = fields.find(x => x.field_index === fieldIndex)
  if (!f) return null
  return { value: text.slice(f.start, f.end), field_type: f.field_type }
}
