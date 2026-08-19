// Runnable self-check for the Tasks auto-fire rule + dedup.
//   npx tsx src/lib/task-auto.selfcheck.ts
import assert from 'node:assert/strict'
import { khataDueTask, createAutoTask, KHATA_DUE_THRESHOLD } from './task-auto'

let n = 0
const ok = (m: string) => { n++; console.log('  ✓', m) }

// ── pure rule: khataDueTask ───────────────────────────────────────────────────
{
  assert.equal(khataDueTask(499, { partyKey: 'p1', partyName: 'Riya' }), null)
  ok('below threshold → no task')

  const t = khataDueTask(750, { partyKey: 'p1', partyName: 'Riya' })
  assert.ok(t)
  assert.equal(t!.sourceKey, 'khata_due:p1')
  assert.match(t!.title, /₹750 due — Riya/)
  ok('at/over threshold → task with ₹ amount + name + stable sourceKey')

  const w = khataDueTask(KHATA_DUE_THRESHOLD, { partyKey: 'p2', partyName: '   ' })
  assert.ok(w)
  assert.match(w!.title, /a customer/)
  ok('threshold is inclusive; blank name → "a customer" fallback')

  // Per-tenant threshold param.
  const P = { partyKey: 'p3', partyName: 'Sam' }
  assert.equal(khataDueTask(999, P, 1000), null)
  assert.ok(khataDueTask(1000, P, 1000))
  ok('custom threshold gates: 999 < 1000 → none; 1000 → task')

  assert.ok(khataDueTask(1, P, 0))        // 0 ⇒ any positive due fires
  assert.equal(khataDueTask(0, P, 0), null)   // no due
  assert.equal(khataDueTask(-50, P, 0), null) // advance / they owe nothing
  ok('threshold 0 fires on any positive due, never on 0 or a negative advance')
}

// ── createAutoTask dedup (stub supabase) ──────────────────────────────────────
type Row = Record<string, any>
function makeStub(tasks: Row[]) {
  const inserted: Row[] = []
  const from = () => {
    let rows = [...tasks]
    const api: any = {
      select() { return api },
      eq(c: string, v: any) { rows = rows.filter(r => r[c] === v); return api },
      in(c: string, vals: any[]) { rows = rows.filter(r => vals.includes(r[c])); return api },
      limit() { return Promise.resolve({ data: rows }) },
      insert(row: Row) { inserted.push(row); return Promise.resolve({ error: null }) },
    }
    return api
  }
  return { sb: { from } as any, inserted }
}

async function run() {
  const a = makeStub([])
  const r1 = await createAutoTask(a.sb, 't1', { title: 'Follow up', sourceKey: 'khata_due:p1', assignedTo: 'owner1' })
  assert.equal(r1.created, true)
  assert.equal(a.inserted.length, 1)
  assert.equal(a.inserted[0].source_key, 'khata_due:p1')
  assert.equal(a.inserted[0].assigned_to, 'owner1')
  assert.equal(a.inserted[0].created_by, 'owner1')
  assert.equal(a.inserted[0].status, 'pending')
  assert.equal(a.inserted[0].requires_proof, false)
  ok('inserts when there is no open task for the source (owner-assigned, pending)')

  const b = makeStub([{ id: 'x', tenant_id: 't1', source_key: 'khata_due:p1', status: 'in_progress' }])
  const r2 = await createAutoTask(b.sb, 't1', { title: 'Follow up', sourceKey: 'khata_due:p1', assignedTo: 'owner1' })
  assert.equal(r2.created, false)
  assert.equal(b.inserted.length, 0)
  ok('dedups when an OPEN task for the source already exists')

  const c = makeStub([{ id: 'x', tenant_id: 't1', source_key: 'khata_due:p1', status: 'done' }])
  const r3 = await createAutoTask(c.sb, 't1', { title: 'Follow up', sourceKey: 'khata_due:p1', assignedTo: 'owner1' })
  assert.equal(r3.created, true)
  ok('a CLOSED task for the source does not block a fresh one (SOP recurs)')

  console.log(`\nAll ${n} task-auto self-checks passed.`)
}
run().catch(e => { console.error(e); process.exit(1) })
