/**
 * Slack connector — Incoming Webhook URL paste flow.
 *
 * Single endpoint:
 *   POST /api/connectors/slack/connect-webhook   { webhook_url }
 *     Validates URL shape, sends ONE verification message to prove the URL
 *     works, then stores it ENCRYPTED in tenant_integrations.refresh_token.
 *     Same shape as Razorpay's key_secret so the disconnect handler at
 *     POST /api/connectors/:key/disconnect works without channel-specific code.
 *
 * No runtime "test" endpoint by design. The verify-on-connect call IS the
 * test — a separate button:
 *   1. trains users to expect dev-mode controls in production,
 *   2. invites accidental spam of their own Slack channel,
 *   3. duplicates information that's already in notification_delivery_log
 *      (every real notification dispatch logs success/failure per channel,
 *      so a broken Slack integration surfaces on the next real event).
 * If a user wants to re-verify, disconnect + reconnect re-fires the
 * verification call — one click each, no extra surface area.
 *
 * Why webhook (not OAuth):
 *   Slack's Incoming Webhooks are designed for exactly this case — a
 *   per-channel notify URL. They need no Slack App marketplace approval +
 *   scope review (which OAuth would). The user goes to Slack →
 *   "Incoming Webhooks" → adds it to a channel → pastes the URL here.
 *
 * Storage shape (mirrors Razorpay api_key path):
 *   tenant_integrations.refresh_token  → encrypt(webhook_url)
 *   tenant_integrations.brand_label    → workspace hint (T-prefixed segment
 *                                         from the URL path)
 *   tenant_integrations.metadata       → { auth_mode: 'webhook_paste' }
 *
 * Notification dispatch reads via `lib/slack.ts:getTenantSlackWebhook` which
 * decrypts refresh_token. ONE codepath, no drift between connect + dispatch.
 */

import express from 'express'
import { z } from 'zod'
import { SupabaseClient } from '@supabase/supabase-js'
import { encrypt } from '../../crypto'
import { validateBody } from '../../validation'

type Middleware = (req: express.Request, res: express.Response, next: express.NextFunction) => void | Promise<void>
interface Deps {
  supabase: SupabaseClient
  requireAuth: Middleware
  identifyTenant: Middleware
  checkPermission: (feature: string, action: 'view' | 'edit' | 'delete') => Middleware
}

const SLACK_WEBHOOK_PREFIX = 'https://hooks.slack.com/'

const ConnectSchema = z.object({
  webhook_url: z.string().url().refine(
    u => u.startsWith(SLACK_WEBHOOK_PREFIX),
    { message: `Webhook URL must start with ${SLACK_WEBHOOK_PREFIX} (Slack → Incoming Webhooks → Add)` },
  ),
}).strict()

export function createSlackConnector(deps: Deps): express.Router {
  const r = express.Router()
  const { supabase, requireAuth, identifyTenant, checkPermission } = deps

  // ── Connect ─────────────────────────────────────────────────────────────
  r.post('/api/connectors/slack/connect-webhook',
    requireAuth, identifyTenant, checkPermission('integrations', 'edit'),
    validateBody(ConnectSchema),
    async (req, res) => {
      const tenantId = (req as any).tenantId
      // tenant_integrations.user_id is NOT NULL — without this the upsert
      // returns { error } (constraint violation) and the previous code path
      // ignored it, returning 200 with nothing persisted.
      const userId = (req as any).user?.id as string | undefined
      if (!userId) { res.status(401).json({ error: 'auth missing user.id' }); return }
      const { webhook_url } = req.body as z.infer<typeof ConnectSchema>

      // 1. Verify with a real Slack call BEFORE persisting. Sends a test
      // message that the user will see in their channel — instant signal
      // that the URL is correct + the channel is the one they expected.
      // If Slack returns 4xx (bad URL, deactivated webhook, channel missing),
      // we never write to the DB.
      try {
        const verify = await fetch(webhook_url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            text: '✓ Frequency connected to this channel. Notifications you opt into via Settings → Notifications will land here.',
          }),
        })
        if (!verify.ok) {
          const detail = await verify.text().catch(() => '')
          res.status(400).json({
            error: detail.includes('no_service')
              ? 'This Slack webhook is deactivated. Re-create it in Slack → Apps → Incoming Webhooks.'
              : detail.includes('invalid_payload')
                ? 'Slack rejected the test payload (this should never happen — file a bug).'
                : `Slack returned ${verify.status}: ${detail.slice(0, 200) || 'unknown error'}`,
          })
          return
        }
      } catch (err: any) {
        res.status(502).json({ error: `Couldn't reach Slack: ${err?.message ?? err}` })
        return
      }

      // 2. Test passed → persist. brand_label tries to extract the workspace
      // hint from the URL path so the AppsModal "Connected" line shows
      // something more informative than "Webhook" (Slack URLs look like
      // hooks.slack.com/services/T01ABC/B02DEF/abc123 — the T-prefixed
      // segment is the workspace id).
      const workspaceHint = webhook_url.split('/').find(s => /^T[A-Z0-9]{6,}$/.test(s)) ?? 'Webhook'

      const { error: upsertErr } = await supabase.from('tenant_integrations').upsert({
        tenant_id:     tenantId,
        user_id:       userId,
        key:           'slack',
        status:        'active',
        scope:         'incoming_webhook',
        brand_label:   workspaceHint,
        // refresh_token holds the encrypted webhook URL — same column as
        // Razorpay's key_secret, so the generic disconnect handler at
        // POST /api/connectors/:key/disconnect already works without changes.
        access_token:  null as any,
        refresh_token: encrypt(webhook_url),
        metadata:      { auth_mode: 'webhook_paste' },
      }, { onConflict: 'tenant_id,key' })
      if (upsertErr) {
        console.error(`[slack connect] DB upsert failed: ${upsertErr.message}`)
        res.status(500).json({ error: 'Failed to persist connection: ' + upsertErr.message }); return
      }

      res.json({ success: true, workspace_hint: workspaceHint })
    })

  return r
}
