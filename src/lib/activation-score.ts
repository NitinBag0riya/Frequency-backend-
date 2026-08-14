/**
 * Activation score (spec Part II §6) — a PURE function over the onboarding
 * checklist + order signals, so it is deterministic and unit-testable with no
 * DB. The route module (naruto-onboarding.ts) loads the signals and calls this.
 *
 *   score 0–100 = setup completeness × first-order × week-1 repeat usage
 *
 * The spec phrases it as a product, but a literal multiply collapses to 0 the
 * moment a signal is missing (a fully-configured tenant that hasn't taken an
 * order yet would read 0 — useless as a health gauge). We keep the three inputs
 * as WEIGHTED COMPONENTS of a 0–100 scale instead, and expose the breakdown so
 * the UI can show *why* a score is what it is:
 *
 *   setup  → 50 pts  (fraction of the 8 checklist steps marked done)
 *   first  → 25 pts  (1 real order received: 0 or 25)
 *   repeat → 25 pts  (week-1 order volume, scaled to a target of 5)
 *
 * The 8 step keys MUST stay in sync with the FE catalog in
 * src/lib/onboarding-checklist.ts (one product, two builds). Keep them equal.
 */

export const ONBOARDING_STEP_KEYS = [
  'create', 'outlets', 'catalog', 'storefront',
  'payments', 'comms', 'team', 'test_golive',
] as const

export type OnboardingStepKey = typeof ONBOARDING_STEP_KEYS[number]
export type StepStatus = 'not_started' | 'in_progress' | 'blocked' | 'done'

export interface ChecklistStep {
  status: StepStatus
  who_completed?: 'operator' | 'merchant'
  blocking_reason?: string
  updated_at?: string
}

/** The stored checklist: a partial map of step key → step state. */
export type Checklist = Partial<Record<OnboardingStepKey, ChecklistStep>>

/** Order-side signals the score needs. All optional / zero-safe. */
export interface ActivationSignals {
  firstOrderAt?: string | null
  /** Orders received within 7 days of the first order (or of going live). */
  ordersWeek1?: number
}

export interface ActivationBreakdown {
  setup: number   // 0–50
  first: number   // 0 or 25
  repeat: number  // 0–25
}

export interface ActivationScore {
  score: number                 // 0–100 (rounded)
  breakdown: ActivationBreakdown
  stepsDone: number             // 0–8
  stepsTotal: number            // 8
}

const WEIGHT = { setup: 50, first: 25, repeat: 25 } as const
const REPEAT_TARGET = 5 // week-1 orders that saturate the repeat component

export function stepsDone(checklist: Checklist): number {
  return ONBOARDING_STEP_KEYS.reduce((n, k) => n + (checklist[k]?.status === 'done' ? 1 : 0), 0)
}

export function computeActivationScore(checklist: Checklist, signals: ActivationSignals = {}): ActivationScore {
  const total = ONBOARDING_STEP_KEYS.length
  const done = stepsDone(checklist)
  const setupFrac = done / total

  const hasFirst = !!signals.firstOrderAt
  const week1 = Math.max(0, signals.ordersWeek1 ?? 0)
  const repeatFrac = Math.min(1, week1 / REPEAT_TARGET)

  const breakdown: ActivationBreakdown = {
    setup: Math.round(WEIGHT.setup * setupFrac),
    first: hasFirst ? WEIGHT.first : 0,
    repeat: Math.round(WEIGHT.repeat * repeatFrac),
  }
  const score = Math.max(0, Math.min(100, breakdown.setup + breakdown.first + breakdown.repeat))
  return { score, breakdown, stepsDone: done, stepsTotal: total }
}
