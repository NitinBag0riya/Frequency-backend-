/**
 * routes/sla.ts — SLA config + breach reads.
 *
 * Phase 3 (migration 095 + 098 hardening). Three surfaces:
 *
 *   GET    /api/sla/config             — list current policy rows
 *   POST   /api/sla/config             — upsert a (channel, team_id) row
 *   DELETE /api/sla/config/:id         — remove a policy row
 *   GET    /api/sla/breaches?active=1  — list open breaches
 *
 * The worker (workers/sla-monitor.ts) is the WRITER; this router is
 * read-mostly for tenant admins and managers.
 *
 * Hardening notes (audit fixes shipped with this file):
 *   - Every Zod schema is .strict() so foreign keys (tenant_id, id)
 *     can't be injected via body spread and clobber the route-set
 *     tenant scope.
 *   - working_hours_json is a real object shape with caps, not a
 *     free-form record — DoS-resistant.
 *   - Supabase errors are NEVER reflected to the client; we log
 *     server-side and return a generic message + correlation id.
 *   - The upsert uses the NULLS NOT DISTINCT unique constraint from
 *     migration 098 so tenant-default rows (team_id IS NULL) actually
 *     update instead of inserting duplicates.
 */

import express from 'express'
import { z } from 'zod'
import type { SupabaseClient } from '@supabase/supabase-js'

type Deps = {
  supabase: SupabaseClient
  requireAuth: express.RequestHandler
  identifyTenant: express.RequestHandler
}

// Tight, capped shape — avoids DoS through unbounded JSON. The worker
// reads working_hours_json to gate breach emission to in-hours windows
// (TODO: not wired up yet; schema reserves the shape so v1.1 doesn't
// need a contract change).
const WorkingHoursBody = z.object({
  tz:    z.string().min(1).max(60).optional(),
  // day -> array of {start, end} HH:MM windows. Each day list is short
  // (real businesses have 1-2 windows per day); cap defensively.
  mon:   z.array(z.object({ start: z.string().max(5), end: z.string().max(5) })).max(4).optional(),
  tue:   z.array(z.object({ start: z.string().max(5), end: z.string().max(5) })).max(4).optional(),
  wed:   z.array(z.object({ start: z.string().max(5), end: z.string().max(5) })).max(4).optional(),
  thu:   z.array(z.object({ start: z.string().max(5), end: z.string().max(5) })).max(4).optional(),
  fri:   z.array(z.object({ start: z.string().max(5), end: z.string().max(5) })).max(4).optional(),
  sat:   z.array(z.object({ start: z.string().max(5), end: z.string().max(5) })).max(4).optional(),
  sun:   z.array(z.object({ start: z.string().max(5), end: z.string().max(5) })).max(4).optional(),
}).strict()

const ConfigBody = z.object({
  team_id:                z.string().uuid().nullable().optional(),
  channel:                z.enum(['any', 'whatsapp', 'instagram', 'telegram']).default('any'),
  first_response_seconds: z.number().int().min(60).max(86400 * 30),
  resolution_seconds:     z.number().int().min(60).max(86400 * 30),
  working_hours_json:     WorkingHoursBody.optional(),
  paused:                 z.boolean().optional(),
}).strict()

// Generic Supabase error responder: logs the real error server-side
// (with a correlation id) and returns a sanitised message so we
// don't leak column / constraint / row data to the wire.
function respond500(res: express.Response, scope: string, error: unknown): void {
  const corrId = Math.random().toString(36).slice(2, 10)
  // eslint-disable-next-line no-console
  console.warn(`[sla:${scope}] ${corrId}`, error)
  res.status(500).json({ error: 'internal', scope, ref: corrId })
}

export function createSlaRouter(deps: Deps): express.Router {
  const { supabase, requireAuth, identifyTenant } = deps
  const r = express.Router()

  // GET /api/sla/config — all policy rows for this tenant.
  r.get('/api/sla/config', requireAuth, identifyTenant, async (req, res) => {
    const tenantId = (req as any).tenantId as string
    const { data, error } = await supabase.from('sla_configs')
      .select('*').eq('tenant_id', tenantId)
      .order('team_id', { nullsFirst: true })
      .order('channel')
    if (error) { respond500(res, 'config_list', error); return }
    res.json({ data: data ?? [] })
  })

  // POST /api/sla/config — upsert a row by (team_id, channel).
  // NULLS NOT DISTINCT constraint (migration 098) means team_id IS NULL
  // rows behave like a real key, so tenant-default rules update in place.
  r.post('/api/sla/config', requireAuth, identifyTenant, async (req, res) => {
    const tenantId = (req as any).tenantId as string
    const parsed = ConfigBody.safeParse(req.body)
    if (!parsed.success) { res.status(400).json({ error: 'invalid_body', issues: parsed.error.issues }); return }
    // Destructure and re-assemble so tenant_id (route-derived) is the
    // SOURCE OF TRUTH and never overridable by client body.
    const { team_id, channel, first_response_seconds, resolution_seconds, working_hours_json, paused } = parsed.data
    const { data, error } = await supabase.from('sla_configs').upsert({
      tenant_id: tenantId,
      team_id:   team_id ?? null,
      channel,
      first_response_seconds,
      resolution_seconds,
      working_hours_json: working_hours_json ?? null,
      paused:    paused ?? false,
      updated_at: new Date().toISOString(),
    }, {
      onConflict: 'tenant_id,team_id,channel',
      ignoreDuplicates: false,
    }).select().single()
    if (error) { respond500(res, 'config_upsert', error); return }
    res.json({ data })
  })

  r.delete('/api/sla/config/:id', requireAuth, identifyTenant, async (req, res) => {
    const tenantId = (req as any).tenantId as string
    const { error } = await supabase.from('sla_configs')
      .delete()
      .eq('id', req.params.id)
      .eq('tenant_id', tenantId)
    if (error) { respond500(res, 'config_delete', error); return }
    res.json({ success: true })
  })

  // GET /api/sla/breaches?active=1 — currently-open breaches (resolved_at IS NULL).
  // ?active=0 returns the last 200 resolved breaches for retrospective reports.
  r.get('/api/sla/breaches', requireAuth, identifyTenant, async (req, res) => {
    const tenantId = (req as any).tenantId as string
    const active = String(req.query.active ?? '1') === '1'
    let q = supabase.from('sla_breaches')
      .select('id, conversation_phone, conversation_channel, type, assigned_agent_id, target_seconds, actual_seconds, breached_at, resolved_at, contact_name')
      .eq('tenant_id', tenantId)
      .order('breached_at', { ascending: false })
      .limit(200)
    q = active ? q.is('resolved_at', null) : q.not('resolved_at', 'is', null)
    const { data, error } = await q
    if (error) { respond500(res, 'breaches_list', error); return }
    res.json({ data: data ?? [] })
  })

  return r
}
