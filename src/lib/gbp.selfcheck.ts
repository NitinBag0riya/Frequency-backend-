/**
 * Runnable self-check for GBP review normalization (star mapping + reply shape).
 * No framework, no DB, no network — just asserts.
 * Run: `npx tsx src/lib/gbp.selfcheck.ts`
 */
import assert from 'node:assert/strict'
import { normalizeReview } from './gbp'

// ── star rating → 1..5 ───────────────────────────────────────────────────────
assert.equal(normalizeReview({ starRating: 'FIVE' }).rating, 5)
assert.equal(normalizeReview({ starRating: 'ONE' }).rating, 1)
assert.equal(normalizeReview({ starRating: 'STAR_RATING_UNSPECIFIED' }).rating, 0, 'unknown → 0, never fabricated')
assert.equal(normalizeReview({}).rating, 0)

// ── field mapping + anonymous fallback ───────────────────────────────────────
const full = normalizeReview({
  reviewId: 'r1',
  reviewer: { displayName: 'Asha K.' },
  starRating: 'FOUR',
  comment: 'Good',
  createTime: '2026-08-12T10:15:00Z',
  reviewReply: { comment: 'Thanks!', updateTime: '2026-08-12T11:00:00Z' },
})
assert.deepEqual(full, {
  id: 'r1',
  reviewer: 'Asha K.',
  rating: 4,
  comment: 'Good',
  createTime: '2026-08-12T10:15:00Z',
  reply: { comment: 'Thanks!', updateTime: '2026-08-12T11:00:00Z' },
})

// ── missing reviewer → 'Anonymous'; no reply → null ──────────────────────────
const bare = normalizeReview({ reviewId: 'r2', starRating: 'THREE' })
assert.equal(bare.reviewer, 'Anonymous')
assert.equal(bare.comment, '')
assert.equal(bare.reply, null)

console.log('gbp.selfcheck: OK')
