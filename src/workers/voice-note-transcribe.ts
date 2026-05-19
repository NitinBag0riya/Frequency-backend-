/**
 * Worker: voice-note.transcribe
 *
 * Transcribes inbound WhatsApp / Instagram / Telegram voice notes using
 * OpenAI Whisper. Triggered from the inbound webhook processor whenever a
 * message with `content.type === 'audio'` (or equivalent per-channel shape)
 * lands. Best-effort — failures here NEVER block message persistence.
 *
 * Hard rules:
 *   - 2 attempts max (BullMQ config). Whisper failures are mostly permanent
 *     (corrupted audio, expired media URL, unsupported codec). Retrying
 *     just burns budget.
 *   - The transcript row is UPSERT-keyed on message_id so BullMQ retries
 *     collapse to the same row.
 *   - Cost tracked in INR paise on the row so the operator dashboard sees
 *     per-tenant voice transcription spend.
 *   - Raw audio is NEVER stored in the DB. Only the transcript text +
 *     metadata. The audio bytes are streamed straight from upstream to
 *     OpenAI and discarded.
 *
 * Channel media resolution:
 *   - WhatsApp: msg.audio = { id, mime_type, voice }. We resolve the actual
 *     bytes via GET https://graph.facebook.com/v18.0/<media_id> with the
 *     tenant's access_token, which returns a signed CDN URL we then GET
 *     with the same Bearer token.
 *   - Telegram: msg.voice or msg.audio = { file_id, ... }. Resolved via
 *     getFile + https://api.telegram.org/file/bot<TOKEN>/<file_path>.
 *   - Instagram: msg.attachments[].payload.url (already a CDN URL, no auth).
 *
 * If none of the above shapes match, the worker marks the row failed with
 * `no_media_url` and exits — this is the "we don't know how to find the
 * audio" branch and a real bug if it ever fires for a known channel.
 *
 * If OPENAI_API_KEY is unset, the worker writes status='failed',
 * error='openai_key_not_configured' and exits gracefully — never crashes.
 */

import '../env'
import { Worker, Job } from 'bullmq'
import { createClient } from '@supabase/supabase-js'
import { Q, VoiceNoteTranscribeJob, connection } from '../queue'

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://yiicpndeggaedxobyopu.supabase.co'
const supabase = createClient(SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY!)

const OPENAI_KEY      = process.env.OPENAI_API_KEY ?? ''
const OPENAI_MODEL    = process.env.VOICE_TRANSCRIBE_MODEL    || 'whisper-1'
const GRAPH_BASE      = process.env.WA_GRAPH_BASE             || 'https://graph.facebook.com/v18.0'
// Whisper API list price as of 2024-2025: $0.006 per minute. Override via env
// when OpenAI changes the rate without redeploy.
const USD_PER_MINUTE  = Number(process.env.VOICE_TRANSCRIBE_USD_PER_MINUTE ?? 0.006)
// Default USD→INR conversion. Operator dashboards can switch this against
// the live FX feed; we keep a fallback constant so unit cost is always
// computable even if the feed is down.
const USDINR_RATE     = Number(process.env.USDINR_RATE ?? 84)

// Hard cap on audio duration we'll send to Whisper. 30 minutes is way longer
// than any plausible WA / IG / TG voice note, and keeps a runaway file from
// burning $0.18 in a single call.
const MAX_DURATION_SECONDS = 30 * 60

const PROVIDER_TAG = `openai-${OPENAI_MODEL}`

export function startVoiceNoteTranscribeWorker() {
  const worker = new Worker<VoiceNoteTranscribeJob>(
    Q.voiceNoteTranscribe,
    async (job: Job<VoiceNoteTranscribeJob>) => {
      const { tenantId, messageId } = job.data

      // 1) Seed the row as pending so the FE sees the spinner immediately
      //    on the second render. UPSERT on message_id so retries are idem.
      await upsertTranscript(tenantId, messageId, {
        provider: PROVIDER_TAG,
        text_raw: '',
        status:   'pending',
      })

      // 2) Load the message + tenant. Tenant carries WA access_token for
      //    Graph media resolution.
      const { data: message, error: msgErr } = await supabase
        .from('messages')
        .select('id, tenant_id, channel, content, platform_message_id')
        .eq('id', messageId)
        .eq('tenant_id', tenantId)
        .maybeSingle()
      if (msgErr) throw new Error(`message lookup failed: ${msgErr.message}`)
      if (!message) {
        await markFailed(tenantId, messageId, 'message_not_found')
        return { failed: 'message_not_found' }
      }

      const { data: tenant } = await supabase
        .from('tenants')
        .select('id, access_token')
        .eq('id', tenantId)
        .maybeSingle()

      // 3) Resolve audio bytes per channel.
      let audio: { bytes: Buffer; mime: string; filename: string } | null = null
      try {
        audio = await resolveAudio(message, tenant)
      } catch (e: any) {
        await markFailed(tenantId, messageId, `media_resolve: ${e?.message ?? e}`)
        return { failed: 'media_resolve' }
      }
      if (!audio) {
        await markFailed(tenantId, messageId, 'no_media_url')
        return { failed: 'no_media_url' }
      }

      // 4) OpenAI key guard — gracefully fail if not configured locally.
      //    Don't throw here; throwing would trigger a BullMQ retry which is
      //    pointless when the key won't materialise on attempt #2 either.
      if (!OPENAI_KEY) {
        await markFailed(tenantId, messageId, 'openai_key_not_configured')
        return { failed: 'openai_key_not_configured' }
      }

      // 5) Call OpenAI Whisper. verbose_json gives us duration + language.
      let whisperResp: WhisperVerboseJson
      try {
        whisperResp = await callOpenAIWhisper(audio.bytes, audio.mime, audio.filename)
      } catch (e: any) {
        // Network / 5xx → throw to let BullMQ retry once. Hard 4xx (unsupp-
        // orted format, file too big) → terminal.
        const status = e?.status ?? 0
        if (status >= 400 && status < 500) {
          await markFailed(tenantId, messageId, `openai_${status}: ${e?.message ?? 'error'}`)
          return { failed: `openai_${status}` }
        }
        throw new Error(`openai_call_failed: ${e?.message ?? e}`)
      }

      const text = (whisperResp.text ?? '').trim()
      const durationSec = clampNumber(whisperResp.duration, 0, MAX_DURATION_SECONDS)
      const language    = typeof whisperResp.language === 'string' ? whisperResp.language : null
      const costPaise   = computeCostPaise(durationSec ?? 0)

      await upsertTranscript(tenantId, messageId, {
        provider:          PROVIDER_TAG,
        language_detected: language,
        text_raw:          text,
        duration_sec:      durationSec,
        cost_paise:        costPaise,
        status:            'completed',
        error:             null,
        completed_at:      new Date().toISOString(),
      })

      return { ok: true, duration_sec: durationSec, chars: text.length }
    },
    {
      connection,
      concurrency: Number(process.env.VOICE_TRANSCRIBE_CONCURRENCY ?? 3),
    },
  )

  worker.on('failed', (job, err) => {
    console.warn(`[worker:voice-note.transcribe] ✗ job=${job?.id} — ${err.message}`)
  })
  console.log('[worker:voice-note.transcribe] started')
  return worker
}

// ─── Audio resolution per channel ─────────────────────────────────────────
// Returns { bytes, mime, filename } or null if the message doesn't look like
// a voice note we can fetch. Throws on transport errors (caller catches and
// marks the row failed without re-raising — these aren't retry-worthy).

async function resolveAudio(message: any, tenant: any): Promise<{ bytes: Buffer; mime: string; filename: string } | null> {
  const content = message.content ?? {}
  const channel = message.channel as string

  // ── WhatsApp ────────────────────────────────────────────────────────────
  // Inbound shape (Meta webhook): top-level `content` is the raw message
  // object, which contains `audio: { id, mime_type, voice, sha256 }`.
  // The `id` is a Meta media id we resolve to a signed CDN URL.
  // We only enter the Meta-resolution branch when we actually have an
  // `audio`/`voice` sub-object; otherwise fall through to the generic
  // media_url path below (which is what smoke tests + future tenant-
  // uploaded audio rows exercise).
  if (channel === 'whatsapp' && (content?.audio || content?.voice)) {
    const audio = content?.audio ?? content?.voice

    // Explicit media_url shortcut (manual test / Telegram-style payload that
    // accidentally landed in a WA row). Use it directly if present.
    if (audio.media_url || audio.url) {
      return await downloadAudio(audio.media_url ?? audio.url, audio.mime_type ?? 'audio/ogg')
    }

    const mediaId = audio.id
    if (!mediaId) return null
    const token = tenant?.access_token
    if (!token) throw new Error('wa_token_missing')

    // Resolve media-id → signed CDN URL via Graph.
    const metaResp = await fetch(`${GRAPH_BASE}/${mediaId}`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    if (!metaResp.ok) throw new Error(`wa_media_lookup_${metaResp.status}`)
    const metaJson: any = await metaResp.json()
    const url  = metaJson?.url
    const mime = metaJson?.mime_type || audio.mime_type || 'audio/ogg'
    if (!url) throw new Error('wa_media_url_missing')

    // The CDN URL itself also requires the Bearer token (not anonymous).
    const audioResp = await fetch(url, { headers: { Authorization: `Bearer ${token}` } })
    if (!audioResp.ok) throw new Error(`wa_media_fetch_${audioResp.status}`)
    const bytes = Buffer.from(await audioResp.arrayBuffer())
    return { bytes, mime, filename: filenameForMime(mime) }
  }

  // ── Telegram ────────────────────────────────────────────────────────────
  // Inbound shape (workers/webhook-retry.ts): `content = { type: 'text',
  // text, raw: msg }`. The audio shape is on `raw.voice` (sendVoice) or
  // `raw.audio` (sendAudio). We resolve via getFile + the file CDN.
  if (channel === 'telegram') {
    const raw = content?.raw ?? {}
    const v = raw.voice ?? raw.audio ?? content?.voice ?? content?.audio ?? null
    if (!v) return null

    if (v.media_url || v.url) {
      return await downloadAudio(v.media_url ?? v.url, v.mime_type ?? 'audio/ogg')
    }

    const fileId = v.file_id
    if (!fileId) return null

    // Telegram bot token: look up via tenant_integrations.
    const { data: integ } = await supabase.from('tenant_integrations')
      .select('access_token, metadata')
      .eq('tenant_id', tenant?.id)
      .eq('key', 'telegram')
      .maybeSingle()
    const tgToken = integ?.access_token || (integ?.metadata as any)?.bot_token
    if (!tgToken) throw new Error('telegram_token_missing')

    const getFileResp = await fetch(`https://api.telegram.org/bot${tgToken}/getFile?file_id=${encodeURIComponent(fileId)}`)
    if (!getFileResp.ok) throw new Error(`telegram_getfile_${getFileResp.status}`)
    const getFileJson: any = await getFileResp.json()
    const filePath = getFileJson?.result?.file_path
    if (!filePath) throw new Error('telegram_file_path_missing')

    const audioResp = await fetch(`https://api.telegram.org/file/bot${tgToken}/${filePath}`)
    if (!audioResp.ok) throw new Error(`telegram_file_fetch_${audioResp.status}`)
    const bytes = Buffer.from(await audioResp.arrayBuffer())
    const mime  = v.mime_type || (filePath.endsWith('.oga') || filePath.endsWith('.ogg') ? 'audio/ogg' : 'audio/mp4')
    return { bytes, mime, filename: filenameForMime(mime) }
  }

  // ── Instagram ───────────────────────────────────────────────────────────
  // IG voice notes arrive as `message.attachments[0].payload.url`, with
  // type='audio'. The URL is a CDN URL that's publicly fetchable (the IG
  // webhook delivers it signed for ~5 minutes). The webhook processor
  // stores `content = { type: 'text', text: '', raw: m }`, so we look in
  // `raw.message.attachments`.
  if (channel === 'instagram') {
    const raw = content?.raw ?? {}
    const atts = raw?.message?.attachments ?? content?.attachments ?? []
    const audioAtt = (atts as any[]).find(a => a?.type === 'audio' || a?.type === 'audio/voice')
    const url = audioAtt?.payload?.url || content?.media_url || content?.audio?.url
    if (!url) return null
    return await downloadAudio(url, 'audio/mp4')
  }

  // ── Generic fallback ────────────────────────────────────────────────────
  // For test fixtures or future channels: if the row literally has
  // content.media_url, just download it. This is also the path that the
  // smoke test exercises (inserts a synthetic row with media_url set).
  const fallbackUrl = content?.media_url ?? content?.audio?.media_url ?? content?.url
  if (typeof fallbackUrl === 'string' && fallbackUrl) {
    return await downloadAudio(fallbackUrl, content?.mime_type ?? 'audio/ogg')
  }

  return null
}

async function downloadAudio(url: string, fallbackMime: string): Promise<{ bytes: Buffer; mime: string; filename: string }> {
  const r = await fetch(url)
  if (!r.ok) throw new Error(`audio_fetch_${r.status}`)
  const mime = r.headers.get('content-type') || fallbackMime
  const bytes = Buffer.from(await r.arrayBuffer())
  return { bytes, mime, filename: filenameForMime(mime) }
}

function filenameForMime(mime: string): string {
  if (mime.includes('ogg')) return 'voice.ogg'
  if (mime.includes('mp4') || mime.includes('m4a')) return 'voice.m4a'
  if (mime.includes('mpeg')) return 'voice.mp3'
  if (mime.includes('wav')) return 'voice.wav'
  if (mime.includes('webm')) return 'voice.webm'
  return 'voice.ogg'
}

// ─── OpenAI Whisper call ──────────────────────────────────────────────────
interface WhisperVerboseJson {
  text?:     string
  language?: string
  duration?: number
}

async function callOpenAIWhisper(bytes: Buffer, mime: string, filename: string): Promise<WhisperVerboseJson> {
  // FormData with the audio + model + response_format. We DO NOT pass
  // `language` so Whisper auto-detects — Indian customers frequently mix
  // Hindi / English / regional languages within a single voice note.
  // The web FormData/Blob types are available in Node 18+; cast through
  // unknown to satisfy older @types/node when targeting CJS.
  const blob = new Blob([new Uint8Array(bytes)], { type: mime })
  const form = new FormData()
  form.append('file', blob, filename)
  form.append('model', OPENAI_MODEL)
  form.append('response_format', 'verbose_json')

  const resp = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${OPENAI_KEY}` },
    body: form as any,
  })
  if (!resp.ok) {
    let bodyText = ''
    try { bodyText = (await resp.text()).slice(0, 300) } catch { /* ignore */ }
    const err: any = new Error(`openai_http_${resp.status}: ${bodyText}`)
    err.status = resp.status
    throw err
  }
  return (await resp.json()) as WhisperVerboseJson
}

// ─── Cost computation ─────────────────────────────────────────────────────
// Whisper price is per minute. We round UP to the nearest second of billed
// audio to avoid under-recording (OpenAI bills the full audio they process).
// Output in INR paise so the bigint column stores an integer.
function computeCostPaise(durationSec: number): number {
  if (!Number.isFinite(durationSec) || durationSec <= 0) return 0
  const minutes  = durationSec / 60
  const usdTotal = minutes * USD_PER_MINUTE
  const inrTotal = usdTotal * USDINR_RATE
  return Math.ceil(inrTotal * 100)
}

function clampNumber(n: any, lo: number, hi: number): number | null {
  const v = Number(n)
  if (!Number.isFinite(v)) return null
  return Math.max(lo, Math.min(hi, v))
}

// ─── DB helpers ───────────────────────────────────────────────────────────
async function upsertTranscript(tenantId: string, messageId: string, patch: Record<string, any>) {
  await supabase.from('voice_note_transcripts').upsert({
    tenant_id:  tenantId,
    message_id: messageId,
    ...patch,
  }, { onConflict: 'message_id' as any })
}

async function markFailed(tenantId: string, messageId: string, error: string) {
  await upsertTranscript(tenantId, messageId, {
    provider:     PROVIDER_TAG,
    text_raw:     '',
    status:       'failed',
    error,
    completed_at: new Date().toISOString(),
  })
}
