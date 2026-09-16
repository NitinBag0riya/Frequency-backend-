/**
 * safe-regex.ts — ReDoS-resistant execution of tenant-authored validation patterns.
 *
 * Tenant-configured form/site field patterns are compiled with `new RegExp(...)`
 * and matched against public submitter input inside the shared request process.
 * A catastrophically-backtracking pattern (e.g. `^(a+)+$`) can stall the Node
 * event loop for seconds, degrading availability for every tenant on the process.
 *
 * Node has no built-in regex timeout, so this helper defends in two layers with
 * no external dependency:
 *   1. Cap the input length before matching (bounds the backtracking work).
 *   2. Statically reject patterns whose shape is prone to exponential
 *      backtracking (nested/adjacent unbounded quantifiers, unbounded quantifier
 *      over a group that itself contains a quantifier). Unsafe patterns are
 *      skipped rather than executed.
 *
 * For a stronger guarantee, swap the internal matcher for the `re2` package
 * (linear-time, no catastrophic backtracking) — kept dependency-free here.
 */

/** Maximum input length we will run a tenant regex against. */
export const MAX_REGEX_INPUT = 4096;

/**
 * Heuristic ReDoS detector. Returns true when the pattern looks safe to run.
 * Conservative: when in doubt it returns false (skip execution) rather than
 * risk a hang. It does not aim to accept every safe pattern, only to reject the
 * dangerous shapes that cause exponential backtracking.
 */
export function isPatternSafe(pattern: string): boolean {
  if (typeof pattern !== "string") return false;
  // Overly long patterns are themselves suspicious and hard to reason about.
  if (pattern.length > 1000) return false;

  // A quantifier applied to a group whose body already contains a quantifier is
  // the classic exponential shape: (a+)+, (a*)*, (a+)*, (.*)+, (\d+|x)+, etc.
  // Match a group "(...)" immediately followed by a quantifier, where the group
  // body contains its own quantifier.
  const groupWithQuantifier = /\(([^()]*)\)\s*[*+]|\(([^()]*)\)\s*\{\d+,\s*\}/g;
  let m: RegExpExecArray | null;
  while ((m = groupWithQuantifier.exec(pattern)) !== null) {
    const body = m[1] ?? m[2] ?? "";
    if (/[*+]|\{\d+,\s*\}/.test(body)) return false; // nested unbounded quantifier
  }

  // Adjacent unbounded quantifiers on overlapping classes, e.g. `\d+\d+`, `.*.*`,
  // `[a-z]+[a-z]*` — a common superlinear shape.
  if (/(\\[dwsDWS]|\[[^\]]+\]|\.)[*+]\s*\1[*+]/.test(pattern)) return false;

  return true;
}

/**
 * Test `value` against a tenant-authored `pattern` without risking a ReDoS stall.
 * Returns:
 *   - true/false  : the pattern ran and matched / did not match
 *   - null        : the pattern was skipped (malformed, or judged unsafe, or the
 *                   input exceeded MAX_REGEX_INPUT) — callers should treat a null
 *                   as "validation not applied" and not block submission on it.
 */
export function safeRegexTest(pattern: string, value: string): boolean | null {
  if (typeof pattern !== "string" || pattern.length === 0) return null;
  if (typeof value !== "string") value = String(value ?? "");
  if (value.length > MAX_REGEX_INPUT) return null;
  if (!isPatternSafe(pattern)) return null;
  try {
    return new RegExp(pattern).test(value);
  } catch {
    return null; // malformed pattern — skip, matching prior behavior
  }
}
