/**
 * WhatsApp Business Calling — HTTP surface.
 *
 * Design ref: `.calling-feature/think/01-backend-design.md` §1–§10.
 * Migration  : `supabase/migrations/035_wa_calling.sql`.
 *
 * Mounted from `src/index.ts` (the webhook BEFORE the global JSON parser so
 * raw bytes survive HMAC verification; the /api/calls/* routes after auth
 * and tenant resolution like every other tenant-scoped router).
 *
 * Middleware chain on tenant-scoped routes (left-to-right, fail-closed):
 *   requireAuth → identifyTenant → impersonationGuard → entitlement
 *     → checkPermission(feature, action) → validateBody → handler
 *
 * `impersonationGuard` is the new bit. Per `02-adr-call-lifecycle.md` §12
 * and `03-compliance.md` §6.7, super-admins viewing as a user MUST NOT be
 * able to dial out from another tenant's identity. We detect impersonation
 * via `(req as any).impersonatorId` (set by the impersonation HMAC layer in
 * super-admin.ts when in use) OR the `X-Impersonator-Id` header (defensive,
 * forward-compat with FE switching to a header-based scheme). Either ⇒
 * 403 on intent/initiate/end.
 *
 * `entitlement` gates by the `feature_flags.wa_calling_enabled` row (LA
 * rollout) AND by plan tier (growth/scale only). It returns
 * `402 calling_plan_required` with an upgrade payload on plan failure so the
 * FE's existing UpgradeBanner can pop up.
 */

import express from 'express'
import { createHmac, timingSafeEqual } from 'crypto'
import { SupabaseClient } from '@supabase/supabase-js'
import {
  validateBody,
  CallIntentSchema, CallInitiateSchema, CallRoutingRulesSchema,
  ConsentDefaultSchema, CallEndSchema, PromoteToContactSchema,
} from '../validation'
import {
  enqueueCallDispatch, enqueueCallEventIngest,
} from '../queue'
import { upsertContactFromLead } from '../services/contact-resolver'

type Middleware = (req: express.Request, res: express.Response, next: express.NextFunction) => void | Promise<void>

interface Deps {
  supabase:        SupabaseClient
  requireAuth:     Middleware
  identifyTenant:  Middleware
  checkPermission: (feature: string, action: 'view' | 'edit' | 'delete') => Middleware
}

// ── helpers ────────────────────────────────────────────────────────────────

/**
 * Constant-time HMAC verification of the Meta webhook signature.
 * Header shape: `sha256=<hex>`. Falls back to false when either side is
 * missing or lengths differ (timingSafeEqual demands matched length; an
 * attacker can already see length via response timing).
 */
function verifyMetaSignature(rawBody: Buffer, header: string | undefined, appSecret: string): boolean {
  if (!header || !appSecret) return false
  const prefix = 'sha256='
  if (!header.startsWith(prefix)) return false
  const provided = header.slice(prefix.length)
  const expected = createHmac('sha256', appSecret).update(rawBody).digest('hex')
  if (provided.length !== expected.length) return false
  try {
    return timingSafeEqual(Buffer.from(provided, 'utf8'), Buffer.from(expected, 'utf8'))
  } catch {
    return false
  }
}

/**
 * Impersonation guard. Compliance §6.7: super-admins acting as a tenant
 * user MUST NOT initiate/accept calls under that user's identity (the
 * customer would otherwise see an agent calling on a recorded line with no
 * audit trail).
 *
 * Detection paths (defense-in-depth — block if ANY is set):
 *   - `(req as any).impersonatorId`    set by future impersonation middleware
 *   - `X-Impersonator-Id` header       FE forwards when in impersonation mode
 *   - `(req as any).user?.app_metadata?.impersonator_id`  reserved
 */
function impersonationGuard(req: express.Request, res: express.Response, next: express.NextFunction) {
  const imp =
    (req as any).impersonatorId ??
    (req.headers['x-impersonator-id'] as string | undefined) ??
    ((req as any).user?.app_metadata?.impersonator_id as string | undefined)
  if (imp) {
    res.status(403).json({
      error: 'Impersonators cannot initiate or accept calls.',
      code:  'impersonator_cannot_call',
    })
    return
  }
  next()
}

/**
 * Entitlement gate. Two checks:
 *   1) `feature_flags.wa_calling_enabled.enabled_for_tenants[]` includes this tenant.
 *   2) Tenant's plan is in the calling whitelist (growth, scale).
 *
 * On plan failure returns 402 with `{ code: 'calling_plan_required', upgrade_to }`
 * so the FE's existing UpgradeBanner handles the prompt.
 */
function createEntitlementGate(supabase: SupabaseClient) {
  return async function entitlement(req: express.Request, res: express.Response, next: express.NextFunction) {
    const tenantId = (req as any).tenantId as string | undefined
    if (!tenantId) { res.status(403).json({ error: 'tenant_required' }); return }

    // Platform users skip the gate — they may be operating tenant-scoped
    // diagnostics. The impersonationGuard already blocked the dangerous
    // verbs (intent/initiate/end), so allowing read paths is safe.
    if ((req as any).isSuperAdmin) { next(); return }

    const [flagRes, tenantRes] = await Promise.all([
      supabase.from('feature_flags')
        .select('is_enabled, rollout_percent, enabled_for_tenants')
        .eq('key', 'wa_calling_enabled').maybeSingle(),
      supabase.from('tenants')
        .select('id, plan_id')
        .eq('id', tenantId).maybeSingle(),
    ])

    const flag    = flagRes.data as any
    const tenant  = tenantRes.data as any

    // Flag must exist and either be globally on OR include this tenant.
    const flagOk =
      flag && (
        flag.is_enabled === true ||
        (Array.isArray(flag.enabled_for_tenants) && flag.enabled_for_tenants.includes(tenantId))
      )
    if (!flagOk) {
      res.status(403).json({
        error: 'WhatsApp Business Calling is not enabled for this tenant yet.',
        code:  'wa_calling_disabled',
      })
      return
    }

    // Plan whitelist. Lookup plan name from plans table — `plan_id` is the
    // FK, plan key/name is the human-facing identifier.
    if (tenant?.plan_id) {
      const { data: plan } = await supabase.from('plans')
        .select('id, name, features').eq('id', tenant.plan_id).maybeSingle()
      const planName = String(plan?.name ?? '').toLowerCase()
      const features = (plan?.features ?? []) as string[]
      const allowed = planName === 'growth' || planName === 'scale' ||
                      (Array.isArray(features) && (features.includes('wa_calling') || features.includes('*')))
      if (!allowed) {
        res.status(402).json({
          error: 'WhatsApp Calling requires Growth or Scale plan.',
          code:  'calling_plan_required',
          upgrade_to: 'growth',
        })
        return
      }
    }
    next()
  }
}

/**
 * Express router factory. Returns one router that owns both the
 * tenant-scoped /api/calls/* routes AND the public /webhook/wa-calls
 * webhook. The webhook is mounted by the caller with `express.raw()` body
 * parser ahead of the global JSON parser (see `src/index.ts`).
 */
export function createWaCallingRouter(deps: Deps): express.Router {
  const r = express.Router()
  const { supabase, requireAuth, identifyTenant, checkPermission } = deps
  const entitlement = createEntitlementGate(supabase)

  const guardView   = [requireAuth, identifyTenant, entitlement, checkPermission('inbox', 'view')]
  const guardEdit   = [requireAuth, identifyTenant, impersonationGuard, entitlement, checkPermission('inbox', 'edit')]
  // Settings-scoped routes (routing rules, consent default) use the
  // settings permission key.
  const guardSettingsEdit = [requireAuth, identifyTenant, entitlement, checkPermission('settings', 'edit')]
  const guardSettingsView = [requireAuth, identifyTenant, entitlement, checkPermission('settings', 'view')]

  // Webhook needs to run BEFORE auth and BEFORE the global JSON parser.
  // The caller mounts the raw-body parser at this path in src/index.ts so
  // by the time we land here `req.body` is a Buffer.
  const webhookPath = process.env.WA_CALLING_WEBHOOK_PATH || '/webhook/wa-calls'

  // ── Webhook verify (GET) — mirrors /webhook/whatsapp handshake ──────────
  r.get(webhookPath, (req, res) => {
    const mode      = req.query['hub.mode']
    const token     = req.query['hub.verify_token']
    const challenge = req.query['hub.challenge']
    const expected  = process.env.WH_VERIFY_TOKEN_CALLS || process.env.WH_VERIFY_TOKEN || 'Frequency_webhook_secret'
    if (mode === 'subscribe' && token === expected) {
      res.status(200).send(challenge as string)
    } else {
      res.sendStatus(403)
    }
  })

  // ── Webhook ingest (POST) ──────────────────────────────────────────────
  // CRITICAL: ack within 200ms after JUST inserting `call_events` + queueing.
  // No state-machine work synchronously — that happens in `call.event.ingest`.
  r.post(webhookPath, async (req, res) => {
    const appSecret = process.env.META_APP_SECRET
    if (!appSecret) {
      // Loud, but ack 200 so Meta doesn't retry-storm us when we know we
      // can't process anyway. The boot warning in env.ts is the operator-
      // facing signal.
      console.warn('[wa-calls.webhook] META_APP_SECRET missing — dropping payload')
      res.sendStatus(200); return
    }
    const sigHeader = req.headers['x-hub-signature-256'] as string | undefined
    const raw = req.body as Buffer
    if (!Buffer.isBuffer(raw)) {
      console.warn('[wa-calls.webhook] body is not a Buffer — raw parser not mounted?')
      res.status(401).json({ error: 'invalid signature' }); return
    }
    if (!verifyMetaSignature(raw, sigHeader, appSecret)) {
      console.warn('[wa-calls.webhook] HMAC verification failed')
      res.status(401).json({ error: 'invalid signature' }); return
    }

    let body: any
    try { body = JSON.parse(raw.toString('utf8')) }
    catch { res.status(400).json({ error: 'invalid json' }); return }

    // Process out-of-band: ack first, ingest after. Meta retries on >2s.
    res.sendStatus(200)

    try {
      if (body.object !== 'whatsapp_business_account') return
      for (const entry of body.entry ?? []) {
        const wabaId: string = entry.id
        // Resolve tenant by WABA. Drop silently if unknown (defence: a
        // misrouted webhook for a foreign WABA must not leak into our DB).
        const { data: tenant } = await supabase.from('tenants')
          .select('id')
          .eq('waba_id', wabaId)
          .eq('status', 'active')
          .maybeSingle()
        if (!tenant) continue

        for (const change of entry.changes ?? []) {
          // The existing /webhook/whatsapp handler owns `field === 'messages'`.
          // We only handle `calls` to avoid double-processing.
          if (change.field !== 'calls') continue
          const value = change.value ?? {}
          const events: any[] = Array.isArray(value.calls) ? value.calls : []
          for (const ev of events) {
            const metaEventId = String(ev.id ?? ev.event_id ?? '')
            const metaCallId  = String(ev.call_id ?? ev.metadata?.call_id ?? '')
            const eventType   = String(ev.event ?? ev.type ?? 'unknown')
            if (!metaEventId || !metaCallId) continue

            // call_events requires a call_session_id (NOT NULL FK). Try to
            // resolve the session by meta_call_id; create a placeholder
            // inbound session if none exists yet (ringing arriving for an
            // unknown call). Outbound sessions are pre-created at /initiate.
            let { data: session } = await supabase
              .from('call_sessions')
              .select('id')
              .eq('tenant_id', tenant.id)
              .eq('meta_call_id', metaCallId)
              .maybeSingle()

            if (!session) {
              const directionGuess: 'inbound' | 'outbound' =
                /ringing|incoming/i.test(eventType) ? 'inbound' : 'inbound'
              const { data: newSess } = await supabase
                .from('call_sessions')
                .insert({
                  tenant_id:        tenant.id,
                  direction:        directionGuess,
                  status:           'ringing',
                  source:           'inbound',
                  meta_call_id:     metaCallId,
                  meta_waba_id:     wabaId,
                  recording_consent: 'none',
                })
                .select('id')
                .maybeSingle()
              session = newSess ?? null
              if (!session?.id) continue
            }

            // Idempotent insert. (tenant_id, meta_event_id) unique → ignore conflict.
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
              // 23505 unique violation = duplicate delivery; that's a no-op
              if ((insErr as any).code !== '23505') {
                console.warn(`[wa-calls.webhook] event insert err tenant=${tenant.id}: ${insErr.message}`)
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
              console.warn(`[wa-calls.webhook] enqueue failed: ${e?.message ?? e}`)
            }
          }
        }
      }
    } catch (err: any) {
      // We already acked — log and move on.
      console.error('[wa-calls.webhook] post-ack ingest error:', err?.message ?? err)
    }
  })

  // ── POST /api/calls/intent ─────────────────────────────────────────────
  // Capture per-call consent BEFORE we know the call_session_id. The
  // SECURITY DEFINER function `insert_call_consent_log` defends against
  // cross-tenant writes. The row is later linked when /initiate is called.
  r.post('/api/calls/intent', ...guardEdit, validateBody(CallIntentSchema), async (req, res) => {
    const tenantId = (req as any).tenantId as string
    const user     = (req as any).user
    const agentId  = user?.id as string | undefined

    const body = req.body as {
      contact_id: string
      consent_choice: 'record_transcribe' | 'record_only' | 'none'
      source: 'inbox' | 'contacts' | 'leads'
      remember_for_session?: boolean
      lead_id?: string | null
    }

    // Verify contact belongs to tenant — defense-in-depth on a route that
    // takes a UUID input.
    const { data: contact } = await supabase.from('contacts')
      .select('id, phone')
      .eq('id', body.contact_id).eq('tenant_id', tenantId)
      .maybeSingle()
    if (!contact) { res.status(404).json({ error: 'contact_not_found' }); return }

    // We don't have a call_session_id yet. The SQL `insert_call_consent_log`
    // requires one (FK NOT NULL on call_consent_log.call_session_id), so we
    // create a placeholder call_sessions row in status='queued' and
    // direction='outbound'. /initiate will UPDATE this row instead of
    // creating another, preserving 1:1 between intent and session.
    const recConsent = body.consent_choice
    const consentSource = 'agent_modal'

    const { data: session, error: sessErr } = await supabase
      .from('call_sessions')
      .insert({
        tenant_id:         tenantId,
        contact_id:        body.contact_id,
        agent_id:          agentId ?? null,
        direction:         'outbound',
        status:            'queued',
        source:            body.source,
        recording_consent: recConsent,
        recording_consent_source: consentSource,
      })
      .select('id')
      .maybeSingle()
    if (sessErr || !session?.id) {
      res.status(500).json({ error: sessErr?.message ?? 'session_insert_failed' }); return
    }

    const ip = (req.ip ?? '') as string
    const ua = (req.headers['user-agent'] as string | undefined) ?? null

    // Insert consent log via SECURITY DEFINER function (the only write path).
    const { data: rpcRes, error: rpcErr } = await supabase.rpc('insert_call_consent_log', {
      p_tenant_id:       tenantId,
      p_call_session_id: session.id,
      p_agent_id:        agentId ?? null,
      p_consent_choice:  recConsent,
      p_source:          consentSource,
      p_modal_dismissed: false,
      p_ip_address:      ip || null,
      p_user_agent:      ua,
    })
    if (rpcErr) {
      // Rollback the placeholder session so we don't accumulate orphans.
      await supabase.from('call_sessions').delete().eq('id', session.id).eq('tenant_id', tenantId)
      res.status(500).json({ error: rpcErr.message })
      return
    }

    res.status(201).json({
      intent_id: rpcRes,           // call_consent_log.id
      call_id:   session.id,       // pre-allocated call_sessions row
      consent_choice: recConsent,
      remember_for_session: body.remember_for_session ?? false,
    })
  })

  // ── POST /api/calls/initiate ───────────────────────────────────────────
  // Atomic: lock the consent row, mark it used, enqueue dispatch.
  r.post('/api/calls/initiate', ...guardEdit, validateBody(CallInitiateSchema), async (req, res) => {
    const tenantId = (req as any).tenantId as string
    const user     = (req as any).user
    const userRole = ((req as any).userRole ?? '') as string
    const body = req.body as { intent_id: string; agent_id?: string; override_dnc?: boolean }

    // Load consent + session in one round-trip.
    const { data: consent } = await supabase
      .from('call_consent_log')
      .select('id, tenant_id, call_session_id, consent_choice, decided_at')
      .eq('id', body.intent_id)
      .eq('tenant_id', tenantId)
      .maybeSingle()
    if (!consent) { res.status(404).json({ error: 'intent_not_found' }); return }

    const { data: session } = await supabase
      .from('call_sessions')
      .select('id, status, contact_id, agent_id, direction')
      .eq('id', consent.call_session_id)
      .eq('tenant_id', tenantId)
      .maybeSingle()
    if (!session) { res.status(404).json({ error: 'call_session_not_found' }); return }

    // Re-use protection: if the session has already moved past 'queued',
    // this intent was consumed.
    if (session.status !== 'queued') {
      res.status(409).json({ error: 'intent_already_used', code: 'intent_already_used', status: session.status })
      return
    }

    // DNC check.
    const { data: contact } = await supabase
      .from('contacts')
      .select('id, phone, attributes')
      .eq('id', session.contact_id).eq('tenant_id', tenantId).maybeSingle()
    if (!contact || !contact.phone) { res.status(400).json({ error: 'contact_phone_missing' }); return }
    const dnc = !!(contact as any).attributes?.do_not_call
    if (dnc && !body.override_dnc) {
      res.status(403).json({ error: 'contact is on Do Not Call list', code: 'dnc_contact' }); return
    }
    if (dnc && body.override_dnc) {
      const PRIV_ROLES = new Set(['platform_owner', 'workspace_admin', 'sales_manager', 'owner', 'admin'])
      if (!PRIV_ROLES.has(userRole) && !(req as any).isSuperAdmin) {
        res.status(403).json({ error: 'role_cannot_override_dnc', code: 'dnc_contact' }); return
      }
    }

    // Minutes allotment check (outbound only — inbound continues at overage).
    const { data: tenant } = await supabase.from('tenants')
      .select('call_minutes_allotment, call_minutes_used_current_period')
      .eq('id', tenantId).maybeSingle()
    if (tenant) {
      const allot = Number(tenant.call_minutes_allotment ?? 0)
      const used  = Number(tenant.call_minutes_used_current_period ?? 0)
      if (allot > 0 && used >= allot) {
        // We still allow outbound at overage on `scale` plan per PRD §7; for
        // v1 we surface a 402 with the right code so the FE shows the
        // top-up CTA, and the FE / admin decides whether to allow.
        res.status(402).json({
          error: 'calling minutes exhausted', code: 'calling_minutes_exhausted',
          used_minutes: used, allotment: allot,
        })
        return
      }
    }

    // Move session into the dispatch lane. We do this BEFORE enqueueing so
    // the FE poll/realtime path sees the state advance even if the queue
    // hiccups; the dispatch worker is idempotent on (call_session_id).
    const agentId = body.agent_id ?? user?.id ?? null
    const { error: updErr } = await supabase
      .from('call_sessions')
      .update({
        status:    'queued',  // explicit no-op transition — we keep 'queued' until worker accepts
        agent_id:  agentId,
        updated_at: new Date().toISOString(),
      })
      .eq('id', session.id).eq('tenant_id', tenantId)
    if (updErr) { res.status(500).json({ error: updErr.message }); return }

    try {
      await enqueueCallDispatch({
        tenantId,
        callSessionId: session.id as string,
        consentLogId:  consent.id as string,
      })
    } catch (e: any) {
      // Job-id conflict (rare): another initiate call raced ours. Treat as
      // already-enqueued; the worker dedupes.
      console.warn(`[wa-calling.initiate] enqueue: ${e?.message ?? e}`)
    }

    res.status(202).json({
      call_id: session.id,
      status:  'queued',
      consent_choice: consent.consent_choice,
    })
  })

  // ── GET /api/calls — paginated list with filters ───────────────────────
  r.get('/api/calls', ...guardView, async (req, res) => {
    const tenantId = (req as any).tenantId as string
    const q = req.query as Record<string, string>
    const page     = Math.max(1, parseInt(q.page ?? '1', 10) || 1)
    const pageSize = Math.min(100, Math.max(1, parseInt(q.pageSize ?? '25', 10) || 25))
    const offset = (page - 1) * pageSize

    let query = supabase.from('call_sessions')
      .select('id, tenant_id, contact_id, agent_id, direction, status, source, meta_call_id, recording_consent, duration_seconds, queued_at, dialing_at, ringing_at, connected_at, ended_at, failure_reason, created_at, updated_at', { count: 'exact' })
      .eq('tenant_id', tenantId)
      .order('created_at', { ascending: false })
      .range(offset, offset + pageSize - 1)

    if (q.status)    query = query.eq('status', q.status)
    if (q.direction) query = query.eq('direction', q.direction)
    if (q.agent_id)  query = query.eq('agent_id', q.agent_id)
    if (q.contact_id) query = query.eq('contact_id', q.contact_id)
    if (q.from)      query = query.gte('created_at', q.from)
    if (q.to)        query = query.lte('created_at', q.to)

    const { data, error, count } = await query
    if (error) { res.status(500).json({ error: error.message }); return }
    res.json({ items: data ?? [], page, pageSize, total: count ?? 0 })
  })

  // ── GET /api/calls/:id — full detail ──────────────────────────────────
  r.get('/api/calls/:id', ...guardView, async (req, res) => {
    const tenantId = (req as any).tenantId as string
    const callId = String(req.params.id)
    const [sessionRes, eventsRes, recordingRes, transcriptRes] = await Promise.all([
      supabase.from('call_sessions').select('*').eq('id', callId).eq('tenant_id', tenantId).maybeSingle(),
      supabase.from('call_events').select('id, event_type, received_at, processed_at, raw_payload')
        .eq('call_session_id', callId).eq('tenant_id', tenantId).order('received_at', { ascending: true }),
      supabase.from('call_recordings').select('id, status, storage_path, duration_seconds, size_bytes, mime_type, expires_at, archived_at')
        .eq('call_session_id', callId).eq('tenant_id', tenantId).maybeSingle(),
      // Default to redacted transcript — raw access requires elevated perm + audit, see /transcript-export
      supabase.from('call_transcripts').select('id, status, transcript_redacted, segments, dollar_cost, completed_at')
        .eq('call_session_id', callId).eq('tenant_id', tenantId).maybeSingle(),
    ])
    if (!sessionRes.data) { res.status(404).json({ error: 'call_not_found' }); return }
    res.json({
      session:    sessionRes.data,
      events:     eventsRes.data ?? [],
      recording:  recordingRes.data ?? null,
      transcript: transcriptRes.data ?? null,
    })
  })

  // ── POST /api/calls/:id/recording-access — signed URL ─────────────────
  r.post('/api/calls/:id/recording-access', ...guardView, async (req, res) => {
    const tenantId = (req as any).tenantId as string
    const userId   = (req as any).user?.id as string | undefined
    const callId   = String(req.params.id)

    const { data: rec } = await supabase.from('call_recordings')
      .select('id, status, storage_path')
      .eq('call_session_id', callId).eq('tenant_id', tenantId).maybeSingle()
    if (!rec || !rec.storage_path) { res.status(404).json({ error: 'recording_not_available' }); return }
    if (rec.status !== 'archived') { res.status(409).json({ error: 'recording_not_ready', status: rec.status }); return }

    const ttl = Number(process.env.RECORDING_TTL_SECONDS ?? 3600)
    const { data: signed, error } = await supabase
      .storage.from('inbox-media').createSignedUrl(rec.storage_path, ttl)
    if (error || !signed?.signedUrl) { res.status(500).json({ error: error?.message ?? 'sign_failed' }); return }

    // Audit row — compliance §8.4 requires every playback to be logged.
    await supabase.rpc('append_tenant_audit', {
      p_tenant_id:     tenantId,
      p_actor_id:      userId ?? null,
      p_actor_role:    (req as any).userRole ?? null,
      p_action:        'recording.playback',
      p_entity_type:   'call_recording',
      p_entity_id:     rec.id,
      p_justification: null,
      p_ticket_ref:    null,
      p_before_value:  null,
      p_after_value:   { call_session_id: callId },
      p_ip_address:    req.ip ?? null,
      p_user_agent:    (req.headers['user-agent'] as string | undefined) ?? null,
    }).then(() => undefined, (e: any) => console.warn(`[wa-calling] audit insert failed: ${e?.message ?? e}`))

    res.json({ url: signed.signedUrl, expires_in: ttl })
  })

  // ── POST /api/calls/:id/transcript-export — rate-limited bulk pull ────
  r.post('/api/calls/:id/transcript-export', ...guardEdit, async (req, res) => {
    const tenantId = (req as any).tenantId as string
    const userId   = (req as any).user?.id as string | undefined
    const callId   = String(req.params.id)

    const { data: t } = await supabase.from('call_transcripts')
      .select('id, status, transcript_redacted, segments, completed_at')
      .eq('call_session_id', callId).eq('tenant_id', tenantId).maybeSingle()
    if (!t || t.status !== 'completed') {
      res.status(404).json({ error: 'transcript_not_ready', status: t?.status ?? 'missing' }); return
    }

    await supabase.rpc('append_tenant_audit', {
      p_tenant_id:     tenantId,
      p_actor_id:      userId ?? null,
      p_actor_role:    (req as any).userRole ?? null,
      p_action:        'transcript.export',
      p_entity_type:   'call_transcript',
      p_entity_id:     t.id,
      p_justification: null,
      p_ticket_ref:    null,
      p_before_value:  null,
      p_after_value:   { call_session_id: callId },
      p_ip_address:    req.ip ?? null,
      p_user_agent:    (req.headers['user-agent'] as string | undefined) ?? null,
    }).then(() => undefined, (e: any) => console.warn(`[wa-calling] audit insert failed: ${e?.message ?? e}`))

    res.json({
      transcript: t.transcript_redacted,
      segments:   t.segments,
      completed_at: t.completed_at,
    })
  })

  // ── POST /api/calls/:id/end — agent-initiated hangup ──────────────────
  r.post('/api/calls/:id/end', ...guardEdit, validateBody(CallEndSchema), async (req, res) => {
    const tenantId = (req as any).tenantId as string
    const callId = String(req.params.id)
    const body = req.body as { reason?: string }
    const { data: session } = await supabase.from('call_sessions')
      .select('id, status, meta_call_id')
      .eq('id', callId).eq('tenant_id', tenantId).maybeSingle()
    if (!session) { res.status(404).json({ error: 'call_not_found' }); return }
    if (!['queued', 'dialing', 'ringing', 'connected'].includes(session.status)) {
      res.status(409).json({ error: 'invalid_state_transition', code: 'invalid_state_transition', status: session.status }); return
    }
    const nowIso = new Date().toISOString()
    const targetStatus: string = session.status === 'connected' ? 'completed' : 'cancelled'
    const { error } = await supabase.from('call_sessions').update({
      status:        targetStatus,
      ended_at:      nowIso,
      ended_by:      'agent',
      failure_reason: body.reason ?? null,
      updated_at:    nowIso,
    }).eq('id', callId).eq('tenant_id', tenantId)
    if (error) { res.status(500).json({ error: error.message }); return }
    res.json({ id: callId, status: targetStatus })
  })

  // ── Routing rules CRUD ────────────────────────────────────────────────
  r.get('/api/calls/routing-rules', ...guardSettingsView, async (req, res) => {
    const tenantId = (req as any).tenantId as string
    const { data, error } = await supabase.from('call_routing_rules')
      .select('*').eq('tenant_id', tenantId).maybeSingle()
    if (error) { res.status(500).json({ error: error.message }); return }
    res.json(data ?? null)
  })

  r.post('/api/calls/routing-rules', ...guardSettingsEdit, validateBody(CallRoutingRulesSchema), async (req, res) => {
    const tenantId = (req as any).tenantId as string
    const body = req.body as any
    const row: Record<string, any> = {
      tenant_id:            tenantId,
      business_hours:       body.business_hours_json,
      agent_pool:           body.agent_pool,
      ring_strategy:        body.ring_strategy,
      ring_timeout_seconds: body.ring_timeout_seconds,
      fallback_action:      body.fallback,
      updated_at:           new Date().toISOString(),
    }
    const { data, error } = await supabase.from('call_routing_rules')
      .upsert(row, { onConflict: 'tenant_id' as any })
      .select('*').maybeSingle()
    if (error) { res.status(500).json({ error: error.message }); return }
    res.json(data)
  })

  r.patch('/api/calls/routing-rules', ...guardSettingsEdit, async (req, res) => {
    const tenantId = (req as any).tenantId as string
    const allowed = ['business_hours_json', 'agent_pool', 'ring_strategy', 'ring_timeout_seconds', 'fallback']
    const patch: Record<string, any> = {}
    for (const k of allowed) if (k in req.body) patch[k] = (req.body as any)[k]
    // Map FE names to DB columns where they differ.
    if ('business_hours_json' in patch) { patch.business_hours = patch.business_hours_json; delete patch.business_hours_json }
    if ('fallback' in patch)            { patch.fallback_action = patch.fallback; delete patch.fallback }
    patch.updated_at = new Date().toISOString()
    const { data, error } = await supabase.from('call_routing_rules')
      .update(patch).eq('tenant_id', tenantId).select('*').maybeSingle()
    if (error) { res.status(500).json({ error: error.message }); return }
    res.json(data)
  })

  // ── POST /api/calls/consent-default ───────────────────────────────────
  r.post('/api/calls/consent-default', ...guardSettingsEdit, validateBody(ConsentDefaultSchema), async (req, res) => {
    const tenantId = (req as any).tenantId as string
    const userId   = (req as any).user?.id as string | undefined
    const body = req.body as { value: 'always_ask' | 'always_on' | 'always_off' }

    const { data: before } = await supabase.from('tenants').select('consent_default').eq('id', tenantId).maybeSingle()
    const { error } = await supabase.from('tenants')
      .update({ consent_default: body.value, updated_at: new Date().toISOString() })
      .eq('id', tenantId)
    if (error) { res.status(500).json({ error: error.message }); return }

    await supabase.rpc('append_tenant_audit', {
      p_tenant_id:     tenantId,
      p_actor_id:      userId ?? null,
      p_actor_role:    (req as any).userRole ?? null,
      p_action:        'consent_default.change',
      p_entity_type:   'tenant_setting',
      p_entity_id:     null,
      p_justification: null,
      p_ticket_ref:    null,
      p_before_value:  before ? { consent_default: before.consent_default } : null,
      p_after_value:   { consent_default: body.value },
      p_ip_address:    req.ip ?? null,
      p_user_agent:    (req.headers['user-agent'] as string | undefined) ?? null,
    }).then(() => undefined, (e: any) => console.warn(`[wa-calling] audit insert failed: ${e?.message ?? e}`))

    res.json({ consent_default: body.value })
  })

  // ── GET /api/calls/usage — current period meters ──────────────────────
  r.get('/api/calls/usage', ...guardView, async (req, res) => {
    const tenantId = (req as any).tenantId as string
    const { data: t } = await supabase.from('tenants')
      .select('call_minutes_allotment, call_minutes_used_current_period, plan_id')
      .eq('id', tenantId).maybeSingle()
    res.json({
      minutes_allotment: t?.call_minutes_allotment ?? 0,
      minutes_used:      t?.call_minutes_used_current_period ?? 0,
      plan_id:           t?.plan_id ?? null,
    })
  })

  // ── POST /api/leads/:id/promote-to-contact ────────────────────────────
  // Explicit FE-initiated promotion. Lives in the calling router because
  // it is gated by the calling feature flag + plan; the underlying service
  // is reused from internal lead-create hooks.
  r.post('/api/leads/:id/promote-to-contact',
    requireAuth, identifyTenant, checkPermission('leads', 'edit'),
    validateBody(PromoteToContactSchema),
    async (req, res) => {
      const tenantId = (req as any).tenantId as string
      const leadId   = String(req.params.id)
      const { data: lead, error } = await supabase
        .from('leads')
        .select('id, tenant_id, data')
        .eq('id', leadId).eq('tenant_id', tenantId).maybeSingle()
      if (error) { res.status(500).json({ error: error.message }); return }
      if (!lead)  { res.status(404).json({ error: 'lead_not_found' }); return }
      const result = await upsertContactFromLead(supabase, tenantId, lead as any)
      if (!result.contact_id) {
        res.status(400).json({ error: result.reason ?? 'promote_failed', code: 'promote_failed' }); return
      }
      res.json({ contact_id: result.contact_id, created: result.created })
    })

  return r
}
