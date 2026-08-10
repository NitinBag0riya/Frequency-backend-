/**
 * Complaint-SLA escalation — a tick function modelled on order-sla.ts, but with
 * NO idle worker of its own. It exports `runComplaintSlaTick(supabase)` which is
 * meant to RIDE an existing repeatable tick (the order-sla worker already fires
 * every ~60s). See the INTEGRATION NOTE for the one-line hook.
 *
 * Each tick: scan open complaints whose SLA deadline (`due_at`) is within
 * ESCALATE_LEAD_MS and that haven't escalated yet, emit one high-severity
 * `complaint.sla_breach`, flip status→escalated, and stamp
 * `escalated_notified_at` so each complaint escalates EXACTLY once. A breached
 * complaint can still be resolved afterward — escalation doesn't block work.
 */
import { SupabaseClient } from '@supabase/supabase-js'
import { emitNotification, tenantNotifyRecipients } from '../routes/notifications'

const SOURCE_LABEL: Record<string, string> = { storefront: 'Storefront', swiggy: 'Swiggy', zomato: 'Zomato' }
// Fire when a complaint is within this window of its deadline (default 15min).
const ESCALATE_LEAD_MS = Number(process.env.COMPLAINT_SLA_LEAD_MS ?? 15 * 60 * 1000)

function dueHuman(dueAt: string): string {
  const ms = new Date(dueAt).getTime() - Date.now()
  if (ms <= 0) return 'now'
  const m = Math.round(ms / 60000)
  if (m < 60) return `in ${m}m`
  return `in ${Math.round(m / 60)}h`
}

export async function runComplaintSlaTick(supabase: SupabaseClient): Promise<{ escalated: number }> {
  const cutoff = new Date(Date.now() + ESCALATE_LEAD_MS).toISOString()
  const { data: rows, error } = await supabase.from('complaints')
    .select('id, tenant_id, source, customer_name, due_at')
    .in('status', ['new', 'acknowledged', 'in_progress'])
    .is('escalated_notified_at', null)
    .not('due_at', 'is', null)
    .lte('due_at', cutoff)
    .limit(500)
  if (error) throw new Error(`complaint-sla scan failed: ${error.message}`)
  if (!rows || rows.length === 0) return { escalated: 0 }

  const recipientsByTenant = new Map<string, string[]>()
  let escalated = 0
  for (const c of rows as any[]) {
    try {
      if (!recipientsByTenant.has(c.tenant_id)) {
        recipientsByTenant.set(c.tenant_id, await tenantNotifyRecipients(supabase, c.tenant_id))
      }
      const recipients = recipientsByTenant.get(c.tenant_id)!
      if (recipients.length) {
        await emitNotification(supabase, {
          tenant_id: c.tenant_id,
          event_key: 'complaint.sla_breach',
          recipient_user_ids: recipients,
          link: '/complaints',
          data: {
            source_label: SOURCE_LABEL[c.source] ?? c.source,
            customer: c.customer_name || 'A guest',
            due_human: dueHuman(c.due_at),
            priority: 'high',
          },
        })
      }
      // Stamp + escalate regardless of recipient count so we never rescan it.
      await supabase.from('complaints')
        .update({ escalated_notified_at: new Date().toISOString(), status: 'escalated', updated_at: new Date().toISOString() })
        .eq('id', c.id)
      escalated++
    } catch (e: any) {
      console.warn(`[complaint-sla] escalation failed for ${c.id}: ${e?.message ?? e}`)
    }
  }
  return { escalated }
}
