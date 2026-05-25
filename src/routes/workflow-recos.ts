/**
 * Workflow recommendations engine + endpoints.
 *
 *   GET  /api/workflow-recommendations?apps=razorpay,whatsapp
 *
 *   Returns cached recommendations for the given app combination. If no
 *   tenant-specific or system default exists yet, generates them once via AI
 *   and caches in `workflow_recommendations` (tenant_id NULL = system default,
 *   shared across all tenants asking for the same combo).
 *
 *   POST /api/workflow-recommendations/:id/customize
 *
 *   Saves a tenant-specific edited copy of a default. Lets users tweak a
 *   recommendation without losing the original.
 *
 * Cache strategy: deterministic key = sorted comma-joined app keys. First
 * tenant to ask triggers AI generation; every subsequent request — including
 * other tenants — hits the cache.
 */

import express from 'express'
import { SupabaseClient } from '@supabase/supabase-js'
import Anthropic from '@anthropic-ai/sdk'

type Middleware = (req: express.Request, res: express.Response, next: express.NextFunction) => void | Promise<void>

interface Deps {
  supabase: SupabaseClient
  requireAuth: Middleware
  identifyTenant: Middleware
}

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY ?? '' })

function appsSignature(apps: string[]): string {
  return [...new Set(apps)].sort().join(',')
}

export function createWorkflowRecosRouter(deps: Deps): express.Router {
  const r = express.Router()
  const { supabase, requireAuth, identifyTenant } = deps

  r.get('/api/workflow-recommendations', requireAuth, identifyTenant, async (req, res) => {
    const tenantId = (req as any).tenantId
    const apps = String(req.query.apps ?? '').split(',').map(s => s.trim()).filter(Boolean)
    if (apps.length === 0) { res.status(400).json({ error: 'apps query param required (comma-sep)' }); return }
    const sig = appsSignature(apps)

    // 1. Check cache — system defaults + tenant overrides for this combo
    const { data: cached } = await supabase.from('workflow_recommendations')
      .select('*')
      .eq('apps_signature', sig)
      .eq('is_active', true)
      .or(`tenant_id.is.null,tenant_id.eq.${tenantId}`)
      .order('use_count', { ascending: false })
    if (cached && cached.length > 0) {
      res.json({ source: 'cache', recommendations: cached })
      return
    }

    // 2. Cache miss → generate via AI, then cache as system default
    if (!process.env.ANTHROPIC_API_KEY) {
      res.json({ source: 'no-cache', recommendations: [], note: 'AI not configured; no recommendations generated.' })
      return
    }

    // Per-tenant plan-limit gates BEFORE the AI call (see /api/parse-workflow
    // for rationale on dual gating).
    {
      const { blockIfOverLimit } = await import('../lib/limits')
      if (await blockIfOverLimit(res, supabase, tenantId, 'ai_tokens_per_month'))   return
      if (await blockIfOverLimit(res, supabase, tenantId, 'ai_dollars_per_month'))  return
    }

    try {
      // Split prompt into stable system + dynamic user. The system part is
      // identical across all recommendation calls — wrapping it in a
      // cache_control block lets Anthropic reuse the prefix at ~90% off
      // input cost on subsequent calls within the 5-minute cache TTL.
      // First call seeds (25% premium); next 5min of calls hit the cache.
      // Net effect on a steady stream: 50-70% cheaper input tokens.
      const SYSTEM_PROMPT = `You recommend automation workflow templates for an Indian SMB SaaS (Frequency).

For the user's connected apps, return up to 4 high-leverage workflow templates that combine them. For each, output JSON with:
  - name (short, action-oriented)
  - description (1 sentence, what it does)
  - category (one of: lead_capture, payment, reminder, onboarding, support, marketing)
  - blueprint: an array of nodes, each with { type, label, config }
    - First node should be a trigger (e.g. type: 'inbox_message', 'lead_added', 'webhook')
    - Subsequent nodes use one of the connected apps' actions

TOKEN GRAMMAR — the workflow executor resolves {{...}} placeholders against this exact namespace:
  • {{trigger.text}}          — inbound message text (keyword / IG comment / IG mention text)
  • {{trigger.<payload_key>}} — any field on the trigger payload (e.g. {{trigger.story_id}}, {{trigger.comment_id}}, {{trigger.order_id}} for shopify webhooks, {{trigger.email_from}} for gmail-triggered)
  • {{contact.name}}          — contact's display name (empty string if unknown)
  • {{contact.phone}}         — E.164 phone with leading +
  • {{contact.tags}}          — array of tag strings
  • {{contact.<attribute>}}   — any tenant-set custom attribute on contacts.attributes (e.g. {{contact.budget}}, {{contact.city}})
  • {{<step_output_var>}}     — variables set by previous nodes via response_variable (e.g. {{ai_reply}}, {{collected_email}}, {{http_response}})

DO NOT use {{conversation.*}}, {{user.*}}, {{tenant.*}} — those namespaces don't exist. Missing tokens render as the literal {{x.y}} string in the sent message (a visible bug), so only reference fields you've explicitly seeded.

Output STRICT JSON: { "recommendations": [...] }. No markdown, no commentary.`

      const userPrompt = `Connected apps: ${apps.join(', ')}`

      const completion = await anthropic.messages.create({
        model: 'claude-sonnet-4-6',
        max_tokens: 2000,
        system: [
          { type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } },
        ] as any,
        messages: [{ role: 'user', content: userPrompt }],
      })
      // Per-tenant token + cost accounting (lib/ai-usage.ts). Fire-and-forget
      // so a counter-table hiccup never blocks recommendations.
      void import('../lib/ai-usage').then(({ recordAiUsage }) =>
        recordAiUsage(supabase, tenantId, completion.usage as any, 'workflow_recos', 'claude-sonnet-4-6'))
      const text = completion.content.find(c => c.type === 'text')?.text ?? '{}'
      const cleaned = text.replace(/^```json\s*|\s*```$/g, '')
      const parsed = JSON.parse(cleaned)
      const recos: any[] = parsed.recommendations ?? []

      // Cache as system defaults (tenant_id NULL)
      if (recos.length > 0) {
        const inserts = recos.map(r => ({
          tenant_id: null,
          apps_signature: sig,
          name: r.name,
          description: r.description ?? null,
          category: r.category ?? 'other',
          blueprint: r,
          generated_by_ai: true,
        }))
        const { data: created } = await supabase.from('workflow_recommendations')
          .upsert(inserts, { onConflict: 'apps_signature,name' as any })
          .select()
        res.json({ source: 'ai', recommendations: created ?? recos })
        return
      }
      res.json({ source: 'ai', recommendations: [] })
    } catch (err: any) {
      console.error('[workflow-recos] AI error:', err.message)
      res.status(500).json({ error: 'Recommendation generation failed', detail: err.message })
    }
  })

  // Tenant-specific customization — saves a tenant copy of a default
  r.post('/api/workflow-recommendations/:id/customize', requireAuth, identifyTenant, async (req, res) => {
    const tenantId = (req as any).tenantId
    const id = String(req.params.id)
    const { blueprint, name } = req.body
    const { data: original } = await supabase.from('workflow_recommendations')
      .select('*').eq('id', id).maybeSingle()
    if (!original) { res.status(404).json({ error: 'Original not found' }); return }
    const { data, error } = await supabase.from('workflow_recommendations').insert({
      tenant_id: tenantId,
      apps_signature: original.apps_signature,
      name: name ?? `${original.name} (custom)`,
      description: original.description,
      category: original.category,
      blueprint: blueprint ?? original.blueprint,
      generated_by_ai: false,
    }).select().single()
    if (error) { res.status((error as any).code === 'PGRST116' ? 404 : 500).json({ error: (error as any).code === 'PGRST116' ? 'not found' : error.message }); return }
    res.json(data)
  })

  // Bump use_count when a recommendation is actually used
  r.post('/api/workflow-recommendations/:id/used', requireAuth, identifyTenant, async (req, res) => {
    const id = String(req.params.id)
    await supabase.rpc('increment_reco_use_count', { reco_id: id }).then(() => {}, () => {
      // Fallback if RPC missing
      return supabase.from('workflow_recommendations').select('use_count').eq('id', id).maybeSingle()
        .then(({ data }) => data && supabase.from('workflow_recommendations').update({ use_count: (data.use_count ?? 0) + 1 }).eq('id', id))
    })
    res.json({ success: true })
  })

  return r
}
