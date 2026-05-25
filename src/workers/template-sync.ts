/**
 * Worker: template-sync (singleton repeatable, every 15 min)
 *
 * Polls Meta's WhatsApp Business Account templates endpoint per active tenant
 * and reconciles `public.wa_templates.status` so the UI shows up-to-date
 * approval state (was: "PENDING" forever once submitted).
 *
 * Meta returns one of: APPROVED | PENDING | REJECTED | DELETED | IN_APPEAL | PAUSED
 * → mapped to lowercase to match the wa_templates.status CHECK constraint
 *   (expanded in migration 011).
 *
 * Hot-path notes:
 *   - We page through with limit=100; tenants typically have <50 templates.
 *   - Failed tenants don't block other tenants — each is wrapped in try/catch.
 *   - This is a separate queue (system.cron) so a slow Meta API doesn't stall
 *     workflow execution.
 */

import '../env'
import { Worker, Job } from 'bullmq'
import { createClient } from '@supabase/supabase-js'
import { Q, connection, cronQueue } from '../queue'
import { emitNotification } from '../routes/notifications'
import { isPollerEnabled, cleanRepeatablesByName, STUB_WORKER, logGate, pollIntervalMs } from '../lib/poller-gate'
import { parseComponents } from '../lib/wa-components'

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://yiicpndeggaedxobyopu.supabase.co'
const supabase = createClient(SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY!)

const GRAPH = 'https://graph.facebook.com/v18.0'
// 15 min prod · 60 min dev.
const SYNC_INTERVAL_MS = pollIntervalMs('TEMPLATE_SYNC_INTERVAL_MS', { prod: 15 * 60_000, dev: 60 * 60_000 })

export async function startTemplateSyncWorker() {
  const enabled = isPollerEnabled('TEMPLATE_SYNC')
  logGate('TEMPLATE_SYNC', enabled)
  if (!enabled) {
    await cleanRepeatablesByName(cronQueue, 'template-sync')
    return STUB_WORKER
  }

  // Schedule the singleton repeatable tick on the same cron queue.
  await cronQueue.add(
    'template-sync',
    { task: 'template-sync' },
    {
      jobId: 'singleton-template-sync',
      repeat: { every: SYNC_INTERVAL_MS },
      removeOnComplete: { count: 50 },
      removeOnFail:     { count: 50 },
    }
  )

  // Worker that handles only template-sync jobs from system.cron.
  // (The schedule-poller worker on the same queue ignores this job kind via name filter.)
  const worker = new Worker(
    Q.cron,
    async (job: Job) => {
      // Only process the template-sync job; let other workers handle other names.
      if (job.name !== 'template-sync') return { skipped: 'not template-sync' }
      return runSync()
    },
    {
      connection,
      concurrency: 1,
    }
  )

  worker.on('failed', (job, err) => {
    if (job?.name === 'template-sync') {
      console.warn(`[template-sync] tick failed: ${err.message}`)
    }
  })

  console.log(`[worker:template-sync] started, interval=${SYNC_INTERVAL_MS}ms`)
  return worker
}

async function runSync() {
  const startedAt = Date.now()
  const { data: tenants, error } = await supabase
    .from('tenants')
    .select('id, waba_id, access_token, user_id')
    .eq('status', 'active')
    .not('access_token', 'is', null)
  if (error) throw new Error(`load tenants: ${error.message}`)
  if (!tenants || tenants.length === 0) return { tenants: 0 }

  let totalTemplates = 0
  let updated = 0
  let deleted = 0
  let failedTenants = 0

  for (const tenant of tenants) {
    if (!tenant.waba_id || !tenant.access_token) continue
    try {
      const r = await syncTenant(tenant as any)
      totalTemplates += r.fetched
      updated += r.updated
      deleted += r.deleted
    } catch (err: any) {
      failedTenants++
      console.warn(`[template-sync] tenant=${tenant.id} failed: ${err.message}`)
    }
  }

  const duration = Date.now() - startedAt
  console.log(`[template-sync] tenants=${tenants.length} fetched=${totalTemplates} updated=${updated} deleted=${deleted} failed=${failedTenants} ${duration}ms`)
  return { tenants: tenants.length, fetched: totalTemplates, updated, deleted, failedTenants, durationMs: duration }
}

/**
 * Sync templates for a single tenant. Exported so the /api/wa-templates/sync
 * endpoint can trigger an on-demand resync (e.g. immediately after a WABA
 * reconnect, when the tenant's stored access_token/waba_id pair has just
 * changed and the cron's 15-minute tick is too slow).
 *
 * Destructive: any locally-stored template whose (name, language) key is
 * NOT in Meta's response gets deleted. This is the only way to clean up
 * stale templates when the tenant switches WABAs (templates were synced
 * from the old WABA; the new WABA doesn't have them → they'd otherwise
 * sit in the picker forever and fail with #132001 on send).
 *
 * Safety: if Meta returns ZERO templates for this WABA, we SKIP the
 * delete. Easy mistake: a transient Meta outage could otherwise wipe
 * every template the tenant has. Real WABAs always have at least
 * `hello_world`, so an empty response is almost always wrong.
 */
export async function syncTenant(tenant: { id: string; waba_id: string; access_token: string; user_id: string | null }): Promise<{ fetched: number; updated: number; deleted: number }> {
  if (!tenant.waba_id || !tenant.access_token) {
    return { fetched: 0, updated: 0, deleted: 0 }
  }
  const templates = await fetchTemplates(tenant.waba_id, tenant.access_token)

  // Pre-fetch existing rows for this tenant so we can DIFF status &
  // category in one pass instead of N round-trips. One row per
  // (tenant_id, name, language) is the natural key.
  const { data: priorRows } = await supabase
    .from('wa_templates')
    .select('id, name, language, category, status')
    .eq('tenant_id', tenant.id)
  const priorByKey = new Map<string, { id: string; category: string | null; status: string | null }>()
  for (const p of (priorRows ?? []) as any[]) {
    priorByKey.set(`${p.name}|${p.language}`, { id: p.id, category: p.category, status: p.status })
  }

  // Track which keys Meta returned so we can purge stale ones below.
  const seenKeys = new Set<string>()
  let updated = 0

  for (const t of templates) {
        const status = mapStatus(t.status)
        const metaCategory = String(t.category ?? '').toLowerCase() || null
        const key = `${t.name}|${t.language}`
        const prior = priorByKey.get(key)

        // Detect category reclassification — i.e. Meta moved the template
        // between marketing / utility / authentication. The pricing cliff
        // is utility→marketing (~7× per-message cost) but ANY change can
        // affect delivery rates, so we notify + pause regardless of
        // direction. First-seen rows (no prior) DON'T count as a change.
        const categoryChanged = !!(prior
          && prior.category
          && metaCategory
          && prior.category.toLowerCase() !== metaCategory)

        // Parse Meta's components array → our flat columns. This is the
        // source of truth for what the recipient actually sees on their
        // phone, so we ALWAYS overwrite (no diff guard) — if a tenant
        // edited the template on business.facebook.com, we want our DB
        // to reflect that on next sync.
        const parsed = parseComponents(t.components)

        const patch: Record<string, any> = {
          tenant_id: tenant.id,
          user_id:   tenant.user_id ?? null,
          name:      t.name,
          language:  t.language,
          status,
          meta_template_id: t.id,
          rejection_reason: t.rejected_reason ?? null,
          body:    parsed.body,
          header:  parsed.header,
          footer:  parsed.footer,
          buttons: parsed.buttons,
          last_synced_at: new Date().toISOString(),
        }
        // Category: ALWAYS include in patch — wa_templates.category is
        // NOT NULL, and PostgREST upserts go through INSERT...ON CONFLICT
        // even when the conflict resolves to UPDATE, so a missing
        // `category` key fails the NOT NULL constraint on the INSERT
        // attempt and the row never updates. Carry forward the prior
        // value when category hasn't changed; stamp the new value (and
        // the change-trail) when it has.
        if (categoryChanged) {
          patch.category            = metaCategory
          patch.previous_category   = prior!.category
          patch.category_changed_at = new Date().toISOString()
        } else if (prior) {
          patch.category = prior.category ?? metaCategory ?? 'utility'
        } else {
          patch.category = metaCategory ?? 'utility'
        }

        // UPSERT (was UPDATE-only) so templates created OUT-OF-BAND
        // (business.facebook.com directly, or POST /api/wa-templates
        // before this row landed locally) actually appear in our DB
        // and become selectable in the inbox composer.
        const { error: upErr } = await supabase.from('wa_templates')
          .upsert(patch, { onConflict: 'tenant_id,name,language' })
        if (upErr) {
          console.warn(`[template-sync] upsert FAILED tenant=${tenant.id} name=${t.name} lang=${t.language}: ${upErr.message}`)
        } else {
          updated++
        }
        // Always mark the key as "seen by Meta" regardless of whether the
        // upsert into our DB succeeded. The destructive purge below should
        // be driven by what Meta returned, not what our DB write managed
        // to persist — otherwise a transient DB error (constraint hiccup,
        // schema drift, etc.) on row N causes us to DELETE row N's
        // existing data, which is the opposite of self-healing.
        seenKeys.add(key)

        // If category changed, pause every active campaign that
        // references this template + notify the tenant's admins.
        if (categoryChanged) {
          await handleCategoryReclassification({
            tenantId:        tenant.id,
            tenantUserId:    tenant.user_id,
            templateName:    t.name,
            fromCategory:    prior!.category!,
            toCategory:      metaCategory!,
          })
        }
      }

  // ──────────────────────────────────────────────────────────────────────
  // Destructive purge: delete any local template whose (name, language)
  // key wasn't returned by Meta this run. Catches the WABA-switch case
  // where the tenant was previously on WABA A (synced 103 templates) and
  // is now on WABA B (which has none of them) — without this purge, the
  // 103 stale rows sit in the picker forever and every send fails with
  // #132001.
  //
  // Safety: skip purge if Meta returned ZERO templates — almost always a
  // transient error (a real WABA at minimum has `hello_world`). Without
  // this guard, a single bad Meta response could wipe every template a
  // tenant has, which would be catastrophic.
  // ──────────────────────────────────────────────────────────────────────
  let deleted = 0
  if (templates.length > 0) {
    const staleIds: string[] = []
    for (const [k, v] of priorByKey.entries()) {
      if (!seenKeys.has(k)) staleIds.push(v.id)
    }
    if (staleIds.length > 0) {
      const { error: delErr, count } = await supabase
        .from('wa_templates')
        .delete({ count: 'exact' })
        .eq('tenant_id', tenant.id)
        .in('id', staleIds)
      if (delErr) {
        console.warn(`[template-sync] purge failed tenant=${tenant.id}: ${delErr.message}`)
      } else {
        deleted = count ?? staleIds.length
        console.log(`[template-sync] purged ${deleted} stale templates for tenant=${tenant.id}`)
      }
    }
  }

  return { fetched: templates.length, updated, deleted }
}

async function fetchTemplates(wabaId: string, accessToken: string) {
  // Meta returns 25 by default; bump to 100 to cover most tenants in 1 page.
  // `components` is the source of truth for header/body/footer/buttons —
  // without it, every newly-synced template lands with those columns NULL
  // and the inbox/composer renders an empty preview. Cost: a few KB per
  // template per page, negligible vs. the per-tenant page-of-100 baseline.
  const url = `${GRAPH}/${wabaId}/message_templates?limit=100&fields=id,name,language,status,category,rejected_reason,components`
  const out: any[] = []
  let next: string | null = url
  let pages = 0
  while (next && pages < 5) {  // hard cap pages so a runaway Meta response can't loop forever
    const r = await fetch(next, { headers: { Authorization: `Bearer ${accessToken}` } })
    if (!r.ok) {
      const txt = await r.text()
      throw new Error(`Meta ${r.status}: ${txt.slice(0, 200)}`)
    }
    const body = await r.json() as any
    if (Array.isArray(body.data)) out.push(...body.data)
    next = body.paging?.next ?? null
    pages++
  }
  return out
}

// `parseComponents` previously lived inline here. Moved to
// src/lib/wa-components.ts so the create endpoint can use the same
// parser (and the same media-header / URL-button preservation logic).
// See the import at the top of the file.

function mapStatus(metaStatus: string): string {
  const s = (metaStatus ?? '').toLowerCase()
  // Meta's `IN_APPEAL` → `in_appeal`, `DELETED` → `deleted`, etc.
  return s.replace(/[^a-z_]/g, '_') || 'pending'
}

/**
 * Auto-pause every active campaign in `tenantId` that uses `templateName`
 * in any `send_template` step, and emit an in-app notification so the
 * admin sees the situation immediately. Best-effort across all the
 * dependent steps — a partial failure in one DB call shouldn't roll back
 * the template's category update (the most important write).
 *
 * Why pause ALL campaigns using the template (not just those affected by
 * the price cliff)?
 *   - Marketing → Utility is RARE but still affects delivery (Meta's
 *     marketing quality rating recalculates).
 *   - Utility → Marketing is the cliff scenario (~7× cost spike). Active
 *     campaigns can BURN BUDGET in minutes if left running.
 *   - Either direction warrants human review before resending. The
 *     amber banner + Resume button on /campaigns is one click away.
 */
async function handleCategoryReclassification(args: {
  tenantId:     string
  tenantUserId: string | null
  templateName: string
  fromCategory: string
  toCategory:   string
}) {
  const { tenantId, tenantUserId, templateName, fromCategory, toCategory } = args

  // Find every active campaign whose steps reference this template. The
  // step `kind = 'send_template'` writes the name into `config.template_name`
  // per migration 012. We do this as a single fetch + JS-side filter
  // because the JSONB path filter `config->>template_name` requires a
  // GIN index we don't have, and the active-campaigns set per tenant is
  // typically small (<100).
  const { data: stepRows, error: stepsErr } = await supabase
    .from('campaign_steps')
    .select('campaign_id, config')
    .eq('tenant_id', tenantId)
    .eq('kind', 'send_template')
  if (stepsErr) {
    console.warn(`[template-sync] steps lookup failed tenant=${tenantId}: ${stepsErr.message}`)
    return
  }

  const affectedCampaignIds = new Set<string>()
  for (const s of (stepRows ?? []) as any[]) {
    const cfg = s.config ?? {}
    if (String(cfg.template_name ?? '') === templateName) {
      affectedCampaignIds.add(s.campaign_id as string)
    }
  }
  if (affectedCampaignIds.size === 0) {
    console.log(`[template-sync] category change observed tenant=${tenantId} template=${templateName} ${fromCategory}→${toCategory} (no campaigns affected)`)
    return
  }

  // Pause every active one. Idempotent — already-paused rows stay paused
  // but we don't clobber their existing pause_reason.
  const { data: paused, error: pauseErr } = await supabase
    .from('campaigns')
    .update({ status: 'paused', pause_reason: 'template_reclassified' })
    .in('id', Array.from(affectedCampaignIds))
    .eq('tenant_id', tenantId)
    .eq('status', 'active')
    .select('id, name')
  if (pauseErr) {
    // The pause_reason column may be missing on schemas where migration
    // 068 hasn't been applied — fall back to a status-only update so the
    // safety net still triggers.
    if (/column .*pause_reason.* does not exist/i.test(pauseErr.message)) {
      await supabase.from('campaigns')
        .update({ status: 'paused' })
        .in('id', Array.from(affectedCampaignIds))
        .eq('tenant_id', tenantId)
        .eq('status', 'active')
    } else {
      console.warn(`[template-sync] pause failed tenant=${tenantId}: ${pauseErr.message}`)
      return
    }
  }
  const pausedCount = paused?.length ?? affectedCampaignIds.size
  const pausedNames = (paused ?? []).map((p: any) => p.name).filter(Boolean).slice(0, 5)

  console.log(`[template-sync] AUTO-PAUSED tenant=${tenantId} template=${templateName} ${fromCategory}→${toCategory} campaigns=${pausedCount}`)

  // Notify the tenant owner. We deliberately don't blast every team
  // member — the campaign owner / admin needs to know first.
  // `campaign.auto_paused` is added to notification_event_types in the
  // 068 migration's sibling seed (see migration 029-style INSERT below
  // in this batch's seed pass).
  if (tenantUserId) {
    try {
      await emitNotification(supabase, {
        tenant_id:           tenantId,
        event_key:           'campaign.auto_paused',
        recipient_user_ids:  [tenantUserId],
        link:                '/campaigns',
        data: {
          template_name:        templateName,
          from_category:        fromCategory,
          to_category:          toCategory,
          affected_count:       pausedCount,
          affected_names_preview: pausedNames.join(', ') || 'multiple campaigns',
        },
      })
    } catch (e: any) {
      // Notification failure is non-fatal — the pause already landed.
      console.warn(`[template-sync] notification emit failed: ${e?.message ?? e}`)
    }
  }
}
