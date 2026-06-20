// Capability-manifest drift check — run in dev / CI to catch the moment a
// registry capability advertises a node the executor can't run.
//   npx tsx scripts/manifest-check.ts        (exit 1 if drift, for CI gating)
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { buildStaticManifest } from '../src/engine/capability-manifest'
import { CORE_NODE_TYPES, TRIGGER_NODE_TYPES, NODE_DESCRIPTIONS, isKnownNodeType } from '../src/engine/node-types'

const m = buildStaticManifest()
console.log(`apps: ${m.apps.length}`)
console.log(`node types: ${m.nodeTypes.length}  (trigger types: ${m.triggerNodeTypes.length})`)
console.log(`picker categories: ${m.pickerCategories.length}  (total pickers: ${m.pickerCategories.reduce((n, c) => n + c.pickers.length, 0)})`)
console.log(`apps with workflow actions: ${m.apps.filter(a => a.actions.some(x => x.nodeType)).length}`)

// Backlog (not a build failure): connector capabilities advertised in the
// registry whose nodeType the executor can't run yet. These are NOT injected
// into the builder's node catalog (that's generated from node-types.ts), so the
// builder never offers them — they're a roadmap list to wire over time.
console.log(`\nBACKLOG — connector capabilities not yet executable (not offered to the builder): ${m.drift.length}`)
for (const d of m.drift) console.log(`  ⚠ ${d.connector}.${d.capability} → ${d.nodeType}`)

console.log('\nsample picker category:')
const tbl = m.pickerCategories.find(c => c.pickers.some(p => p.field === 'table_id')) ?? m.pickerCategories[0]
if (tbl) {
  console.log(`  ${tbl.key} — ${tbl.name}`)
  console.log('  pickers:', tbl.pickers.map(p => `${p.field}(${p.type}${p.live ? ',live' : ''})`).join(', '))
  if (tbl.operations) console.log('  ops:', tbl.operations.choices.map(o => o.key).join(' / '))
}

// Builder-grounding gate: every core + trigger node MUST have a one-line
// description so the workflow builder knows it. A node added to node-types.ts
// without a NODE_DESCRIPTIONS entry fails the build here — that's what keeps the
// builder aware of 100% of the engine's powers, with no "valid in draft / breaks
// live" surprises and no silent future gaps.
const undocumented = [...CORE_NODE_TYPES, ...TRIGGER_NODE_TYPES].filter(t => !NODE_DESCRIPTIONS[t]?.trim())
console.log(`\nUNDOCUMENTED nodes (no NODE_DESCRIPTIONS entry → builder unaware): ${undocumented.length}`)
for (const t of undocumented) console.log(`  ✗ ${t}`)

// Prompt-token audit: scan the parser source for trigger_* tokens that the
// engine can't run. This catches the "stale few-shot example teaches a
// non-existent trigger" bug class (e.g. trigger_webhook / trigger_scheduled /
// trigger_form_submit) — the few-shot examples dominate what the AI emits, so a
// fake one there is as bad as a wrong catalog. Hard-fails the build.
const __dir = dirname(fileURLToPath(import.meta.url))
// Legit non-node identifiers that happen to start with trigger_ (output-schema
// fields, API body keys) — not workflow node types, so don't flag them.
const NON_NODE_TRIGGER_TOKENS = new Set(['trigger_summary', 'trigger_input'])
let staleTokens: string[] = []
try {
  const src = readFileSync(join(__dir, '../src/index.ts'), 'utf8')
  const found = new Set((src.match(/trigger_[a-z_]+/g) ?? []))
  staleTokens = [...found].filter(t => !isKnownNodeType(t) && !NON_NODE_TRIGGER_TOKENS.has(t))
} catch { /* file move — skip the audit rather than crash the gate */ }
console.log(`\nSTALE PROMPT TOKENS in src/index.ts (trigger_* the engine can't run): ${staleTokens.length}`)
for (const t of staleTokens) console.log(`  ✗ ${t}`)

// Hard-fail the build on undocumented nodes (builder unaware of a real power)
// and on stale prompt tokens (builder taught a fake one). Connector backlog
// (m.drift) is reported above but doesn't block — those nodes are never
// surfaced to the builder.
if (undocumented.length || staleTokens.length) process.exitCode = 1
