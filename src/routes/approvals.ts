/**
 * Approval engine + endpoints.
 *
 * Concept:
 *   Some actions are "big blast radius" — broadcasts to many recipients,
 *   bulk delete of contacts, paid integration connect, etc. We don't block
 *   the requesting user (they may be a Sales Rep), but we *queue* the action
 *   as an approval_request and notify the role(s) that can approve.
 *
 *   `requireApproval(supabase, ctx, action_type, payload, metric_value)`
 *      - Reads approval_rules for that action_type (tenant override > platform default)
 *      - If no rule or below threshold → returns { needs_approval: false }
 *      - Else → writes an approval_requests row, fires notifications, returns
 *        { needs_approval: true, request_id }
 *
 * Endpoints:
 *   GET    /api/approvals                      list approval requests for this tenant
 *   POST   /api/approvals/:id/approve          approver clicks ✓
 *   POST   /api/approvals/:id/reject           approver clicks ✗
 *   GET    /api/approvals/pending-count        badge for the team admin's nav
 */

import express from 'express'
import { SupabaseClient } from '@supabase/supabase-js'
import { emitNotification } from './notifications'

type Middleware = (req: express.Request, res: express.Response, next: express.NextFunction) => void | Promise<void>

interface Deps {
  supabase: SupabaseClient
  requireAuth: Middleware
  identifyTenant: Middleware
  /** Permission gate factory — same one mounted in index.ts. */
  checkPermission: (feature: string, action: 'view' | 'edit' | 'delete') => Middleware
}

/**
 * Public helper used by other routers (broadcasts, contacts, templates).
 * Returns the matching rule (if any) when an action needs approval.
 */
export async function checkApprovalRequired(
  supabase: SupabaseClient,
  args: { tenant_id: string; action_type: string; metric_value?: number | null },
): Promise<{ rule: any | null; needs_approval: boolean }> {
  // Tenant-specific rule first, then platform default
  const { data: tenant } = await supabase.from('approval_rules')
    .select('*').eq('tenant_id', args.tenant_id).eq('action_type', args.action_type).eq('is_enabled', true).maybeSingle()
  const { data: platform } = await supabase.from('approval_rules')
    .select('*').is('tenant_id', null).eq('action_type', args.action_type).eq('is_enabled', true).maybeSingle()
  const rule = tenant ?? platform
  if (!rule) return { rule: null, needs_approval: false }

  // Threshold check (when metric defined)
  if (rule.threshold_value != null && args.metric_value != null) {
    if (Number(args.metric_value) <= Number(rule.threshold_value)) {
      return { rule, needs_approval: false }
    }
  }
  return { rule, needs_approval: true }
}

/** Create an approval_requests row + notify all users with the required role. */
export async function requireApproval(
  supabase: SupabaseClient,
  args: {
    tenant_id: string
    requested_by: string
    action_type: string
    target_payload: any
    metric_value?: number | null
    requested_by_name?: string
  },
): Promise<{ needs_approval: boolean; request_id?: string; rule?: any }> {
  const check = await checkApprovalRequired(supabase, args)
  if (!check.needs_approval) return { needs_approval: false }

  // 48-hour expiry by default
  const { data: ttlFlag } = await supabase.from('feature_flags')
    .select('value_json').eq('key', 'approval_request_ttl_hours').maybeSingle()
  const ttlH = (ttlFlag?.value_json as any)?.value ?? 48

  const { data: req, error: insErr } = await supabase.from('approval_requests').insert({
    tenant_id: args.tenant_id, requested_by: args.requested_by,
    action_type: args.action_type, target_payload: args.target_payload,
    expires_at: new Date(Date.now() + Number(ttlH) * 60 * 60 * 1000).toISOString(),
    status: 'pending',
  }).select().single()
  if (insErr) {
    console.error('[approvals] insert failed', insErr.message)
    return { needs_approval: true }
  }

  // Find users in this tenant whose role can approve
  const { data: approvers } = await supabase.from('user_role_assignments')
    .select(`user_id, role_definitions ( key )`)
    .eq('tenant_id', args.tenant_id).is('disabled_at', null)
  const approverIds = (approvers ?? [])
    .filter((a: any) => a.role_definitions?.key === check.rule.required_role || a.role_definitions?.key === 'owner' || a.role_definitions?.key === 'workspace_admin')
    .map((a: any) => a.user_id)

  if (approverIds.length > 0) {
    await emitNotification(supabase, {
      tenant_id: args.tenant_id,
      event_key: 'approval.requested',
      recipient_user_ids: approverIds,
      data: { action: args.action_type, requested_by_name: args.requested_by_name ?? 'A teammate' },
      link: '/settings/team?tab=approvals',
    })
  }

  return { needs_approval: true, request_id: req.id, rule: check.rule }
}

export function createApprovalsRouter(deps: Deps): express.Router {
  const r = express.Router()
  const { supabase, requireAuth, identifyTenant, checkPermission } = deps

  r.get('/api/approvals', requireAuth, identifyTenant, async (req, res) => {
    const tenantId = (req as any).tenantId
    const { data, error } = await supabase.from('approval_requests')
      .select('*').eq('tenant_id', tenantId).order('created_at', { ascending: false }).limit(100)
    if (error) { res.status(500).json({ error: error.message }); return }
    res.json(data ?? [])
  })

  r.get('/api/approvals/pending-count', requireAuth, identifyTenant, async (req, res) => {
    const tenantId = (req as any).tenantId
    const { count, error } = await supabase.from('approval_requests')
      .select('id', { count: 'exact', head: true })
      .eq('tenant_id', tenantId).eq('status', 'pending')
    if (error) { res.status(500).json({ error: error.message }); return }
    res.json({ count: count ?? 0 })
  })

  // Approve / reject are gated to settings.edit — same bar as changing
  // workspace settings, which in practice means owner / workspace_admin.
  // Sales reps, support agents, analysts etc. cannot bypass approvals.
  r.post('/api/approvals/:id/approve', requireAuth, identifyTenant, checkPermission('settings', 'edit'), async (req, res) => {
    const tenantId = (req as any).tenantId
    const userId = (req as any).user.id
    const { data: row } = await supabase.from('approval_requests')
      .select('*').eq('id', String(req.params.id)).eq('tenant_id', tenantId).maybeSingle()
    if (!row) { res.status(404).json({ error: 'Not found' }); return }
    if (row.status !== 'pending') { res.status(400).json({ error: `Already ${row.status}` }); return }
    await supabase.from('approval_requests').update({
      status: 'approved', approved_by: userId, approved_at: new Date().toISOString(),
    }).eq('id', String(req.params.id))

    // Notify the requester
    await emitNotification(supabase, {
      tenant_id: tenantId,
      event_key: 'approval.granted',
      recipient_user_ids: [row.requested_by],
      data: { action: row.action_type },
    })
    res.json({ success: true })
  })

  r.post('/api/approvals/:id/reject', requireAuth, identifyTenant, checkPermission('settings', 'edit'), async (req, res) => {
    const tenantId = (req as any).tenantId
    const reason = String(req.body?.reason ?? '').trim() || 'No reason provided'
    const { data: row } = await supabase.from('approval_requests')
      .select('*').eq('id', String(req.params.id)).eq('tenant_id', tenantId).maybeSingle()
    if (!row) { res.status(404).json({ error: 'Not found' }); return }
    if (row.status !== 'pending') { res.status(400).json({ error: `Already ${row.status}` }); return }
    await supabase.from('approval_requests').update({
      status: 'rejected', rejection_reason: reason,
    }).eq('id', String(req.params.id))
    await emitNotification(supabase, {
      tenant_id: tenantId,
      event_key: 'approval.rejected',
      recipient_user_ids: [row.requested_by],
      data: { action: row.action_type, reason },
    })
    res.json({ success: true })
  })

  return r
}
