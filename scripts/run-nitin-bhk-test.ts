/**
 * End-to-end "real estate BHK button test" against the acme tenant.
 *
 * Idempotent — safe to re-run. Does, in order:
 *   1. Upsert contact "Nitin" / +917877427709 in acme
 *   2. Upsert workflow "Real estate BHK reply" — trigger_inbound_keyword on
 *      [1 BHK, 2 BHK, 3 BHK] → send_text(thank-you), status='live'
 *   3. Send the approved 'lead_welcome_bhk' (en_US) template to +917877427709
 *      via Meta Graph API using the tenant's own access_token
 *
 * Prints every step. Stops on first error.
 *
 * Run: `npx tsx scripts/run-nitin-bhk-test.ts`
 */

import 'dotenv/config'
import { createClient } from '@supabase/supabase-js'

const sb = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false } },
)

const ACME_SLUG     = 'acme'
const NITIN_PHONE   = '+917877427709'
const NITIN_DIGITS  = '917877427709'             // Meta wants no leading +
const NITIN_NAME    = 'Nitin'
const TEMPLATE_NAME = 'lead_welcome_bhk'
const TEMPLATE_LANG = 'en_US'
const WORKFLOW_NAME = 'Real estate BHK reply'
const BHK_KEYWORDS  = ['1 BHK', '2 BHK', '3 BHK']
const THANKYOU_MSG  =
  "Thanks for choosing {{trigger.text}}, {{contact.name}}! " +
  "Our team will reach out shortly with options that match your interest."

async function main() {
  // 0. Resolve tenant
  const { data: tenant, error: tErr } = await sb.from('tenants')
    .select('id, slug, business_name, user_id, waba_id, phone_number_id, access_token')
    .eq('slug', ACME_SLUG).single()
  if (tErr || !tenant) throw new Error(`tenant '${ACME_SLUG}' not found: ${tErr?.message}`)
  if (!tenant.access_token) throw new Error('acme has no access_token; cannot send via Meta')
  console.log(`✓ tenant: ${tenant.business_name} (${tenant.slug}) id=${tenant.id}`)

  // 1. Upsert contact
  //    Match on (tenant_id, phone). Don't blast updates — only fill name/tags if missing.
  const { data: existing } = await sb.from('contacts')
    .select('id, name, phone, tags, status')
    .eq('tenant_id', tenant.id)
    .eq('phone', NITIN_PHONE)
    .maybeSingle()

  let contactId: string
  if (existing) {
    contactId = existing.id
    console.log(`✓ contact exists: ${existing.name ?? '(no name)'} ${existing.phone} id=${contactId}`)
  } else {
    const { data: ins, error: cErr } = await sb.from('contacts').insert({
      tenant_id:  tenant.id,
      user_id:    tenant.user_id,
      name:       NITIN_NAME,
      phone:      NITIN_PHONE,
      status:     'active',
      tags:       ['lead', 'test-bhk-flow'],
      attributes: { source: 'bhk-test', test: true },
    }).select('id').single()
    if (cErr || !ins) throw new Error(`contact insert failed: ${cErr?.message}`)
    contactId = ins.id
    console.log(`✓ contact created: ${NITIN_NAME} ${NITIN_PHONE} id=${contactId}`)
  }

  // 2. Upsert workflow
  //    Schema: nodes is jsonb array. Trigger entry + one send_text per branch
  //    is overkill — keyword trigger fires on ANY match, then send_text runs
  //    with {{trigger.text}} interpolated so the message reflects whichever
  //    button the customer tapped.
  const nodes = [
    {
      id:   'n_trigger',
      type: 'trigger_inbound_keyword',
      label: 'BHK button reply',
      config: {
        keywords: BHK_KEYWORDS,
        channels: ['whatsapp'],
      },
      connections: { default: 'n_reply' },
    },
    {
      id:   'n_reply',
      type: 'send_text',
      label: 'Thank-you',
      config: {
        text: THANKYOU_MSG,
      },
    },
  ]

  const { data: existingWf } = await sb.from('workflows')
    .select('id, status')
    .eq('tenant_id', tenant.id)
    .eq('name', WORKFLOW_NAME)
    .maybeSingle()

  let workflowId: string
  if (existingWf) {
    workflowId = existingWf.id
    const { error: uErr } = await sb.from('workflows')
      .update({ nodes, status: 'live', updated_at: new Date().toISOString() })
      .eq('id', workflowId)
    if (uErr) throw new Error(`workflow update failed: ${uErr.message}`)
    console.log(`✓ workflow updated → live: ${WORKFLOW_NAME} id=${workflowId}`)
  } else {
    const { data: ins, error: wErr } = await sb.from('workflows').insert({
      tenant_id:   tenant.id,
      user_id:     tenant.user_id,
      name:        WORKFLOW_NAME,
      description: 'When a contact taps 1/2/3 BHK on the welcome template, send a thank-you.',
      status:      'live',
      intent_text: 'When customer taps a BHK button on WhatsApp, thank them.',
      nodes,
      integrations: ['whatsapp'],
    }).select('id').single()
    if (wErr || !ins) throw new Error(`workflow insert failed: ${wErr?.message}`)
    workflowId = ins.id
    console.log(`✓ workflow created → live: ${WORKFLOW_NAME} id=${workflowId}`)
  }

  // 3. Send the template via Meta Graph API
  //    Use the tenant's own phone_number_id + access_token (NOT the platform
  //    env values). lead_welcome_bhk has no body variables — params would
  //    only be needed on the buttons component if they had dynamic payloads.
  const body = {
    messaging_product: 'whatsapp',
    to: NITIN_DIGITS,
    type: 'template',
    template: {
      name:     TEMPLATE_NAME,
      language: { code: TEMPLATE_LANG },
    },
  }
  console.log(`→ POST graph.facebook.com/v21.0/${tenant.phone_number_id}/messages`)
  console.log(`  body=${JSON.stringify(body)}`)
  const resp = await fetch(
    `https://graph.facebook.com/v21.0/${tenant.phone_number_id}/messages`,
    {
      method:  'POST',
      headers: {
        Authorization:  `Bearer ${tenant.access_token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    },
  )
  const text = await resp.text()
  console.log(`← Meta status ${resp.status}`)
  console.log(`  body=${text}`)
  if (!resp.ok) {
    console.error('\n✗ Meta send failed. Stopping here.')
    process.exit(1)
  }

  let parsed: any = {}
  try { parsed = JSON.parse(text) } catch { /* keep raw */ }
  const wamid = parsed.messages?.[0]?.id
  console.log('')
  console.log('─────────────────────────────────────────────')
  console.log(`✓ template sent. wamid=${wamid}`)
  console.log('')

  console.log('Inserting message record into Supabase for webhook tracking...')
  const { error: insErr } = await sb.from('messages').insert({
    tenant_id: tenant.id,
    direction: 'outbound',
    contact_phone: NITIN_PHONE,
    channel: 'whatsapp',
    platform_message_id: wamid,
    content: body,
    status: 'sent',
  })
  if (insErr) {
    console.error('Failed to insert message into Supabase:', insErr.message)
    return
  }
  console.log('✓ Message record inserted. Polling for webhook updates (will check for 15 seconds)...')

  // Poll for status updates
  let finalStatus = 'sent'
  for (let i = 0; i < 15; i++) {
    await new Promise(resolve => setTimeout(resolve, 1000))
    const { data: msg, error: qErr } = await sb.from('messages')
      .select('status, created_at, content')
      .eq('platform_message_id', wamid)
      .single()
    if (qErr) {
      console.error('Failed to query message status:', qErr.message)
      break
    }
    console.log(`[Second ${i+1}] Status: ${msg.status}`)
    if (msg.status !== 'sent') {
      finalStatus = msg.status
      console.log('Final Status received!', JSON.stringify(msg, null, 2))
      break
    }
  }

  if (finalStatus === 'delivered' || finalStatus === 'read') {
    console.log('Next:')
    console.log(`  1. Open WhatsApp on the phone for ${NITIN_PHONE}`)
    console.log(`  2. You should see the welcome template with [1 BHK] [2 BHK] [3 BHK]`)
    console.log('  3. Tap any button')
    console.log(`  4. The deployed stage BE (whichever URL Meta is configured to webhook)`)
    console.log(`     will route to workflow ${workflowId} and reply with the thank-you message`)
  } else {
    console.log(`\nDelivery failed. Status: ${finalStatus}`)
  }
  console.log('─────────────────────────────────────────────')
}

main().catch(e => { console.error('FATAL:', e?.message ?? e); process.exit(1) })
