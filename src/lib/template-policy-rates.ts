/**
 * template-policy-rates.ts — Meta India per-message pass-through rates.
 *
 * Mirrors the FE side of truth at:
 *   frontend → src/data/markup-rates.ts → META_RATES_INR
 *
 * Kept as a tiny standalone module on the BE so the wa-template-policy
 * library can compute "utility → marketing" reclassification cost deltas
 * without pulling the entire FE markup-rates module (which carries
 * competitor rows + calculator helpers we don't need server-side).
 *
 * If the FE rates change (May / Nov Meta cycle), update both files.
 * Source: https://developers.facebook.com/docs/whatsapp/pricing/
 */

export const META_RATES_INR = {
  marketing:      0.78,
  utility:        0.115,
  authentication: 0.115,
  service:        0,
} as const

export type MetaCategory = keyof typeof META_RATES_INR
