// Capability-manifest drift check — run in dev / CI to catch the moment a
// registry capability advertises a node the executor can't run.
//   npx tsx scripts/manifest-check.ts        (exit 1 if drift, for CI gating)
import { buildStaticManifest } from '../src/engine/capability-manifest'

const m = buildStaticManifest()
console.log(`apps: ${m.apps.length}`)
console.log(`node types: ${m.nodeTypes.length}  (trigger types: ${m.triggerNodeTypes.length})`)
console.log(`picker categories: ${m.pickerCategories.length}  (total pickers: ${m.pickerCategories.reduce((n, c) => n + c.pickers.length, 0)})`)
console.log(`apps with workflow actions: ${m.apps.filter(a => a.actions.some(x => x.nodeType)).length}`)

console.log(`\nDRIFT (capability nodeType the executor can't run): ${m.drift.length}`)
for (const d of m.drift) console.log(`  ⚠ ${d.connector}.${d.capability} → ${d.nodeType}`)

console.log('\nsample picker category:')
const tbl = m.pickerCategories.find(c => c.pickers.some(p => p.field === 'table_id')) ?? m.pickerCategories[0]
if (tbl) {
  console.log(`  ${tbl.key} — ${tbl.name}`)
  console.log('  pickers:', tbl.pickers.map(p => `${p.field}(${p.type}${p.live ? ',live' : ''})`).join(', '))
  if (tbl.operations) console.log('  ops:', tbl.operations.choices.map(o => o.key).join(' / '))
}

if (m.drift.length) process.exitCode = 1
