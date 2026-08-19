/**
 * Runnable self-check for the task state machine — assert-based, no framework.
 *
 *   npx tsx src/lib/taskTransitions.selfcheck.ts
 *
 * Exits non-zero on the first failed assertion so it can gate CI if wired up.
 */
import assert from 'node:assert/strict'
import { evaluateTransition, isOpen, ACTION_ROLE, type TaskStatus } from './taskTransitions'

let n = 0
const ok = (cond: boolean, msg: string) => { assert.ok(cond, msg); n++ }

// Happy path: pending → accepted → in_progress → done
ok(evaluateTransition('pending', 'accept').to === 'accepted', 'accept from pending')
ok(evaluateTransition('accepted', 'start').to === 'in_progress', 'start from accepted')
ok(evaluateTransition('in_progress', 'complete').to === 'done', 'complete from in_progress')

// Reject path
ok(evaluateTransition('pending', 'reject').to === 'rejected', 'reject from pending')
ok(evaluateTransition('accepted', 'reject').to === 'rejected', 'reject from accepted')

// Cancel path (creator) — allowed from any open state
for (const s of ['pending', 'accepted', 'in_progress', 'rejected'] as TaskStatus[])
  ok(evaluateTransition(s, 'cancel').to === 'cancelled', `cancel from ${s}`)

// Proof-of-work path: accepted/in_progress → submitted → done (approve) | in_progress (bounce)
ok(evaluateTransition('accepted', 'submit').to === 'submitted', 'submit from accepted')
ok(evaluateTransition('in_progress', 'submit').to === 'submitted', 'submit from in_progress')
ok(evaluateTransition('submitted', 'approve').to === 'done', 'approve from submitted')
ok(evaluateTransition('submitted', 'bounce').to === 'in_progress', 'bounce from submitted')

// Illegal proof transitions must fail closed
ok(!evaluateTransition('pending', 'submit').ok, 'cannot submit straight from pending')
ok(!evaluateTransition('submitted', 'submit').ok, 'cannot re-submit an in-review task')
ok(!evaluateTransition('accepted', 'approve').ok, 'cannot approve before submission')
ok(!evaluateTransition('in_progress', 'approve').ok, 'cannot approve an in-progress task')
ok(!evaluateTransition('done', 'bounce').ok, 'cannot bounce a done task')
ok(!evaluateTransition('accepted', 'bounce').ok, 'cannot bounce before submission')

// Role guards for the proof actions
ok(ACTION_ROLE.submit === 'assignee', 'submit is an assignee action')
ok(ACTION_ROLE.approve === 'creator', 'approve is a creator action')
ok(ACTION_ROLE.bounce === 'creator', 'bounce is a creator action')

// Illegal transitions must fail closed
ok(!evaluateTransition('done', 'accept').ok, 'cannot accept a done task')
ok(!evaluateTransition('done', 'start').ok, 'cannot start a done task')
ok(!evaluateTransition('done', 'cancel').ok, 'cannot cancel a done task')
ok(!evaluateTransition('cancelled', 'accept').ok, 'cannot accept a cancelled task')
ok(!evaluateTransition('rejected', 'accept').ok, 'cannot accept a rejected task')
ok(!evaluateTransition('pending', 'complete').ok, 'cannot complete straight from pending')
ok(!evaluateTransition('in_progress', 'accept').ok, 'cannot re-accept an in-progress task')

// Role guards
ok(ACTION_ROLE.accept === 'assignee', 'accept is an assignee action')
ok(ACTION_ROLE.cancel === 'creator', 'cancel is a creator action')

// isOpen
ok(isOpen('pending') && isOpen('accepted') && isOpen('in_progress'), 'open states are open')
ok(!isOpen('done') && !isOpen('rejected') && !isOpen('cancelled'), 'terminal states are closed')

// eslint-disable-next-line no-console
console.log(`✓ taskTransitions self-check passed (${n} assertions)`)
