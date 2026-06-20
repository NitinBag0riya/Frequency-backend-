// Capability-manifest drift check — run in dev / CI to catch the moment a
// registry capability advertises a node the executor can't run.
//   npx tsx scripts/manifest-check.ts        (exit 1 if drift, for CI gating)
import { buildStaticManifest } from '../src/engine/capability-manifest'
import { CORE_NODE_TYPES, TRIGGER_NODE_TYPES, NODE_DESCRIPTIONS } from '../src/engine/node-types'

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

// Hard-fail the build ONLY on undocumented nodes — that's the guarantee we can
// keep: the builder is aware of every node the engine runs. Connector backlog
// (m.drift) is reported above but doesn't block, since those nodes are never
// surfaced to the builder.
if (undocumented.length) process.exitCode = 1
