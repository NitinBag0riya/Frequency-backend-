/**
 * Phase 3 API routes — campaigns, analytics, execution logs, contact activity.
 *
 * Mounted from index.ts as a router so we don't bloat the monolith further.
 * The route splitting (Phase 2 task 2.1) is a separate refactor; this module
 * is the first taste of the target structure.
 */

import express from 'express'
import { z } from 'zod'
import { SupabaseClient } from '@supabase/supabase-js'
import { enrollContact } from '../engine/campaign'
import { validateBody } from '../validation'

type Middleware = (req: express.Request, res: express.Response, next: express.NextFunction) => void | Promise<void>

interface Deps {
  supabase: SupabaseClient
  requireAuth: Middleware
  identifyTenant: Middleware
  checkPermission: (feature: string, action: 'view' | 'edit' | 'delete') => Middleware
}

// ── Schemas ──────────────────────────────────────────────────────────────────
const CampaignStepSchema = z.object({
  position: z.number().int().nonnegative(),
  kind: z.enum(['wait_delay', 'send_template', 'send_text', 'add_tag', 'end']),
  config: z.record(z.string(), z.any()).default({}),
})

const CampaignStepsBulkSchema = z.object({
  steps: z.array(CampaignStepSchema).min(1),
})

const EnrollSchema = z.object({
  contact_id: z.string().uuid().optional().nullable(),
  contact_phone: z.string().min(6).optional(),
  variables: z.record(z.string(), z.any()).optional(),
}).refine(v => v.contact_id || v.contact_phone, { message: 'contact_id or contact_phone required' })

const BulkEnrollSchema = z.object({
  // Audience filter — matching subset of contacts
  audience: z.object({
    tags:         z.array(z.string()).optional(),
    exclude_tags: z.array(z.string()).optional(),
  }).optional(),
  // Or explicit list
  contact_ids: z.array(z.string().uuid()).optional(),
})

// ── Router factory ───────────────────────────────────────────────────────────
export function createPhase3Router(deps: Deps): express.Router {
  const r = express.Router()
  const { supabase, requireAuth, identifyTenant, checkPermission } = deps

  // ╭──────────────────────────────────────────────────────────────────────────╮
  // │ Campaign Steps (CRUD)                                                    │
  // ╰──────────────────────────────────────────────────────────────────────────╯

  r.get('/api/campaigns/:id/steps',
    requireAuth, identifyTenant, checkPermission('whatsapp_automation', 'view'),
    async (req, res) => {
      const tenantId = (req as any).tenantId
      const { data, error } = await supabase.from('campaign_steps')
        .select('*')
        .eq('campaign_id', req.params.id)
        .eq('tenant_id', tenantId)
        .order('position', { ascending: true })
      if (error) { res.status(500).json({ error: error.message }); return }
      res.json(data ?? [])
    })

  // Bulk-replace all steps (simplest editor flow: client sends the whole list).
  r.put('/api/campaigns/:id/steps',
    requireAuth, identifyTenant, checkPermission('whatsapp_automation', 'edit'),
    validateBody(CampaignStepsBulkSchema),
    async (req, res) => {
      const tenantId = (req as any).tenantId
      const { steps } = req.body as z.infer<typeof CampaignStepsBulkSchema>
      // Verify campaign belongs to tenant
      const { data: camp } = await supabase.from('campaigns')
        .select('id').eq('id', req.params.id).eq('tenant_id', tenantId).maybeSingle()
      if (!camp) { res.status(404).json({ error: 'campaign not found' }); return }

      // Delete + insert (small N, simple semantics)
      await supabase.from('campaign_steps').delete().eq('campaign_id', req.params.id)
      const rows = steps.map(s => ({
        campaign_id: req.params.id,
        tenant_id: tenantId,
        position: s.position,
        kind: s.kind,
        config: s.config,
      }))
      const { data, error } = await supabase.from('campaign_steps').insert(rows).select()
      if (error) { res.status(500).json({ error: error.message }); return }
      res.json(data)
    })

  // ╭──────────────────────────────────────────────────────────────────────────╮
  // │ Campaign Enrollment                                                      │
  // ╰──────────────────────────────────────────────────────────────────────────╯

  r.post('/api/campaigns/:id/enroll',
    requireAuth, identifyTenant, checkPermission('whatsapp_automation', 'edit'),
    validateBody(EnrollSchema),
    async (req, res) => {
      const tenantId = (req as any).tenantId
      const { contact_id, contact_phone, variables } = req.body as z.infer<typeof EnrollSchema>

      const { data: camp } = await supabase.from('campaigns')
        .select('id, status').eq('id', req.params.id).eq('tenant_id', tenantId).maybeSingle()
      if (!camp) { res.status(404).json({ error: 'campaign not found' }); return }
      if (camp.status !== 'active') { res.status(400).json({ error: `campaign status=${camp.status}` }); return }

      // Resolve phone if only contact_id provided
      let phone = contact_phone
      let contactIdResolved: string | null = contact_id ?? null
      if (!phone && contact_id) {
        const { data: c } = await supabase.from('contacts').select('phone')
          .eq('id', contact_id).eq('tenant_id', tenantId).maybeSingle()
        if (!c) { res.status(404).json({ error: 'contact not found' }); return }
        phone = c.phone
      }

      try {
        const { enrollment, alreadyEnrolled } = await enrollContact({
          campaignId: String(req.params.id),
          tenantId,
          contactId: contactIdResolved,
          contactPhone: phone!,
          variables,
        })
        res.json({ enrollment, alreadyEnrolled })
      } catch (err: any) {
        res.status(500).json({ error: err.message })
      }
    })

  // Bulk enroll — by audience filter OR explicit contact_ids
  r.post('/api/campaigns/:id/enroll/bulk',
    requireAuth, identifyTenant, checkPermission('whatsapp_automation', 'edit'),
    validateBody(BulkEnrollSchema),
    async (req, res) => {
      const tenantId = (req as any).tenantId
      const { audience, contact_ids } = req.body as z.infer<typeof BulkEnrollSchema>

      const { data: camp } = await supabase.from('campaigns')
        .select('id, status').eq('id', req.params.id).eq('tenant_id', tenantId).maybeSingle()
      if (!camp) { res.status(404).json({ error: 'campaign not found' }); return }
      if (camp.status !== 'active') { res.status(400).json({ error: `campaign status=${camp.status}` }); return }

      let q = supabase.from('contacts')
        .select('id, phone')
        .eq('tenant_id', tenantId)
        .eq('status', 'active')
      if (contact_ids?.length) q = q.in('id', contact_ids)
      if (audience?.tags?.length) q = q.overlaps('tags', audience.tags)
      if (audience?.exclude_tags?.length) q = q.not('tags', 'ov', `{${audience.exclude_tags.join(',')}}`)

      const { data: contacts, error } = await q
      if (error) { res.status(500).json({ error: error.message }); return }
      if (!contacts || contacts.length === 0) { res.json({ enrolled: 0, skipped: 0 }); return }

      let enrolled = 0, skipped = 0
      for (const c of contacts) {
        try {
          const { alreadyEnrolled } = await enrollContact({
            campaignId: String(req.params.id),
            tenantId,
            contactId: c.id,
            contactPhone: c.phone,
          })
          if (alreadyEnrolled) skipped++
          else enrolled++
        } catch { skipped++ }
      }
      res.json({ enrolled, skipped, total: contacts.length })
    })

  r.get('/api/campaigns/:id/enrollments',
    requireAuth, identifyTenant, checkPermission('whatsapp_automation', 'view'),
    async (req, res) => {
      const tenantId = (req as any).tenantId
      const status = (req.query.status as string) ?? undefined
      let q = supabase.from('campaign_enrollments').select('*')
        .eq('campaign_id', req.params.id).eq('tenant_id', tenantId)
        .order('enrolled_at', { ascending: false })
        .limit(500)
      if (status) q = q.eq('status', status)
      const { data, error } = await q
      if (error) { res.status(500).json({ error: error.message }); return }
      res.json(data ?? [])
    })

  // ╭──────────────────────────────────────────────────────────────────────────╮
  // │ Analytics — Phase 3.3                                                    │
  // ╰──────────────────────────────────────────────────────────────────────────╯

  // Top-line stats: totals + last-7d delta
  r.get('/api/analytics/summary',
    requireAuth, identifyTenant,
    async (req, res) => {
      const tenantId = (req as any).tenantId
      const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()
      const [total, recent, contactsCount, sessionsCount, broadcastsCount] = await Promise.all([
        supabase.from('messages').select('id', { count: 'exact', head: true }).eq('tenant_id', tenantId),
        supabase.from('messages').select('id', { count: 'exact', head: true }).eq('tenant_id', tenantId).gte('created_at', sevenDaysAgo),
        supabase.from('contacts').select('id', { count: 'exact', head: true }).eq('tenant_id', tenantId),
        supabase.from('workflow_sessions').select('id', { count: 'exact', head: true }).eq('tenant_id', tenantId),
        supabase.from('broadcasts').select('id', { count: 'exact', head: true }).eq('tenant_id', tenantId),
      ])
      const inboundRecent = await supabase.from('messages').select('id', { count: 'exact', head: true })
        .eq('tenant_id', tenantId).eq('direction', 'inbound').gte('created_at', sevenDaysAgo)
      const outboundRecent = await supabase.from('messages').select('id', { count: 'exact', head: true })
        .eq('tenant_id', tenantId).eq('direction', 'outbound').gte('created_at', sevenDaysAgo)

      res.json({
        messages_total: total.count ?? 0,
        messages_7d:    recent.count ?? 0,
        inbound_7d:     inboundRecent.count ?? 0,
        outbound_7d:    outboundRecent.count ?? 0,
        contacts:       contactsCount.count ?? 0,
        sessions:       sessionsCount.count ?? 0,
        broadcasts:     broadcastsCount.count ?? 0,
      })
    })

  // Daily message counts for the last N days (default 14).
  r.get('/api/analytics/timeseries',
    requireAuth, identifyTenant,
    async (req, res) => {
      const tenantId = (req as any).tenantId
      const days = Math.min(Math.max(Number(req.query.days ?? 14), 1), 90)
      const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString()

      const { data, error } = await supabase.from('messages')
        .select('created_at, direction')
        .eq('tenant_id', tenantId)
        .gte('created_at', since)
        .limit(50_000)
      if (error) { res.status(500).json({ error: error.message }); return }

      // Bucket by day in JS (small dataset; for huge tenants, switch to a
      // materialized view + RPC).
      const buckets: Record<string, { day: string; inbound: number; outbound: number }> = {}
      for (let i = 0; i < days; i++) {
        const d = new Date(Date.now() - i * 86_400_000)
        const day = d.toISOString().slice(0, 10)
        buckets[day] = { day, inbound: 0, outbound: 0 }
      }
      for (const m of data ?? []) {
        const day = new Date(m.created_at).toISOString().slice(0, 10)
        if (!buckets[day]) buckets[day] = { day, inbound: 0, outbound: 0 }
        if (m.direction === 'inbound') buckets[day].inbound++
        else if (m.direction === 'outbound') buckets[day].outbound++
      }
      const series = Object.values(buckets).sort((a, b) => a.day.localeCompare(b.day))
      res.json(series)
    })

  // ╭──────────────────────────────────────────────────────────────────────────╮
  // │ Execution Logs — Phase 3.4                                               │
  // ╰──────────────────────────────────────────────────────────────────────────╯

  r.get('/api/workflows/:id/executions',
    requireAuth, identifyTenant, checkPermission('whatsapp_automation', 'view'),
    async (req, res) => {
      const tenantId = (req as any).tenantId
      const limit = Math.min(Number(req.query.limit ?? 100), 500)
      const { data, error } = await supabase.from('workflow_executions')
        .select('*')
        .eq('workflow_id', req.params.id)
        .eq('tenant_id', tenantId)
        .order('created_at', { ascending: false })
        .limit(limit)
      if (error) { res.status(500).json({ error: error.message }); return }
      res.json(data ?? [])
    })

  r.get('/api/sessions/:id/executions',
    requireAuth, identifyTenant, checkPermission('whatsapp_automation', 'view'),
    async (req, res) => {
      const tenantId = (req as any).tenantId
      const { data, error } = await supabase.from('workflow_executions')
        .select('*')
        .eq('session_id', req.params.id)
        .eq('tenant_id', tenantId)
        .order('created_at', { ascending: true })
      if (error) { res.status(500).json({ error: error.message }); return }
      res.json(data ?? [])
    })

  // ╭──────────────────────────────────────────────────────────────────────────╮
  // │ Contact Activity Timeline — Phase 3.5                                    │
  // ╰──────────────────────────────────────────────────────────────────────────╯

  // Merges messages, workflow sessions, and tag changes into a chronological
  // feed. The FE renders one timeline view from this single endpoint.
  r.get('/api/contacts/:phone/activity',
    requireAuth, identifyTenant, checkPermission('inbox', 'view'),
    async (req, res) => {
      const tenantId = (req as any).tenantId
      const phone = decodeURIComponent(req.params.phone as string).replace(/^\+/, '')
      const limit = Math.min(Number(req.query.limit ?? 100), 500)

      const [msgs, sessions] = await Promise.all([
        supabase.from('messages')
          .select('id, direction, content, status, created_at, broadcast_id, session_id')
          .eq('tenant_id', tenantId).eq('contact_phone', phone)
          .order('created_at', { ascending: false }).limit(limit),
        supabase.from('workflow_sessions')
          .select('id, workflow_id, current_node_id, status, started_at, updated_at')
          .eq('tenant_id', tenantId).eq('contact_phone', phone)
          .order('started_at', { ascending: false }).limit(50),
      ])

      const events: any[] = []
      for (const m of msgs.data ?? []) {
        events.push({
          type: m.direction === 'inbound' ? 'message_received' : 'message_sent',
          at: m.created_at,
          message_id: m.id,
          session_id: m.session_id,
          broadcast_id: m.broadcast_id,
          status: m.status,
          summary: extractTextSummary(m.content),
        })
      }
      for (const s of sessions.data ?? []) {
        events.push({
          type: 'session_started',
          at: s.started_at,
          workflow_id: s.workflow_id,
          session_id: s.id,
          status: s.status,
        })
      }
      events.sort((a, b) => (b.at ?? '').localeCompare(a.at ?? ''))
      res.json(events.slice(0, limit))
    })

  // ╭──────────────────────────────────────────────────────────────────────────╮
  // │ Per-broadcast Analytics — Phase 3.6                                      │
  // ╰──────────────────────────────────────────────────────────────────────────╯

  r.get('/api/broadcasts/:id/recipients',
    requireAuth, identifyTenant, checkPermission('whatsapp_automation', 'view'),
    async (req, res) => {
      const tenantId = (req as any).tenantId
      // Verify broadcast belongs to tenant
      const { data: b } = await supabase.from('broadcasts').select('id, status, stats')
        .eq('id', req.params.id).eq('tenant_id', tenantId).maybeSingle()
      if (!b) { res.status(404).json({ error: 'broadcast not found' }); return }

      const { data: msgs, error } = await supabase.from('messages')
        .select('id, contact_phone, status, created_at')
        .eq('tenant_id', tenantId)
        .eq('broadcast_id', req.params.id)
        .order('created_at', { ascending: false })
        .limit(5000)
      if (error) { res.status(500).json({ error: error.message }); return }

      // Aggregate
      const byStatus: Record<string, number> = {}
      for (const m of msgs ?? []) byStatus[m.status] = (byStatus[m.status] ?? 0) + 1

      res.json({
        broadcast: b,
        recipients: msgs?.length ?? 0,
        by_status: byStatus,
        rows: (msgs ?? []).slice(0, 500),       // cap detail rows for FE
      })
    })

  return r
}

// ── helpers ──────────────────────────────────────────────────────────────────
function extractTextSummary(content: any): string {
  if (!content) return ''
  // Inbound shape: { text: { body: '...' } } or { type, button: {text}, interactive: {...} }
  if (content.text?.body) return String(content.text.body).slice(0, 280)
  if (content.button?.text) return `[btn] ${content.button.text}`
  if (content.interactive?.button_reply?.title) return `[btn] ${content.interactive.button_reply.title}`
  if (content.template?.name) return `[template] ${content.template.name}`
  if (content.type) return `[${content.type}]`
  return ''
}
