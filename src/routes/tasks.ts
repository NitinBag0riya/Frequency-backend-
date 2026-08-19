/**
 * Org Tasks — cross-vertical internal follow-up tracker (all verticals).
 *
 * A teammate assigns a task; it lands in the assignee's list with an
 * Accept / Reject(reason) / Start / Done lifecycle. Every status change writes
 * a task_activity row and notifies the OTHER party via emitNotification, so the
 * assigner sees each change and the assignee sees edits/reassignment.
 *
 * Tenant-scoped + feature-gated exactly like appointments.ts (checkPermission
 * carries the `tasks` entitlement + userDataScope). Status transitions and the
 * assignee/creator identity rules are enforced SERVER-SIDE — the FE only hides.
 */
import express from 'express'
import { SupabaseClient } from '@supabase/supabase-js'
import { emitNotification } from './notifications'
import {
  evaluateTransition, ACTION_VERB, isOpen,
  type TaskAction, type TaskStatus,
} from '../lib/taskTransitions'

type Mw = (req: express.Request, res: express.Response, next: express.NextFunction) => void | Promise<void>
const PRIORITIES = ['low', 'normal', 'high', 'urgent'] as const
const LINKED_TYPES = ['lead', 'appointment', 'order'] as const

export function createTasksRouter(
  supabase: SupabaseClient,
  requireAuth: Mw,
  identifyTenant: Mw,
  checkPermission: (f: string, a: 'view' | 'edit' | 'delete') => Mw,
) {
  const router = express.Router()
  // Gated behind the `tasks` feature/entitlement. Reuses the leads permission
  // for the RBAC matrix via PERMISSION_KEY_ALIASES (tasks → leads).
  const view = [requireAuth, identifyTenant, checkPermission('tasks', 'view')]
  const edit = [requireAuth, identifyTenant, checkPermission('tasks', 'edit')]

  const actor = (req: express.Request) => ({
    id: (req as any).user?.id as string | undefined,
    email: (req as any).user?.email as string | undefined,
  })

  // Write an activity-trail row (best-effort; never blocks the response).
  const logActivity = async (taskId: string, actorId: string | undefined, action: string, note?: string | null) => {
    await supabase.from('task_activity').insert({ task_id: taskId, actor: actorId ?? null, action, note: note ?? null }).then(
      () => {}, (e: any) => console.error('[tasks] activity log failed', e?.message),
    )
  }

  // Notify a single recipient (dedup: never ping yourself). Best-effort.
  const notify = async (
    tenantId: string, recipient: string | null | undefined, self: string | undefined,
    eventKey: 'task.assigned' | 'task.updated', data: Record<string, any>,
  ) => {
    if (!recipient || recipient === self) return
    await emitNotification(supabase, {
      tenant_id: tenantId, event_key: eventKey, recipient_user_ids: [recipient], data, link: '/tasks',
    }).catch((e: any) => console.error('[tasks] notify failed', e?.message))
  }

  // ── GET /tasks?filter=mine|created|all&status=&assigned_to= ────────────────
  router.get('/tasks', ...view, async (req, res) => {
    const tenantId = (req as any).tenantId
    const me = actor(req).id
    const filter = String(req.query.filter ?? 'all')

    let q = supabase.from('tasks').select('*').eq('tenant_id', tenantId).order('created_at', { ascending: false })
    if (filter === 'mine') q = q.eq('assigned_to', me)
    else if (filter === 'created') q = q.eq('created_by', me)

    // Staff scoped to 'own' only ever see tasks they were assigned OR created —
    // a server boundary, not a UI filter (mirrors appointments.ts).
    if ((req as any).userDataScope === 'own' && filter === 'all') {
      q = q.or(`assigned_to.eq.${me},created_by.eq.${me}`)
    }
    if (req.query.status) q = q.eq('status', String(req.query.status))
    if (req.query.assigned_to) q = q.eq('assigned_to', String(req.query.assigned_to))

    const { data, error } = await q
    if (error) return res.status(500).json({ error: error.message })
    res.json({ tasks: data ?? [] })
  })

  // ── POST /tasks — create + assign (status=pending) → notify assignee ───────
  router.post('/tasks', ...edit, async (req, res) => {
    const tenantId = (req as any).tenantId
    const { id: meId, email: meEmail } = actor(req)
    const b = (req.body ?? {}) as any

    const title = typeof b.title === 'string' ? b.title.trim() : ''
    if (!title) return res.status(400).json({ error: 'title is required' })
    const priority = PRIORITIES.includes(b.priority) ? b.priority : 'normal'
    const linkedType = LINKED_TYPES.includes(b.linkedType) ? b.linkedType : null

    const { data, error } = await supabase.from('tasks').insert({
      tenant_id: tenantId,
      title,
      description: typeof b.description === 'string' && b.description.trim() ? b.description.trim() : null,
      created_by: meId ?? null,
      assigned_to: b.assignedTo || null,
      assignee_name: b.assigneeName ?? null,
      priority,
      status: 'pending',
      requires_proof: !!b.requiresProof,
      due_at: b.dueAt || null,
      linked_type: linkedType,
      linked_id: linkedType ? (b.linkedId ?? null) : null,
    }).select().single()
    if (error) return res.status(500).json({ error: error.message })

    await logActivity(data.id, meId, 'created')
    if (data.assigned_to) {
      await logActivity(data.id, meId, 'assigned', data.assignee_name ?? null)
      await notify(tenantId, data.assigned_to, meId, 'task.assigned', {
        assigner: meEmail ?? 'A teammate', title: data.title, priority: data.priority,
      })
    }
    res.json({ task: data })
  })

  // ── PATCH /tasks/:id — creator edits while the task is still open ──────────
  router.patch('/tasks/:id', ...edit, async (req, res) => {
    const tenantId = (req as any).tenantId
    const { id: meId } = actor(req)
    const b = (req.body ?? {}) as any

    const { data: task, error: loadErr } = await supabase.from('tasks')
      .select('*').eq('tenant_id', tenantId).eq('id', req.params.id).maybeSingle()
    if (loadErr) return res.status(500).json({ error: loadErr.message })
    if (!task) return res.status(404).json({ error: 'task not found' })
    // Fail-CLOSED: a task with no creator is not editable by just anyone (mirrors the
    // assignee gate). A null created_by must never fall through to "allowed".
    if (!task.created_by || task.created_by !== meId) return res.status(403).json({ error: 'only the creator can edit this task' })
    if (!isOpen(task.status as TaskStatus)) return res.status(409).json({ error: `cannot edit a '${task.status}' task` })

    const patch: Record<string, unknown> = { updated_at: new Date().toISOString() }
    if (typeof b.title === 'string') { const t = b.title.trim(); if (!t) return res.status(400).json({ error: 'title cannot be empty' }); patch.title = t }
    if (b.description !== undefined) patch.description = b.description === '' ? null : b.description
    if (b.dueAt !== undefined) patch.due_at = b.dueAt || null
    if (b.priority !== undefined) { if (!PRIORITIES.includes(b.priority)) return res.status(400).json({ error: 'bad priority' }); patch.priority = b.priority }
    if (b.requiresProof !== undefined) patch.requires_proof = !!b.requiresProof

    // Reassign — hands the task to a new teammate. Resets to pending so the new
    // assignee runs the accept/reject flow fresh; notifies them.
    let reassignedTo: string | null = null
    if (b.assignedTo !== undefined && (b.assignedTo || null) !== (task.assigned_to || null)) {
      patch.assigned_to = b.assignedTo || null
      patch.assignee_name = b.assigneeName ?? null
      patch.status = 'pending'
      patch.reject_reason = null
      patch.completed_at = null
      // Clear the previous assignee's proof/review so the new person (and the creator's
      // next review) never sees stale evidence from the old assignee.
      patch.proof = null
      patch.submission_note = null
      patch.submitted_at = null
      patch.review_note = null
      patch.reviewed_by = null
      patch.reviewed_at = null
      patch.accepted_at = null
      reassignedTo = b.assignedTo || null
    }

    const { data, error } = await supabase.from('tasks').update(patch)
      .eq('tenant_id', tenantId).eq('id', req.params.id).select().single()
    if (error) return res.status(500).json({ error: error.message })

    await logActivity(data.id, meId, reassignedTo ? 'reassigned' : 'updated', reassignedTo ? (data.assignee_name ?? null) : null)
    if (reassignedTo) await notify(tenantId, reassignedTo, meId, 'task.assigned', { assigner: actor(req).email ?? 'A teammate', title: data.title, priority: data.priority })
    res.json({ task: data })
  })

  // ── Lifecycle actions ──────────────────────────────────────────────────────
  // accept / reject / start / complete / submit → assignee only;
  // approve / bounce / cancel → creator only.
  const CREATOR_ACTIONS = new Set<TaskAction>(['cancel', 'approve', 'bounce'])
  // Proof files must live in OUR public assets bucket — never a caller-supplied
  // arbitrary URL. Mirrors the assets-route host (assets.getfrequency.app).
  const ASSETS_HOST = 'https://assets.getfrequency.app/'

  const runAction = (action: TaskAction) => async (req: express.Request, res: express.Response) => {
    const tenantId = (req as any).tenantId
    const { id: meId, email: meEmail } = actor(req)
    const b = (req.body ?? {}) as any

    const { data: task, error: loadErr } = await supabase.from('tasks')
      .select('*').eq('tenant_id', tenantId).eq('id', req.params.id).maybeSingle()
    if (loadErr) return res.status(500).json({ error: loadErr.message })
    if (!task) return res.status(404).json({ error: 'task not found' })

    // Identity gate — server-enforced, not a UI hint. Fail-CLOSED on both sides: a task
    // with no creator must NOT let just anyone approve/bounce/cancel it (proof-bypass).
    if (CREATOR_ACTIONS.has(action)) {
      if (!task.created_by || task.created_by !== meId) return res.status(403).json({ error: `only the creator can ${action === 'cancel' ? 'cancel' : 'review'} this task` })
    } else {
      if (!task.assigned_to || task.assigned_to !== meId) return res.status(403).json({ error: 'only the assignee can do that' })
    }

    // Reject / bounce both require a reason.
    let reason: string | null = null
    if (action === 'reject' || action === 'bounce') {
      reason = typeof b.reason === 'string' ? b.reason.trim() : ''
      if (!reason) return res.status(400).json({ error: `a reason is required to ${action === 'reject' ? 'reject' : 'send back'}` })
    }

    // Submit requires ≥1 proof item, each hosted in our assets bucket.
    let proof: { url: string; type: string | null; name: string | null; size: number | null }[] | null = null
    let submissionNote: string | null = null
    if (action === 'submit') {
      const raw = Array.isArray(b.proof) ? b.proof : []
      const clean = raw
        .filter((p: any) => p && typeof p.url === 'string' && p.url.startsWith(ASSETS_HOST))
        .map((p: any) => ({
          url: p.url as string,
          type: typeof p.type === 'string' ? p.type : null,
          name: typeof p.name === 'string' ? p.name : null,
          size: typeof p.size === 'number' ? p.size : null,
        }))
      if (clean.length === 0) return res.status(400).json({ error: 'attach at least one proof file to submit' })
      proof = clean
      submissionNote = typeof b.note === 'string' && b.note.trim() ? b.note.trim() : null
    }

    // Close the boundary: a proof task can never take the plain done path.
    if (action === 'complete' && task.requires_proof) {
      return res.status(409).json({ error: 'this task needs proof — submit proof for review instead' })
    }

    const t = evaluateTransition(task.status as TaskStatus, action)
    if (!t.ok) return res.status(409).json({ error: t.error })

    const now = new Date().toISOString()
    const patch: Record<string, unknown> = { status: t.to, updated_at: now }
    if (action === 'reject') patch.reject_reason = reason
    if (action === 'accept') patch.accepted_at = now
    if (action === 'submit') { patch.proof = proof; patch.submission_note = submissionNote; patch.submitted_at = now }
    if (action === 'approve') { patch.reviewed_by = meId ?? null; patch.reviewed_at = now }
    if (action === 'bounce') { patch.review_note = reason; patch.reviewed_by = meId ?? null; patch.reviewed_at = now }
    if (t.to === 'done') patch.completed_at = now

    const { data, error } = await supabase.from('tasks').update(patch)
      .eq('tenant_id', tenantId).eq('id', req.params.id).select().single()
    if (error) return res.status(500).json({ error: error.message })

    await logActivity(data.id, meId, ACTION_VERB[action], action === 'submit' ? submissionNote : reason)
    // Notify the OTHER party: assignee actions → creator; creator actions
    // (cancel/approve/bounce) → assignee.
    const other = CREATOR_ACTIONS.has(action) ? data.assigned_to : data.created_by
    await notify(tenantId, other, meId, 'task.updated', {
      status: t.to, title: data.title, actor: meEmail ?? 'A teammate',
      summary: reason ? `${meEmail ?? 'A teammate'}: ${reason}` : `${meEmail ?? 'A teammate'} marked it ${t.to}`,
    })
    res.json({ task: data })
  }

  router.post('/tasks/:id/accept', ...edit, runAction('accept'))
  router.post('/tasks/:id/reject', ...edit, runAction('reject'))
  router.post('/tasks/:id/start', ...edit, runAction('start'))
  router.post('/tasks/:id/complete', ...edit, runAction('complete'))
  router.post('/tasks/:id/submit', ...edit, runAction('submit'))
  router.post('/tasks/:id/approve', ...edit, runAction('approve'))
  router.post('/tasks/:id/bounce', ...edit, runAction('bounce'))
  router.post('/tasks/:id/cancel', ...edit, runAction('cancel'))

  // ── GET /tasks/:id/activity — the update trail ─────────────────────────────
  router.get('/tasks/:id/activity', ...view, async (req, res) => {
    const tenantId = (req as any).tenantId
    const me = actor(req).id
    // Confirm the task is in this tenant before returning its trail.
    const { data: task } = await supabase.from('tasks').select('id, assigned_to, created_by').eq('tenant_id', tenantId).eq('id', req.params.id).maybeSingle()
    if (!task) return res.status(404).json({ error: 'task not found' })
    // Own-scoped staff only read the trail (reject/bounce reasons, notes) of a task they're
    // on — same boundary the list endpoint applies; otherwise a guessed id leaks it.
    if ((req as any).userDataScope === 'own' && task.assigned_to !== me && task.created_by !== me) {
      return res.status(403).json({ error: 'you can only view your own tasks' })
    }
    const { data, error } = await supabase.from('task_activity')
      .select('*').eq('task_id', req.params.id).order('at', { ascending: true })
    if (error) return res.status(500).json({ error: error.message })
    res.json({ activity: data ?? [] })
  })

  return router
}
