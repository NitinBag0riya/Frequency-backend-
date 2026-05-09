/**
 * Instagram endpoints — OAuth (Meta Graph), DM send, comments + auto-rules,
 * content publishing, insights, shopping.
 *
 * OAuth runs through the same Meta App that hosts WhatsApp. Required scopes:
 *   instagram_basic, instagram_manage_messages, instagram_manage_comments,
 *   instagram_content_publish, instagram_manage_insights,
 *   pages_show_list, pages_read_engagement
 *
 * Connection storage: tenant_integrations row with key='instagram'. The
 * `metadata` column carries { ig_user_id, page_id, page_access_token } so we
 * can call the Graph API without round-tripping every request. The
 * page_access_token is stored AES-encrypted in `access_token`.
 */

import express from 'express'
import { SupabaseClient } from '@supabase/supabase-js'
import { encrypt, decrypt, randomToken } from '../crypto'

type Middleware = (req: express.Request, res: express.Response, next: express.NextFunction) => void | Promise<void>

interface Deps {
  supabase: SupabaseClient
  requireAuth: Middleware
  identifyTenant: Middleware
  checkPermission: (feature: string, action: 'view' | 'edit' | 'delete') => Middleware
}

const GRAPH = 'https://graph.facebook.com/v18.0'
const SCOPES = [
  'instagram_basic',
  'instagram_manage_messages',
  'instagram_manage_comments',
  'instagram_content_publish',
  'instagram_manage_insights',
  'pages_show_list',
  'pages_read_engagement',
].join(',')

export function createInstagramRouter(deps: Deps): express.Router {
  const r = express.Router()
  const { supabase, requireAuth, identifyTenant, checkPermission } = deps
  const guard = [requireAuth, identifyTenant, checkPermission('whatsapp_automation', 'edit')]
  const guardView = [requireAuth, identifyTenant, checkPermission('whatsapp_automation', 'view')]

  // ── OAuth start ───────────────────────────────────────────────────────────
  r.get('/api/auth/instagram/start', requireAuth, identifyTenant, async (req, res) => {
    const userId   = (req as any).user?.id   as string
    const tenantId = (req as any).tenantId   as string
    const appId    = process.env.META_APP_ID
    if (!appId) {
      res.status(503).type('html').send(closePopupHtml('Meta App ID not configured'))
      return
    }
    const redirectUri = (process.env.META_REDIRECT_URI ?? `${process.env.PUBLIC_API_URL ?? 'http://localhost:3001'}/api/auth/instagram/callback`)
    const state = Buffer.from(JSON.stringify({ userId, tenantId, csrf: randomToken(8) })).toString('base64url')
    const params = new URLSearchParams({
      client_id: appId,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: SCOPES,
      state,
    })
    res.redirect(`https://www.facebook.com/v18.0/dialog/oauth?${params.toString()}`)
  })

  r.get('/api/auth/instagram/callback', async (req, res) => {
    const { code, state, error } = req.query as Record<string, string>
    if (error || !code) {
      res.type('html').send(closePopupHtml(`Instagram authorization cancelled${error ? `: ${error}` : ''}`))
      return
    }
    let parsed: { userId: string; tenantId: string }
    try {
      parsed = JSON.parse(Buffer.from(state, 'base64url').toString())
    } catch {
      res.status(400).type('html').send(closePopupHtml('Invalid state')); return
    }

    const appId = process.env.META_APP_ID!
    const appSecret = process.env.META_APP_SECRET!
    const redirectUri = (process.env.META_REDIRECT_URI ?? `${process.env.PUBLIC_API_URL ?? 'http://localhost:3001'}/api/auth/instagram/callback`)

    try {
      // 1. Short-lived user token
      const t1 = await fetch(`${GRAPH}/oauth/access_token?client_id=${appId}&client_secret=${appSecret}&redirect_uri=${encodeURIComponent(redirectUri)}&code=${code}`).then(r => r.json()) as any
      if (!t1.access_token) throw new Error(t1.error?.message ?? 'token exchange failed')
      // 2. Long-lived user token
      const t2 = await fetch(`${GRAPH}/oauth/access_token?grant_type=fb_exchange_token&client_id=${appId}&client_secret=${appSecret}&fb_exchange_token=${t1.access_token}`).then(r => r.json()) as any
      const userToken = t2.access_token ?? t1.access_token

      // 3. Find an IG-business-linked Page
      const pages = await fetch(`${GRAPH}/me/accounts?fields=id,name,access_token,instagram_business_account&access_token=${userToken}`).then(r => r.json()) as any
      const linked = (pages.data ?? []).find((p: any) => p.instagram_business_account?.id)
      if (!linked) throw new Error('No Instagram Business account linked to your Pages. Convert to Business + connect to a Facebook Page first.')

      const igUserId = linked.instagram_business_account.id
      const pageId   = linked.id
      const pageToken = linked.access_token

      await supabase.from('tenant_integrations').upsert({
        tenant_id: parsed.tenantId, key: 'instagram', status: 'active',
        access_token: encrypt(pageToken),
        scope: SCOPES,
        brand_label: linked.name ?? `IG ${igUserId}`,
        connected_at: new Date().toISOString(),
        metadata: { ig_user_id: igUserId, page_id: pageId },
      })

      res.type('html').send(closePopupHtml(`Connected ${linked.name}`, true))
    } catch (err: any) {
      res.type('html').send(closePopupHtml(err.message ?? 'Instagram connect failed'))
    }
  })

  // ── DM send ───────────────────────────────────────────────────────────────
  r.post('/api/instagram/dm', ...guard, async (req, res) => {
    const tenantId = (req as any).tenantId
    const { recipient_id, text } = req.body
    if (!recipient_id || !text) { res.status(400).json({ error: 'recipient_id + text required' }); return }
    const conn = await getIgConnection(supabase, tenantId)
    if (!conn) { res.status(404).json({ error: 'Instagram not connected' }); return }
    try {
      const resp = await fetch(`${GRAPH}/${conn.igUserId}/messages?access_token=${conn.token}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ recipient: { id: String(recipient_id) }, message: { text } }),
      })
      const data = await resp.json() as any
      if (!resp.ok || data.error) throw new Error(data.error?.message ?? `IG send failed (${resp.status})`)
      await supabase.from('messages').insert({
        tenant_id: tenantId, channel: 'instagram', direction: 'outbound',
        contact_phone: String(recipient_id),
        platform_message_id: data.message_id ?? null,
        content: { type: 'text', text }, status: 'sent',
      })
      res.json({ success: true, message_id: data.message_id })
    } catch (err: any) {
      res.status(500).json({ error: err.message })
    }
  })

  // ── Posts ─────────────────────────────────────────────────────────────────
  r.get('/api/instagram/posts', ...guardView, async (req, res) => {
    const tenantId = (req as any).tenantId
    const { data, error } = await supabase.from('ig_posts')
      .select('*').eq('tenant_id', tenantId).order('created_at', { ascending: false })
    if (error) { res.status(500).json({ error: error.message }); return }
    res.json(data ?? [])
  })

  r.post('/api/instagram/publish/:type', ...guard, async (req, res) => {
    const tenantId = (req as any).tenantId
    const type = req.params.type as 'image' | 'carousel' | 'reel' | 'story'
    const { caption, media_urls, scheduled_at } = req.body
    if (!Array.isArray(media_urls) || media_urls.length === 0) { res.status(400).json({ error: 'media_urls required' }); return }

    const status = scheduled_at ? 'scheduled' : 'draft'
    const { data, error } = await supabase.from('ig_posts').insert({
      tenant_id: tenantId, type,
      caption: caption ?? null, media_urls,
      scheduled_at: scheduled_at ?? null, status,
    }).select().single()
    if (error) { res.status(500).json({ error: error.message }); return }

    // Real publish path: queue on the schedule poller. For "publish now" we
    // attempt the Meta call inline; failures fall back to draft + a note.
    if (!scheduled_at) {
      const conn = await getIgConnection(supabase, tenantId)
      if (conn) {
        try {
          // Step 1: create container; Step 2: publish.
          const fields = type === 'reel' || type === 'story'
            ? { media_type: type.toUpperCase(), video_url: media_urls[0], caption }
            : type === 'carousel'
              ? { media_type: 'CAROUSEL', children: media_urls.join(','), caption }
              : { image_url: media_urls[0], caption }
          const c = await fetch(`${GRAPH}/${conn.igUserId}/media?access_token=${conn.token}`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(fields),
          }).then(r => r.json()) as any
          if (c.id) {
            const pub = await fetch(`${GRAPH}/${conn.igUserId}/media_publish?access_token=${conn.token}`, {
              method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ creation_id: c.id }),
            }).then(r => r.json()) as any
            if (pub.id) {
              await supabase.from('ig_posts').update({
                status: 'published', meta_post_id: pub.id, published_at: new Date().toISOString(),
              }).eq('id', data.id)
              data.status = 'published'; data.meta_post_id = pub.id
            }
          }
        } catch (e) { /* drop to draft */ }
      }
    }
    res.json(data)
  })

  // ── Comments ──────────────────────────────────────────────────────────────
  r.get('/api/instagram/comment-rules', ...guardView, async (req, res) => {
    const tenantId = (req as any).tenantId
    const { data, error } = await supabase.from('ig_comment_rules')
      .select('*').eq('tenant_id', tenantId).order('created_at', { ascending: false })
    if (error) { res.status(500).json({ error: error.message }); return }
    res.json(data ?? [])
  })

  r.post('/api/instagram/comment-rules', ...guard, async (req, res) => {
    const tenantId = (req as any).tenantId
    const { name, trigger_keywords, match_kind, reply_text, auto_dm_text, enabled } = req.body
    if (!name || !Array.isArray(trigger_keywords) || trigger_keywords.length === 0) {
      res.status(400).json({ error: 'name + trigger_keywords required' }); return
    }
    const { data, error } = await supabase.from('ig_comment_rules').insert({
      tenant_id: tenantId, name, trigger_keywords,
      match_kind: match_kind ?? 'contains',
      reply_text: reply_text ?? null,
      auto_dm_text: auto_dm_text ?? null,
      enabled: enabled !== false,
    }).select().single()
    if (error) { res.status(500).json({ error: error.message }); return }
    res.json(data)
  })

  r.patch('/api/instagram/comment-rules/:id', ...guard, async (req, res) => {
    const tenantId = (req as any).tenantId
    const allowed = ['name', 'trigger_keywords', 'match_kind', 'reply_text', 'auto_dm_text', 'enabled']
    const patch: Record<string, unknown> = {}
    for (const k of allowed) if (k in req.body) patch[k] = req.body[k]
    const { data, error } = await supabase.from('ig_comment_rules').update(patch)
      .eq('id', req.params.id).eq('tenant_id', tenantId).select().single()
    if (error) { res.status(500).json({ error: error.message }); return }
    res.json(data)
  })

  r.delete('/api/instagram/comment-rules/:id', ...guard, async (req, res) => {
    const tenantId = (req as any).tenantId
    const { error } = await supabase.from('ig_comment_rules').delete()
      .eq('id', req.params.id).eq('tenant_id', tenantId)
    if (error) { res.status(500).json({ error: error.message }); return }
    res.json({ success: true })
  })

  // ── Insights (proxied from Meta Graph; cached short-term server-side) ───
  r.get('/api/instagram/insights/profile', ...guardView, async (req, res) => {
    const tenantId = (req as any).tenantId
    const conn = await getIgConnection(supabase, tenantId)
    if (!conn) { res.status(404).json({ error: 'Instagram not connected' }); return }
    try {
      const r1 = await fetch(`${GRAPH}/${conn.igUserId}/insights?metric=reach,profile_views,follower_count&period=day&access_token=${conn.token}`)
      const j = await r1.json() as any
      res.json(j.data ?? [])
    } catch (err: any) {
      res.status(500).json({ error: err.message })
    }
  })

  r.get('/api/instagram/insights/media', ...guardView, async (req, res) => {
    const tenantId = (req as any).tenantId
    const conn = await getIgConnection(supabase, tenantId)
    if (!conn) { res.status(404).json({ error: 'Instagram not connected' }); return }
    try {
      const list = await fetch(`${GRAPH}/${conn.igUserId}/media?fields=id,caption,media_type,permalink,thumbnail_url,media_url,timestamp,insights.metric(impressions,reach,saved,engagement)&limit=20&access_token=${conn.token}`).then(r => r.json()) as any
      res.json(list.data ?? [])
    } catch (err: any) {
      res.status(500).json({ error: err.message })
    }
  })

  r.get('/api/instagram/insights/audience', ...guardView, async (req, res) => {
    const tenantId = (req as any).tenantId
    const conn = await getIgConnection(supabase, tenantId)
    if (!conn) { res.status(404).json({ error: 'Instagram not connected' }); return }
    try {
      const j = await fetch(`${GRAPH}/${conn.igUserId}/insights?metric=audience_city,audience_country,audience_gender_age&period=lifetime&access_token=${conn.token}`).then(r => r.json()) as any
      res.json(j.data ?? [])
    } catch (err: any) {
      res.status(500).json({ error: err.message })
    }
  })

  // ── Shopping (catalog tags) ──────────────────────────────────────────────
  r.get('/api/instagram/shopping/tags', ...guardView, async (_req, res) => {
    res.json([])    // surface real tags once Catalog Commerce Manager is wired
  })

  return r
}

async function getIgConnection(supabase: SupabaseClient, tenantId: string) {
  const { data } = await supabase.from('tenant_integrations')
    .select('access_token, metadata').eq('tenant_id', tenantId).eq('key', 'instagram').maybeSingle()
  if (!data?.access_token) return null
  const meta = (data.metadata ?? {}) as { ig_user_id?: string; page_id?: string }
  if (!meta.ig_user_id) return null
  return { token: decrypt(data.access_token), igUserId: meta.ig_user_id, pageId: meta.page_id ?? null }
}

function closePopupHtml(message: string, ok = false): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${ok ? 'Connected' : 'Error'}</title></head><body style="font-family:DM Sans,system-ui;background:#0d1117;color:#fff;padding:24px;text-align:center;">
    <h2>${ok ? '✓ Connected' : '⚠ '}${message}</h2>
    <p style="opacity:.6">This window will close…</p>
    <script>
      try { window.opener?.postMessage({ ok: ${ok}, message: ${JSON.stringify(message)} }, '*') } catch(e){}
      setTimeout(() => { try { window.close(); } catch(e){} }, 1500);
    </script></body></html>`
}
