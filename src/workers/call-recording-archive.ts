/**
 * Worker: call.recording.archive
 *
 * Streams a Meta-hosted recording into the `inbox-media` Supabase Storage
 * bucket at path `calls/<tenant_id>/<call_session_id>.opus`. On success,
 * upserts `call_recordings`. If consent='record_transcribe' AND the AI
 * dollar cap allows it, chains into `call.transcribe`.
 *
 * Concurrency: CALL_RECORDING_ARCHIVE_CONCURRENCY (default 10). Meta's CDN
 * URLs are TTL-bound (~30d) but the worker treats expired URLs as terminal
 * to avoid retry storms on permanently dead links.
 */

import '../env'
import { Worker, Job } from 'bullmq'
import { createClient } from '@supabase/supabase-js'
import {
  Q, CallRecordingArchiveJob, connection,
  enqueueCallTranscribe,
} from '../queue'

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://yiicpndeggaedxobyopu.supabase.co'
const supabase = createClient(SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY!)

const BUCKET = 'inbox-media'

export function startCallRecordingArchiveWorker() {
  const worker = new Worker<CallRecordingArchiveJob>(
    Q.callRecordingArchive,
    async (job: Job<CallRecordingArchiveJob>) => {
      const start = Date.now()
      const { tenantId, callSessionId, metaRecordingUrl, metaRecordingId } = job.data

      // Idempotency: skip if a successful archive row already exists.
      const { data: existing } = await supabase.from('call_recordings')
        .select('id, status').eq('call_session_id', callSessionId).eq('tenant_id', tenantId).maybeSingle()
      if (existing && existing.status === 'archived') {
        return { skipped: 'already_archived' }
      }

      // Stream the recording. Meta delivers as application/octet-stream or
      // audio/* depending on codec.
      const resp = await fetch(metaRecordingUrl)
      if (!resp.ok) {
        // 404 / 410 / expired URL → terminal (no retry).
        if (resp.status === 404 || resp.status === 410) {
          await upsertRecording(callSessionId, tenantId, metaRecordingId, null, null, null, 'failed')
          return { failed: true, status: resp.status }
        }
        throw new Error(`meta_fetch_${resp.status}`)
      }
      const arrayBuf = await resp.arrayBuffer()
      const bytes = Buffer.from(arrayBuf)
      const mime  = resp.headers.get('content-type') || 'audio/opus'
      // Pick extension by mime — .opus is the dominant codec for WA calls.
      const ext = mime.includes('mp4') ? 'm4a'
                : mime.includes('mpeg') ? 'mp3'
                : mime.includes('wav') ? 'wav'
                : 'opus'
      const storagePath = `calls/${tenantId}/${callSessionId}.${ext}`

      const { error: upErr } = await supabase.storage.from(BUCKET).upload(storagePath, bytes, {
        contentType: mime,
        upsert: true,
      })
      if (upErr) {
        throw new Error(`storage_upload: ${upErr.message}`)
      }

      // Recording retention window from tenant setting.
      const { data: tenant } = await supabase.from('tenants')
        .select('recording_retention_days, transcription_default, allow_cross_border_transcription, plan_id')
        .eq('id', tenantId).maybeSingle()
      const retentionDays = Number(tenant?.recording_retention_days ?? 30)
      const expiresAtIso = new Date(Date.now() + retentionDays * 86400 * 1000).toISOString()

      await upsertRecording(callSessionId, tenantId, metaRecordingId, storagePath, bytes.byteLength, mime, 'archived', expiresAtIso)

      // Realtime publish so playback button enables.
      await publishCallState(tenantId, {
        type:       'call.recording_ready',
        call_id:    callSessionId,
        updated_at: new Date().toISOString(),
        extras:     { recording_ready: true },
      }).catch(() => {})

      // Chain into transcription if consent allowed.
      const { data: session } = await supabase.from('call_sessions')
        .select('recording_consent').eq('id', callSessionId).eq('tenant_id', tenantId).maybeSingle()
      if (session?.recording_consent === 'record_transcribe') {
        // F-02 (security audit): regulated verticals (BFSI / healthcare /
        // government) default to cross-border DISABLED even if the column
        // wasn't explicitly flipped. Treat regulated_vertical IS NOT NULL as
        // the override anchor — defense in depth against any tenant whose
        // backfill missed the migration 040 sweep.
        const isRegulated     = !!(tenant as any)?.regulated_vertical
        const explicitOptIn   = (tenant as any)?.allow_cross_border_transcription === true
        const allowCrossBorder = isRegulated
          ? explicitOptIn  // regulated tenants need a true opt-in, not just the default
          : ((tenant as any)?.allow_cross_border_transcription !== false)
        if (allowCrossBorder) {
          // AI-cap pre-check is the worker's responsibility (terminal if exhausted)
          try {
            await enqueueCallTranscribe({
              tenantId,
              callSessionId,
              recordingId: (await supabase.from('call_recordings')
                .select('id').eq('call_session_id', callSessionId).eq('tenant_id', tenantId).maybeSingle()).data?.id as string,
              storagePath,
            })
          } catch (e: any) {
            console.warn(`[worker:call.recording.archive] transcribe enqueue: ${e?.message ?? e}`)
          }
        } else {
          await supabase.from('call_transcripts').upsert({
            tenant_id: tenantId, call_session_id: callSessionId,
            status: 'skipped_no_consent', failure_reason: 'cross_border_disabled',
            updated_at: new Date().toISOString(),
          }, { onConflict: 'call_session_id' as any })
        }
      }

      console.log(`[worker:call.recording.archive] archived call=${callSessionId} ms=${Date.now() - start} bytes=${bytes.byteLength}`)
      return { storagePath, bytes: bytes.byteLength }
    },
    {
      connection,
      concurrency: Number(process.env.CALL_RECORDING_ARCHIVE_CONCURRENCY ?? 10),
    },
  )

  worker.on('failed', (job, err) => {
    console.warn(`[worker:call.recording.archive] ✗ job=${job?.id} — ${err.message}`)
  })
  console.log('[worker:call.recording.archive] started')
  return worker
}

async function upsertRecording(
  callSessionId: string, tenantId: string,
  metaRecordingId: string | undefined,
  storagePath: string | null,
  sizeBytes: number | null,
  mimeType: string | null,
  status: 'pending'|'archived'|'failed'|'expired'|'deleted',
  expiresAtIso?: string,
) {
  const nowIso = new Date().toISOString()
  const row: Record<string, any> = {
    tenant_id:        tenantId,
    call_session_id:  callSessionId,
    meta_recording_id: metaRecordingId ?? null,
    storage_path:     storagePath,
    size_bytes:       sizeBytes,
    mime_type:        mimeType,
    status,
    updated_at:       nowIso,
  }
  if (status === 'archived') row.archived_at = nowIso
  if (expiresAtIso) row.expires_at = expiresAtIso
  // Compose unique key on (call_session_id) — migration index. Use upsert
  // with conflict on call_session_id to make repeat archival safe.
  await supabase.from('call_recordings').upsert(row, {
    onConflict: 'call_session_id' as any,
  })
}

async function publishCallState(tenantId: string, payload: Record<string, any>) {
  const channel = supabase.channel(`calls:${tenantId}`, { config: { broadcast: { ack: false } } })
  try {
    await channel.send({ type: 'broadcast', event: payload.type ?? 'call.state', payload })
  } finally {
    await supabase.removeChannel(channel).catch(() => {})
  }
}
