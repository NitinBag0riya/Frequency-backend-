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
