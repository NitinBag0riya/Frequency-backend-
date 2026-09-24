/**
 * Merchant support intake — POST /api/support/ticket.
 *
 * A merchant hits "Raise a ticket" in the Copilot; the ticket lands in the
 * right Slack channel with enough context that whoever picks it up doesn't
 * have to ask "which workspace? which outlet? what plan?" before they can help.
 *
 * The one rule that shapes this file: the CLIENT supplies only what the human
 * actually typed. Identity, tenant, role, vertical and plan are all re-read
 * server-side from the authenticated session. A merchant cannot post a ticket
 * that claims to be a different workspace, and cannot inflate their own role in
 * the message a support agent reads.
 *
 * Slack IS the ticket store for now — there is no tickets table. That is a
 * deliberate corner: it means a merchant can't see status in-app and nothing is
 * queryable later.
 * ponytail: ceiling = no ticket history / no status back to the merchant.
 *   Upgrade path when that hurts: insert a row in a `support_tickets` table
 *   here before posting, keep the Slack `ts` on it as the thread key, and let a
 *   Slack Events subscription write thread replies back onto the row.
 */
import express from 'express'
import type { SupabaseClient } from '@supabase/supabase-js'

type Mw = (req: express.Request, res: express.Response, next: express.NextFunction) => void | Promise<void>
interface Deps { supabase: SupabaseClient; requireAuth: Mw; identifyTenant: Mw }

/** category → Slack channel id. Overridable with SLACK_SUPPORT_CHANNELS (JSON)
 *  so a channel can be re-pointed without a code change. */
const DEFAULT_CHANNELS: Record<string, string> = {
  triage:          'C0BTT1KAZ2L',
  payments:        'C0BSSDB733M',
  onboarding:      'C0BSWPSBG6A',
  orders:          'C0BSYMCT9K4',
  'catalog-stock': 'C0BT2CE4PHA',
  'billing-plans': 'C0BTT3H39C0',
  bugs:            'C0BSHB6DNET',
}

export function channelMap(): Record<string, string> {
  const raw = process.env.SLACK_SUPPORT_CHANNELS
  if (!raw) return DEFAULT_CHANNELS
  try {
    const parsed = JSON.parse(raw)
    // Merge, don't replace — a partial override must not silently drop the
    // categories it didn't mention.
    return { ...DEFAULT_CHANNELS, ...parsed }
  } catch {
    console.warn('[support] SLACK_SUPPORT_CHANNELS is not valid JSON — using defaults')
    return DEFAULT_CHANNELS
  }
}

const EMOJI: Record<string, string> = {
  triage: '🎫', payments: '💳', onboarding: '🚀', orders: '🍽️',
  'catalog-stock': '📦', 'billing-plans': '🧾', bugs: '🐞',
}

/**
 * Route a ticket by what the merchant actually wrote.
 *
 * Deliberately keyword-based, not an LLM call: routing wrong is cheap (a human
 * moves it), routing SLOWLY is not — the merchant is waiting on a confirmation,
 * and a mis-routed ticket still reaches a human either way. Unmatched goes to
 * triage, which is exactly what that channel exists for.
 *
 * Keywords carry Hinglish and Devanagari because that is what merchants type.
 */
const ROUTES: Array<{ key: string; words: RegExp }> = [
  { key: 'payments',      words: /\b(payment|paid|razorpay|upi|refund|settle|settlement|gateway|kyc|paisa|bhugtan|payout|money|transaction)\b|भुगतान|पैसा|रिफंड/i },
  { key: 'billing-plans', words: /\b(subscription|invoice|plan|upgrade|downgrade|seat|billing|renew|trial expired)\b/i },
  { key: 'orders',        words: /\b(pos|kot|bill|day close|printer|print|order|zomato|swiggy|aggregator|desktop|kds|kitchen)\b|बिल|रसोई|ऑर्डर/i },
  { key: 'catalog-stock', words: /\b(menu|dish|item|price|sold out|recipe|ingredient|stock|inventory|wastage|supplier)\b|मेन्यू|स्टॉक|सामग्री/i },
  { key: 'onboarding',    words: /\b(setup|set up|onboard|getting started|go live|import|migrate|new account|first time)\b/i },
  { key: 'bugs',          words: /\b(bug|crash|broken|error|not working|blank|stuck|failed)\b/i },
]

export function inferCategory(text: string): string {
  for (const r of ROUTES) if (r.words.test(text)) return r.key
  return 'triage'
}

/** Short human-quotable reference. Not a DB id — just something the merchant
 *  and the agent can both say out loud. */
function ticketRef(): string {
  return 'FRQ-' + Math.random().toString(36).slice(2, 7).toUpperCase()
}

export function createSupportRouter({ supabase, requireAuth, identifyTenant }: Deps) {
  const r = express.Router()

  r.post('/api/support/ticket', requireAuth as any, identifyTenant as any, async (req, res) => {
    const token = process.env.SLACK_BOT_TOKEN
    if (!token) {
      // Fail loudly to the operator log, softly to the merchant — they should
      // be told to email us, not shown an integration detail.
      console.warn('[support] SLACK_BOT_TOKEN not set — ticket dropped')
      res.status(503).json({ error: "Support isn't reachable right now. Please email hello@getfrequency.app." })
      return
    }

    const message = String(req.body?.message ?? '').trim()
    if (!message) { res.status(400).json({ error: 'message required' }); return }
    if (message.length > 4000) { res.status(400).json({ error: 'message too long (max 4000 chars)' }); return }

    // Optional: the Copilot conversation that led here. Clamped hard — it is
    // context for a human, not a transcript archive.
    type Turn = { role: string; text: string }
    const transcript: Turn[] = (Array.isArray(req.body?.transcript) ? req.body.transcript : [])
      .filter((m: any) => m && typeof m.text === 'string' && (m.role === 'user' || m.role === 'assistant'))
      .slice(-6)
      .map((m: any): Turn => ({ role: String(m.role), text: String(m.text).slice(0, 500) }))

    const pagePath = String(req.body?.page_path ?? '').slice(0, 120)
    // A client-supplied category is a HINT only; it still has to be a category
    // we actually have a channel for, or we fall back to inference.
    const map = channelMap()
    const hinted = String(req.body?.category ?? '')
    const category = map[hinted] ? hinted : inferCategory(message + ' ' + transcript.map(t => t.text).join(' '))
    const channel = map[category] ?? map.triage

    // ── Everything below is re-read server-side. Never from the request. ─────
    const user = (req as any).user
    const tenantId = (req as any).tenantId as string | undefined
    const userRole = (req as any).userRoleKey || (req as any).userRole || 'member'

    let tenantName = 'Unknown workspace'
    let tenantSlug = ''
    let businessType = 'unknown'
    let planLabel = '—'
    try {
      if (tenantId) {
        const [{ data: t, error: tErr }, { data: sub }] = await Promise.all([
          // Columns verified against the live schema. There is no `tenants.name`
          // — asking for one makes PostgREST reject the WHOLE select, and
          // because supabase-js returns that as an error VALUE rather than a
          // throw, the catch below never fires and every ticket silently reads
          // "Unknown workspace". Keep this list honest.
          supabase.from('tenants').select('business_name, legal_name, slug, business_type').eq('id', tenantId).maybeSingle(),
          supabase.from('tenant_subscriptions').select('plan_id, status').eq('tenant_id', tenantId).maybeSingle(),
        ])
        if (tErr) console.warn('[support] tenant lookup failed:', tErr.message)
        tenantName = (t as any)?.business_name || (t as any)?.legal_name || tenantName
        tenantSlug = (t as any)?.slug || ''
        businessType = (t as any)?.business_type || 'unknown'
        if (sub) planLabel = `${(sub as any).plan_id ?? '—'} · ${(sub as any).status ?? '—'}`
      }
    } catch (e: any) {
      // Enrichment is best-effort. A ticket with thin context still beats a
      // merchant who couldn't reach anyone.
      console.warn('[support] enrichment failed:', e?.message)
    }

    const ref = ticketRef()
    const emoji = EMOJI[category] ?? '🎫'
    const dashUrl = tenantId ? `https://getfrequency.app/naruto/tenants/${tenantId}` : 'https://getfrequency.app/naruto/tenants'

    const blocks: any[] = [
      { type: 'header', text: { type: 'plain_text', text: `${emoji}  ${tenantName}`, emoji: true } },
      { type: 'section', text: { type: 'mrkdwn', text: '> ' + message.replace(/\n/g, '\n> ').slice(0, 2800) } },
      { type: 'section', fields: [
        { type: 'mrkdwn', text: `*Workspace*\n${tenantName}${tenantSlug ? ` (\`${tenantSlug}\`)` : ''}` },
        { type: 'mrkdwn', text: `*Vertical · Plan*\n${businessType} · ${planLabel}` },
        { type: 'mrkdwn', text: `*Raised by*\n${user?.email ?? 'unknown'} · ${userRole}` },
        { type: 'mrkdwn', text: `*From page*\n${pagePath ? `\`${pagePath}\`` : '—'}` },
      ]},
    ]

    if (transcript.length) {
      blocks.push({ type: 'divider' })
      blocks.push({ type: 'section', text: { type: 'mrkdwn',
        text: '*What they already tried with the assistant*\n' + transcript
          .map(t => `${t.role === 'user' ? '🙋' : '🤖'} ${t.text.replace(/\n/g, ' ').slice(0, 220)}`)
          .join('\n').slice(0, 2800) } })
    }

    blocks.push({ type: 'context', elements: [
      { type: 'mrkdwn', text: `\`${ref}\`  ·  routed to *${category}*  ·  tenant \`${tenantId ?? 'none'}\`` },
    ]})
    blocks.push({ type: 'actions', elements: [
      { type: 'button', text: { type: 'plain_text', text: 'Open Tenant 360', emoji: true }, url: dashUrl, style: 'primary' },
    ]})

    try {
      const slack = await fetch('https://slack.com/api/chat.postMessage', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-type': 'application/json; charset=utf-8' },
        body: JSON.stringify({ channel, text: `${ref} · ${category} · ${tenantName}`, blocks, unfurl_links: false }),
      })
      const out: any = await slack.json()
      if (!out?.ok) {
        console.warn('[support] slack rejected:', out?.error)
        res.status(502).json({ error: "Couldn't reach support right now. Please email hello@getfrequency.app." })
        return
      }
      res.json({ ok: true, ref, category })
    } catch (e: any) {
      console.warn('[support] slack post failed:', e?.message)
      res.status(502).json({ error: "Couldn't reach support right now. Please email hello@getfrequency.app." })
    }
  })

  return r
}
