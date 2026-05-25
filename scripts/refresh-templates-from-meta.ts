/**
 * One-off refresh of wa_templates for a tenant — pulls live components
 * from Meta and writes body / header / footer / buttons.
 *
 * Use when the recurring template-sync worker has populated metadata only
 * (status / category) but the content columns are missing/stale and the
 * inbox preview is showing "No preview available".
 *
 * Run:  TENANT_ID=<uuid> npx tsx scripts/refresh-templates-from-meta.ts
 * Default TENANT_ID = acme.
 */
import 'dotenv/config'
import { createClient } from '@supabase/supabase-js'

const TENANT_ID = process.env.TENANT_ID ?? '56481854-951e-40b2-9a3a-aa1e7254fdb0'
const GRAPH     = 'https://graph.facebook.com/v22.0'

const sb = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false } },
)

function parseComponents(components: any[]) {
  let body: string | null = null
  let header: { text: string; type: string } | null = null
  let footer: string | null = null
  const buttons: Array<{ text: string; type: string }> = []
  for (const c of components ?? []) {
    const t = String(c?.type ?? '').toUpperCase()
    if (t === 'BODY')   body   = c?.text ?? null
    else if (t === 'HEADER' && c?.text) header = { text: String(c.text), type: String(c.format ?? 'text').toLowerCase() }
    else if (t === 'FOOTER') footer = c?.text ?? null
    else if (t === 'BUTTONS' && Array.isArray(c?.buttons)) {
      for (const b of c.buttons) {
        if (b?.text) buttons.push({ text: String(b.text), type: String(b.type ?? 'QUICK_REPLY') })
      }
    }
  }
  return { body, header, footer, buttons }
}

async function main() {
  const { data: tenant, error: tErr } = await sb.from('tenants')
    .select('id, waba_id, access_token, slug').eq('id', TENANT_ID).maybeSingle()
  if (tErr || !tenant) throw new Error(`tenant not found: ${tErr?.message}`)
  if (!tenant.waba_id || !tenant.access_token) throw new Error('tenant missing waba_id/access_token')
  console.log(`[refresh] tenant=${tenant.slug} waba=${tenant.waba_id}`)

  // Page through Meta
  let next: string | null = `${GRAPH}/${tenant.waba_id}/message_templates?limit=100&fields=id,name,language,status,category,components`
  const all: any[] = []
  while (next) {
    const r = await fetch(next, { headers: { Authorization: `Bearer ${tenant.access_token}` } })
    if (!r.ok) throw new Error(`Meta ${r.status}: ${(await r.text()).slice(0, 200)}`)
    const j = await r.json() as any
    all.push(...(j.data ?? []))
    next = j.paging?.next ?? null
  }
  console.log(`[refresh] Meta returned ${all.length} templates`)

  let touched = 0, inserted = 0, errored = 0
  for (const t of all) {
    const parsed = parseComponents(t.components)
    const { data: existing } = await sb.from('wa_templates').select('id')
      .eq('tenant_id', tenant.id).eq('name', t.name).eq('language', t.language).maybeSingle()

    const row: any = {
      tenant_id: tenant.id,
      user_id:   (tenant as any).user_id ?? null,
      name:      t.name,
      language:  t.language,
      status:    (t.status ?? '').toLowerCase().replace(/[^a-z_]/g, '_') || 'pending',
      category:  (t.category ?? '').toLowerCase() || null,
      meta_template_id: t.id,
      body:      parsed.body,
      header:    parsed.header,
      footer:    parsed.footer,
      buttons:   parsed.buttons,
      last_synced_at: new Date().toISOString(),
    }

    if (existing) {
      const { error: uErr } = await sb.from('wa_templates').update(row).eq('id', existing.id)
      if (uErr) { errored++; console.warn(`  update ${t.name}: ${uErr.message}`) } else { touched++ }
    } else {
      const { error: iErr } = await sb.from('wa_templates').insert(row)
      if (iErr) { errored++; console.warn(`  insert ${t.name}: ${iErr.message}`) } else { inserted++ }
    }
  }
  console.log(`[refresh] done — updated=${touched} inserted=${inserted} errored=${errored}`)
}

main().catch(e => { console.error(e); process.exit(1) })
