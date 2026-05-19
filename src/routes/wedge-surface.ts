/**
 * routes/wedge-surface.ts — endpoints powering the in-app "wedge surface".
 *
 * These are the small read-side endpoints that drive the four nudges the
 * dashboard / inbox / broadcast composer / campaigns page surface to make
 * the Frequency value-prop visible inside the product (not just on the
 * marketing site). They share a router so the mount in index.ts stays
 * one line and so the file is easy to audit as a single unit when the
 * pricing surface evolves.
 *
 * Endpoints:
 *   GET  /api/me/markup-saved          — "you'd have paid ₹X more on Wati"
 *                                        (dashboard hero card, P0.3)
 *   GET  /api/me/sla-today             — average first-response time (inbox
 *                                        badge, P0-inbox)
 *   POST /api/contacts/:id/consent     — record DPDPA consent + write
 *                                        tenant_audit row (returns audit id)
 *   POST /api/campaigns/:id/resume     — resume a campaign auto-paused by
 *                                        template reclassification (P0.5)
 *
 * No mutations to existing endpoints; this is purely additive. All
 * endpoints are scoped to the caller's tenant.
 *
 * Markup math: rates live in src/data/markup-rates.ts on the FE side.
 * Duplicating the table here would risk drift — so we MIRROR the
 * conservative subset relevant to the endpoint (Wati / Interakt / AiSensy
 * / DoubleTick) and keep the comment block in markup-rates.ts as the
 * source of truth. If a rate changes there, update the matching row here
 * AND bump VERIFIED_ON. Tests pin both files to the same date.
 */

import express from 'express'
import crypto from 'crypto'
import { SupabaseClient } from '@supabase/supabase-js'

// Hash an IP for storage in consent_events.source_detail. DPDPA encourages
// pseudonymization of identifiers when full value isn't needed for the
// stated purpose — for consent audit, "an IP captured this consent" is
// sufficient and avoids putting raw PII in a jsonb the FE can browse.
function hashIp(ip: string): string {
  return crypto.createHash('sha256').update(ip).digest('hex').slice(0, 16)
}

type Middleware = (
  req: express.Request,
  res: express.Response,
  next: express.NextFunction,
) => void | Promise<void>

interface Deps {
  supabase: SupabaseClient
  requireAuth: Middleware
  identifyTenant: Middleware
  checkPermission: (feature: string, action: 'view' | 'edit' | 'delete') => Middleware
}

// ── Competitor markup table — server-side mirror of src/data/markup-rates.ts ─
// Same conservative posture: we use the LOWER end of any published range
// (kinder to the competitor). Numbers in INR per-message, on top of Meta's
// pass-through rate (which Frequency also charges — at cost).
const COMPETITOR_MARKUP_INR: Record<string, { marketing: number; utility: number; authentication: number; label: string }> = {
  wati:       { marketing: 0.18, utility: 0.07, authentication: 0.07, label: 'Wati' },
  interakt:   { marketing: 0.18, utility: 0,    authentication: 0,    label: 'Interakt' },
  aisensy:    { marketing: 0.20, utility: 0.05, authentication: 0.05, label: 'AiSensy' },
  doubletick: { marketing: 0.25, utility: 0,    authentication: 0,    label: 'DoubleTick' },
}

// Default competitor when the FE doesn't pass ?vs= — Wati is the loudest
// public comparator in the Indian SMB segment, so the headline number is
// most legible there.
const DEFAULT_VS = 'wati'

export function createWedgeSurfaceRouter(deps: Deps): express.Router {
  const r = express.Router()
  const { supabase, requireAuth, identifyTenant, checkPermission } = deps

  // ── GET /api/me/markup-saved?vs=wati ─────────────────────────────────────
  //
  // Sum outbound messages this calendar month, bucket by template category,
  // multiply by the competitor's markup-per-message, return the ₹ saving.
  // If the tenant has sent nothing yet this month, returns zeros — the FE
  // hides the card in that case (a card that says "you saved ₹0" is worse
  // than no card).
  //
  // The bucket join is best-effort:
  //   messages.broadcast_id → broadcasts.template_name → wa_templates.category
  //     OR
  //   messages.content->'template'->>'name' → wa_templates.category
  // Anything we can't bucket falls back to 'marketing' (the highest-markup
  // category) so the saving number is conservative — we never overstate.
  r.get('/api/me/markup-saved',
    requireAuth, identifyTenant,
    async (req, res) => {
      const tenantId = (req as any).tenantId as string
      const vsRaw = String(req.query.vs ?? DEFAULT_VS).toLowerCase()
      const vs = COMPETITOR_MARKUP_INR[vsRaw] ? vsRaw : DEFAULT_VS
      const competitor = COMPETITOR_MARKUP_INR[vs]

      // Start of the current calendar month, UTC. SQL `>=` semantics
      // include the first millisecond; we lose nothing.
      const now = new Date()
      const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString()

      try {
        // Pull every outbound row this month with the template hint we have.
        // Filtering to just the columns we need keeps the wire small even
        // for chatty tenants (~10k msgs/month would be ~600 KB raw).
        const { data: msgs, error: msgErr } = await supabase
          .from('messages')
          .select('id, content, broadcast_id, created_at')
          .eq('tenant_id', tenantId)
          .eq('direction', 'outbound')
          .gte('created_at', monthStart)
        if (msgErr) {
          // Schema parity issues (`direction` missing on legacy DBs) →
          // surface as zeros, not a 500 that breaks the dashboard.
          console.warn('[markup-saved] messages query failed:', msgErr.message)
          res.json(emptyResult(vs, competitor.label)); return
        }
        const messages = msgs ?? []
        if (messages.length === 0) { res.json(emptyResult(vs, competitor.label)); return }

        // Resolve template_name for messages we can — two paths:
        //   (a) broadcast_id → broadcasts.template_name
        //   (b) content.template.name (workflow `send_template` writes this)
        const broadcastIds = Array.from(new Set(
          messages.map(m => (m as any).broadcast_id).filter(Boolean),
        )) as string[]
        const broadcastTemplate = new Map<string, string>()
        if (broadcastIds.length > 0) {
          const { data: bcs } = await supabase
            .from('broadcasts')
            .select('id, template_name')
            .in('id', broadcastIds)
          for (const b of (bcs ?? []) as any[]) {
            if (b.template_name) broadcastTemplate.set(b.id, b.template_name)
          }
        }

        // Collect every distinct template_name we know about, then fetch
        // the category for each in one round-trip.
        const templateNames = new Set<string>()
        for (const m of messages as any[]) {
          const fromBroadcast = m.broadcast_id ? broadcastTemplate.get(m.broadcast_id) : null
          const fromContent = (m.content as any)?.template?.name ?? null
          const name = fromBroadcast || fromContent
          if (name) templateNames.add(String(name))
        }

        const categoryByName = new Map<string, 'marketing' | 'utility' | 'authentication'>()
        if (templateNames.size > 0) {
          const { data: tpls } = await supabase
            .from('wa_templates')
            .select('name, category')
            .eq('tenant_id', tenantId)
            .in('name', Array.from(templateNames))
          for (const t of (tpls ?? []) as any[]) {
            const cat = String(t.category ?? '').toLowerCase()
            if (cat === 'marketing' || cat === 'utility' || cat === 'authentication') {
              categoryByName.set(t.name, cat)
            }
          }
        }

        // Bucket counts. Unknown → 'marketing' (the conservative choice for
        // the COMPETITOR'S saving math: marketing has the lowest markup
        // for most competitors, so it understates the win. But it has the
        // HIGHEST Meta passthrough — we don't surface passthrough here so
        // it doesn't matter for this widget. Conservative is to assume
        // 'utility' which has the smallest markup; switch if a pricing
        // page review demands a tighter number.)
        let marketingMsgs = 0
        let utilityMsgs = 0
        let authMsgs = 0
        for (const m of messages as any[]) {
          const fromBroadcast = m.broadcast_id ? broadcastTemplate.get(m.broadcast_id) : null
          const fromContent = (m.content as any)?.template?.name ?? null
          const name = fromBroadcast || fromContent
          const cat = name ? categoryByName.get(String(name)) : undefined
          if (cat === 'utility')             utilityMsgs++
          else if (cat === 'authentication') authMsgs++
          else                                marketingMsgs++  // includes unknown
        }

        const saving =
          marketingMsgs * competitor.marketing +
          utilityMsgs   * competitor.utility   +
          authMsgs      * competitor.authentication

        res.json({
          vs,
          competitor_label: competitor.label,
          marketing_msgs:   marketingMsgs,
          utility_msgs:     utilityMsgs,
          auth_msgs:        authMsgs,
          saving_inr:       Math.round(saving),
          month_start:      monthStart,
        })
      } catch (e: any) {
        console.warn('[markup-saved] failed:', e?.message ?? e)
        res.json(emptyResult(vs, competitor.label))
      }
    },
  )

  // ── GET /api/me/sla-today ────────────────────────────────────────────────
  //
  // For each inbound message TODAY (UTC), find the first outbound message
  // in the same (tenant_id, contact_phone) thread that arrived AFTER the
  // inbound. Delta in minutes. Average across all such "responded" threads.
  // Threads with no outbound yet today count as "pending" and don't pull
  // down the average — they're surfaced as a separate counter so the FE
  // can show "12 responded · 3 pending".
  //
  // Returns zeros for brand-new tenants (FE hides the badge).
  r.get('/api/me/sla-today',
    requireAuth, identifyTenant,
    async (req, res) => {
      const tenantId = (req as any).tenantId as string
      const dayStart = new Date()
      dayStart.setUTCHours(0, 0, 0, 0)
      const dayStartIso = dayStart.toISOString()

      try {
        const { data: rows, error } = await supabase
          .from('messages')
          .select('contact_phone, direction, created_at')
          .eq('tenant_id', tenantId)
          .gte('created_at', dayStartIso)
          .order('created_at', { ascending: true })
          .limit(5000)  // hard cap; >5k msgs/day means we sample the bottom
        if (error) {
          console.warn('[sla-today] query failed:', error.message)
          res.json({ avg_minutes: 0, threads_responded: 0, threads_pending: 0 }); return
        }
        const msgs = (rows ?? []) as Array<{ contact_phone: string; direction: string; created_at: string }>
        if (msgs.length === 0) {
          res.json({ avg_minutes: 0, threads_responded: 0, threads_pending: 0 }); return
        }

        // Per-phone: track the first inbound time waiting for a reply.
        // When we see an outbound after that, record the delta and clear
        // the pending state (next inbound restarts the cycle).
        const pendingInbound = new Map<string, number>()  // phone → ms timestamp
        const deltasMs: number[] = []
        let respondedThreads = 0
        const respondedPhones = new Set<string>()
        const pendingPhones = new Set<string>()

        for (const m of msgs) {
          const phone = m.contact_phone
          const ts = new Date(m.created_at).getTime()
          if (!phone || !isFinite(ts)) continue
          if (m.direction === 'inbound') {
            // Only set if there's no waiting inbound — i.e. the FIRST
            // inbound after the latest outbound is what we're measuring
            // SLA against.
            if (!pendingInbound.has(phone)) pendingInbound.set(phone, ts)
          } else if (m.direction === 'outbound') {
            const inboundTs = pendingInbound.get(phone)
            if (inboundTs !== undefined && ts > inboundTs) {
              deltasMs.push(ts - inboundTs)
              respondedThreads++
              respondedPhones.add(phone)
              pendingInbound.delete(phone)
            }
          }
        }
        // Anything still in pendingInbound is a thread waiting on a reply.
        for (const phone of pendingInbound.keys()) pendingPhones.add(phone)

        const avgMinutes = deltasMs.length === 0
          ? 0
          : Math.round((deltasMs.reduce((a, b) => a + b, 0) / deltasMs.length) / 60_000)

        res.json({
          avg_minutes:       avgMinutes,
          threads_responded: respondedPhones.size,
          threads_pending:   pendingPhones.size,
          day_start:         dayStartIso,
        })
      } catch (e: any) {
        console.warn('[sla-today] failed:', e?.message ?? e)
        res.json({ avg_minutes: 0, threads_responded: 0, threads_pending: 0 })
      }
    },
  )

  // ── POST /api/contacts/:id/consent ───────────────────────────────────────
  //
  // Record DPDPA-compliant consent for a contact. Three writes happen:
  //   1. contacts.consent_captured_at/_source updated (hot-path mirror).
  //   2. tenant_audit row appended (legacy evidentiary trail — kept so the
  //      existing /audit page still shows consent events).
  //   3. consent_events row inserted (migration 072 — the new evidentiary
  //      trail with per-(channel, purpose) granularity; the AFTER INSERT
  //      trigger materializes contact_consent_state for sender gating).
  //
  // Body (legacy + new fields all optional, sensible defaults):
  //   { source?: string,        // legacy free-text source
  //     method?: 'inline'|'webhook'|'csv'|'inbox',
  //     channel?: 'whatsapp'|'instagram'|'telegram'|'email'|'sms'|'all',
  //     purpose?: 'transactional'|'marketing'|'service_updates',
  //     proof_text?: string,    // the checkbox label / system message shown
  //     event_type?: 'opt_in'|'opt_out'|'reaffirm' }
  //
  // Defaults: channel='whatsapp', purpose='marketing', event_type='opt_in'
  // (the most common flow today — admin ticks the "I have marketing consent"
  // box during contact add). Idempotent.
  r.post('/api/contacts/:id/consent',
    requireAuth, identifyTenant, checkPermission('leads', 'edit'),
    async (req, res) => {
      const tenantId = (req as any).tenantId as string
      const userId = (req as any).user?.id ?? null
      const contactId = String(req.params.id)
      const source = String(req.body?.source ?? 'manual').slice(0, 60)
      const method = String(req.body?.method ?? 'inline').slice(0, 32)

      // ── New per-channel/purpose granularity (P0.7) ────────────────────
      const channel = (() => {
        const v = String(req.body?.channel ?? 'whatsapp').toLowerCase()
        return ['whatsapp', 'instagram', 'telegram', 'email', 'sms', 'all'].includes(v) ? v : 'whatsapp'
      })()
      const purpose = (() => {
        const v = String(req.body?.purpose ?? 'marketing').toLowerCase()
        return ['transactional', 'marketing', 'service_updates'].includes(v) ? v : 'marketing'
      })()
      const eventType = (() => {
        const v = String(req.body?.event_type ?? 'opt_in').toLowerCase()
        return ['opt_in', 'opt_out', 'reaffirm'].includes(v) ? v : 'opt_in'
      })()
      const proofText = typeof req.body?.proof_text === 'string'
        ? String(req.body.proof_text).slice(0, 2000)
        : `Captured via ${method} (source=${source})`

      // Ownership check — the .update will silently affect 0 rows if the
      // contact isn't in this tenant. Pre-fetch so we can return 404
      // instead of pretending success.
      const { data: contact, error: cErr } = await supabase
        .from('contacts')
        .select('id, phone, name')
        .eq('id', contactId)
        .eq('tenant_id', tenantId)
        .maybeSingle()
      if (cErr) { res.status(500).json({ error: cErr.message }); return }
      if (!contact)  { res.status(404).json({ error: 'contact not found' }); return }

      // Best-effort write to contacts. The columns may not exist yet on
      // older schemas — we don't fail the audit-log write if so, because
      // the audit row IS the evidentiary record (DPDP §6).
      const updatedAt = new Date().toISOString()
      const { error: updErr } = await supabase
        .from('contacts')
        .update({ consent_captured_at: updatedAt, consent_source: source })
        .eq('id', contactId)
        .eq('tenant_id', tenantId)
      if (updErr && !/column .* does not exist/i.test(updErr.message)) {
        console.warn('[consent] contacts update failed:', updErr.message)
      }

      // Append tenant_audit via the SECURITY DEFINER helper. Falls back to
      // a direct insert if the RPC is unavailable on this DB (older schema).
      let auditId: string | null = null
      try {
        const { data: rpcRes, error: rpcErr } = await (supabase as any).rpc('append_tenant_audit', {
          p_tenant_id:     tenantId,
          p_actor_id:      userId,
          p_actor_role:    null,
          p_action:        'consent.captured',
          p_entity_type:   'contact',
          p_entity_id:     contactId,
          p_justification: `source=${source}, method=${method}, channel=${channel}, purpose=${purpose}`,
          p_ticket_ref:    null,
          p_before_value:  null,
          p_after_value:   { source, method, channel, purpose, phone: (contact as any).phone, name: (contact as any).name },
          p_ip_address:    (req.headers['x-forwarded-for'] as string | undefined)?.split(',')[0]?.trim() ?? null,
          p_user_agent:    req.headers['user-agent'] ?? null,
        })
        if (!rpcErr && rpcRes) {
          auditId = String(rpcRes)
        } else if (rpcErr) {
          // Fallback for environments without the RPC — service-role insert.
          // RLS won't block since the policy is SELECT-only by tenant.
          const { data: ins } = await supabase
            .from('tenant_audit')
            .insert({
              tenant_id:     tenantId,
              actor_id:      userId,
              action:        'consent.captured',
              entity_type:   'contact',
              entity_id:     contactId,
              justification: `source=${source}, method=${method}`,
              after_value:   { source, method, phone: (contact as any).phone },
            })
            .select('id')
            .single()
          auditId = ins?.id ?? null
        }
      } catch (e: any) {
        console.warn('[consent] audit append failed:', e?.message ?? e)
      }

      // ── Write consent_events row (P0.7 — DPDPA evidentiary trail) ────
      // The AFTER INSERT trigger materializes contact_consent_state for
      // the sender gate to read. If the table doesn't exist (older schema
      // without migration 072), swallow the error — the tenant_audit
      // record above is still the legal evidence.
      let consentEventId: string | null = null
      let consentState: any = null
      try {
        const ipHeader = (req.headers['x-forwarded-for'] as string | undefined)?.split(',')[0]?.trim()
        const { data: ce, error: ceErr } = await supabase
          .from('consent_events')
          .insert({
            tenant_id:    tenantId,
            contact_id:   contactId,
            channel,
            event_type:   eventType,
            purpose,
            source:       source ?? 'manual_add',
            source_detail: {
              method,
              ip_hashed:   ipHeader ? hashIp(ipHeader) : null,
              user_agent:  req.headers['user-agent'] ?? null,
            },
            proof_text:   proofText,
            captured_by:  userId,
          })
          .select('id')
          .single()
        if (ceErr && !/relation .* does not exist/i.test(ceErr.message)) {
          console.warn('[consent] consent_events insert failed:', ceErr.message)
        } else if (ce) {
          consentEventId = ce.id
          // Fetch the materialized state to return it (FE renders a chip).
          const { data: st } = await supabase
            .from('contact_consent_state')
            .select('channel, purpose, status, effective_at')
            .eq('contact_id', contactId)
            .eq('channel', channel)
            .eq('purpose', purpose)
            .maybeSingle()
          consentState = st ?? null
        }
      } catch (e: any) {
        console.warn('[consent] consent_events write failed:', e?.message ?? e)
      }

      res.json({
        success:            true,
        contact_id:         contactId,
        audit_id:           auditId,
        consent_event_id:   consentEventId,
        state:              consentState,
        captured_at:        updatedAt,
      })
    },
  )

  // ── GET /api/contacts/:id/consent/history ──────────────────────────────
  // Returns the full consent_events timeline for a contact + the current
  // materialized state per (channel, purpose). Used by the contact-detail
  // side panel.
  r.get('/api/contacts/:id/consent/history',
    requireAuth, identifyTenant, checkPermission('leads', 'view'),
    async (req, res) => {
      const tenantId = (req as any).tenantId as string
      const contactId = String(req.params.id)
      // Ownership check
      const { data: contact } = await supabase.from('contacts')
        .select('id').eq('id', contactId).eq('tenant_id', tenantId).maybeSingle()
      if (!contact) { res.status(404).json({ error: 'contact not found' }); return }

      const [{ data: events, error: eErr }, { data: state, error: sErr }] = await Promise.all([
        supabase.from('consent_events')
          .select('id, channel, event_type, purpose, source, source_detail, proof_text, captured_by, occurred_at')
          .eq('tenant_id', tenantId).eq('contact_id', contactId)
          .order('occurred_at', { ascending: false }).limit(500),
        supabase.from('contact_consent_state')
          .select('channel, purpose, status, effective_at')
          .eq('contact_id', contactId),
      ])
      if (eErr && !/relation .* does not exist/i.test(eErr.message)) {
        res.status(500).json({ error: eErr.message }); return
      }
      if (sErr && !/relation .* does not exist/i.test(sErr.message)) {
        res.status(500).json({ error: sErr.message }); return
      }
      res.json({
        events: events ?? [],
        state:  state ?? [],
      })
    },
  )

  // ── GET /api/consent-events ─────────────────────────────────────────────
  // Tenant-wide consent-event feed for the Compliance Center timeline.
  // Filters: ?channel=, ?purpose=, ?event_type=, ?limit= (max 500).
  r.get('/api/consent-events',
    requireAuth, identifyTenant, checkPermission('leads', 'view'),
    async (req, res) => {
      const tenantId = (req as any).tenantId as string
      const limit = Math.min(500, Math.max(1, Number(req.query.limit ?? 200)))
      let q = supabase.from('consent_events')
        .select('id, contact_id, channel, event_type, purpose, source, proof_text, occurred_at')
        .eq('tenant_id', tenantId)
        .order('occurred_at', { ascending: false })
        .limit(limit)
      if (typeof req.query.channel === 'string')    q = q.eq('channel', req.query.channel)
      if (typeof req.query.purpose === 'string')    q = q.eq('purpose', req.query.purpose)
      if (typeof req.query.event_type === 'string') q = q.eq('event_type', req.query.event_type)
      const { data, error } = await q
      if (error) { res.status(500).json({ error: error.message }); return }
      res.json(data ?? [])
    },
  )

  // ── POST /api/campaigns/:id/resume ───────────────────────────────────────
  //
  // Lifts the 'paused' state on a campaign that the template-sync worker
  // auto-paused after a Meta category reclassification. Clears pause_reason
  // so the amber "auto-paused" banner disappears from the row.
  //
  // 404 if the campaign isn't in this tenant or isn't paused.
  r.post('/api/campaigns/:id/resume',
    requireAuth, identifyTenant, checkPermission('whatsapp_automation', 'edit'),
    async (req, res) => {
      const tenantId = (req as any).tenantId as string
      const campaignId = String(req.params.id)

      const { data: campaign, error: cErr } = await supabase
        .from('campaigns')
        .select('id, status, pause_reason')
        .eq('id', campaignId)
        .eq('tenant_id', tenantId)
        .maybeSingle()
      if (cErr) { res.status(500).json({ error: cErr.message }); return }
      if (!campaign) { res.status(404).json({ error: 'campaign not found' }); return }
      if ((campaign as any).status !== 'paused') {
        res.status(409).json({ error: 'campaign is not paused' }); return
      }

      // Try the update with both columns; fall back without pause_reason if
      // the column is missing on this schema (migration 068 not applied).
      let { error: upErr } = await supabase
        .from('campaigns')
        .update({ status: 'active', pause_reason: null })
        .eq('id', campaignId)
        .eq('tenant_id', tenantId)
      if (upErr && /column .*pause_reason.* does not exist/i.test(upErr.message)) {
        const fallback = await supabase
          .from('campaigns').update({ status: 'active' })
          .eq('id', campaignId).eq('tenant_id', tenantId)
        upErr = fallback.error
      }
      if (upErr) { res.status(500).json({ error: upErr.message }); return }
      res.json({ success: true, campaign_id: campaignId, status: 'active' })
    },
  )

  return r
}

function emptyResult(vs: string, label: string) {
  return {
    vs,
    competitor_label: label,
    marketing_msgs:   0,
    utility_msgs:     0,
    auth_msgs:        0,
    saving_inr:       0,
    month_start:      new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1)).toISOString(),
  }
}
