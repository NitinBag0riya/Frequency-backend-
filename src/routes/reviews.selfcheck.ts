/**
 * Runnable self-check for the Reviews normalisation + analytics pure logic.
 * Run:  npx tsx src/routes/reviews.selfcheck.ts
 * No framework — plain asserts. Exits non-zero on failure.
 *
 * Proves the deterministic core: star projection across scales, the sentiment
 * floor, HoReCa theme extraction, the deterministic draft-reply, and the R11
 * analytics roll-up (avg/distribution/trend/dish best-worst/reply-rate/themes).
 *
 * The second half drives ingestReview against an in-memory Supabase stub, proving
 * the feedback→Reviews wiring: the 'whatsapp' source is accepted, a guest re-rating
 * one order UPDATES its row instead of adding a second, the mini-app and WhatsApp
 * mirrors of ONE rating collapse to ONE row in either arrival order, and a ≤3★
 * WhatsApp rating produces a review row AND the matching Complaints row.
 *
 * What it does NOT prove (needs a live Supabase): the review.low emit FAN-OUT
 * (notification rows / push) — the stub stops at emitNotification's event-type
 * lookup, so we assert the alert is REACHED, never that a message was delivered.
 * The ≤3★ Complaints mirror is fired by storefront-api (mirrorComplaintToMain),
 * which this repo cannot run — we assert the receiving normaliser instead.
 */
import assert from 'node:assert/strict'
import type { SupabaseClient } from '@supabase/supabase-js'
import { normalizeStars, deriveSentiment, deriveThemes, buildAnalytics, draftReply, ingestReview } from './reviews'
import { normaliseStorefrontComplaint } from './complaints'

// ── normalizeStars: scale projection + clamp + null ──────────────────────────
assert.equal(normalizeStars(5, 5), 5)
assert.equal(normalizeStars(1, 5), 1)
assert.equal(normalizeStars(null), null)
assert.equal(normalizeStars(undefined), null)
assert.equal(normalizeStars(9, 10), 5)   // 9/10 → 4.5 → round 5
assert.equal(normalizeStars(6, 10), 3)   // 6/10 → 3
assert.equal(normalizeStars(0, 5), 1)    // clamped up to floor 1
assert.equal(normalizeStars(7, 5), 5)    // clamped down to 5

// ── deriveSentiment: floor thresholds ────────────────────────────────────────
assert.equal(deriveSentiment(1), 'negative')
assert.equal(deriveSentiment(2), 'negative')
assert.equal(deriveSentiment(3), 'neutral')
assert.equal(deriveSentiment(4), 'positive')
assert.equal(deriveSentiment(5), 'positive')
assert.equal(deriveSentiment(null), null)

// ── deriveThemes: keyword extraction ─────────────────────────────────────────
assert.deepEqual(deriveThemes('Food arrived cold and very late'), ['delivery-time', 'temperature'])
assert.deepEqual(deriveThemes('portion was too small for the price'), ['portion', 'price'])
assert.deepEqual(deriveThemes(''), [])
assert.deepEqual(deriveThemes(null), [])
assert.ok(deriveThemes('there was hair in my food').includes('hygiene'))

// ── draftReply: tone by stars + theme ────────────────────────────────────────
assert.ok(/thrilled|thank/i.test(draftReply({ stars: 5, customer_name: 'Ayushi Sharma' })))
assert.ok(draftReply({ stars: 5, customer_name: 'Ayushi Sharma' }).includes('Ayushi'))
assert.ok(/sorry/i.test(draftReply({ stars: 2, theme: ['delivery-time'], customer_name: null })))

// ── buildAnalytics: full roll-up ─────────────────────────────────────────────
const now = Date.now()
const iso = (dOffset: number) => new Date(now - dOffset * 86400000).toISOString()
const rows = [
  { source: 'storefront', stars: 2, is_aggregate: false, reply_status: 'none', review_at: iso(0), reply_at: null,
    dish_ratings: [{ item: 'Alfredo Pasta', stars: 2 }], theme: ['packaging'], sentiment: 'negative' },
  { source: 'storefront', stars: 5, is_aggregate: false, reply_status: 'sent', review_at: iso(0),
    reply_at: new Date(now - 0 * 86400000 + 30 * 60000).toISOString(),
    dish_ratings: [{ item: 'Alfredo Pasta', stars: 4 }], theme: [], sentiment: 'positive' },
  { source: 'zomato', stars: 3, is_aggregate: false, reply_status: 'queued', review_at: iso(1), reply_at: null,
    dish_ratings: [{ name: 'Margherita', rating: 3 }], theme: ['delivery-time'], sentiment: 'neutral' },
  { source: 'swiggy', stars: 4, is_aggregate: true, reply_status: 'none', review_at: iso(0), reply_at: null,
    dish_ratings: null, theme: [], sentiment: null },
]
const a = buildAnalytics(rows)

assert.equal(a.total, 3, 'aggregate row excluded from real total')
assert.equal(a.avg_overall, +((2 + 5 + 3) / 3).toFixed(2))
// unanswered_low counts stars<=3 AND reply_status in none|draft. 2★ none = yes; 3★ queued = no.
assert.equal(a.unanswered_low, 1)

const swiggy = a.avg_by_source.find(s => s.source === 'swiggy')!
assert.ok(swiggy.is_aggregate && swiggy.avg === 4, 'swiggy avg comes from the aggregate row')
const store = a.avg_by_source.find(s => s.source === 'storefront')!
assert.equal(store.avg, 3.5)

assert.deepEqual(a.distribution, [
  { star: 1, count: 0 }, { star: 2, count: 1 }, { star: 3, count: 1 }, { star: 4, count: 0 }, { star: 5, count: 1 },
])

// Alfredo Pasta averages (2+4)/2 = 3; Margherita = 3 → worst list sorted ascending.
const pasta = a.dishes_worst.find(d => d.item === 'Alfredo Pasta')!
assert.equal(pasta.avg, 3)
assert.equal(pasta.count, 2)

const storefrontReply = a.reply_stats.find(s => s.source === 'storefront')!
assert.equal(storefrontReply.reply_rate, 0.5)      // 1 of 2 replied
assert.equal(storefrontReply.median_response_min, 30)

assert.ok(a.themes.some(t => t.theme === 'packaging' && t.count === 1))
assert.ok(a.themes.some(t => t.theme === 'delivery-time' && t.count === 1))

console.log('reviews.selfcheck: OK')

// ═══════════════════════════════════════════════════════════════════════════════
// ingestReview against an in-memory Supabase stub
// ═══════════════════════════════════════════════════════════════════════════════

type Row = Record<string, any>

/** Minimal stand-in for the postgrest builder subset ingestReview + tenantNotifyRecipients use. */
function makeSupabaseStub(seed: Record<string, Row[]> = {}) {
  const tables: Record<string, Row[]> = {
    reviews: [], tenants: [], user_role_assignments: [], notification_event_types: [], ...seed,
  }
  let nextId = 1
  const client = {
    from(table: string) {
      const all = () => (tables[table] ??= [])
      let rows: Row[] | null = null
      let op: 'select' | 'update' | 'upsert' = 'select'
      let patch: Row = {}
      let conflict: string[] = []
      const run = (): { data: Row[]; error: null } => {
        const hit = rows ?? all()
        if (op === 'update') { for (const r of hit) Object.assign(r, patch); return { data: hit, error: null } }
        if (op === 'upsert') {
          const match = all().find(r => conflict.every(k => r[k] === patch[k]))
          if (match) { Object.assign(match, patch); return { data: [match], error: null } }
          const fresh = { id: `row_${nextId++}`, ...patch }
          all().push(fresh)
          return { data: [fresh], error: null }
        }
        return { data: hit, error: null }
      }
      const api: any = {
        select: () => api,
        eq: (c: string, v: any) => { rows = (rows ?? all()).filter(r => r[c] === v); return api },
        in: (c: string, v: any[]) => { rows = (rows ?? all()).filter(r => v.includes(r[c])); return api },
        is: (c: string, v: any) => { rows = (rows ?? all()).filter(r => (r[c] ?? null) === v); return api },
        gte: (c: string, v: any) => { rows = (rows ?? all()).filter(r => r[c] >= v); return api },
        limit: (n: number) => { rows = (rows ?? all()).slice(0, n); return api },
        update: (p: Row) => { op = 'update'; patch = p; return api },
        upsert: (p: Row, o?: { onConflict?: string }) => {
          op = 'upsert'; patch = p; conflict = (o?.onConflict ?? '').split(',').filter(Boolean); return api
        },
        maybeSingle: async () => ({ data: run().data[0] ?? null, error: null }),
        single: async () => { const d = run().data[0]; return { data: d ?? null, error: d ? null : { message: 'no row' } } },
        then: (res: any, rej: any) => Promise.resolve(run()).then(res, rej),
      }
      return api
    },
  }
  return { supabase: client as unknown as SupabaseClient, tables }
}

async function main() {
  const TENANT = 'tenant-1'
  const seedTenant = () => [{ id: TENANT, slug: 'cafe', name: 'Dyodhi', user_id: 'owner-1' }]

  // ── whatsapp is an accepted source; an unknown one is still rejected ──────────
  {
    const { supabase, tables } = makeSupabaseStub({ tenants: seedTenant() })
    const out = await ingestReview(supabase, {
      tenantId: TENANT, source: 'whatsapp', sourceReviewId: 'ord_1', orderRef: 'ord_1',
      rating: 5, text: 'Loved the pasta', customerName: 'Riya',
    })
    assert.equal(out.ok, true, 'whatsapp must be an accepted source')
    assert.equal(tables.reviews.length, 1)
    assert.equal(tables.reviews[0].source, 'whatsapp')
    assert.equal(tables.reviews[0].stars, 5)
    assert.equal(tables.reviews[0].sentiment, 'positive')
    assert.equal(tables.reviews[0].text, 'Loved the pasta')
    assert.equal(tables.reviews[0].customer_name, 'Riya')

    const bad = await ingestReview(supabase, { tenantId: TENANT, source: 'instagram', sourceReviewId: 'x' })
    assert.equal(bad.ok, false, 'an unknown source is still rejected')
    assert.equal(tables.reviews.length, 1)
  }

  // ── idempotency: a guest re-rating the SAME order updates, never duplicates ────
  {
    const { supabase, tables } = makeSupabaseStub({ tenants: seedTenant() })
    const first = await ingestReview(supabase, {
      tenantId: TENANT, source: 'whatsapp', sourceReviewId: 'ord_2', orderRef: 'ord_2', rating: 2, text: 'arrived cold',
    })
    const second = await ingestReview(supabase, {
      tenantId: TENANT, source: 'whatsapp', sourceReviewId: 'ord_2', orderRef: 'ord_2', rating: 5, text: 'sorted, thank you',
    })
    assert.equal(tables.reviews.length, 1, 're-rating one order must not add a second row')
    assert.equal(first.id, second.id, 'same row id back')
    assert.equal(tables.reviews[0].stars, 5, 'the new rating wins')
    assert.equal(tables.reviews[0].text, 'sorted, thank you')
    assert.equal(first.emitted, true, 'a NEW 2★ reaches the review.low alert')
    assert.equal(second.emitted, false, 'a re-rating must not re-ring the operator')
  }

  // ── one order = one row across our own channels, in EITHER arrival order ──────
  for (const order of [['storefront', 'whatsapp'], ['whatsapp', 'storefront']] as const) {
    const { supabase, tables } = makeSupabaseStub({ tenants: seedTenant() })
    for (const src of order) {
      await ingestReview(supabase, {
        tenantId: TENANT, source: src, sourceReviewId: 'ord_3', orderRef: 'ord_3',
        rating: 4, ...(src === 'storefront' ? { customerRef: 'guest_9', text: 'good' } : {}),
      })
    }
    assert.equal(tables.reviews.length, 1, `one row for ${order.join(' then ')}`)
    assert.equal(tables.reviews[0].source, 'whatsapp', 'the whatsapp label survives either arrival order')
    assert.equal(tables.reviews[0].customer_ref, 'guest_9', 'a sparse second write must not erase the first')
    assert.equal(tables.reviews[0].text, 'good')
  }

  // An aggregator keeps its own identity — the collapse is OUR channels only.
  {
    const { supabase, tables } = makeSupabaseStub({ tenants: seedTenant() })
    await ingestReview(supabase, { tenantId: TENANT, source: 'storefront', sourceReviewId: 'ord_4', orderRef: 'ord_4', rating: 4 })
    await ingestReview(supabase, { tenantId: TENANT, source: 'zomato', sourceReviewId: 'zrev_7', orderRef: 'ord_4', rating: 3 })
    assert.equal(tables.reviews.length, 2, 'a zomato review on the same order stays its own row')
  }

  // ── a ≤3★ lands in BOTH places: Reviews AND Complaints ───────────────────────
  // storefront-api fires both mirrors for one low WhatsApp rating: mirrorReviewToMain
  // → ingestReview (below) and mirrorComplaintToMain → normaliseStorefrontComplaint
  // (below, kind 'rating'). Neither path was touched by the whatsapp wiring, and the
  // two rows agree on the order they describe.
  {
    const { supabase, tables } = makeSupabaseStub({ tenants: seedTenant() })
    const lowOrder = { id: 'ord_5', rating: 2, outletId: 'o1', table: 4, guestName: 'Asha' }

    const rev = await ingestReview(supabase, {
      tenantId: TENANT, source: 'whatsapp', sourceReviewId: lowOrder.id, orderRef: lowOrder.id,
      rating: lowOrder.rating, text: 'food was cold and late', customerName: lowOrder.guestName,
    })
    assert.equal(rev.ok, true)
    assert.equal(rev.emitted, true, '≤3★ reaches the review.low alert')
    assert.equal(tables.reviews[0].sentiment, 'negative')
    assert.deepEqual(tables.reviews[0].theme, ['delivery-time', 'temperature'])

    const comp = normaliseStorefrontComplaint({
      tenantId: TENANT, order: lowOrder, index: 0, text: 'Rated 2★ on WhatsApp — food was cold and late',
      at: Date.now(), kind: 'rating',
    })
    assert.equal(comp.raw_issue_type, 'rating')
    assert.equal(comp.severity, 'high', '2★ is a high-severity complaint')
    assert.equal(comp.order_ref, tables.reviews[0].order_ref, 'both rows describe the same order')
    assert.equal(comp.rating, tables.reviews[0].rating)
  }
}

main().then(
  () => console.log('reviews.selfcheck: ingest OK'),
  e => { console.error(e); process.exit(1) },
)
