/**
 * Runnable self-check for the Reviews normalisation + analytics pure logic.
 * Run:  npx tsx src/routes/reviews.selfcheck.ts
 * No framework — plain asserts. Exits non-zero on failure.
 *
 * Proves the deterministic core: star projection across scales, the sentiment
 * floor, HoReCa theme extraction, the deterministic draft-reply, and the R11
 * analytics roll-up (avg/distribution/trend/dish best-worst/reply-rate/themes).
 *
 * What it does NOT prove (needs a live Supabase): the ingest upsert + the
 * review.low emit fan-out — those are thin wrappers over emitNotification,
 * exercised by the integration build.
 */
import assert from 'node:assert/strict'
import { normalizeStars, deriveSentiment, deriveThemes, buildAnalytics, draftReply } from './reviews'

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
