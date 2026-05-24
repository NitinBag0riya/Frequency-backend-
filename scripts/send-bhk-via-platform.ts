/**
 * Send the lead_welcome_bhk template to Nitin using Frequency's PLATFORM
 * credentials (META_TOKEN + phone derived from WABA_ID in .env), bypassing
 * the acme tenant's read-only stored token.
 *
 * The contact + workflow already exist in stage from run-nitin-bhk-test.ts —
 * this script only does the outbound send.
 *
 * Webhook NOTE: Meta will deliver the customer's button-tap reply to whatever
 * webhook URL is configured at the WABA level (in this case WABA
 * 721735523894042 — the platform-managed WABA). Whichever deployed BE that
 * URL points to needs to be (a) running, (b) connected to the same stage
 * Postgres so it sees the live "Real estate BHK reply" workflow.
 */

import 'dotenv/config'

const TOKEN  = process.env.META_TOKEN!
const PN_ID  = '840109565862856'  // Phone Nitin sees: +91 98875 05504 — under platform WABA
const TO     = '917877427709'     // Nitin's phone, no leading +
const TEMPLATE = 'lead_welcome_bhk'
const LANG     = 'en_US'

async function main() {
  if (!TOKEN) throw new Error('META_TOKEN missing in .env')

  const body = {
    messaging_product: 'whatsapp',
    to: TO,
    type: 'template',
    template: { name: TEMPLATE, language: { code: LANG } },
  }
  console.log(`→ POST graph.facebook.com/v21.0/${PN_ID}/messages`)
  console.log(`  body=${JSON.stringify(body)}`)
  const r = await fetch(`https://graph.facebook.com/v21.0/${PN_ID}/messages`, {
    method:  'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body:    JSON.stringify(body),
  })
  const txt = await r.text()
  console.log(`← Meta ${r.status}`)
  console.log(`  body=${txt}`)
  if (!r.ok) process.exit(1)
  let parsed: any = {}; try { parsed = JSON.parse(txt) } catch {}
  console.log('\n✓ wamid =', parsed.messages?.[0]?.id ?? '(missing)')
  console.log('\nOpen WhatsApp on +91 7877 427 709 — you should see the welcome')
  console.log('template with [1 BHK] [2 BHK] [3 BHK]. Tap any button — Meta')
  console.log('webhooks the reply to whatever URL is set on WABA 721735523894042;')
  console.log('that BE looks up workflow "Real estate BHK reply" in stage Postgres')
  console.log('and replies with the thank-you message.')
}
main().catch(e => { console.error(e); process.exit(1) })
