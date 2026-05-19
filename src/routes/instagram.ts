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
import { createHmac, timingSafeEqual } from 'crypto'
import { SupabaseClient } from '@supabase/supabase-js'
import { encrypt, decrypt } from '../crypto'
import { signOauthState, verifyOauthState } from '../lib/oauth-state'

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
    // B4: HMAC-signed state with 10-min TTL + nonce. The unsigned base64
    // JSON used previously could be forged by any attacker who guessed the
    // shape (trivial — { userId, tenantId, csrf }), letting them steal the
    // resulting Instagram tokens onto another tenant.
    const state = signOauthState({ userId, tenantId })
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
    // B4: verify HMAC + expiry on the state blob. Treats forged / expired
    // states identically (single error path, no oracle).
    const verified = verifyOauthState(state)
    if (!verified) {
      res.status(400).type('html').send(closePopupHtml('Invalid or expired state')); return
    }
    const parsed = { userId: verified.u, tenantId: verified.t ?? '' }

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

      // Identity sync: pull the IG business account's @username + display
      // name so brand_label is the @handle ("@frequency_labs") rather than
      // the linked Facebook Page name. Users recognize the IG handle far
      // more than the Page name they may have set years ago.
      // Wrapped in try/catch — identity fetch failures MUST NOT block the
      // connect; the page_access_token is already valid.
      let igUsername: string | null = null
      let igDisplayName: string | null = null
      try {
        const igMe = await fetch(`${GRAPH}/${igUserId}?fields=username,name&access_token=${pageToken}`).then(r => r.json()) as any
        if (igMe?.username) igUsername    = igMe.username
        if (igMe?.name)     igDisplayName = igMe.name
      } catch (e: any) {
        console.warn(`[instagram oauth-callback] IG /me identity fetch failed (non-fatal): ${e?.message}`)
      }
      const brandLabel = igUsername ? `@${igUsername}` : (linked.name ?? `IG ${igUserId}`)

      // tenant_integrations.user_id is NOT NULL (migration 005). The signed
      // state blob carries the user id (verified.u → parsed.userId); without
      // it the upsert silently fails the constraint and the popup
      // postMessages ok:true while nothing landed.
      if (!parsed.userId) {
        res.status(400).type('html').send(closePopupHtml('Signed state missing user_id — please retry')); return
      }
      // supabase-js returns { data, error } and never throws on DB errors —
      // the previous version ignored `error`, so any constraint violation
      // produced a misleading "Connected" toast in the FE.
      const { error: upsertErr } = await supabase.from('tenant_integrations').upsert({
        tenant_id: parsed.tenantId, user_id: parsed.userId, key: 'instagram', status: 'active',
        access_token: encrypt(pageToken),
        scope: SCOPES,
        brand_label: brandLabel,
        connected_at: new Date().toISOString(),
        metadata: {
          ig_user_id:      igUserId,
          ig_username:     igUsername,
          ig_display_name: igDisplayName,
          page_id:         pageId,
          page_name:       linked.name ?? null,
        },
      }, { onConflict: 'tenant_id,key' })
      if (upsertErr) {
        console.error(`[instagram oauth-callback] DB upsert failed: ${upsertErr.message}`)
        // closePopupHtml(msg, ok=false) → popup postMessages { ok:false, message }
        // so the FE OAuth popup helper surfaces the failure as an error toast
        // instead of silently believing the connection succeeded.
        res.status(500).type('html').send(closePopupHtml('Failed to save Instagram connection: ' + upsertErr.message))
        return
      }

      res.type('html').send(closePopupHtml(`Connected ${brandLabel}`, true))
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

  // ── P0.9 IG triggers ─────────────────────────────────────────────────────
  //
  // The three IG-unique trigger surfaces — story replies, comments,
  // mentions — show up here as REST endpoints the Triggers page reads.
  // Underlying storage:
  //   • story replies   → messages with content.kind='story_reply'
  //   • comments        → instagram_comment_events (webhook + poller)
  //   • mentions        → instagram_mention_events (webhook)
  //
  // All three lists are tenant-scoped, paginated by `?limit` (default 50)
  // and sorted desc by event time.

  r.get('/api/instagram/story-replies', ...guardView, async (req, res) => {
    const tenantId = (req as any).tenantId
    const limit = clampLimit(req.query.limit, 50, 200)
    const { data, error } = await supabase.from('messages')
      .select('id, contact_phone, content, metadata, created_at')
      .eq('tenant_id', tenantId)
      .eq('channel', 'instagram')
      .eq('direction', 'inbound')
      .filter('content->>kind', 'eq', 'story_reply')
      .order('created_at', { ascending: false })
      .limit(limit)
    if (error) { res.status(500).json({ error: error.message }); return }
    res.json(data ?? [])
  })

  r.get('/api/instagram/comment-events', ...guardView, async (req, res) => {
    const tenantId = (req as any).tenantId
    const limit = clampLimit(req.query.limit, 50, 200)
    const onlyPending = String(req.query.pending ?? '') === '1'
    let q = supabase.from('instagram_comment_events')
      .select('*')
      .eq('tenant_id', tenantId)
      .is('deleted_at', null)
      .order('created_at', { ascending: false })
      .limit(limit)
    if (onlyPending) q = q.is('dm_sent_at', null).is('replied_at', null)
    const { data, error } = await q
    if (error) { res.status(500).json({ error: error.message }); return }
    res.json(data ?? [])
  })

  r.get('/api/instagram/mention-events', ...guardView, async (req, res) => {
    const tenantId = (req as any).tenantId
    const limit = clampLimit(req.query.limit, 50, 200)
    const { data, error } = await supabase.from('instagram_mention_events')
      .select('*').eq('tenant_id', tenantId)
      .order('created_at', { ascending: false }).limit(limit)
    if (error) { res.status(500).json({ error: error.message }); return }
    res.json(data ?? [])
  })

  // ── DM a commenter via Meta private_replies ──────────────────────────────
  // Meta's policy: brands have a 7-day window after the comment was posted
  // to send ONE private reply. Outside that window the API returns
  // (#100) Object cannot be private replied to anymore. We enforce
  // server-side so the FE warning can't be bypassed.
  r.post('/api/instagram/comments/:comment_id/dm', ...guard, async (req, res) => {
    const tenantId  = (req as any).tenantId
    const commentId = req.params.comment_id
    const body = String(req.body?.body ?? '').trim()
    if (!body) { res.status(400).json({ error: 'body required' }); return }
    if (body.length > 1000) { res.status(400).json({ error: 'body too long (max 1000 chars)' }); return }

    // Look up the event so we can (a) check the 7-day window and (b)
    // resolve the commenter to write a `messages` row for the inbox.
    const { data: evt, error: evtErr } = await supabase.from('instagram_comment_events')
      .select('*').eq('tenant_id', tenantId).eq('comment_id', commentId).maybeSingle()
    if (evtErr) { res.status(500).json({ error: evtErr.message }); return }
    if (!evt)   { res.status(404).json({ error: 'comment not found' }); return }

    const createdAt = evt.ig_created_at ?? evt.created_at
    if (createdAt && Date.now() - new Date(createdAt).getTime() > 7 * 24 * 60 * 60 * 1000) {
      res.status(422).json({
        error: 'private_reply_window_expired',
        message: 'Instagram only allows a private reply within 7 days of the original comment.',
      })
      return
    }
    if (evt.dm_sent_at) {
      res.status(422).json({
        error: 'already_dm_sent',
        message: 'A private reply has already been sent for this comment. Meta allows only one per comment.',
      })
      return
    }

    const conn = await getIgConnection(supabase, tenantId)
    if (!conn) { res.status(404).json({ error: 'Instagram not connected' }); return }

    try {
      const r1 = await fetch(`${GRAPH}/${commentId}/private_replies?access_token=${conn.token}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: body }),
      })
      const data = await r1.json() as any
      if (!r1.ok || data.error) {
        throw new Error(data.error?.message ?? `private_replies failed (${r1.status})`)
      }
      // Mark + mirror to messages so it shows up in the inbox.
      await supabase.from('instagram_comment_events').update({
        dm_sent_at: new Date().toISOString(),
      }).eq('id', evt.id)

      if (evt.commenter_ig_id) {
        await supabase.from('messages').insert({
          tenant_id:           tenantId,
          channel:             'instagram',
          direction:           'outbound',
          contact_phone:       evt.commenter_ig_id,
          platform_message_id: data.id ?? data.message_id ?? null,
          content:             { type: 'text', text: body, kind: 'private_reply' },
          metadata:            { kind: 'private_reply', source_comment_id: commentId, post_id: evt.post_id },
          status:              'sent',
        })
      }
      res.json({ success: true, message_id: data.id ?? data.message_id ?? null })
    } catch (err: any) {
      res.status(500).json({ error: err.message ?? 'private_replies failed' })
    }
  })

  // ── Public reply to a comment (kept for parity) ──────────────────────────
  r.post('/api/instagram/comments/:comment_id/reply', ...guard, async (req, res) => {
    const tenantId  = (req as any).tenantId
    const commentId = req.params.comment_id
    const body = String(req.body?.body ?? '').trim()
    if (!body) { res.status(400).json({ error: 'body required' }); return }

    const { data: evt } = await supabase.from('instagram_comment_events')
      .select('id').eq('tenant_id', tenantId).eq('comment_id', commentId).maybeSingle()
    if (!evt) { res.status(404).json({ error: 'comment not found' }); return }

    const conn = await getIgConnection(supabase, tenantId)
    if (!conn) { res.status(404).json({ error: 'Instagram not connected' }); return }

    try {
      const r1 = await fetch(`${GRAPH}/${commentId}/replies?access_token=${conn.token}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: body }),
      })
      const data = await r1.json() as any
      if (!r1.ok || data.error) throw new Error(data.error?.message ?? `comment reply failed (${r1.status})`)
      await supabase.from('instagram_comment_events').update({
        replied_at: new Date().toISOString(),
      }).eq('id', evt.id)
      res.json({ success: true, id: data.id ?? null })
    } catch (err: any) {
      res.status(500).json({ error: err.message ?? 'comment reply failed' })
    }
  })

  // ── Reply to a mention (story / post media) ──────────────────────────────
  // Implemented as a comment on the original media. Mentions in DMs are
  // handled via the regular send-DM path (story_mention attachments).
  r.post('/api/instagram/mentions/:mention_id/reply', ...guard, async (req, res) => {
    const tenantId  = (req as any).tenantId
    const mentionId = req.params.mention_id
    const body = String(req.body?.body ?? '').trim()
    if (!body) { res.status(400).json({ error: 'body required' }); return }

    const { data: evt } = await supabase.from('instagram_mention_events')
      .select('id, media_id, comment_id, mention_type').eq('tenant_id', tenantId).eq('id', mentionId).maybeSingle()
    if (!evt) { res.status(404).json({ error: 'mention not found' }); return }

    const conn = await getIgConnection(supabase, tenantId)
    if (!conn) { res.status(404).json({ error: 'Instagram not connected' }); return }

    // If the mention was inside a comment, reply to that comment;
    // otherwise post a comment on the mention's media.
    const targetId   = evt.comment_id ?? evt.media_id
    const targetKind = evt.comment_id ? 'replies' : 'comments'
    if (!targetId) { res.status(400).json({ error: 'mention has no media or comment target' }); return }

    try {
      const r1 = await fetch(`${GRAPH}/${targetId}/${targetKind}?access_token=${conn.token}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: body }),
      })
      const data = await r1.json() as any
      if (!r1.ok || data.error) throw new Error(data.error?.message ?? `mention reply failed (${r1.status})`)
      await supabase.from('instagram_mention_events').update({
        processed_at: new Date().toISOString(),
      }).eq('id', evt.id)
      res.json({ success: true, id: data.id ?? null })
    } catch (err: any) {
      res.status(500).json({ error: err.message ?? 'mention reply failed' })
    }
  })

  // ── Quick-reply DM send (IG supports up to 13 QR buttons) ────────────────
  // Meta's `messages` endpoint accepts a `quick_replies` array on message.
  // This endpoint normalizes the input so workflow nodes don't have to
  // construct the full Meta payload.
  r.post('/api/instagram/dm/quick-replies', ...guard, async (req, res) => {
    const tenantId = (req as any).tenantId
    const { recipient_id, text, options } = req.body ?? {}
    if (!recipient_id || !text || !Array.isArray(options) || options.length === 0) {
      res.status(400).json({ error: 'recipient_id + text + options[] required' }); return
    }
    if (options.length > 13) {
      res.status(400).json({ error: 'Instagram allows at most 13 quick-reply options' }); return
    }
    const conn = await getIgConnection(supabase, tenantId)
    if (!conn) { res.status(404).json({ error: 'Instagram not connected' }); return }
    try {
      const quick_replies = options.slice(0, 13).map((o: any) => ({
        content_type: 'text',
        title:        String(o.title ?? o.label ?? o).slice(0, 20),
        payload:      String(o.payload ?? o.value ?? o.title ?? o).slice(0, 1000),
      }))
      const resp = await fetch(`${GRAPH}/${conn.igUserId}/messages?access_token=${conn.token}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ recipient: { id: String(recipient_id) }, message: { text, quick_replies } }),
      })
      const data = await resp.json() as any
      if (!resp.ok || data.error) throw new Error(data.error?.message ?? `IG quick-reply send failed (${resp.status})`)
      await supabase.from('messages').insert({
        tenant_id: tenantId, channel: 'instagram', direction: 'outbound',
        contact_phone: String(recipient_id),
        platform_message_id: data.message_id ?? null,
        content: { type: 'interactive', text, quick_replies }, status: 'sent',
      })
      res.json({ success: true, message_id: data.message_id })
    } catch (err: any) {
      res.status(500).json({ error: err.message })
    }
  })

  // ── Inbound webhook ──────────────────────────────────────────────────────
  // Meta delivers IG DM events here. Configure in Meta App Dashboard →
  // Instagram → Webhooks → Subscribe to `messages` (and `comments` if you
  // want comment-trigger rules). Use these URLs:
  //
  //   Verify URL:  https://<your-domain>/webhook/instagram
  //   Verify token: $META_VERIFY_TOKEN  (same env var WhatsApp uses)
  //
  // Tenant resolution: IG webhook payloads include the page id under
  // `entry[].id`. We look up the tenant by `tenant_integrations.metadata->>page_id`.
  // No `?tenant_id=` query param like Telegram needs — Meta won't route
  // dynamic query strings through the dashboard config.
  //
  // Verification GET — Meta hits this once on subscribe.
  r.get('/webhook/instagram', (req, res) => {
    const mode      = req.query['hub.mode']
    const token     = req.query['hub.verify_token']
    const challenge = req.query['hub.challenge']
    if (mode === 'subscribe' && token && token === (process.env.META_VERIFY_TOKEN ?? '')) {
      res.status(200).send(String(challenge ?? ''))
      return
    }
    res.sendStatus(403)
  })

  // Event POST. Each entry is per page (one IG account). Each entry may
  // contain `messaging[]` (DMs) and/or `changes[]` (comments / mentions).
  // Always 200 quickly — never let Meta retry on our processing errors,
  // it just doubles the load.
  //
  // B2: HMAC verification. The raw-body parser is mounted in src/index.ts
  // BEFORE the global express.json(), so req.body is a Buffer here. Reject
  // unsigned / mis-signed payloads with 401 before doing any DB work.
  r.post('/webhook/instagram', async (req, res) => {
    const sigHeader = req.header('x-hub-signature-256') || req.header('X-Hub-Signature-256')
    const rawBody = req.body as Buffer
    const appSecret = process.env.META_APP_SECRET || ''
    if (!Buffer.isBuffer(rawBody)) {
      console.warn('[ig-webhook] body is not a Buffer — raw parser not mounted? Refusing.')
      res.status(401).json({ error: 'invalid_signature' }); return
    }
    const verifyMetaSignature = (body: Buffer, header: string | undefined, secret: string): boolean => {
      if (!header || !secret) return false
      const prefix = 'sha256='
      if (!header.startsWith(prefix)) return false
      const provided = header.slice(prefix.length)
      const expected = createHmac('sha256', secret).update(body).digest('hex')
      if (provided.length !== expected.length) return false
      try { return timingSafeEqual(Buffer.from(provided, 'utf8'), Buffer.from(expected, 'utf8')) }
      catch { return false }
    }
    if (!verifyMetaSignature(rawBody, sigHeader, appSecret)) {
      console.warn('[ig-webhook] HMAC verification failed — rejecting')
      res.status(401).json({ error: 'invalid_signature' }); return
    }

    // ── Webhook queue handoff (migration 064) ──────────────────────────
    // Same flag-gated pattern as /webhook/whatsapp. See queue.ts and
    // workers/webhook-retry.ts for the retry + DLQ contract.
    if (process.env.WEBHOOK_QUEUE_ENABLED === '1') {
      try {
        const { enqueueWebhookInbound } = await import('../queue')
        await enqueueWebhookInbound({
          source:     'meta_instagram',
          rawBodyB64: rawBody.toString('base64'),
          receivedAt: new Date().toISOString(),
        })
        res.sendStatus(200)
        return
      } catch (e: any) {
        console.warn(`[ig-webhook] queue enqueue failed, running inline: ${e?.message ?? e}`)
      }
    }

    res.sendStatus(200)
    try {
      let body: any
      try { body = JSON.parse(rawBody.toString('utf8')) }
      catch { console.warn('[ig-webhook] JSON parse failed (body verified but malformed)'); return }
      const entries: any[] = Array.isArray(body?.entry) ? body.entry : []
      for (const entry of entries) {
        // Resolve tenant by page_id stored in tenant_integrations metadata.
        const pageId = String(entry?.id ?? '')
        if (!pageId) continue
        const { data: integration } = await supabase.from('tenant_integrations')
          .select('tenant_id, metadata').eq('key', 'instagram')
          .filter('metadata->>page_id', 'eq', pageId).maybeSingle()
        if (!integration?.tenant_id) {
          console.warn(`[ig-webhook] page_id ${pageId} not linked to any tenant`)
          continue
        }
        const { data: tenant } = await supabase.from('tenants')
          .select('*').eq('id', integration.tenant_id).maybeSingle()
        if (!tenant) continue

        // ── DMs ────────────────────────────────────────────────────────
        for (const m of (entry.messaging ?? [])) {
          // sender.id is the user PSID (page-scoped user id) — that's
          // what you POST back to /messages.recipient.id when replying.
          // Skip echoes (our own outbound messages mirrored back).
          if (m.message?.is_echo) continue
          const senderId = String(m.sender?.id ?? '')
          if (!senderId) continue

          // ── Story-reply / shared-post / replied-message branches ────
          // Meta surfaces these as additional fields on `message`:
          //   reply_to.story.id + .url → user replied to OUR story
          //   reply_to.mid             → user replied to a specific msg
          //   attachments[].type='share' / 'story_mention'
          // We stamp a `kind` on content so the inbox can render an
          // inline story-thumbnail preview, and dump the refs into
          // metadata so workflow nodes can reference them by variable.
          // P0.9: also fires `instagram_story_reply` trigger downstream.
          const replyToStory = m.message?.reply_to?.story
          const attachments  = Array.isArray(m.message?.attachments) ? m.message.attachments : []
          const storyMention = attachments.find((a: any) => a?.type === 'story_mention')
          const sharedPost   = attachments.find((a: any) => a?.type === 'share')

          let kind: 'text' | 'story_reply' | 'shared_post' | 'story_mention' = 'text'
          let metadata: Record<string, any> | null = null
          if (replyToStory?.id) {
            kind = 'story_reply'
            metadata = { kind: 'story_reply', story_id: String(replyToStory.id), story_url: replyToStory.url ?? null }
          } else if (storyMention) {
            kind = 'story_mention'
            metadata = { kind: 'story_mention', story_url: storyMention.payload?.url ?? null }
          } else if (sharedPost) {
            kind = 'shared_post'
            metadata = { kind: 'shared_post', media_id: sharedPost.payload?.id ?? null, media_url: sharedPost.payload?.url ?? null }
          }

          const text = m.message?.text ?? ''

          // Log the inbound message + upsert contact.
          await supabase.from('messages').insert({
            tenant_id:           tenant.id,
            channel:             'instagram',
            direction:           'inbound',
            contact_phone:       senderId,
            platform_message_id: String(m.message?.mid ?? ''),
            content:             { type: 'text', text, kind, raw: m },
            metadata:            metadata,
          })
          await supabase.from('contacts').upsert({
            tenant_id:       tenant.id,
            user_id:         tenant.user_id,
            phone:           `ig:${senderId}`,
            name:            `Instagram ${senderId.slice(0, 6)}…`,
            channel_primary: 'instagram',
          }, { onConflict: 'tenant_id,phone' })

          // Workflow trigger + session resume (shared with WhatsApp + Telegram).
          // For story replies we ALSO fire the IG-specific trigger so workflows
          // authored with `instagram_story_reply` as the entry-point can match
          // even when the text doesn't hit a keyword.
          if (kind === 'story_reply') {
            try {
              const { fireIgEventTrigger } = await import('../engine/inbound-router')
              await fireIgEventTrigger(supabase, tenant, 'instagram_story_reply', {
                contactId: senderId,
                text,
                story_id: metadata?.story_id ?? null,
                story_url: metadata?.story_url ?? null,
                raw: m,
              })
            } catch (e: any) {
              console.warn(`[ig-webhook] story_reply trigger fan-out failed (non-fatal): ${e?.message ?? e}`)
            }
          }
          if (text) {
            const { routeInboundToWorkflow } = await import('../engine/inbound-router')
            await routeInboundToWorkflow(supabase, tenant, 'instagram', senderId, text, m)
          }
        }

        // ── changes[] (comments, mentions, feed updates) ───────────────
        // Meta delivers comment + mention events under entry.changes[].
        // Field values we handle:
        //   'comments'  — { value.from, value.text, value.id, value.media.id, … }
        //   'mentions'  — { value.media_id, value.comment_id, … }
        //   'feed'      — wider feed change stream; we only act on item='comment'
        //
        // Anything else logs at info level and is dropped — the goal is
        // honesty + room to extend, not exhaustive coverage on day one.
        for (const ch of (entry.changes ?? [])) {
          try {
            const field = String(ch?.field ?? '')
            const value: any = ch?.value ?? {}
            if (field === 'comments' || (field === 'feed' && value?.item === 'comment')) {
              await handleIncomingComment(supabase, tenant, value)
            } else if (field === 'mentions') {
              await handleIncomingMention(supabase, tenant, value)
            }
          } catch (e: any) {
            // Per-event swallow — one bad change-row shouldn't poison the
            // rest of the entry. Already 200'd to Meta either way.
            console.warn(`[ig-webhook] change-event handler failed: ${e?.message ?? e}`)
          }
        }
      }
    } catch (err) {
      console.error('[ig-webhook] processing error', err)
      // Already 200'd; nothing more to do.
    }
  })

  return r
}

// ─── P0.9 helpers — comment + mention event handlers ─────────────────────────
//
// Both are best-effort: they swallow errors after logging because the IG
// webhook MUST 200 to Meta. Re-running the same webhook event is fine
// thanks to unique(comment_id) on instagram_comment_events.

async function handleIncomingComment(
  supabase: SupabaseClient,
  tenant: any,
  value: any,
): Promise<void> {
  const commentId = String(value?.id ?? value?.comment_id ?? '')
  if (!commentId) return

  // Resolve post id — Meta sometimes nests it under media.id, sometimes
  // surfaces it as parent_id/post_id depending on the webhook channel.
  const postId = String(
    value?.media?.id ??
    value?.media_id ??
    value?.post_id ??
    value?.parent_id ??
    ''
  )
  const text     = value?.text ?? value?.message ?? null
  const fromId   = String(value?.from?.id ?? '')
  const fromUser = value?.from?.username ?? null

  // Insert; idempotent via unique(comment_id). On conflict we still update
  // the username/text fields in case the poller saw it first with less data.
  const { error: insertErr } = await supabase.from('instagram_comment_events').insert({
    tenant_id:          tenant.id,
    post_id:            postId,
    comment_id:         commentId,
    parent_comment_id:  value?.parent_id ? String(value.parent_id) : null,
    commenter_ig_id:    fromId || null,
    commenter_username: fromUser,
    text,
    permalink:          value?.permalink ?? null,
    source:             'webhook',
    ig_created_at:      value?.created_time ? new Date(value.created_time).toISOString() : null,
    raw:                value,
  })
  if (insertErr && !/duplicate key/i.test(insertErr.message)) {
    console.warn(`[ig-comment] insert failed: ${insertErr.message}`)
    return
  }

  // Fire the per-tenant comment rules. Existing ig_comment_rules powers
  // keyword → auto-reply + auto-DM. We piggy-back on the webhook path so
  // rules fire even when no poller is running.
  if (text) {
    await applyCommentRules(supabase, tenant, commentId, postId, fromId, text)
  }

  // Fan out to the workflow trigger as well so users can author chat-based
  // workflows on the `instagram_comment` trigger.
  try {
    const { fireIgEventTrigger } = await import('../engine/inbound-router')
    await fireIgEventTrigger(supabase, tenant, 'instagram_comment', {
      contactId: fromId || `ig-comment:${commentId}`,
      text:      text ?? '',
      comment_id: commentId,
      post_id:   postId,
      username:  fromUser,
      raw:       value,
    })
  } catch (e: any) {
    console.warn(`[ig-comment] workflow fan-out failed: ${e?.message ?? e}`)
  }
}

async function handleIncomingMention(
  supabase: SupabaseClient,
  tenant: any,
  value: any,
): Promise<void> {
  const mediaId   = value?.media_id ? String(value.media_id) : null
  const commentId = value?.comment_id ? String(value.comment_id) : null
  if (!mediaId && !commentId) return

  const mentionType: 'media' | 'comment' | 'story' =
    commentId ? 'comment' : (value?.media_type === 'STORY' ? 'story' : 'media')

  const { data: row, error } = await supabase.from('instagram_mention_events').insert({
    tenant_id:          tenant.id,
    media_id:           mediaId,
    comment_id:         commentId,
    mention_type:       mentionType,
    mentioner_ig_id:    value?.from?.id ? String(value.from.id) : null,
    mentioner_username: value?.from?.username ?? null,
    text:               value?.text ?? value?.caption ?? null,
    permalink:          value?.permalink ?? null,
    ig_created_at:      value?.created_time ? new Date(value.created_time).toISOString() : null,
    raw:                value,
  }).select('id').single()
  if (error) {
    console.warn(`[ig-mention] insert failed: ${error.message}`)
    return
  }

  try {
    const { fireIgEventTrigger } = await import('../engine/inbound-router')
    await fireIgEventTrigger(supabase, tenant, 'instagram_mention', {
      contactId:  value?.from?.id ? String(value.from.id) : `ig-mention:${row?.id ?? ''}`,
      text:       value?.text ?? value?.caption ?? '',
      media_id:   mediaId,
      comment_id: commentId,
      mention_type: mentionType,
      username:   value?.from?.username ?? null,
      raw:        value,
    })
  } catch (e: any) {
    console.warn(`[ig-mention] workflow fan-out failed: ${e?.message ?? e}`)
  }
}

// Applies the configured ig_comment_rules to an incoming comment. Re-uses
// the same Graph API endpoints the FE comment-reply / DM endpoints use,
// so behaviour stays consistent (and respects the 7-day window because
// we run this synchronously off the webhook = always within window).
async function applyCommentRules(
  supabase: SupabaseClient,
  tenant: any,
  commentId: string,
  postId: string,
  commenterIgId: string,
  text: string,
): Promise<void> {
  const { data: rules } = await supabase.from('ig_comment_rules')
    .select('*').eq('tenant_id', tenant.id).eq('enabled', true)
  if (!rules || rules.length === 0) return

  const lower = text.toLowerCase()
  for (const rule of rules as any[]) {
    const kws: string[] = rule.trigger_keywords ?? []
    const matched = kws.some(kw => {
      const k = String(kw).toLowerCase()
      switch (rule.match_kind) {
        case 'exact':       return lower === k
        case 'starts_with': return lower.startsWith(k)
        case 'any':         return true
        case 'contains':
        default:            return lower.includes(k)
      }
    })
    if (!matched) continue

    const conn = await getIgConnection(supabase, tenant.id)
    if (!conn) return

    // Public reply (optional)
    if (rule.reply_text) {
      try {
        await fetch(`${GRAPH}/${commentId}/replies?access_token=${conn.token}`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ message: rule.reply_text }),
        })
        await supabase.from('instagram_comment_events').update({
          replied_at: new Date().toISOString(), rule_id: rule.id,
        }).eq('comment_id', commentId).eq('tenant_id', tenant.id)
      } catch (e: any) {
        console.warn(`[ig-comment-rule] public reply failed: ${e?.message ?? e}`)
      }
    }
    // Auto-DM via private_replies (optional). Mirror to messages for inbox.
    if (rule.auto_dm_text) {
      try {
        await fetch(`${GRAPH}/${commentId}/private_replies?access_token=${conn.token}`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ message: rule.auto_dm_text }),
        })
        await supabase.from('instagram_comment_events').update({
          dm_sent_at: new Date().toISOString(), rule_id: rule.id,
        }).eq('comment_id', commentId).eq('tenant_id', tenant.id)
        if (commenterIgId) {
          await supabase.from('messages').insert({
            tenant_id: tenant.id, channel: 'instagram', direction: 'outbound',
            contact_phone: commenterIgId,
            content: { type: 'text', text: rule.auto_dm_text, kind: 'private_reply' },
            metadata: { kind: 'private_reply', source_comment_id: commentId, post_id: postId, rule_id: rule.id },
            status: 'sent',
          })
        }
      } catch (e: any) {
        console.warn(`[ig-comment-rule] auto DM failed: ${e?.message ?? e}`)
      }
    }
    // Bump counters
    await supabase.from('ig_comment_rules').update({
      fired_count: (rule.fired_count ?? 0) + 1,
      last_fired_at: new Date().toISOString(),
    }).eq('id', rule.id)
    // First match wins — same semantics as keyword workflow triggers.
    break
  }
}

function clampLimit(raw: unknown, fallback: number, max: number): number {
  const n = Number(raw)
  if (!Number.isFinite(n) || n <= 0) return fallback
  return Math.min(Math.floor(n), max)
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
  // B10: pin targetOrigin to FRONTEND_URL so cross-origin openers can't
  // intercept the connect-result message (which carries IG account names).
  const FRONTEND_ORIGIN = process.env.FRONTEND_URL || 'http://localhost:5173'
  return `<!doctype html><html><head><meta charset="utf-8"><title>${ok ? 'Connected' : 'Error'}</title></head><body style="font-family:DM Sans,system-ui;background:#0d1117;color:#fff;padding:24px;text-align:center;">
    <h2>${ok ? '✓ Connected' : '⚠ '}${message}</h2>
    <p style="opacity:.6">This window will close…</p>
    <script>
      try { window.opener?.postMessage({ ok: ${ok}, message: ${JSON.stringify(message)} }, ${JSON.stringify(FRONTEND_ORIGIN)}) } catch(e){}
      setTimeout(() => { try { window.close(); } catch(e){} }, 1500);
    </script></body></html>`
}
