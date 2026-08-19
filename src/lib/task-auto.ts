/**
 * Frequency Tasks — auto-fire (event-driven staff SOPs).
 *
 * Turns the shipped Tasks engine into proactive standard-operating-procedures: a
 * business event (a Khata due crossing a threshold, later a POS cancel / low stock)
 * spawns a task for the owner, so follow-ups aren't forgotten. Called FIRE-AND-FORGET
 * from the event source — it must never block or fail the originating write.
 *
 * Idempotent per (tenant, source_key): a rule that fires repeatedly for the same
 * subject reuses the one OPEN task instead of piling on duplicates. When that task is
 * closed and the condition recurs, a fresh one is created (correct SOP behaviour).
 *
 * ponytail: no feature-gate here — an auto-task is a cheap, deduped row that's only
 * surfaced when the `tasks` feature is on; add a gate if it ever reads as noise.
 */
import type { SupabaseClient } from '@supabase/supabase-js'

/** A customer owing at least this (₹) triggers a follow-up SOP task. */
export const KHATA_DUE_THRESHOLD = 500

const OPEN_STATUSES = ['pending', 'accepted', 'in_progress', 'submitted', 'rejected'] as const

/** Pure: the task payload for a Khata-due follow-up, or null when below threshold.
 *  Extracted so the rule is unit-testable without a DB (see task-auto.selfcheck). */
export function khataDueTask(balance: number, party: { partyKey: string; partyName: string | null }, threshold = KHATA_DUE_THRESHOLD):
  { title: string; sourceKey: string } | null {
  // threshold 0 ⇒ any positive due fires; else the balance must reach the threshold.
  if (!(balance > 0 && balance >= threshold)) return null
  const name = (party.partyName || '').trim() || 'a customer'
  return { title: `Follow up on ₹${Math.round(balance)} due — ${name}`, sourceKey: `khata_due:${party.partyKey}` }
}

/** Insert an auto-task, deduped per (tenant, sourceKey): if a non-terminal task with
 *  this sourceKey already exists, no-op. Returns whether a task was created. */
export async function createAutoTask(
  sb: SupabaseClient,
  tenantId: string,
  t: { title: string; sourceKey: string; assignedTo: string | null; dueAt?: string | null },
): Promise<{ created: boolean }> {
  const { data: open } = await sb.from('tasks')
    .select('id').eq('tenant_id', tenantId).eq('source_key', t.sourceKey)
    .in('status', OPEN_STATUSES as unknown as string[]).limit(1)
  if (open && open.length) return { created: false }
  const { error } = await sb.from('tasks').insert({
    tenant_id: tenantId,
    title: t.title.slice(0, 200),
    created_by: t.assignedTo,   // owner owns the SOP task (system-originated)
    assigned_to: t.assignedTo,
    status: 'pending',
    requires_proof: false,
    due_at: t.dueAt ?? null,
    source_key: t.sourceKey,
  })
  return { created: !error }
}

/** SOP rule: a Khata debit that pushes a customer's running balance over the threshold
 *  auto-creates a follow-up task for the founding owner. Fire-and-forget. */
export async function maybeAutoTaskForKhataDue(
  sb: SupabaseClient,
  tenantId: string,
  party: { partyKey: string; partyName: string | null },
): Promise<void> {
  const { data: rows } = await sb.from('ledger_entries')
    .select('direction, amount').eq('tenant_id', tenantId).eq('party_key', party.partyKey)
  if (!rows) return
  const balance = rows.reduce((s, e: any) => s + (e.direction === 'debit' ? Number(e.amount) : -Number(e.amount)), 0)
  // Per-tenant threshold (₹). A stored integer ≥ 0 wins (0 = any due); else the ₹500 default.
  const { data: t } = await sb.from('tenants').select('user_id, khata_due_task_threshold').eq('id', tenantId).maybeSingle()
  const stored = (t as any)?.khata_due_task_threshold
  const threshold = Number.isInteger(stored) && stored >= 0 ? stored : KHATA_DUE_THRESHOLD
  const task = khataDueTask(balance, party, threshold)
  if (!task) return
  await createAutoTask(sb, tenantId, { ...task, assignedTo: (t as any)?.user_id ?? null })
}
