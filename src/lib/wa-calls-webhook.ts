/**
 * WA Business Calling webhook payload processor — extracted so both the
 * live route (routes/wa-calling.ts) and the queue worker
 * (workers/webhook-retry.ts) call the same code.
 *
 * Input: parsed JSON body (signature verified upstream).
 * Side-effect: per-event idempotent insert into call_events + enqueue of
 * the downstream call.event.ingest job.
 *
 * Throws on transient DB errors so the queue worker retries; swallows
 * unique-violation conflicts (duplicate delivery is expected).
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { enqueueCallEventIngest } from '../queue'

export async function processWACallsWebhookPayload(
  supabase: SupabaseClient,
  body: any,
): Promise<void> {
  if (body.object !== 'whatsapp_business_account') return

  for (const entry of body.entry ?? []) {
    const wabaId: string = entry.id
    const { data: tenant } = await supabase.from('tenants')
      .select('id')
      .eq('waba_id', wabaId)
      .eq('status', 'active')
      .maybeSingle()
    if (!tenant) continue

    for (const change of entry.changes ?? []) {
      if (change.field !== 'calls') continue
      const value = change.value ?? {}
      const events: any[] = Array.isArray(value.calls) ? value.calls : []
      for (const ev of events) {
        const metaEventId = String(ev.id ?? ev.event_id ?? '')
        const metaCallId  = String(ev.call_id ?? ev.metadata?.call_id ?? '')
        const eventType   = String(ev.event ?? ev.type ?? 'unknown')
        if (!metaEventId || !metaCallId) continue

        let { data: session } = await supabase
          .from('call_sessions')
          .select('id')
          .eq('tenant_id', tenant.id)
          .eq('meta_call_id', metaCallId)
          .maybeSingle()

        if (!session) {
          const directionGuess: 'inbound' | 'outbound' =
            /ringing|incoming|inbound/i.test(eventType) ? 'inbound' : 'outbound'
          const { data: newSess, error: sessInsErr } = await supabase
            .from('call_sessions')
            .insert({
              tenant_id:         tenant.id,
              direction:         directionGuess,
              status:            'ringing',
              source:            'inbound',
              meta_call_id:      metaCallId,
              meta_waba_id:      wabaId,
              recording_consent: 'none',
            })
            .select('id')
            .maybeSingle()
          if (sessInsErr) {
            // Concurrent insert → re-select; otherwise propagate so the queue retries.
            const { data: existing } = await supabase
              .from('call_sessions')
              .select('id')
              .eq('tenant_id', tenant.id)
              .eq('meta_call_id', metaCallId)
              .maybeSingle()
            session = existing ?? null
          } else {
            session = newSess ?? null
          }
          if (!session?.id) continue
        }

        const { data: created, error: insErr } = await supabase
          .from('call_events')
          .insert({
            tenant_id:       tenant.id,
            call_session_id: session.id,
            meta_event_id:   metaEventId,
            event_type:      eventType,
            raw_payload:     ev,
          })
          .select('id')
          .maybeSingle()

        if (insErr) {
          if ((insErr as any).code !== '23505') {
            // Real DB error — let it bubble so the queue retries.
            throw new Error(`call_events insert: ${insErr.message}`)
          }
          continue
        }
        if (!created?.id) continue

        try {
          await enqueueCallEventIngest({
            tenantId:    tenant.id,
            callEventId: created.id as string,
          })
        } catch (e: any) {
          console.warn(`[wa-calls.processor] enqueue failed: ${e?.message ?? e}`)
        }
      }
    }
  }
}
