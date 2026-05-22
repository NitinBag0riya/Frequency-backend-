/**
 * Worker: instagram-comment-poller (singleton repeatable, every 60s by default)
 *
 * Safety net for the IG webhook. Even with the `comments` change-field
 * subscribed in the Meta App Dashboard, deliveries can lag, drop, or get
 * filtered by Meta's anti-spam heuristics. This worker polls each connected
 * IG account's most-recent ~50 media items for new comments and writes them
 * into `instagram_comment_events`. The webhook handler shares the same
 * insert path, so a row written by either side passes through the same
 * comment-rules + workflow-trigger fan-out.
 *
 * Idempotency: `instagram_comment_events.comment_id` has a unique constraint,
 * so re-inserting a comment already seen by the webhook is a no-op (we catch
 * the duplicate-key error and move on). The per-(tenant, post) cursor in
 * `instagram_poller_cursors` keeps `since` parameters tight so we don't
 * re-read the entire comment history on every tick.
 *
 * Cost shape: O(connected_ig_accounts * 50 media) per tick worst case. For
 * Frequency's SMB scale (≤5k IG-connected tenants, ≤50 recent posts each)
 * that's well within Meta's per-app rate limit. We cap each tick at 200
 * tenants in case the customer base grows; the next tick picks up the rest
 * via the `last_run_at` ordering.
 */

import '../env'
import { Worker, Job } from 'bullmq'
import { createClient } from '@supabase/supabase-js'
import { Q, connection, cronQueue } from '../queue'
import { decrypt } from '../crypto'
import { isPollerEnabled, cleanRepeatablesByName, STUB_WORKER, logGate } from '../lib/poller-gate'

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://yiicpndeggaedxobyopu.supabase.co'
const supabase = createClient(SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY!)

const GRAPH = 'https://graph.facebook.com/v18.0'
const TICK_INTERVAL_MS = Number(process.env.IG_COMMENT_POLL_INTERVAL_MS ?? 60 * 1000)
const MAX_TENANTS_PER_TICK = Number(process.env.IG_COMMENT_POLL_MAX_TENANTS ?? 200)
const MAX_POSTS_PER_TENANT = Number(process.env.IG_COMMENT_POLL_MAX_POSTS  ?? 50)

export async function startInstagramCommentPollerWorker() {
  const enabled = isPollerEnabled('IG_COMMENT_POLLER')
  logGate('IG_COMMENT_POLLER', enabled)
  if (!enabled) {
    await cleanRepeatablesByName(cronQueue, 'instagram-comment-poller-tick')
    return STUB_WORKER
  }

  await cronQueue.add(
    'instagram-comment-poller-tick',
    {},
    {
      jobId: 'singleton-instagram-comment-poller',
      repeat: { every: TICK_INTERVAL_MS },
      removeOnComplete: { count: 50 },
      removeOnFail:     { count: 50 },
    },
  )

  const worker = new Worker(
    Q.cron,
    async (job: Job) => {
      if (job.name !== 'instagram-comment-poller-tick') return { skipped: 'not for me' }
      return runTick()
    },
    { connection, concurrency: 1 },
  )

  worker.on('failed', (job, err) => {
    if (job?.name === 'instagram-comment-poller-tick') {
      console.warn(`[ig-comment-poller] tick failed: ${err.message}`)
    }
  })

  console.log(`[worker:ig-comment-poller] started, interval=${TICK_INTERVAL_MS}ms`)
  return worker
}

interface IgConn {
  tenantId: string
  token: string
  igUserId: string
}

async function runTick() {
  const startedAt = Date.now()
  let postsScanned = 0
  let commentsInserted = 0

  // Pull tenants with IG connected AND at least one live workflow that
  // subscribes to comment triggers OR at least one enabled comment rule.
  // Filtering at the SQL layer keeps the poll fan-out lean — we'd otherwise
  // hammer Meta for tenants who haven't authored anything to act on.
  const { data: integrations } = await supabase
    .from('tenant_integrations')
    .select('tenant_id, access_token, metadata')
    .eq('key', 'instagram')
    .in('status', ['active', null] as any)
    .limit(MAX_TENANTS_PER_TICK)

  const conns: IgConn[] = []
  for (const row of integrations ?? []) {
    const meta = (row.metadata ?? {}) as { ig_user_id?: string }
    if (!row.access_token || !meta.ig_user_id) continue
    let token: string
    try { token = decrypt(row.access_token) }
    catch (e: any) {
      console.warn(`[ig-comment-poller] decrypt failed for tenant ${row.tenant_id}: ${e?.message ?? e}`)
      continue
    }
    conns.push({ tenantId: row.tenant_id, token, igUserId: meta.ig_user_id })
  }

  for (const conn of conns) {
    try {
      // Cheap pre-filter: only poll if this tenant has (a) at least one
      // enabled ig_comment_rule OR (b) a live workflow with an
      // instagram_comment trigger. Otherwise we'd burn the tenant's Meta
      // quota for zero benefit.
      const hasRule = await tenantHasCommentSurface(conn.tenantId)
      if (!hasRule) continue

      // List recent media. `fields=id` only — we follow up with /comments
      // per post and only need the post id here.
      const list = await fetch(`${GRAPH}/${conn.igUserId}/media?fields=id,timestamp&limit=${MAX_POSTS_PER_TENANT}&access_token=${conn.token}`).then(r => r.json()) as any
      if (list?.error) {
        console.warn(`[ig-comment-poller] media list failed for tenant ${conn.tenantId}: ${list.error.message}`)
        continue
      }
      const media: any[] = Array.isArray(list?.data) ? list.data : []

      // Batch-load all cursors for this tenant's tracked posts in a single
      // round-trip. The old code did one SELECT per post inside the loop —
      // for 50 tenants × 25 posts that was 1,250 round-trips per minute,
      // dominated by Supabase RTT. One query collapses that to 50/min.
      const postIds = media.map(m => String(m?.id ?? '')).filter(Boolean)
      const cursorByPost = new Map<string, string | null>()
      if (postIds.length > 0) {
        const { data: cursorRows } = await supabase
          .from('instagram_poller_cursors')
          .select('post_id, last_seen_at')
          .eq('tenant_id', conn.tenantId)
          .in('post_id', postIds)
        for (const cr of cursorRows ?? []) {
          cursorByPost.set(String(cr.post_id), (cr.last_seen_at as string | null) ?? null)
        }
      }

      for (const m of media) {
        if (!m?.id) continue
        const postId = String(m.id)
        postsScanned++

        // Cursor: only fetch comments newer than what we've seen for this
        // post on a previous tick. Read from the pre-batched map.
        const sinceIso = cursorByPost.get(postId) ?? null

        const fields = 'id,text,username,from,parent_id,permalink,timestamp,replies'
        const url = `${GRAPH}/${postId}/comments?fields=${fields}&limit=50&access_token=${conn.token}`
        const resp = await fetch(url).then(r => r.json()) as any
        if (resp?.error) {
          // (#100) "no permission" can happen on legacy posts — silent.
          if (!/permission/i.test(resp.error.message ?? '')) {
            console.warn(`[ig-comment-poller] comments fetch failed post=${postId}: ${resp.error.message}`)
          }
          continue
        }
        const comments: any[] = Array.isArray(resp?.data) ? resp.data : []

        let newestSeen: Date | null = null
        for (const c of comments) {
          if (!c?.id) continue
          const created = c.timestamp ? new Date(c.timestamp) : null
          if (sinceIso && created && created <= new Date(sinceIso)) continue

          const inserted = await supabase.from('instagram_comment_events').insert({
            tenant_id:          conn.tenantId,
            post_id:            postId,
            comment_id:         String(c.id),
            parent_comment_id:  c.parent_id ? String(c.parent_id) : null,
            commenter_ig_id:    c.from?.id ?? c.username ?? null,
            commenter_username: c.username ?? c.from?.username ?? null,
            text:               c.text ?? null,
            permalink:          c.permalink ?? null,
            source:             'poller',
            ig_created_at:      created ? created.toISOString() : null,
            raw:                c,
          })
          // duplicate-key is the expected path when webhook saw it first.
          if (!inserted.error) {
            commentsInserted++
          } else if (!/duplicate key|unique/i.test(inserted.error.message ?? '')) {
            console.warn(`[ig-comment-poller] insert failed comment=${c.id}: ${inserted.error.message}`)
          }
          if (created && (!newestSeen || created > newestSeen)) newestSeen = created
        }

        // Update cursor (upsert).
        await supabase.from('instagram_poller_cursors').upsert({
          tenant_id:    conn.tenantId,
          post_id:      postId,
          last_seen_at: newestSeen ? newestSeen.toISOString() : sinceIso,
          last_run_at:  new Date().toISOString(),
        }, { onConflict: 'tenant_id,post_id' })
      }
    } catch (e: any) {
      console.warn(`[ig-comment-poller] tenant ${conn.tenantId} tick errored: ${e?.message ?? e}`)
    }
  }

  return {
    duration_ms:        Date.now() - startedAt,
    tenants_polled:     conns.length,
    posts_scanned:      postsScanned,
    comments_inserted:  commentsInserted,
  }
}

async function tenantHasCommentSurface(tenantId: string): Promise<boolean> {
  // Enabled rule?
  const { count: rules } = await supabase.from('ig_comment_rules')
    .select('id', { count: 'exact', head: true })
    .eq('tenant_id', tenantId).eq('enabled', true)
  if ((rules ?? 0) > 0) return true

  // Live workflow with an instagram_comment trigger? We pull the nodes for
  // the cheapest set of live workflows and scan in-memory — the typical
  // tenant has <20 workflows so this stays cheap.
  const { data: wfs } = await supabase.from('workflows')
    .select('nodes').eq('tenant_id', tenantId).eq('status', 'live').limit(50)
  for (const wf of wfs ?? []) {
    const nodes = ((wf as any).nodes ?? []) as any[]
    if (nodes.some(n => n?.type === 'instagram_comment')) return true
  }
  return false
}
