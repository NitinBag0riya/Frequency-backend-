/**
 * Auto-create + status-sync the `team_invite` WhatsApp template on the FREQ_WA
 * platform WABA, using the Meta Graph API. This is the template
 * lib/team-invite-wa.ts sends for phone/WhatsApp team invites.
 *
 * Usage:
 *   node scripts/wa-team-invite-template.mjs           # ensure (create if missing) + print status
 *   node scripts/wa-team-invite-template.mjs status    # print current status only, no create
 *   node scripts/wa-team-invite-template.mjs ensure    # same as default
 *
 * Creds are REUSED from env (same names lib/wa-creds.ts + storefront-otp.ts read),
 * never hardcoded. Reads process.env first, then falls back to parsing ../.env so
 * it runs the same whether or not the env is exported (mirrors wa-poll-register.mjs):
 *   FREQ_WA_WABA_ID       — platform WhatsApp Business Account id
 *   FREQ_WA_ACCESS_TOKEN  — long-lived token for that WABA (needs whatsapp_business_management)
 *   WA_TEAM_INVITE_TEMPLATE      — template name (default 'team_invite'; the sender's default)
 *   WA_TEAM_INVITE_TEMPLATE_LANG — language code (default 'en_US'; must match the sender)
 *
 * Idempotent: if a template with this name already exists on the WABA we DON'T
 * recreate it — we just report its status. Once Meta flips it to APPROVED the
 * sender uses it automatically (its default name is already 'team_invite'), so no
 * env change is needed on approval. Exit code: 0 if APPROVED, 2 if PENDING/created,
 * 3 if REJECTED, 1 on error/misconfig.
 */
import fs from 'fs'

const GRAPH = 'https://graph.facebook.com/v21.0'

// process.env wins; fall back to a bare parse of ../.env (KEY=VALUE, quotes trimmed).
function env(name) {
  if (process.env[name]) return process.env[name]
  try {
    const line = fs.readFileSync(new URL('../.env', import.meta.url), 'utf8')
      .split('\n').find(l => new RegExp(`^\\s*${name}\\s*=`).test(l))
    return line ? line.replace(/^[^=]*=\s*/, '').replace(/^["']|["']$/g, '').trim() : null
  } catch { return null }
}

const WABA = env('FREQ_WA_WABA_ID')
const TOKEN = env('FREQ_WA_ACCESS_TOKEN')
const NAME = env('WA_TEAM_INVITE_TEMPLATE') || 'team_invite'
const LANG = env('WA_TEAM_INVITE_TEMPLATE_LANG') || 'en_US'
// Where the "Accept invite" button points. The token is appended by Meta as the
// dynamic URL suffix ({{1}}), which the sender fills with the opaque invite token.
// A WhatsApp template's button URL is baked in + public-facing, so a dev
// FRONTEND_URL (localhost) must NEVER end up in it. Ignore localhost/loopback and
// fall back to the prod domain; allow override via WA_ACCEPT_BASE for other envs.
const ACCEPT_BASE = (() => {
  const f = env('WA_ACCEPT_BASE') || env('FRONTEND_URL') || ''
  return (f && !/localhost|127\.0\.0\.1|\.local(:|\/|$)/i.test(f))
    ? f.replace(/\/+$/, '')
    : 'https://getfrequency.app'
})()

const auth = { Authorization: `Bearer ${TOKEN}` }

async function findTemplate() {
  const url = `${GRAPH}/${WABA}/message_templates?name=${encodeURIComponent(NAME)}&fields=name,status,category,language,rejected_reason&limit=50`
  const r = await fetch(url, { headers: auth })
  const j = await r.json()
  if (j.error) throw new Error(`lookup failed: ${j.error.message} (code ${j.error.code})`)
  // The name filter is a prefix match on some API versions — pin to exact name + lang.
  return (j.data || []).find(t => t.name === NAME && (!t.language || t.language === LANG)) || null
}

async function createTemplate() {
  const payload = {
    name: NAME,
    language: LANG,
    category: 'UTILITY',
    components: [
      {
        type: 'BODY',
        text: "You've been invited to join {{1}} on Frequency. Tap below to accept.",
        example: { body_text: [['Maple Mortar']] },
      },
      {
        type: 'BUTTONS',
        buttons: [{
          type: 'URL',
          text: 'Accept invite',
          url: `${ACCEPT_BASE}/accept-invite?token={{1}}`,
          example: [`${ACCEPT_BASE}/accept-invite?token=abc123def456ghi789`],
        }],
      },
    ],
  }
  const r = await fetch(`${GRAPH}/${WABA}/message_templates`, {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
  const j = await r.json()
  if (j.error) throw new Error(`create failed: ${j.error.message} (code ${j.error.code})`)
  return j // { id, status, category }
}

async function main() {
  const action = (process.argv[2] || 'ensure').toLowerCase()
  if (!WABA || !TOKEN) {
    console.error('Missing FREQ_WA_WABA_ID and/or FREQ_WA_ACCESS_TOKEN (set in env or ../.env).')
    process.exit(1)
  }
  console.log(`WABA ${WABA} · template '${NAME}' (${LANG})`)

  let tpl = await findTemplate()

  if (!tpl && action !== 'status') {
    console.log(`Not found — creating UTILITY template with URL button → ${ACCEPT_BASE}/accept-invite?token={{1}} …`)
    const created = await createTemplate()
    console.log(`Created (id ${created.id}), initial status ${created.status || 'PENDING'}.`)
    tpl = await findTemplate() // re-read for the authoritative status
  } else if (!tpl) {
    console.log('Not found (status-only run — not creating).')
    process.exit(2)
  } else {
    console.log('Already exists — not recreating (idempotent).')
  }

  const status = tpl?.status || 'PENDING'
  console.log(`\nStatus: ${status}${tpl?.rejected_reason ? ` — reason: ${tpl.rejected_reason}` : ''}`)
  if (status === 'APPROVED') {
    console.log(`APPROVED — the sender uses '${NAME}' automatically (no env change needed).`)
    process.exit(0)
  }
  if (status === 'REJECTED') {
    console.log('REJECTED — fix the copy/button and re-run to resubmit.')
    process.exit(3)
  }
  console.log('PENDING — re-run this with `status` to poll until Meta approves it.')
  process.exit(2)
}

main().catch(e => { console.error(String(e?.message || e)); process.exit(1) })
