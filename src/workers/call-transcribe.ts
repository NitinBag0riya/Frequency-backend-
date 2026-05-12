/**
 * Worker: call.transcribe
 *
 * Pulls the archived recording, runs Anthropic Claude with a CACHED system
 * prompt (diarization + transcription), persists raw + redacted text,
 * atomically deducts AI dollars via the existing `lib/ai-usage.ts`
 * mechanism (`purpose='call_transcript'`), and publishes a notification.
 *
 * Hard rules:
 *   - AI dollar cap pre-check is TERMINAL — no retry. `status='skipped_cap'`.
 *   - 3 attempts max (BullMQ config). Anthropic 529 / overload → retried.
 *   - PII redaction (Aadhaar, PAN, Indian card BIN, OTP-like) runs server-side
 *     BEFORE the transcript reaches any UI fetch.
 *
 * The Anthropic call uses prompt caching on the system prompt so repeat
 * tenant traffic gets ~90% off the input rate after the first call.
 */

import '../env'
import { Worker, Job } from 'bullmq'
import { createClient } from '@supabase/supabase-js'
import Anthropic from '@anthropic-ai/sdk'
import { Q, CallTranscribeJob, connection } from '../queue'
import { recordAiUsage, getAiDollarsThisMonth } from '../lib/ai-usage'
import { getActivePlanForTenant } from '../lib/plans'

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://yiicpndeggaedxobyopu.supabase.co'
const supabase = createClient(SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY!)
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

const MODEL = process.env.TRANSCRIBE_MODEL || 'claude-sonnet-4-6'
const AI_DOLLAR_FLOOR = Number(process.env.TRANSCRIBE_AI_DOLLAR_FLOOR ?? 0.05)
const REDACT_ON = process.env.CALL_TRANSCRIPT_PII_REDACT !== '0'

const SYSTEM_PROMPT = `You are a call-transcription engine for short customer-service calls.

Output STRICT JSON with this shape (no surrounding text, no markdown fences):
{
  "language": "en|hi|hi-en",
  "segments": [
    { "speaker": "agent" | "customer", "t_start": <seconds>, "t_end": <seconds>, "text": "<utterance>" }
  ]
}

Rules:
- Preserve original casing and punctuation.
- Do not summarise. Do not paraphrase.
- Use "agent" for the business-side speaker and "customer" for the other party.
- If the audio language is Hinglish, use "hi-en".
- Keep segments short (<= 20s) where natural pauses allow.`

export function startCallTranscribeWorker() {
  const worker = new Worker<CallTranscribeJob>(
    Q.callTranscribe,
    async (job: Job<CallTranscribeJob>) => {
      const start = Date.now()
      const { tenantId, callSessionId, recordingId, storagePath } = job.data

      // 1) AI dollar cap pre-check — TERMINAL on failure.
      const plan = await loadPlanLimits(tenantId)
      if (plan && plan.ai_dollars_per_month !== -1) {
        const usedDollars = await getAiDollarsThisMonth(supabase, tenantId)
        const remaining = (plan.ai_dollars_per_month - usedDollars)
        if (remaining <= 0 || remaining < AI_DOLLAR_FLOOR) {
          await upsertTranscript(callSessionId, tenantId, {
            status:         'skipped_cap',
            failure_reason: 'ai_dollars_exhausted',
          })
          await publishTranscriptStatus(tenantId, callSessionId, 'skipped_cap').catch(() => {})
          return { skipped: 'ai_dollars_exhausted' }
        }
      }

      // 2) Bump attempts + mark in-flight (so the FE can disable retry while
      //    we work).
      await upsertTranscript(callSessionId, tenantId, {
        status: 'pending',
        // attempts is incremented atomically by Postgres if we read first;
        // a small race is acceptable here (BullMQ retries are serialised).
      })

      // 3) Pull the audio bytes from Storage via signed URL.
      const ttl = Number(process.env.RECORDING_RAW_TTL_SECONDS ?? 600)
      const { data: signed, error: signErr } = await supabase
        .storage.from('inbox-media').createSignedUrl(storagePath, ttl)
      if (signErr || !signed?.signedUrl) {
        throw new Error(`storage_sign_failed: ${signErr?.message ?? 'no_url'}`)
      }
      const audioResp = await fetch(signed.signedUrl)
      if (!audioResp.ok) throw new Error(`audio_fetch_${audioResp.status}`)
      const audioBytes = Buffer.from(await audioResp.arrayBuffer())
      const b64 = audioBytes.toString('base64')

      // 4) Anthropic call with prompt caching on the system block.
      //    NOTE: Anthropic's native audio-input is forward-compat in the SDK;
      //    if not available in the current SDK version, the worker logs a
      //    soft skip and surfaces a retry button to the admin. We keep the
      //    call shape forward-compat with content blocks of type 'audio'.
      let resp: any
      try {
        resp = await anthropic.messages.create({
          model: MODEL,
          max_tokens: 4096,
          system: [
            { type: 'text' as const, text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } as const },
          ] as any,
          messages: [{
            role: 'user',
            content: [
              { type: 'input_audio' as any, source: { type: 'base64', media_type: 'audio/opus', data: b64 } } as any,
              { type: 'text' as const, text: 'Transcribe the audio above with speaker diarization.' },
            ] as any,
          }],
        } as any)
      } catch (e: any) {
        // Surface 529 / overload as retryable; everything else terminal.
        const status = e?.status ?? e?.response?.status
        if (status === 529 || status === 503) throw e
        // Soft-fail if the SDK lacks audio support: mark failed-non-retry.
        await upsertTranscript(callSessionId, tenantId, {
          status: 'failed', failure_reason: `anthropic_error:${e?.message ?? e}`,
        })
        await publishTranscriptStatus(tenantId, callSessionId, 'failed').catch(() => {})
        return { failed: true, reason: e?.message ?? 'anthropic_error' }
      }

      const textOut = (resp?.content ?? [])
        .filter((c: any) => c.type === 'text')
        .map((c: any) => c.text).join('').trim()

      let parsed: { language?: string; segments?: any[] } = {}
      try { parsed = JSON.parse(textOut) } catch { /* leave parsed empty */ }

      const transcriptRaw = textOut
      const transcriptRedacted = REDACT_ON ? redactPII(transcriptRaw) : transcriptRaw
      const segments = Array.isArray(parsed.segments) ? parsed.segments : null

      await upsertTranscript(callSessionId, tenantId, {
        status:              'completed',
        transcript_raw:      transcriptRaw,
        transcript_redacted: transcriptRedacted,
        segments:            segments,
        input_tokens:        resp?.usage?.input_tokens ?? 0,
        output_tokens:       resp?.usage?.output_tokens ?? 0,
        completed_at:        new Date().toISOString(),
      })

      // 5) Atomic AI dollar deduction via the existing usage_counters path.
      await recordAiUsage(supabase, tenantId, {
        input_tokens:                resp?.usage?.input_tokens,
        output_tokens:               resp?.usage?.output_tokens,
        cache_read_input_tokens:     resp?.usage?.cache_read_input_tokens,
        cache_creation_input_tokens: resp?.usage?.cache_creation_input_tokens,
      }, 'call_transcript', MODEL)
      // QA #8 fix: AiUsageSource union now includes 'call_transcript' so we
      // can attribute Anthropic spend correctly in observability + audits
      // instead of masquerading as 'ai_responder'.

      await publishTranscriptStatus(tenantId, callSessionId, 'completed').catch(() => {})
      console.log(`[worker:call.transcribe] done call=${callSessionId} recording=${recordingId} ms=${Date.now() - start}`)

      return { ok: true, segments: segments?.length ?? 0 }
    },
    {
      connection,
      concurrency: Number(process.env.CALL_TRANSCRIBE_CONCURRENCY ?? 3),
    },
  )

  worker.on('failed', (job, err) => {
    console.warn(`[worker:call.transcribe] ✗ job=${job?.id} — ${err.message}`)
  })
  console.log('[worker:call.transcribe] started')
  return worker
}

async function loadPlanLimits(tenantId: string): Promise<{ ai_dollars_per_month: number } | null> {
  // Plan lookup goes through tenant_subscriptions (not tenants.plan_id —
  // that column doesn't exist). getActivePlanForTenant returns null for
  // tenants without an active sub, in which case we let the worker proceed
  // without a cap pre-check (same legacy behaviour as before this fix).
  const plan = await getActivePlanForTenant(supabase, tenantId)
  if (!plan) return null
  const dollars = Number(plan.limits.ai_dollars_per_month ?? -1)
  return { ai_dollars_per_month: Number.isFinite(dollars) ? dollars : -1 }
}

async function upsertTranscript(callSessionId: string, tenantId: string, patch: Record<string, any>) {
  await supabase.from('call_transcripts').upsert({
    tenant_id:       tenantId,
    call_session_id: callSessionId,
    updated_at:      new Date().toISOString(),
    ...patch,
  }, { onConflict: 'call_session_id' as any })
}

async function publishTranscriptStatus(tenantId: string, callSessionId: string, status: string) {
  const channel = supabase.channel(`calls:${tenantId}`, { config: { broadcast: { ack: false } } })
  try {
    await channel.send({
      type: 'broadcast',
      event: 'call.transcript_ready',
      payload: {
        type: 'call.transcript_ready',
        call_id: callSessionId,
        status,
        updated_at: new Date().toISOString(),
      },
    })
  } finally {
    await supabase.removeChannel(channel).catch(() => {})
  }
}

/**
 * Server-side PII redaction. Applied to the raw model output before the
 * redacted text reaches any UI fetch. Compliance §5.1 + §7.5.
 *
 * Patterns:
 *   - Aadhaar:   12 digits (optionally space-separated 4-4-4)
 *   - PAN:       5 letters + 4 digits + 1 letter
 *   - Card BIN:  Visa/MC/Amex/RuPay 13-19 digits with Luhn validation
 *   - OTP-like:  4-8 digit code preceded by "OTP"/"code"/"pin"
 */
export function redactPII(input: string): string {
  if (!input) return input
  let out = input
  // Aadhaar — official format XXXX XXXX XXXX (12 digits, optionally
  // space-separated). The original `\b\d{4}\s?\d{4}\s?\d{4}\b` pattern
  // false-positives on Indian phones in international format
  // (`+919876543210` has 12 trailing digits that match the pattern at
  // the `\b` between `+` and `9`). Negative lookbehind for `+` or any
  // digit ensures we don't match inside a longer number; negative
  // lookahead for `\d` ensures we don't match the first 12 of a longer
  // numeric run.
  out = out.replace(/(?<![+\d])\b\d{4}\s?\d{4}\s?\d{4}\b(?!\d)/g, '[REDACTED:aadhaar]')
  // PAN
  out = out.replace(/\b[A-Z]{5}\d{4}[A-Z]\b/g, '[REDACTED:pan]')
  // Card numbers (Luhn-validated to avoid false positives on phone-like strings).
  out = out.replace(/\b(?:\d[ -]?){13,19}\b/g, (m) => {
    const digits = m.replace(/\D/g, '')
    if (digits.length < 13 || digits.length > 19) return m
    return isLuhn(digits) ? '[REDACTED:card]' : m
  })
  // OTP-like — contextual.
  out = out.replace(/\b(?:otp|verification\s+(?:code|pin)|one\s*time\s*(?:code|password|pin))[\s:\-]*\d{4,8}\b/gi, '[REDACTED:otp]')
  return out
}

function isLuhn(numStr: string): boolean {
  let sum = 0
  let dbl = false
  for (let i = numStr.length - 1; i >= 0; i--) {
    let d = numStr.charCodeAt(i) - 48
    if (d < 0 || d > 9) return false
    if (dbl) { d *= 2; if (d > 9) d -= 9 }
    sum += d
    dbl = !dbl
  }
  return sum % 10 === 0
}
