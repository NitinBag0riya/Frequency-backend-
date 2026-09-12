/**
 * meta-graph-sync.ts — Graph API helpers shared by the Meta Ads connect
 * callback (routes/meta-business-assets.ts + routes/meta-ads.ts) and the
 * Lead Ads webhook (routes/meta-webhook.ts).
 *
 * Three responsibilities, in the order the callback fires them:
 *
 *   1. backfillPagesAndForms(tenantId, userToken)
 *      - Enumerate /me/accounts → upsert meta_ad_pages with the PAGE token
 *        (not the user token — Meta Lead Ads /leadgen fetches require the
 *        page's token, which is what /me/accounts?fields=access_token
 *        returns).
 *      - Subscribe app to `leadgen` on each page (idempotent).
 *      - Enumerate /{page_id}/leadgen_forms per page → upsert meta_lead_forms.
 *
 *   2. syncCustomAudiences(tenantId)
 *      - Mirror the tenant's pre-existing Ads-Manager custom audiences into
 *        meta_audiences (keyed by remote_id). Otherwise users see nothing on
 *        /ads/meta/audiences until they create one through Frequency.
 *
 * Both helpers are idempotent and safe to re-run — the FBLfB callback,
 * the classic OAuth callback, and the manual /audiences/refresh endpoint
 * all call the same code.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { encrypt, decrypt } from '../crypto'

export const GRAPH = 'https://graph.facebook.com/v21.0'

// ── Page + Lead Form backfill ────────────────────────────────────────────────

interface FbPage {
  id: string
  name?: string
  access_token?: string
}

export async function backfillPagesAndForms(
  supabase: SupabaseClient,
  tenantId: string,
  userToken: string,
): Promise<{ pages: number; forms: number; errors: string[] }> {
  const errors: string[] = []
  let pageCount = 0
  let formCount = 0

  // Step 1: enumerate pages the user manages. The page token that comes
  // back here is what /leadgen fetches sign against — the user token can
  // read the form list but NOT retrieve individual lead rows.
  let pages: FbPage[] = []
  try {
    const j = await fetch(
      `${GRAPH}/me/accounts?fields=id,name,access_token&access_token=${encodeURIComponent(userToken)}`,
    ).then(r => r.json()) as any
    if (j?.error) throw new Error(j.error.message)
    pages = Array.isArray(j?.data) ? j.data : []
  } catch (e: any) {
    errors.push(`me/accounts: ${e?.message ?? e}`)
    return { pages: 0, forms: 0, errors }
  }

  // Step 2: per page — upsert row, subscribe leadgen, pull forms.
  for (const p of pages) {
    if (!p.id || !p.access_token) continue

    // Subscribe app to leadgen (idempotent — Meta happily returns
    // { success: true } on repeated calls with the same fields).
    let subscribed = false
    try {
      const s = await fetch(`${GRAPH}/${p.id}/subscribed_apps`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          subscribed_fields: 'leadgen',
          access_token: p.access_token,
        }).toString(),
      }).then(r => r.json()) as any
      if (s?.error) errors.push(`subscribe ${p.id}: ${s.error.message}`)
      else subscribed = !!s?.success
    } catch (e: any) {
      errors.push(`subscribe ${p.id}: ${e?.message ?? e}`)
    }

    const { error: pageErr } = await supabase.from('meta_ad_pages').upsert({
      tenant_id:          tenantId,
      page_id:            p.id,
      name:               p.name ?? null,
      page_access_token:  encrypt(p.access_token),
      subscribed_leadgen: subscribed,
      updated_at:         new Date().toISOString(),
    }, { onConflict: 'page_id' as any })
    if (pageErr) {
      errors.push(`upsert page ${p.id}: ${pageErr.message}`)
      continue
    }
    pageCount += 1

    // Step 3: enumerate leadgen forms on this page. Each form is scoped to a
    // page, so this is the only place these ids come from.
    try {
      const f = await fetch(
        `${GRAPH}/${p.id}/leadgen_forms?fields=id,name,status,questions&limit=100&access_token=${encodeURIComponent(p.access_token)}`,
      ).then(r => r.json()) as any
      if (f?.error) { errors.push(`forms ${p.id}: ${f.error.message}`); continue }
      const forms: any[] = Array.isArray(f?.data) ? f.data : []
      for (const form of forms) {
        if (!form?.id) continue
        const { error: formErr } = await supabase.from('meta_lead_forms').upsert({
          tenant_id: tenantId,
          form_id:   String(form.id),
          name:      form.name ?? `Form ${form.id}`,
          page_id:   p.id,
          questions: Array.isArray(form.questions) ? form.questions : [],
        }, { onConflict: 'form_id' as any })
        if (formErr) { errors.push(`upsert form ${form.id}: ${formErr.message}`); continue }
        formCount += 1
      }
    } catch (e: any) {
      errors.push(`forms ${p.id}: ${e?.message ?? e}`)
    }
  }

  return { pages: pageCount, forms: formCount, errors }
}

// ── Custom-audience sync ─────────────────────────────────────────────────────

export async function syncCustomAudiences(
  supabase: SupabaseClient,
  tenantId: string,
): Promise<{ count: number; errors: string[] }> {
  const errors: string[] = []
  let count = 0

  // Read the user token from tenant_integrations. syncCustomAudiences may
  // be called from a /refresh endpoint (no token in hand), so resolve here.
  const { data: intg } = await supabase.from('tenant_integrations')
    .select('access_token').eq('tenant_id', tenantId).eq('key', 'meta_ads').maybeSingle()
  const token = intg?.access_token ? decrypt(intg.access_token) : null
  if (!token) return { count: 0, errors: ['meta_ads not connected'] }

  const { data: accounts } = await supabase.from('meta_ad_accounts')
    .select('ad_account_id').eq('tenant_id', tenantId)
  if (!accounts?.length) return { count: 0, errors: ['no ad accounts for tenant'] }

  const fields = 'id,name,subtype,description,approximate_count_lower_bound,approximate_count_upper_bound,delivery_status,operation_status,time_created'

  for (const a of accounts) {
    try {
      const j = await fetch(
        `${GRAPH}/${a.ad_account_id}/customaudiences?fields=${fields}&limit=200&access_token=${encodeURIComponent(token)}`,
      ).then(r => r.json()) as any
      if (j?.error) { errors.push(`${a.ad_account_id}: ${j.error.message}`); continue }
      const audiences: any[] = Array.isArray(j?.data) ? j.data : []
      for (const aud of audiences) {
        if (!aud?.id) continue
        const subtype = String(aud.subtype ?? 'CUSTOM').toUpperCase()
        // meta_audiences.type CHECK: ('CUSTOM','LOOKALIKE','VALUE_BASED').
        // Meta returns richer subtypes (WEBSITE, ENGAGEMENT, VIDEO, …). Map
        // everything unknown to CUSTOM so the insert doesn't blow up.
        const type = ['CUSTOM', 'LOOKALIKE', 'VALUE_BASED'].includes(subtype) ? subtype : 'CUSTOM'
        const upper = aud.approximate_count_upper_bound ?? null
        const { error: upErr } = await supabase.from('meta_audiences').upsert({
          tenant_id:                  tenantId,
          ad_account_id:              a.ad_account_id,
          remote_id:                  String(aud.id),
          meta_audience_id:           String(aud.id),
          name:                       aud.name ?? `Audience ${aud.id}`,
          type,
          source:                     aud.description ?? 'meta_sync',
          approximate_count:          upper != null ? Number(upper) : null,
          delivery_status:            aud.delivery_status ?? null,
          operation_status:           aud.operation_status ?? null,
          last_estimate_refreshed_at: new Date().toISOString(),
          last_error:                 null,
        }, { onConflict: 'tenant_id,remote_id' as any })
        if (upErr) { errors.push(`upsert ${aud.id}: ${upErr.message}`); continue }
        count += 1
      }
    } catch (e: any) {
      errors.push(`${a.ad_account_id}: ${e?.message ?? e}`)
    }
  }

  return { count, errors }
}
