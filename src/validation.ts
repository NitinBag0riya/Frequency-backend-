/**
 * Zod request-body validation. One helper, one schema per critical route.
 *
 * Apply with:  app.post('/api/x', requireAuth, validateBody(MySchema), handler)
 *
 * On validation failure: 400 with { error, issues } so the FE can show the
 * exact field that's wrong instead of a generic "Bad Request".
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
    // accidentally trust unknown fields.
    req.body = result.data
    next()
  }
}

// ── Schemas ──────────────────────────────────────────────────────────────────

export const WorkflowCreateSchema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(2000).optional().nullable(),
  status: z.enum(['draft', 'live', 'paused', 'archived']).optional(),
  // Nodes JSON shape comes from Claude — accept any object for now (parser
  // already shapes it). Just guard the outer envelope.
  nodes: z.array(z.any()).optional(),
  trigger_type: z.string().optional().nullable(),
}).passthrough()  // keep forward-compat fields like config_completion_percent

export const WorkflowPatchSchema = WorkflowCreateSchema.partial()

export const BroadcastCreateSchema = z.object({
  name: z.string().min(1).max(200),
  template_name: z.string().min(1).max(200).optional().nullable(),
  template_id: z.string().uuid().optional().nullable(),
  language: z.string().max(20).optional(),
  audience: z.object({
    tags:         z.array(z.string()).optional(),
    exclude_tags: z.array(z.string()).optional(),
  }).passthrough().optional(),
  variable_map: z.record(z.string(), z.string()).optional(),
  scheduled_at: z.string().datetime().optional().nullable(),
  status: z.enum(['draft', 'scheduled', 'sending', 'sent', 'failed']).optional(),
}).passthrough()

export const ContactCreateSchema = z.object({
  name: z.string().min(1).max(200),
  phone: z.string().min(6).max(20),
  email: z.string().email().optional().nullable(),
  tags: z.array(z.string()).optional(),
  attributes: z.record(z.string(), z.any()).optional(),
  status: z.enum(['active', 'opted_out', 'blocked']).optional(),
}).passthrough()

export const ContactPatchSchema = ContactCreateSchema.partial()

export const RazorpayConnectSchema = z.object({
  key_id: z.string().regex(/^rzp_(live|test)_/, 'Must start with rzp_live_ or rzp_test_'),
  key_secret: z.string().min(8),
})

// Inbox accepts the legacy FE shape: { phone, type, text|template_name }
export const InboxSendSchema = z.object({
  phone:             z.string().min(6),
  type:              z.enum(['text', 'template']),
  text:              z.string().max(4096).optional(),
  template_name:     z.string().optional(),
  template_language: z.string().optional(),
  template_params:   z.array(z.string()).optional(),
}).refine(
  (v) => (v.type === 'text' ? !!v.text : !!v.template_name),
  { message: 'text required for type=text; template_name required for type=template' }
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
}).passthrough()
