/**
 * Task status state-machine — the single source of truth for which lifecycle
 * transitions are legal and who may perform them. Imported by routes/tasks.ts
 * (server enforcement) and by taskTransitions.selfcheck.ts (runnable assertions).
 *
 * Roles:
 *   • assignee — the person the task was assigned to. Accepts / rejects / starts
 *                / completes (or, on a proof task, submits) it.
 *   • creator  — the person who created & assigned it. Can cancel while open,
 *                and on a proof task approves / bounces the submitted work.
 *
 * Proof-of-work path (opt-in per task via `requires_proof`): the assignee
 * SUBMITs proof instead of completing directly → 'submitted'; the creator then
 * APPROVEs (→ done) or BOUNCEs it back with a reason (→ in_progress).
 *
 * Enforcement stays server-side (routes check `actor === assigned_to` etc.);
 * this module only answers "is this transition valid at all?".
 */

export type TaskStatus = 'pending' | 'accepted' | 'rejected' | 'in_progress' | 'submitted' | 'done' | 'cancelled'
export type TaskAction = 'accept' | 'reject' | 'start' | 'complete' | 'submit' | 'approve' | 'bounce' | 'cancel'

export const TASK_STATUSES: TaskStatus[] = ['pending', 'accepted', 'rejected', 'in_progress', 'submitted', 'done', 'cancelled']

/** Terminal states — no further transitions allowed. */
export const TERMINAL_STATUSES: TaskStatus[] = ['rejected', 'done', 'cancelled']

/** Who is allowed to fire each action. */
export const ACTION_ROLE: Record<TaskAction, 'assignee' | 'creator'> = {
  accept: 'assignee',
  reject: 'assignee',
  start: 'assignee',
  complete: 'assignee',
  submit: 'assignee',
  approve: 'creator',
  bounce: 'creator',
  cancel: 'creator',
}

/** action → { from: allowed source statuses, to: resulting status }. */
export const TRANSITIONS: Record<TaskAction, { from: TaskStatus[]; to: TaskStatus }> = {
  accept: { from: ['pending'], to: 'accepted' },
  reject: { from: ['pending', 'accepted'], to: 'rejected' },
  start: { from: ['pending', 'accepted'], to: 'in_progress' },
  complete: { from: ['accepted', 'in_progress'], to: 'done' },
  submit: { from: ['accepted', 'in_progress'], to: 'submitted' },
  approve: { from: ['submitted'], to: 'done' },
  bounce: { from: ['submitted'], to: 'in_progress' },
  cancel: { from: ['pending', 'accepted', 'in_progress', 'rejected'], to: 'cancelled' },
}

/** The activity `action` verb written to task_activity for each transition. */
export const ACTION_VERB: Record<TaskAction, string> = {
  accept: 'accepted',
  reject: 'rejected',
  start: 'started',
  complete: 'completed',
  submit: 'submitted',
  approve: 'approved',
  bounce: 'bounced',
  cancel: 'cancelled',
}

export interface TransitionResult {
  ok: boolean
  to?: TaskStatus
  error?: string
}

/**
 * Validate a transition. Fail-closed: unknown action / illegal source → not ok.
 * Does NOT check identity (that is the route's job) — only the state machine.
 */
export function evaluateTransition(current: TaskStatus, action: TaskAction): TransitionResult {
  const rule = TRANSITIONS[action]
  if (!rule) return { ok: false, error: `unknown action: ${action}` }
  if (!rule.from.includes(current)) {
    return { ok: false, error: `cannot ${action} a task that is '${current}'` }
  }
  return { ok: true, to: rule.to }
}

/** May a task still be edited/reassigned by its creator? (open = not terminal) */
export function isOpen(status: TaskStatus): boolean {
  return !TERMINAL_STATUSES.includes(status)
}
