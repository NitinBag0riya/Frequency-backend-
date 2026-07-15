/**
 * Integration requests — user-submitted asks for native app support.
 *
 *   POST /api/integration-requests
 *     body: { app_name, n8n_type?, reason?, context? }
 *
 * Side-effects:
 *   1. Inserts an `integration_requests` row (migration 118).
 *   2. Fires a transactional email to developers@frequency.app (configurable
 *      via DEVELOPER_NOTIFY_EMAIL) via the existing Resend wrapper in
 *      src/lib/email.ts. If Resend isn't configured (env unset), we still
 *      create the row + return 200 — losing the email is recoverable
 *      (super-admins can see the row in their dashboard later), losing the
 *      row would mean the user gets no signal at all.
 *
 *   The most common source today is the n8n import flow's "Request
 *   onboarding" CTA. The endpoint is intentionally generic so it can be
 *   reused for any in-product "request this app" surface (e.g. the
 *   connectors page, the workflow builder picker).
 */

import express from 'express'
import { z } from 'zod'
import { SupabaseClient } from '@supabase/supabase-js'
import { apiError } from '../lib/api-error'
import { sendEmail, emailConfigured } from '../lib/email'
import { renderEmail } from '../emails/render'
import IntegrationRequestAlert from '../emails/templates/IntegrationRequestAlert'

type Middleware = (req: express.Request, res: express.Response, next: express.NextFunction) => void | Promise<void>

interface Deps {
  supabase:        SupabaseClient
  requireAuth:     Middleware
  identifyTenant:  Middleware
}

const BodySchema = z.object({
  app_name: z.string().min(1).max(200),
  n8n_type: z.string().max(200).optional().nullable(),
  reason:   z.string().max(4000).optional().nullable(),
  context:  z.record(z.string(), z.any()).optional().nullable(),
}).strict()

export function createIntegrationRequestsRouter(deps: Deps): express.Router {
  const r = express.Router()
  const { supabase, requireAuth, identifyTenant } = deps

  r.post(
    '/api/integration-requests',
    express.json({ limit: '50kb' }),
    requireAuth, identifyTenant,
    async (req, res) => {
      const tenantId = (req as any).tenantId as string
      const userId   = (req as any).user?.id as string | undefined
      if (!userId) return apiError(res, 401, 'auth_required', 'auth.uid() missing')

      const parsed = BodySchema.safeParse(req.body)
      if (!parsed.success) {
        return apiError(res, 400, 'invalid_body', 'Invalid request body', parsed.error.issues)
      }

      const { app_name, n8n_type, reason, context } = parsed.data

      // 1. Insert row first — we'd rather have the record without an email
      // than the other way around.
      const { data: row, error } = await supabase
        .from('integration_requests')
        .insert({
          tenant_id:     tenantId,
          requested_by:  userId,
          app_name,
          n8n_type:      n8n_type ?? null,
          reason:        reason ?? null,
          context:       context ?? null,
        })
        .select('id, app_name, created_at')
        .single()
      if (error) {
        return apiError(res, 500, 'insert_failed', error.message)
      }

      // 2. Fire-and-forget email. Don't await — if Resend is slow or down
      // the user still gets a 200 immediately. Errors are logged but never
      // bubble back to the FE: the row is the source of truth.
      void notifyDeveloperTeam({ supabase, tenantId, userId, row, app_name, n8n_type, reason, context })

      return res.json({ ok: true, id: row.id })
    },
  )

  return r
}

// ── Email helper ─────────────────────────────────────────────────────────────

async function notifyDeveloperTeam(args: {
  supabase: SupabaseClient
  tenantId: string
  userId:   string
  row:      { id: string; app_name: string; created_at: string }
  app_name: string
  n8n_type?: string | null
  reason?:   string | null
  context?:  Record<string, unknown> | null
}): Promise<void> {
  try {
    if (!emailConfigured()) {
      console.warn('[integration-requests] Brevo not configured — row created but no email sent', args.row.id)
      return
    }

    const to    = process.env.DEVELOPER_NOTIFY_EMAIL || 'developers@frequency.app'
    const ccRaw = process.env.DEVELOPER_NOTIFY_CC                // optional; comma-separated

    // Best-effort tenant + user metadata for the email body. Failures here
    // are non-fatal — we still send the email with whatever we have.
    const [tenantRes, userRes] = await Promise.all([
      args.supabase.from('tenants').select('id, name, user_id').eq('id', args.tenantId).maybeSingle(),
      args.supabase.auth.admin.getUserById(args.userId).then(
        (r: any) => r,
        () => ({ data: { user: null } } as any),
      ),
    ])
    const tenant = (tenantRes as any)?.data ?? null
    const user   = (userRes  as any)?.data?.user ?? null

    const tenantLabel = (tenant as any)?.name ?? args.tenantId
    const userEmail   = (user as any)?.email ?? '(unknown)'
    const appBase     = (process.env.FRONTEND_URL ?? 'https://beta.getfrequency.app').replace(/\/$/, '')
    const dashLink    = `${appBase}/admin/integration-requests/${args.row.id}`

    const subject = `[Frequency] Integration request: ${args.app_name}`
    const lines = [
      `App requested: ${args.app_name}`,
      args.n8n_type ? `Source n8n type: ${args.n8n_type}` : null,
      `Tenant: ${tenantLabel} (${args.tenantId})`,
      `Requested by: ${userEmail} (${args.userId})`,
      args.reason ? `\nReason from user:\n${args.reason}` : null,
      args.context ? `\nContext:\n${JSON.stringify(args.context, null, 2)}` : null,
      `\nRequest id: ${args.row.id}`,
      `Created: ${args.row.created_at}`,
      `Super-admin link: ${dashLink}`,
    ].filter(Boolean).join('\n')

    const { html } = await renderEmail(IntegrationRequestAlert, {
      appName:     args.app_name,
      tenantLabel,
      tenantId:    args.tenantId,
      userEmail,
      n8nType:     args.n8n_type ?? null,
      reason:      args.reason ?? null,
      context:     args.context ?? null,
      createdAt:   args.row.created_at,
      dashLink,
    })

    const recipients: string[] = [to]
    if (ccRaw) for (const cc of ccRaw.split(',').map(s => s.trim()).filter(Boolean)) recipients.push(cc)

    await sendEmail({
      to: recipients,
      subject,
      html,
      text: lines,                 // keep the rich plain-text internal log (incl. ids)
      idempotency_key: `integration-request:${args.row.id}`,
    })
    console.log('[integration-requests] notified', to, 'about', args.app_name, args.row.id)
  } catch (e: any) {
    console.warn('[integration-requests] email failed (row already persisted):', e?.message ?? e)
  }
}
