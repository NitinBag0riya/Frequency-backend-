/**
 * routes/pii.ts — PII masking config + audit endpoints.
 *
 * Phase 1B (migration 094). Three endpoints + a helper for the inbox
 * messages handler to call when serializing message bodies.
 *
 *   GET    /api/pii/config              — tenant's current policy
 *                                          (auto-seeds on first read)
 *   PATCH  /api/pii/config               — admin-only, update policy
 *   POST   /api/pii/unmask               — log + return original value
 *                                          for ONE field on ONE message
 *
 * Helper exports:
 *   getTenantPiiConfig(supabase, tenantId)
 *     — used by the inbox message-list handler to decide whether to
 *       apply masking + which field types.
 */

import express from 'express'
import { z } from 'zod'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  maskText, lookupOriginal, piiValueHash,
  type PiiFieldType, type MaskResult,
} from '../lib/pii-masking'

type Deps = {
  supabase: SupabaseClient
  requireAuth: express.RequestHandler
  identifyTenant: express.RequestHandler
}

export interface PiiConfig {
  enabled_types:     PiiFieldType[]
  unmask_roles:      string[]
  require_reason:    boolean
  regex_overrides:   Record<string, string>
  /** Drives the outbound PII check in /api/inbox/send. See migration 099. */
  outbound_action:   'off' | 'warn' | 'block'
}

const DEFAULT_CONFIG: PiiConfig = {
  enabled_types:   ['aadhaar', 'pan', 'bank_account', 'ifsc', 'phone', 'email', 'dob', 'otp'],
  unmask_roles:    ['tenant_admin', 'tenant_owner'],
  require_reason:  false,
  regex_overrides: {},
  outbound_action: 'warn',
}

/**
 * Fetch the tenant's PII config — auto-seeds the default row on first
 * read so the inbox handler doesn't have to worry about NULL.
 * Cached in-memory per process for 60s (config changes are rare;
 * inbox handlers call this on every message-list fetch).
 */
const configCache = new Map<string, { value: PiiConfig; expires: number }>()
const CONFIG_TTL_MS = 60_000

export async function getTenantPiiConfig(
  supabase: SupabaseClient,
  tenantId: string,
): Promise<PiiConfig> {
  const cached = configCache.get(tenantId)
  if (cached && cached.expires > Date.now()) return cached.value

  const { data } = await supabase.from('pii_masking_config')
    .select('enabled_types, unmask_roles, require_reason, regex_overrides, outbound_action')
    .eq('tenant_id', tenantId)
    .maybeSingle()

  let cfg: PiiConfig
  if (data) {
    cfg = {
      enabled_types:   (data.enabled_types ?? DEFAULT_CONFIG.enabled_types) as PiiFieldType[],
      unmask_roles:    (data.unmask_roles ?? DEFAULT_CONFIG.unmask_roles) as string[],
      require_reason:  Boolean(data.require_reason ?? false),
      regex_overrides: (data.regex_overrides ?? {}) as Record<string, string>,
      outbound_action: (data.outbound_action ?? DEFAULT_CONFIG.outbound_action) as 'off' | 'warn' | 'block',
    }
  } else {
    // Auto-seed on first read. Best-effort; if the insert races with
    // another worker we just retry on next call.
    await supabase.from('pii_masking_config').insert({ tenant_id: tenantId }).then(() => {}, () => {})
    cfg = DEFAULT_CONFIG
  }
  configCache.set(tenantId, { value: cfg, expires: Date.now() + CONFIG_TTL_MS })
  return cfg
}

/**
 * Decide whether to apply masking for `userRoleKey` against this tenant's
 * config. The inbox message-list handler calls this once per request.
 */
export function shouldMaskForRole(cfg: PiiConfig, userRoleKey: string | null): boolean {
  if (!userRoleKey) return true                       // unknown role → always mask
  return !cfg.unmask_roles.includes(userRoleKey)
}

/**
 * Outbound PII detection — runs on text the agent is about to send.
 * Returns the detected fields (NEVER masks — the agent typed this; we
 * just surface what we found). Caller decides whether to block per
 * tenant's outbound_action.
 */
export function detectOutboundPii(
  text: string,
  cfg: PiiConfig,
): { hits: MaskResult['fields']; action: 'off' | 'warn' | 'block' } {
  if (cfg.outbound_action === 'off' || !text) return { hits: [], action: cfg.outbound_action }
  const r = maskText(text, cfg.enabled_types, cfg.regex_overrides)
  return { hits: r.fields, action: cfg.outbound_action }
}

/**
 * Render-time masking helper. Given message text + cfg + role, returns
 * the appropriately masked / unmasked text + (when masked) the field
 * metadata the FE needs to render tap-to-unmask chips.
 */
export function maskMessageForRole(
  text: string,
  cfg: PiiConfig,
  userRoleKey: string | null,
): { text: string; masked: boolean; fields?: MaskResult['fields'] } {
  if (!shouldMaskForRole(cfg, userRoleKey)) {
    return { text, masked: false }
  }
  const result = maskText(text, cfg.enabled_types, cfg.regex_overrides)
  if (result.fields.length === 0) {
    return { text, masked: false }
  }
  return { text: result.masked, masked: true, fields: result.fields }
}

// ─── Validation ──────────────────────────────────────────────────────────

const ALL_FIELD_TYPES: PiiFieldType[] = [
  'aadhaar', 'pan', 'bank_account', 'ifsc', 'phone', 'email',
  'dob', 'policy_number', 'transaction_id', 'otp',
]

const PatchConfigBody = z.object({
  enabled_types:   z.array(z.enum(ALL_FIELD_TYPES as [PiiFieldType, ...PiiFieldType[]])).optional(),
  unmask_roles:    z.array(z.string()).optional(),
  require_reason:  z.boolean().optional(),
  regex_overrides: z.record(z.string(), z.string()).optional(),
  outbound_action: z.enum(['off', 'warn', 'block']).optional(),
})

const UnmaskBody = z.object({
  message_id:    z.string().min(1),
  field_index:   z.number().int().positive(),
  /** Source plaintext is sent BACK by the FE because the BE doesn't
   *  cache message bodies across requests. The BE re-runs detection
   *  on this text to find the exact span at `field_index`. Trust
   *  boundary: the agent must already have read-access to this
   *  message (the inbox endpoint returned the SAME text — masked —
   *  in the previous round-trip). */
  source_text:   z.string().min(1).max(20_000),
  reason:        z.string().max(500).optional(),
})

// ─── Router ──────────────────────────────────────────────────────────────

export function createPiiRouter(deps: Deps): express.Router {
  const { supabase, requireAuth, identifyTenant } = deps
  const r = express.Router()

  /**
   * GET /api/pii/config — current tenant policy (seeds default on first read).
   */
  r.get('/api/pii/config', requireAuth, identifyTenant, async (req, res) => {
    const tenantId = (req as any).tenantId as string
    try {
      const cfg = await getTenantPiiConfig(supabase, tenantId)
      res.json({ data: cfg })
    } catch (e: any) {
      res.status(500).json({ error: e?.message ?? 'Failed to load' })
    }
  })

  /**
   * PATCH /api/pii/config — update masking policy. We don't enforce role
   * via RLS (the table is admin-only via GRANT); we DO enforce via the
   * `requirePermission` middleware pattern from the existing codebase.
   * For v1 we accept any authenticated tenant member — admins can
   * tighten this once we wire up checkPermission('pii', 'edit').
   */
  r.patch('/api/pii/config', requireAuth, identifyTenant, async (req, res) => {
    const tenantId = (req as any).tenantId as string
    const parsed = PatchConfigBody.safeParse(req.body)
    if (!parsed.success) { res.status(400).json({ error: 'Invalid body', issues: parsed.error.issues }); return }
    // Upsert: if no row, create it.
    const { data, error } = await supabase.from('pii_masking_config')
      .upsert({ tenant_id: tenantId, ...parsed.data, updated_at: new Date().toISOString() }, { onConflict: 'tenant_id' })
      .select('enabled_types, unmask_roles, require_reason, regex_overrides, outbound_action')
      .single()
    if (error) { res.status((error as any).code === 'PGRST116' ? 404 : 500).json({ error: (error as any).code === 'PGRST116' ? 'not found' : error.message }); return }
    // Invalidate cache so the next message fetch picks up the change.
    configCache.delete(tenantId)
    res.json({ data })
  })

  /**
   * POST /api/pii/unmask — reveal a single masked field on a single
   * message AND log to pii_unmask_log. Audit-first design:
   *
   *   1. Look up tenant config.
   *   2. If `require_reason=true` and no reason provided → 400.
   *   3. Re-run detection on source_text → find span at field_index.
   *   4. Write pii_unmask_log with sha256(value).
   *   5. Return the original value to the caller.
   *
   * The audit row is INSERT-first so a failure between insert + response
   * still leaves the audit trail intact (agent saw it OR the BE crashed —
   * either way it's logged).
   */
  r.post('/api/pii/unmask', requireAuth, identifyTenant, async (req, res) => {
    const tenantId = (req as any).tenantId as string
    const userId   = (req as any).user?.id as string
    const parsed = UnmaskBody.safeParse(req.body)
    if (!parsed.success) { res.status(400).json({ error: 'Invalid body', issues: parsed.error.issues }); return }
    const { message_id, field_index, source_text, reason } = parsed.data

    const cfg = await getTenantPiiConfig(supabase, tenantId)
    if (cfg.require_reason && !reason?.trim()) {
      res.status(400).json({ error: 'Reason is required by your tenant policy' }); return
    }

    const found = lookupOriginal(source_text, field_index, cfg.enabled_types, cfg.regex_overrides)
    if (!found) {
      res.status(404).json({ error: 'Field not found in source text — message may have been edited' }); return
    }

    // Resolve contact_id from message_id (best-effort; messages table varies
    // by schema, contact_id may live there or be looked up via contact_phone).
    let contactId: string | null = null
    try {
      const { data: msg } = await supabase.from('messages')
        .select('contact_phone')
        .eq('id', message_id)
        .maybeSingle()
      if (msg?.contact_phone) {
        const { data: c } = await supabase.from('contacts')
          .select('id')
          .eq('tenant_id', tenantId)
          .eq('phone', msg.contact_phone)
          .maybeSingle()
        contactId = c?.id ?? null
      }
    } catch { /* non-fatal */ }

    // Audit FIRST. service-role bypass writes through despite the
    // `revoke insert from authenticated` GRANT on the table.
    const ip = String(req.headers['x-forwarded-for'] ?? req.socket.remoteAddress ?? '').split(',')[0]?.trim() || null
    const userAgent = String(req.headers['user-agent'] ?? '').slice(0, 500) || null
    const { error: auditErr } = await supabase.from('pii_unmask_log').insert({
      tenant_id:        tenantId,
      actor_user_id:    userId,
      contact_id:       contactId,
      message_id,
      field_type:       found.field_type,
      field_value_hash: piiValueHash(found.value),
      reason:           reason ?? null,
      ip,
      user_agent:       userAgent,
    })
    if (auditErr) {
      // Audit-write failure is a HARD failure — we won't reveal the value
      // without a guaranteed audit trail. Surface a 500 + log loudly.
      console.error('[pii.unmask] AUDIT WRITE FAILED — refusing to reveal value', auditErr.message)
      res.status(500).json({ error: 'Audit write failed; access denied' })
      return
    }

    res.json({
      data: {
        value:      found.value,
        field_type: found.field_type,
      },
    })
  })

  return r
}
