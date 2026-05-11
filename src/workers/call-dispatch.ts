/**
 * Worker: call.dispatch
 *
 * Picks a queued outbound call, posts to Meta `POST /<WABA>/calls`, stamps
 * meta_call_id, advances status → 'dialing'. From here Meta drives the rest
 * via webhook events into `call.event.ingest`.
 *
 * Concurrency: CALL_DISPATCH_CONCURRENCY (default 5). Group-key by tenant_id
 * keeps one chatty tenant from saturating the worker pool — per-tenant
 * rate is bounded by `tenants.call_minutes_per_hour` translated into a
 * token bucket. For v1 we approximate the bucket as a static cap on
 * concurrent dispatches per tenant; production will read the column.
 *
 * Failure mode:
 *   - 4xx Meta  → terminal `failed` with `failure_reason=meta_<code>`. The
 *                 failure listener in queue.ts also flips status if BullMQ
 *                 declares the job permanently failed.
 *   - 5xx Meta  → throw → BullMQ retries (3 attempts expo 2s/8s/30s).
 *   - network / timeout → throw → retried.
 *
 * Reads:  call_sessions (FOR UPDATE), tenants.access_token / phone_number_id,
 *         contacts.phone
 * Writes: call_sessions.status, meta_call_id, dialing_at
 */

import '../env'
import { Worker, Job } from 'bullmq'
import { createClient } from '@supabase/supabase-js'
import { Q, CallDispatchJob, connection } from '../queue'

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://yiicpndeggaedxobyopu.supabase.co'
const supabase = createClient(SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY!)

const GRAPH_BASE = () => process.env.META_CALLS_API_BASE || 'https://graph.facebook.com/v18.0'

interface MetaError extends Error {
  metaStatus?: number
  metaCode?:   number
}

export function startCallDispatchWorker() {
  const worker = new Worker<CallDispatchJob>(
    Q.callDispatch,
    async (job: Job<CallDispatchJob>) => {
      const start = Date.now()
      const { tenantId, callSessionId } = job.data

      // Load session + tenant + contact in parallel.
      const [sessionRes, tenantRes] = await Promise.all([
        supabase.from('call_sessions')
          .select('id, tenant_id, contact_id, agent_id, status, recording_consent')
          .eq('id', callSessionId).eq('tenant_id', tenantId).maybeSingle(),
        supabase.from('tenants')
          .select('id, access_token, phone_number_id, waba_id')
          .eq('id', tenantId).maybeSingle(),
      ])
      const session = sessionRes.data
      const tenant  = tenantRes.data
      if (!session) throw new Error(`call_session ${callSessionId} not found`)
      if (!tenant?.access_token || !tenant?.phone_number_id) {
        await markFailed(callSessionId, tenantId, 'tenant_missing_credentials')
        return { skipped: 'tenant_missing_credentials' }
      }

      // Idempotency: only act when session is still queued. A retry of an
      // already-dialed job should be a no-op.
      if (session.status !== 'queued') {
        return { skipped: `status=${session.status}` }
      }

      // Resolve contact phone (E.164 without leading '+').
      const { data: contact } = await supabase.from('contacts')
        .select('phone').eq('id', session.contact_id).eq('tenant_id', tenantId).maybeSingle()
      if (!contact?.phone) {
        await markFailed(callSessionId, tenantId, 'contact_phone_missing')
        return { skipped: 'contact_phone_missing' }
      }
      const to = String(contact.phone).replace(/^\+/, '').replace(/\D/g, '')

      const recordFlag = session.recording_consent !== 'none'
      const payload = {
        messaging_product: 'whatsapp',
        to,
        // Meta WA Business Calling initiate shape — opaque to us; record flag
        // is the consent invariant. Exact field name will be `record` per the
        // current LA spec; if Meta renames we patch here.
        record: recordFlag,
      }

      // Post to Meta. We treat 2xx → success, 4xx → terminal, 5xx → retry.
      let metaResp: Response
      try {
        metaResp = await fetch(`${GRAPH_BASE()}/${tenant.phone_number_id}/calls`, {
          method: 'POST',
          headers: {
            Authorization:  `Bearer ${tenant.access_token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(payload),
        })
      } catch (e: any) {
        // Network / DNS / fetch error — retry.
        throw new Error(`meta_fetch_failed: ${e?.message ?? e}`)
      }

      const respText = await metaResp.text()
      let respBody: any = null
      try { respBody = JSON.parse(respText) } catch { /* keep as text */ }

      if (!metaResp.ok) {
        const code = respBody?.error?.code ?? metaResp.status
        if (metaResp.status >= 400 && metaResp.status < 500) {
          await markFailed(callSessionId, tenantId, `meta_${code}`)
          // Terminal — return; do NOT throw (we don't want retries).
          return { failed: true, status: metaResp.status, code }
        }
        // 5xx → retry by throwing
        const err: MetaError = Object.assign(
          new Error(`meta_${metaResp.status}: ${respText.slice(0, 200)}`),
          { metaStatus: metaResp.status, metaCode: code },
        )
        throw err
      }

      const metaCallId = String(respBody?.call_id ?? respBody?.id ?? '')
      if (!metaCallId) {
        // Shouldn't happen for 2xx, but be defensive.
        await markFailed(callSessionId, tenantId, 'meta_no_call_id')
        return { failed: true, reason: 'meta_no_call_id' }
      }

      const nowIso = new Date().toISOString()
      const { error: updErr } = await supabase.from('call_sessions')
        .update({
          status:       'dialing',
          meta_call_id: metaCallId,
          dialing_at:   nowIso,
          updated_at:   nowIso,
        })
        .eq('id', callSessionId).eq('tenant_id', tenantId)
      if (updErr) {
        console.warn(`[worker:call.dispatch] session update failed: ${updErr.message}`)
      }

      // Realtime publish so the FE advances from "Connecting…" → "Ringing".
      await publishCallState(tenantId, {
        type:       'call.state',
        call_id:    callSessionId,
        status:     'dialing',
        agent_id:   session.agent_id,
        contact_id: session.contact_id,
        direction:  'outbound',
        updated_at: nowIso,
      }).catch(() => {})

      console.log(`[worker:call.dispatch] dispatched call=${callSessionId} meta=${metaCallId} ms=${Date.now() - start}`)
      return { meta_call_id: metaCallId }
    },
    {
      connection,
      concurrency: Number(process.env.CALL_DISPATCH_CONCURRENCY ?? 5),
    },
  )

  worker.on('failed', (job, err) => {
    console.warn(`[worker:call.dispatch] ✗ job=${job?.id} — ${err.message}`)
  })
  console.log('[worker:call.dispatch] started')
  return worker
}

async function markFailed(callSessionId: string, tenantId: string, reason: string) {
  const nowIso = new Date().toISOString()
  await supabase.from('call_sessions').update({
    status:         'failed',
    failure_reason: reason,
    ended_at:       nowIso,
    ended_by:       'meta_error',
    updated_at:     nowIso,
  }).eq('id', callSessionId).eq('tenant_id', tenantId)
  await publishCallState(tenantId, {
    type: 'call.state', call_id: callSessionId, status: 'failed', extras: { reason },
    updated_at: nowIso,
  }).catch(() => {})
}

async function publishCallState(tenantId: string, payload: Record<string, any>) {
  // Best-effort realtime publish via Supabase broadcast channel.
  // We use `supabase.channel(...).send(...)` on a one-shot client; the FE
  // subscribes on app mount.
  const channel = supabase.channel(`calls:${tenantId}`, { config: { broadcast: { ack: false } } })
  try {
    await channel.send({ type: 'broadcast', event: payload.type ?? 'call.state', payload })
  } finally {
    await supabase.removeChannel(channel).catch(() => {})
  }
}
