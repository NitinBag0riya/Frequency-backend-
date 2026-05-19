/**
 * Zod request-body validation. One helper, one schema per critical route.
 *
 * Apply with:  app.post('/api/x', requireAuth, validateBody(MySchema), handler)
 *
 * On validation failure: 400 with { error, issues } so the FE can show the
 * exact field that's wrong instead of a generic "Bad Request".
 *
 * ─── SECURITY CONTRACT — read before changing this file ──────────────────
 *
 * After validateBody runs, `req.body` is REPLACED with the parsed Zod result.
 * Downstream handlers can safely do `update({ ...req.body, … })` because
 * the spread will only include fields the schema permitted:
 *
 *   - .strict()      → unknown keys threw 400 already, body has only known fields
 *   - default (strip)→ unknown keys silently dropped, body has only known fields
 *   - .passthrough() → unknown keys ARE preserved (use only on inner blob fields)
 *
 * If you remove or weaken the `req.body = result.data` line below, every
 * PATCH handler in the codebase that spreads req.body becomes a tenant-write
 * vulnerability — a client could sneak `tenant_id`/`user_id`/`id` past
 * validation by sending them alongside legitimate fields. The .eq('tenant_id')
 * filter on UPDATE only restricts WHICH row is targeted, not what gets
 * written.
 *
 * Don't add a separate `req.parsed` alongside — single source of truth
 * minimises drift. If you need typed access in a handler, cast at the
 * use site: `const patch = req.body as z.infer<typeof MySchema>`.
 */

import express from 'express'
import { z, ZodSchema } from 'zod'

export function validateBody<T extends ZodSchema>(schema: T) {
  return (req: express.Request, res: express.Response, next: express.NextFunction) => {
    const result = schema.safeParse(req.body)
    if (!result.success) {
      res.status(400).json({
        error: 'Validation failed',
        issues: result.error.issues.map((i: any) => ({
          path: Array.isArray(i.path) ? i.path.join('.') : String(i.path),
          message: i.message,
        })),
      })
      return
    }
    // Replace req.body with the parsed (and stripped) value so handlers don't
    // accidentally trust unknown fields. See the security contract above.
    req.body = result.data
    next()
  }
}

// ── Schemas ──────────────────────────────────────────────────────────────────

// SECURITY: every Patch/Create schema below uses an explicit allow-list of
// known fields and DOES NOT use `.passthrough()` on the outer envelope.
// `.passthrough()` was previously letting clients sneak `tenant_id`,
// `user_id`, `id`, `created_at` etc. into the spread `update({ ...req.body })`
// — the .eq('tenant_id', ...) filter on UPDATE only restricts the *target*
// row, so unknown fields would have re-tenanted the row, leaking it.
// `.passthrough()` is still allowed on inner JSON-blob fields where forward
// compat with payloads matters (config / audience / interactive).
//
// Note on `__proto__` pollution: Zod's `.strict()` SILENTLY STRIPS the
// `__proto__` key during parse (it doesn't error like other unknown keys).
// That's still safe for our use case because (a) we spread the parsed
// output, not req.body, and (b) Object.prototype is frozen at boot in
// src/index.ts. Don't rely on `.strict()` alone to defeat pollution.
//
// Add new fields here when the FE needs them — fail closed by design.

export const WorkflowCreateSchema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(2000).optional().nullable(),
  status: z.enum(['draft', 'live', 'paused', 'archived']).optional(),
  // Nodes JSON shape comes from the parser — accept any object for the
  // inner array. Still strict on the outer envelope.
  nodes: z.array(z.any()).optional(),
  blueprint: z.any().optional(),
  intent_text: z.string().optional().nullable(),
  integrations: z.array(z.string()).optional(),
  trigger_type: z.string().optional().nullable(),
  // Workflow chaining — when set, this workflow auto-runs every time the
  // referenced upstream workflow completes a session. Cycle prevention
  // happens server-side in the create/patch handlers.
  triggered_by_workflow_id: z.string().uuid().optional().nullable(),
}).strict()

// IMPORTANT: `.partial()` returns a NEW ZodObject whose unknownKeys policy
// resets to default (`strip`). It does NOT inherit `.strict()` from the
// base — caller must re-apply, otherwise unknown keys silently strip but
// the *route handler* still spreads `req.body` (not the parsed result),
// so unknown keys land in the UPDATE anyway. Re-strict() makes Zod
// reject them at validation, before the handler runs.
export const WorkflowPatchSchema = WorkflowCreateSchema.partial().strict()

export const BroadcastCreateSchema = z.object({
  name: z.string().min(1).max(200),
  template_name: z.string().min(1).max(2000).optional().nullable(),
  template_id: z.string().uuid().optional().nullable(),
  language: z.string().max(20).optional(),
  // P0.8 — Telegram parity. The DB CHECK constraint (migration 016) is the
  // authoritative whitelist; this enum keeps the API response cleaner than
  // a generic 500 on bad channel values. Default 'whatsapp' to preserve
  // legacy clients that POST without `channel`.
  channel: z.enum(['whatsapp', 'instagram', 'telegram', 'email', 'sms']).optional(),
  audience: z.object({
    tags:         z.array(z.string()).optional(),
    exclude_tags: z.array(z.string()).optional(),
  }).passthrough().optional(),
  // P1 #18 — optional saved-segment target. When present, broadcast-worker
  // resolves the audience via lib/segment-filter.ts instead of the legacy
  // audience.tags shape. Both can coexist on a broadcast row; segment_id
  // wins if both are set. The server validates the segment is in the
  // caller's tenant before linking.
  segment_id:   z.string().uuid().optional().nullable(),
  variable_map: z.record(z.string(), z.string()).optional(),
  scheduled_at: z.string().datetime().optional().nullable(),
  status: z.enum(['draft', 'scheduled', 'sending', 'sent', 'failed']).optional(),
  // FE seeds zero-valued stats on create — accepted but server overrides
  // anyway since stats track real delivery state. The DB also defaults to
  // zero, so a client sending these is harmless.
  stats: z.record(z.string(), z.number()).optional(),
}).strict()

export const ContactCreateSchema = z.object({
  name: z.string().min(1).max(200),
  phone: z.string().min(6).max(20),
  email: z.string().email().optional().nullable(),
  tags: z.array(z.string()).optional(),
  attributes: z.record(z.string(), z.any()).optional(),
  status: z.enum(['active', 'opted_out', 'blocked']).optional(),
  // bot_paused is editable from ContactModal (the inline checkbox) AND from
  // the dedicated /api/contacts/:id/bot-pause PATCH. Both paths must accept it.
  bot_paused: z.boolean().optional(),
}).strict()

// See WorkflowPatchSchema note re: .partial().strict() pattern.
export const ContactPatchSchema = ContactCreateSchema.partial().strict()

export const RazorpayConnectSchema = z.object({
  key_id: z.string().regex(/^rzp_(live|test)_/, 'Must start with rzp_live_ or rzp_test_'),
  key_secret: z.string().min(8),
})

// Inbox accepts a channel-aware shape supporting text / media / template /
// interactive replies across WhatsApp, Instagram, Telegram.
export const InboxSendSchema = z.object({
  channel:           z.enum(['whatsapp', 'instagram', 'telegram']).default('whatsapp'),
  phone:             z.string().min(1),
  type:              z.enum(['text', 'template', 'media', 'interactive']),
  // text
  text:              z.string().max(4096).optional(),
  // template (WhatsApp only)
  template_name:     z.string().optional(),
  template_language: z.string().optional(),
  template_params:   z.array(z.string()).optional(),
  // media
  media_kind:        z.enum(['image', 'video', 'audio', 'document']).optional(),
  media_url:         z.string().url().optional(),
  caption:           z.string().max(1024).optional().nullable(),
  filename:          z.string().max(255).optional(),
  // interactive
  interactive:       z.object({}).passthrough().optional(),
}).refine(
  (v) => {
    if (v.type === 'text')        return !!v.text
    if (v.type === 'template')    return !!v.template_name
    if (v.type === 'media')       return !!v.media_kind && !!v.media_url
    if (v.type === 'interactive') return !!v.interactive
    return false
  },
  { message: 'Missing required fields for the specified message type' }
).refine(
  (v) => v.type !== 'template' || v.channel === 'whatsapp',
  { message: 'Templates are only supported on WhatsApp' }
)

export const TeamInviteSchema = z.object({
  email: z.string().email(),
  role:  z.enum(['admin', 'agent', 'viewer']),
})

export const CampaignCreateSchema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(2000).optional().nullable(),
  type: z.enum(['drip', 'one_time', 'triggered']),
  status: z.enum(['draft', 'active', 'paused', 'completed']).optional(),
  audience: z.object({}).passthrough().optional(),
  message_count: z.number().int().nonnegative().optional(),
  // FE seeds zero-valued stats. Server-side, real values come from the
  // workers as enrolment + delivery proceed. Accepted but harmless either way.
  stats: z.record(z.string(), z.number()).optional(),
}).strict()

// Campaigns PATCH was not previously schema-validated at all (the route just
// spread req.body into update). Mirror the create shape, optional-ised.
// See WorkflowPatchSchema note re: .partial().strict() — must re-strict.
export const CampaignPatchSchema = CampaignCreateSchema.partial().strict()

// ── WhatsApp Business Calling schemas ───────────────────────────────────────
//
// All envelopes .strict() — unknown keys throw 400 so a client can't sneak
// `tenant_id`, `agent_id` (when the route resolves it itself), `id`, etc.
// past validation into a downstream spread. See the SECURITY CONTRACT at
// the top of this file.
//
// Shape matches 01-backend-design.md §3 verbatim.

export const CallIntentSchema = z.object({
  contact_id:           z.string().uuid(),
  consent_choice:       z.enum(['record_transcribe', 'record_only', 'none']),
  source:               z.enum(['inbox', 'contacts', 'leads']),
  remember_for_session: z.boolean().optional().default(false),
  // Only meaningful when source='leads' — server promotes the lead → contact
  // before opening the call, defense-in-depth even if FE forgot.
  lead_id:              z.string().uuid().optional().nullable(),
}).strict()

export const CallInitiateSchema = z.object({
  intent_id: z.string().uuid(),
  // Server defaults to req.user.id; only platform_owner / workspace_admin
  // can hand a call to a different agent_id at initiate time.
  agent_id:  z.string().uuid().optional(),
  // sales_manager+ override of contacts.do_not_call. Server enforces the
  // role gate; this is just the FE telling us the agent confirmed.
  override_dnc: z.boolean().optional(),
}).strict()

export const CallRoutingRulesSchema = z.object({
  business_hours_json: z.record(
    z.enum(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']),
    z.object({
      open:    z.string().regex(/^\d{2}:\d{2}$/),
      close:   z.string().regex(/^\d{2}:\d{2}$/),
      enabled: z.boolean(),
    })
  ),
  agent_pool:           z.array(z.string().uuid()).min(0).max(200),
  ring_strategy:        z.enum(['parallel', 'round_robin']).default('parallel'),
  ring_timeout_seconds: z.number().int().min(10).max(60).default(30),
  fallback:             z.enum(['voicemail', 'missed_template', 'none']).default('missed_template'),
  fallback_template_name: z.string().optional().nullable(),
}).strict()

export const ConsentDefaultSchema = z.object({
  value: z.enum(['always_ask', 'always_on', 'always_off']),
}).strict()

// Agent-initiated hangup. Reason free-form, capped so a runaway client can't
// stuff multi-MB strings into the audit row.
export const CallEndSchema = z.object({
  reason: z.string().max(500).optional(),
}).strict()

// Explicit lead → contact promotion endpoint. The body is empty in practice;
// we accept and ignore an optional preserve_tags flag for future-compat.
export const PromoteToContactSchema = z.object({
  preserve_tags: z.boolean().optional(),
}).strict()

// ── Mobile push device registration (P0.10) ─────────────────────────────────
//
// Mobile (mobile/src/lib/push.ts) POSTs this shape to /api/devices/register
// after sign-in. Token format matches Expo's published spec:
//   ExponentPushToken[base64url-ish chars]
// We validate strictly at the route boundary so a malformed token never
// hits the Expo push service (which would 400 every batch it lands in).
//
// `web` is in the platform enum for future PWA support — mobile only ever
// sends 'ios' or 'android' today.
export const DeviceRegisterSchema = z.object({
  expo_push_token: z.string()
    .regex(/^ExponentPushToken\[[A-Za-z0-9_-]+\]$/, 'Invalid Expo push token format')
    .max(200),
  platform:        z.enum(['ios', 'android', 'web']),
  app_version:     z.string().max(40).optional(),
  device_label:    z.string().max(120).optional(),
}).strict()

