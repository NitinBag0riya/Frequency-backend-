/**
 * Unit tests for src/lib/n8n-import.ts — the deterministic n8n → Frequency
 * parser. Pure functions, no I/O — runnable with: `npx tsx tests/n8n-import.test.ts`.
 *
 * Coverage:
 *   - simple single-trigger webhook flow → linear translation
 *   - multi-trigger flow → split into N proposed workflows
 *   - WhatsApp httpRequest → send_template detection + template-name extraction
 *   - Razorpay payment-link httpRequest → send_payment_link detection
 *   - unsupported app → surfaced in missing_apps with display_name + occurrences
 *   - n8n expressions ={{ $json.foo }} → translated to {{trigger.foo}}
 *   - IF node → connections.true / connections.false
 *   - malformed JSON → throws
 *   - missing nodes[] → throws
 *   - empty workflow / no triggers → empty proposed_workflows + warning
 *
 * If anything fails the process exits 1 — easy to wire into CI later.
 */

import assert from 'node:assert/strict'
import { parseN8nJson, n8nTypeToDisplayName, slugify } from '../src/lib/n8n-import'

let pass = 0
let fail = 0
const failures: string[] = []

function test(name: string, fn: () => void): void {
  try {
    fn()
    pass++
    console.log(`  PASS  ${name}`)
  } catch (e: any) {
    fail++
    failures.push(`${name}\n    ${e?.message ?? String(e)}`)
    console.log(`  FAIL  ${name}`)
    console.log(`        ${e?.message ?? String(e)}`)
  }
}

console.log('\nn8n-import.test.ts\n')

// ── 1. Simple webhook → http_request linear flow ─────────────────────────────
test('simple webhook → http_request → send_email linear flow', () => {
  const json = JSON.stringify({
    name: 'Lead intake',
    nodes: [
      { name: 'Webhook',     type: 'n8n-nodes-base.webhook',     parameters: { path: '/lead' } },
      { name: 'Call CRM',    type: 'n8n-nodes-base.httpRequest', parameters: { url: 'https://crm.example.com/leads', method: 'POST' } },
      { name: 'Notify team', type: 'n8n-nodes-base.emailSend',   parameters: { toEmail: 'team@x.com' } },
    ],
    connections: {
      'Webhook':  { main: [[{ node: 'Call CRM',    type: 'main', index: 0 }]] },
      'Call CRM': { main: [[{ node: 'Notify team', type: 'main', index: 0 }]] },
    },
  })
  const out = parseN8nJson(json)
  assert.equal(out.source_name, 'Lead intake')
  assert.equal(out.proposed_workflows.length, 1, 'expected exactly one proposed workflow')
  const wf = out.proposed_workflows[0]
  assert.equal(wf.trigger_kind, 'trigger_webhook')
  assert.equal(wf.node_count, 3)
  assert.equal(wf.nodes_json[0].type, 'trigger_webhook')
  assert.equal(wf.nodes_json[1].type, 'http_request')
  assert.equal(wf.nodes_json[2].type, 'send_email')
  // connections wired in order
  assert.equal(wf.nodes_json[0].connections?.default, 'node_2')
  assert.equal(wf.nodes_json[1].connections?.default, 'node_3')
})

// ── 2. Multi-trigger flow split into N proposed workflows ────────────────────
test('two triggers in same source → two proposed workflows', () => {
  const json = JSON.stringify({
    name: 'Hybrid',
    nodes: [
      { name: 'Form',  type: 'n8n-nodes-base.formTrigger',     parameters: {} },
      { name: 'Cron',  type: 'n8n-nodes-base.scheduleTrigger', parameters: {} },
      { name: 'Email', type: 'n8n-nodes-base.emailSend',       parameters: {} },
    ],
    connections: {
      'Form': { main: [[{ node: 'Email', type: 'main', index: 0 }]] },
      'Cron': { main: [[{ node: 'Email', type: 'main', index: 0 }]] },
    },
  })
  const out = parseN8nJson(json)
  assert.equal(out.proposed_workflows.length, 2)
  const kinds = out.proposed_workflows.map(w => w.trigger_kind).sort()
  assert.deepEqual(kinds, ['trigger_form_submit', 'trigger_scheduled'])
})

// ── 3. WhatsApp httpRequest → send_template ─────────────────────────────────
test('WhatsApp httpRequest → send_template with template_name extracted', () => {
  const json = JSON.stringify({
    name: 'WA welcome',
    nodes: [
      { name: 'Webhook', type: 'n8n-nodes-base.webhook',     parameters: {} },
      {
        name: 'Send WA', type: 'n8n-nodes-base.httpRequest',
        parameters: {
          url: 'https://graph.facebook.com/v18.0/12345/messages',
          method: 'POST',
          jsonBody: JSON.stringify({ template: { name: 'welcome_v3', language: { code: 'en' } } }),
        },
      },
    ],
    connections: { 'Webhook': { main: [[{ node: 'Send WA', type: 'main', index: 0 }]] } },
  })
  const out = parseN8nJson(json)
  assert.equal(out.proposed_workflows.length, 1)
  const node = out.proposed_workflows[0].nodes_json[1]
  assert.equal(node.type, 'send_template')
  assert.equal(node.config?.channel, 'whatsapp')
  assert.equal(node.config?.template_name, 'welcome_v3')
  assert.equal(node.template_required, true)
})

// ── 4. Razorpay payment-link httpRequest → send_payment_link ────────────────
test('Razorpay payment-link httpRequest → send_payment_link with amount', () => {
  const json = JSON.stringify({
    name: 'Pay',
    nodes: [
      { name: 'Webhook', type: 'n8n-nodes-base.webhook',     parameters: {} },
      {
        name: 'Razorpay', type: 'n8n-nodes-base.httpRequest',
        parameters: {
          url: 'https://api.razorpay.com/v1/payment_links',
          method: 'POST',
          jsonBody: JSON.stringify({ amount: 50000, currency: 'INR' }),
        },
      },
    ],
    connections: { 'Webhook': { main: [[{ node: 'Razorpay', type: 'main', index: 0 }]] } },
  })
  const out = parseN8nJson(json)
  const node = out.proposed_workflows[0].nodes_json[1]
  assert.equal(node.type, 'send_payment_link')
  assert.equal(node.config?.amount_paise, 50000)
})

// ── 5. Unsupported app → missing_apps + http_request stub ────────────────────
test('Slack node → missing_apps entry + http_request placeholder', () => {
  const json = JSON.stringify({
    name: 'Slack ping',
    nodes: [
      { name: 'Hook',  type: 'n8n-nodes-base.webhook', parameters: {} },
      { name: 'Slack', type: 'n8n-nodes-base.slack',   parameters: {} },
      { name: 'Slack2',type: 'n8n-nodes-base.slack',   parameters: {} },
    ],
    connections: {
      'Hook':  { main: [[{ node: 'Slack',  type: 'main', index: 0 }]] },
      'Slack': { main: [[{ node: 'Slack2', type: 'main', index: 0 }]] },
    },
  })
  const out = parseN8nJson(json)
  assert.equal(out.missing_apps.length, 1)
  assert.equal(out.missing_apps[0].n8n_type, 'n8n-nodes-base.slack')
  assert.equal(out.missing_apps[0].display_name, 'Slack')
  assert.equal(out.missing_apps[0].occurrences, 2)
  assert.equal(out.proposed_workflows[0].nodes_json[1].type, 'http_request')
  assert.ok((out.proposed_workflows[0].nodes_json[1].warnings ?? []).length > 0)
})

// ── 6. n8n expressions translated to {{trigger.*}} ─────────────────────────
test('n8n ={{ $json.email }} expression → {{trigger.email}}', () => {
  const json = JSON.stringify({
    name: 'Expr',
    nodes: [
      { name: 'Hook', type: 'n8n-nodes-base.webhook',     parameters: {} },
      {
        name: 'Call', type: 'n8n-nodes-base.httpRequest',
        parameters: {
          url: 'https://example.com',
          method: 'POST',
          body: '={{ $json.email }}',
          options: { name: '={{ $node["Hook"].json.full_name }}' },
        },
      },
    ],
    connections: { 'Hook': { main: [[{ node: 'Call', type: 'main', index: 0 }]] } },
  })
  const out = parseN8nJson(json)
  const cfg = out.proposed_workflows[0].nodes_json[1].config as any
  assert.equal(cfg.body, '{{trigger.email}}')
  assert.equal(cfg.options.name, '{{trigger.full_name}}')
})

// ── 7. IF node → condition_variable with true/false branches ────────────────
test('IF node emits condition_variable with true + false connections', () => {
  const json = JSON.stringify({
    name: 'Branch',
    nodes: [
      { name: 'Hook',   type: 'n8n-nodes-base.webhook',  parameters: {} },
      { name: 'Check',  type: 'n8n-nodes-base.if',       parameters: {} },
      { name: 'Yes',    type: 'n8n-nodes-base.emailSend',parameters: {} },
      { name: 'No',     type: 'n8n-nodes-base.emailSend',parameters: {} },
    ],
    connections: {
      'Hook':  { main: [[{ node: 'Check', type: 'main', index: 0 }]] },
      'Check': { main: [
        [{ node: 'Yes', type: 'main', index: 0 }],
        [{ node: 'No',  type: 'main', index: 0 }],
      ] },
    },
  })
  const out = parseN8nJson(json)
  const check = out.proposed_workflows[0].nodes_json.find(n => n.label === 'Check')!
  assert.equal(check.type, 'condition_variable')
  assert.ok(check.connections?.true, 'expected a true branch')
  assert.ok(check.connections?.false, 'expected a false branch')
  assert.notEqual(check.connections?.true, check.connections?.false)
})

// ── 8. Malformed JSON throws ────────────────────────────────────────────────
test('malformed JSON throws a clear error', () => {
  assert.throws(() => parseN8nJson('{not json'),
    /Invalid n8n JSON/,
    'expected an Invalid n8n JSON error message')
})

// ── 9. Missing nodes array throws ───────────────────────────────────────────
test('missing nodes[] throws', () => {
  assert.throws(() => parseN8nJson(JSON.stringify({ name: 'x', connections: {} })),
    /missing "nodes" array/)
})

// ── 10. Empty workflow (no triggers) → soft warning, no proposed workflows ──
test('no triggers → empty proposed_workflows + warning', () => {
  const out = parseN8nJson(JSON.stringify({
    name: 'Inert',
    nodes: [{ name: 'Just an http', type: 'n8n-nodes-base.httpRequest', parameters: {} }],
    connections: {},
  }))
  assert.equal(out.proposed_workflows.length, 0)
  assert.ok(out.warnings.some(w => /No trigger/.test(w)))
})

// ── 11. Display-name helper ─────────────────────────────────────────────────
test('n8nTypeToDisplayName: known + unknown', () => {
  assert.equal(n8nTypeToDisplayName('n8n-nodes-base.slack'), 'Slack')
  assert.equal(n8nTypeToDisplayName('n8n-nodes-base.googleSheets'), 'Google Sheets')
  assert.equal(n8nTypeToDisplayName('n8n-nodes-base.somethingNew'), 'Something New')
})

// ── 12. Slugify helper ──────────────────────────────────────────────────────
test('slugify produces clean slugs', () => {
  assert.equal(slugify('Lead Intake — Hot leads!'), 'lead-intake-hot-leads')
  assert.equal(slugify('   '), '')
})

// ── 13. Credentials stripped from config ────────────────────────────────────
test('credentials / API keys / phone-number IDs stripped from config', () => {
  const json = JSON.stringify({
    name: 'Cred test',
    nodes: [
      { name: 'Hook', type: 'n8n-nodes-base.webhook',     parameters: {} },
      {
        name: 'Call', type: 'n8n-nodes-base.httpRequest',
        parameters: {
          url: 'https://example.com',
          method: 'POST',
          authentication: 'genericCredentialType',
          headers: { Authorization: 'Bearer secret-token-12345' },
          phoneNumberId: '102937428765',
        },
      },
    ],
    connections: { 'Hook': { main: [[{ node: 'Call', type: 'main', index: 0 }]] } },
  })
  const out = parseN8nJson(json)
  const cfg = out.proposed_workflows[0].nodes_json[1].config as any
  assert.equal(cfg.authentication, undefined, 'authentication should be stripped')
  assert.equal(cfg.headers, undefined, 'headers should be stripped')
  assert.equal(cfg.phoneNumberId, undefined, 'phoneNumberId should be stripped')
  assert.equal(cfg.url, 'https://example.com')
})

// ── Summary ─────────────────────────────────────────────────────────────────
console.log(`\n${pass} passed, ${fail} failed`)
if (fail > 0) {
  console.log('\nFailures:')
  for (const f of failures) console.log(`  - ${f}`)
  process.exit(1)
}
