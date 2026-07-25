/**
 * Read-only WhatsApp account inspector.
 *
 * Prints what Meta reports for every connected tenant: number, verified name,
 * messaging tier, quality, review + verification status, and which apps are
 * subscribed to the WABA's webhooks. Secrets are read via the same
 * resolveWaCreds() path production uses and are never printed.
 *
 * Run: npx tsx src/scripts/probe-wa.ts
 */

import './../env'
import { createClient } from '@supabase/supabase-js'
import { resolveWaCreds, probeWabaCapability } from '../lib/wa-creds'

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
)

const GRAPH = 'https://graph.facebook.com/v18.0'

/**
 * Which Meta app do our configured META_APP_ID + META_APP_SECRET actually
 * belong to? An app access token is literally `{id}|{secret}`, so asking Meta
 * to identify it proves the pair is consistent AND names the app — the check
 * that catches an id/secret pair left over from a different app.
 */
async function identifyConfiguredApp() {
  const id = process.env.META_APP_ID
  const secret = process.env.META_APP_SECRET
  if (!id || !secret) { console.log('⚠️  META_APP_ID / META_APP_SECRET not set\n'); return }

  const r = await fetch(`${GRAPH}/app?fields=id,name&access_token=${encodeURIComponent(`${id}|${secret}`)}`)
  const j: any = await r.json()
  if (j?.error) {
    console.log(`⚠️  configured META_APP_ID=${id} + secret REJECTED by Meta: ${j.error.message}\n`)
    return
  }
  console.log(`Configured app: ${j.name} (${j.id})`)
  if (j.id !== id) console.log(`  ⚠️  secret belongs to ${j.id}, but META_APP_ID says ${id}`)
  console.log()
}

/**
 * Walk every business + WABA the stored token can see and list their numbers.
 *
 * Needed because a number added in Business Manager only shows up in our
 * tenants table once it is connected to Frequency — so "I added a number and
 * it isn't showing" is almost always a WABA we've never been pointed at.
 * Pass a number (digits only) to highlight where it lives.
 */
async function findNumber(accessToken: string, needle?: string) {
  const digits = (s: string) => s.replace(/\D/g, '')
  const hunting = needle ? digits(needle) : ''

  const bizRes = await fetch(`${GRAPH}/me/businesses?fields=id,name&limit=50`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  })
  const biz: any = await bizRes.json()
  if (biz?.error) { console.log(`  business lookup failed: ${biz.error.message}`); return }

  for (const b of biz?.data ?? []) {
    console.log(`\nBusiness: ${b.name} (${b.id})`)
    for (const edge of ['owned_whatsapp_business_accounts', 'client_whatsapp_business_accounts']) {
      const r = await fetch(`${GRAPH}/${b.id}/${edge}?fields=id,name&limit=50`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      })
      const j: any = await r.json()
      for (const w of j?.data ?? []) {
        const pr = await fetch(
          `${GRAPH}/${w.id}/phone_numbers?fields=display_phone_number,verified_name,quality_rating,messaging_limit_tier,code_verification_status`,
          { headers: { Authorization: `Bearer ${accessToken}` } },
        )
        const pj: any = await pr.json()
        const nums = pj?.data ?? []
        console.log(`  WABA ${w.id}  "${w.name}"  (${edge.startsWith('owned') ? 'owned' : 'client'}) — ${nums.length} number(s)`)
        for (const n of nums) {
          const hit = hunting && digits(n.display_phone_number ?? '').endsWith(hunting)
          console.log(`    ${hit ? '★' : '·'} ${n.display_phone_number}  ${n.verified_name ?? ''}  tier=${n.messaging_limit_tier ?? '—'}  quality=${n.quality_rating ?? '—'}  verified=${n.code_verification_status ?? '—'}`)
          if (hit) console.log(`      ↑ MATCH — connect this WABA (${w.id}) to Frequency`)
        }
      }
    }
  }
}

/**
 * List the WABAs + numbers under one business portfolio.
 *
 * Tries each credential we hold, because which one works tells us something:
 * an app token proves nothing about business assets, while a user/system-user
 * token needs `business_management` for THIS business. Reporting which one
 * failed and how is the fastest route to the right fix.
 *
 * Usage: npx tsx src/scripts/probe-wa.ts --business <id> [number]
 */
async function inspectBusiness(businessId: string, needle?: string, tenantToken?: string | null) {
  const digits = (s: string) => s.replace(/\D/g, '')
  const hunting = needle ? digits(needle) : ''

  const candidates: Array<{ label: string; token: string }> = []
  if (process.env.META_APP_ID && process.env.META_APP_SECRET) {
    candidates.push({ label: 'app token', token: `${process.env.META_APP_ID}|${process.env.META_APP_SECRET}` })
  }
  if (tenantToken) candidates.push({ label: 'stored tenant token', token: tenantToken })

  for (const c of candidates) {
    console.log(`\n── via ${c.label} ──`)
    const nameRes = await fetch(`${GRAPH}/${businessId}?fields=id,name,verification_status`,
      { headers: { Authorization: `Bearer ${c.token}` } })
    const nameJson: any = await nameRes.json()
    if (nameJson?.error) { console.log(`  ✗ ${nameJson.error.message}`); continue }
    console.log(`  Business: ${nameJson.name} (${nameJson.id})  verification=${nameJson.verification_status ?? '—'}`)

    let found = 0
    for (const edge of ['owned_whatsapp_business_accounts', 'client_whatsapp_business_accounts']) {
      const r = await fetch(`${GRAPH}/${businessId}/${edge}?fields=id,name&limit=50`,
        { headers: { Authorization: `Bearer ${c.token}` } })
      const j: any = await r.json()
      if (j?.error) { console.log(`  ${edge}: ✗ ${j.error.message}`); continue }
      for (const w of j?.data ?? []) {
        found++
        const pr = await fetch(
          `${GRAPH}/${w.id}/phone_numbers?fields=display_phone_number,verified_name,quality_rating,messaging_limit_tier,code_verification_status`,
          { headers: { Authorization: `Bearer ${c.token}` } })
        const pj: any = await pr.json()
        const nums = pj?.data ?? []
        console.log(`  WABA ${w.id} "${w.name}" — ${nums.length} number(s)`)
        for (const n of nums) {
          const hit = hunting && digits(n.display_phone_number ?? '').endsWith(hunting)
          console.log(`    ${hit ? '★' : '·'} ${n.display_phone_number}  ${n.verified_name ?? ''}  tier=${n.messaging_limit_tier ?? '—'}  quality=${n.quality_rating ?? '—'}  verified=${n.code_verification_status ?? '—'}`)
          if (hit) console.log(`      ↑ MATCH — WABA ${w.id}`)
        }
      }
    }
    if (found) return
  }
}

async function main() {
  await identifyConfiguredApp()

  // Direct WABA lookup — `npx tsx src/scripts/probe-wa.ts --waba <id>`
  const wabaFlag = process.argv.indexOf('--waba')
  if (wabaFlag !== -1) {
    const wabaId = process.argv[wabaFlag + 1]
    const { data: t } = await supabase.from('tenants')
      .select('id').eq('waba_id', '1350661140220950').maybeSingle()
    const stored = t ? await resolveWaCreds(supabase, t.id) : null

    const candidates: Array<{ label: string; token: string }> = []
    // Operator-supplied token wins — it's the only one scoped to a business
    // we don't already have a tenant under. Passed via env so the credential
    // never lands in shell history or a process listing.
    if (process.env.WA_PROBE_TOKEN) {
      candidates.push({ label: 'WA_PROBE_TOKEN', token: process.env.WA_PROBE_TOKEN })
    }
    if (process.env.META_APP_ID && process.env.META_APP_SECRET) {
      candidates.push({ label: 'app token', token: `${process.env.META_APP_ID}|${process.env.META_APP_SECRET}` })
    }
    if (stored?.accessToken) candidates.push({ label: 'stored tenant token', token: stored.accessToken })

    console.log(`\nInspecting WABA ${wabaId} …`)
    for (const c of candidates) {
      console.log(`\n── via ${c.label} ──`)
      const cap = await probeWabaCapability(wabaId, c.token)
      if (!cap.ok) { console.log(`  ✗ ${cap.error}`); continue }
      console.log(`  Name              ${cap.wabaName ?? '—'}`)
      console.log(`  Number            ${cap.displayPhone ?? '—'}`)
      console.log(`  Verified name     ${cap.verifiedName ?? '—'}`)
      console.log(`  Numbers on WABA   ${cap.numbers}`)
      console.log(`  Messaging tier    ${cap.messagingTier ?? '—'}`)
      console.log(`  Quality rating    ${cap.qualityRating ?? '—'}`)
      console.log(`  Account review    ${cap.accountReviewStatus ?? '—'}`)
      console.log(`  Business verif.   ${cap.businessVerificationStatus ?? '—'}`)
      const r = await fetch(`${GRAPH}/${wabaId}/subscribed_apps`, { headers: { Authorization: `Bearer ${c.token}` } })
      const j: any = await r.json()
      const apps = (j?.data ?? []).map((a: any) => `${a.whatsapp_business_api_data?.name ?? '?'} (${a.whatsapp_business_api_data?.id ?? '?'})`)
      console.log(`  Subscribed apps   ${apps.length ? apps.join(', ') : '⚠️  NONE — inbound will not arrive'}`)
      return
    }
    return
  }

  const bizFlag = process.argv.indexOf('--business')
  if (bizFlag !== -1) {
    const businessId = process.argv[bizFlag + 1]
    const needle = process.argv[bizFlag + 2]
    const { data: t } = await supabase.from('tenants')
      .select('id').eq('waba_id', '1350661140220950').maybeSingle()
    const creds = t ? await resolveWaCreds(supabase, t.id) : null
    console.log(`\nInspecting business ${businessId}${needle ? ` for ${needle}` : ''} …`)
    await inspectBusiness(businessId, needle, creds?.accessToken)
    return
  }

  // Real WABAs only — the table is full of e2e fixtures with fake ids.
  const { data: tenants, error } = await supabase
    .from('tenants')
    .select('id, business_name, waba_id, phone_number_id, display_phone, wa_mode, status')
    .not('waba_id', 'is', null)
    .not('access_token', 'is', null)
    .eq('status', 'active')

  if (error) throw new Error(error.message)

  const real = (tenants ?? []).filter(t => /^\d+$/.test(String(t.waba_id)))
  console.log(`${tenants?.length ?? 0} connected tenants, ${real.length} with a real numeric WABA\n`)

  for (const t of real) {
    console.log('═'.repeat(64))
    console.log(`${t.business_name}  ·  mode=${t.wa_mode}  ·  tenant=${t.id}`)
    console.log(`WABA ${t.waba_id}   phone_number_id ${t.phone_number_id}`)

    const creds = await resolveWaCreds(supabase, t.id)
    if (!creds?.accessToken || !creds.wabaId) {
      console.log('  ⚠️  no usable credentials\n')
      continue
    }

    const cap = await probeWabaCapability(creds.wabaId, creds.accessToken)
    if (!cap.ok) {
      console.log(`  ❌ Meta says: ${cap.error}\n`)
      continue
    }

    console.log(`  Number            ${cap.displayPhone ?? '—'}`)
    console.log(`  Verified name     ${cap.verifiedName ?? '—'}`)
    console.log(`  Numbers on WABA   ${cap.numbers}`)
    console.log(`  Messaging tier    ${cap.messagingTier ?? '—'}`)
    console.log(`  Quality rating    ${cap.qualityRating ?? '—'}`)
    console.log(`  Account review    ${cap.accountReviewStatus ?? '—'}`)
    console.log(`  Business verif.   ${cap.businessVerificationStatus ?? '—'}`)

    // Which app(s) receive this WABA's webhooks — the thing that silently
    // breaks inbound when a tenant is onboarded through the wrong app.
    try {
      const r = await fetch(`${GRAPH}/${creds.wabaId}/subscribed_apps`, {
        headers: { Authorization: `Bearer ${creds.accessToken}` },
      })
      const j: any = await r.json()
      const apps = (j?.data ?? []).map((a: any) =>
        `${a.whatsapp_business_api_data?.name ?? '?'} (${a.whatsapp_business_api_data?.id ?? '?'})`)
      console.log(`  Subscribed apps   ${apps.length ? apps.join(', ') : '⚠️  NONE — inbound will not arrive'}`)
    } catch (e: any) {
      console.log(`  Subscribed apps   (lookup failed: ${e?.message})`)
    }
    console.log()

    // Discovery pass — every WABA this token can reach, not just the one we
    // already have on file. `npx tsx src/scripts/probe-wa.ts 9694993366`
    const needle = process.argv[2]
    if (needle) {
      console.log(`Searching every visible WABA for ${needle} …`)
      await findNumber(creds.accessToken, needle)
    }
  }
}

main().catch(e => { console.error(e); process.exit(1) })
