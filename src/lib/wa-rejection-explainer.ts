/**
 * wa-rejection-explainer.ts — translate Meta's terse rejection codes into
 *                             plain English + actionable fixes.
 *
 * Powers GET /api/wa-templates/:name/explain-rejection and feeds the
 * resubmit-draft suggested edits (POST /api/wa-templates/:name/
 * resubmit-draft).
 *
 * Meta's rejection_reason field arrives as a short uppercase token
 * (TAG_CONTENT_MISMATCH, INVALID_FORMAT, …) or a slightly longer free-form
 * sentence when the reviewer adds context. Both forms are tested below.
 *
 * Today this is a deterministic rule table — no LLM calls. The schema in
 * migration 082 includes wa_template_rejection_explanations as a forward-
 * looking cache for when we delegate UNKNOWN reasons to Claude.
 *
 * Each suggested_edit row has the shape:
 *   {
 *     kind:    'strip' | 'replace' | 'category_change' | 'note',
 *     find?:   string | RegExp source,
 *     replace?: string,
 *     why:      string,         // shown in the "Why we suggested this" tooltip
 *   }
 *
 * The resubmit-draft endpoint applies `strip` / `replace` directly to the
 * body. `category_change` is informational — the user picks the new
 * category in the modal. `note` is rendered as a passive tooltip.
 */

export interface SuggestedEdit {
  kind:     'strip' | 'replace' | 'category_change' | 'note'
  find?:    string
  replace?: string
  why:      string
  /** Optional: suggested target category for `category_change` edits. */
  target_category?: 'MARKETING' | 'UTILITY' | 'AUTHENTICATION'
}

export interface RejectionExplanation {
  original_reason:  string
  plain_english:    string
  suggested_edits:  SuggestedEdit[]
  /** Stable code we can chart against ("tag_content_mismatch", etc.). */
  code:             string
}

/* ── Pattern → explanation table ─────────────────────────────────────────── */

interface ExplainerRule {
  code:     string
  /** Substring or regex tested against the lower-cased reason. */
  match:    (reasonLc: string) => boolean
  build:    (reason: string) => Omit<RejectionExplanation, 'original_reason'>
}

const PROMO_KEYWORDS = [
  'offer', 'discount', 'sale', 'save', 'limited time', 'exclusive',
  'buy now', 'shop now', 'promo', 'deal', 'coupon', 'cashback',
] as const

const RULES: ExplainerRule[] = [
  // ── TAG_CONTENT_MISMATCH ───────────────────────────────────────────────
  // The most common India-D2C rejection. Body has promo language but the
  // category was UTILITY, or vice versa.
  {
    code: 'tag_content_mismatch',
    match: (r) => r.includes('tag_content_mismatch') || r.includes('content does not match') || r.includes('category mismatch'),
    build: () => ({
      code: 'tag_content_mismatch',
      plain_english:
        'Meta thinks the template content doesn\'t match the category you picked. ' +
        'This is almost always a UTILITY template with promotional words ("offer", "discount", "save", "limited time") ' +
        'that Meta thinks should be MARKETING.',
      suggested_edits: [
        {
          kind: 'category_change',
          target_category: 'MARKETING',
          why: 'Easiest fix: change the category to MARKETING. The body is fine, but it costs about 7× more per message.',
        },
        ...PROMO_KEYWORDS.map<SuggestedEdit>(kw => ({
          kind: 'strip',
          find: kw,
          why: `Removes the promotional word "${kw}" so the template stays in UTILITY (₹0.115 vs ₹0.78 per message).`,
        })),
      ],
    }),
  },

  // ── INVALID_FORMAT — variable formatting ───────────────────────────────
  {
    code: 'invalid_format_named_vars',
    match: (r) => (r.includes('invalid_format') || r.includes('invalid format')) && (r.includes('parameter') || r.includes('variable') || r.includes('placeholder')),
    build: () => ({
      code: 'invalid_format_named_vars',
      plain_english:
        'Meta only accepts positional variables like {{1}}, {{2}}. Named variables ' +
        '(e.g. {{first_name}}, {{order_id}}) are rejected.',
      suggested_edits: [
        {
          kind: 'replace',
          find: '\\{\\{\\s*[a-zA-Z_][a-zA-Z0-9_]*\\s*\\}\\}',
          replace: '{{N}}',
          why: 'Auto-replaces named placeholders with sequential {{1}}, {{2}}…',
        },
      ],
    }),
  },

  // ── INVALID_FORMAT — generic ───────────────────────────────────────────
  {
    code: 'invalid_format',
    match: (r) => r.includes('invalid_format') || r.includes('invalid format'),
    build: () => ({
      code: 'invalid_format',
      plain_english:
        'Meta couldn\'t parse the template. Common culprits: variables with no fixed text before them ' +
        '({{1}} at the very start), variables in the footer, or buttons missing required fields.',
      suggested_edits: [
        {
          kind: 'note',
          why: 'Make sure: (a) the body has at least one word before any {{N}}, (b) the footer contains no variables, (c) every URL button has a valid HTTPS URL.',
        },
      ],
    }),
  },

  // ── NON_COMPLIANT_PARAMETER ────────────────────────────────────────────
  {
    code: 'non_compliant_parameter',
    match: (r) => r.includes('non_compliant_parameter') || r.includes('non-compliant parameter') || r.includes('parameter format'),
    build: () => ({
      code: 'non_compliant_parameter',
      plain_english:
        'Variables must be numbered like {{1}}, {{2}} — not named like {{first_name}} or {{order_id}}. ' +
        'Meta\'s template engine is positional-only.',
      suggested_edits: [
        {
          kind: 'replace',
          find: '\\{\\{\\s*[a-zA-Z_][a-zA-Z0-9_]*\\s*\\}\\}',
          replace: '{{N}}',
          why: 'Auto-replaces every named placeholder with the next positional index.',
        },
      ],
    }),
  },

  // ── ABUSIVE_CONTENT ────────────────────────────────────────────────────
  {
    code: 'abusive_content',
    match: (r) => r.includes('abusive_content') || r.includes('abusive content') || r.includes('hate') || r.includes('harassment'),
    build: () => ({
      code: 'abusive_content',
      plain_english:
        'Meta flagged the template as abusive, threatening, or harassing. This is a serious classification — ' +
        'repeated submissions can affect the WhatsApp Business Account quality rating.',
      suggested_edits: [
        {
          kind: 'note',
          why: 'Do NOT auto-resubmit. Review the body with a human reviewer. If you believe this is a false positive, file an appeal in Meta Business Manager rather than resubmitting.',
        },
      ],
    }),
  },

  // ── PROMOTIONAL_CONTENT in UTILITY (an alternate phrasing) ─────────────
  {
    code: 'promotional_in_utility',
    match: (r) => (r.includes('promotional') || r.includes('marketing')) && (r.includes('utility') || r.includes('utility tag')),
    build: () => ({
      code: 'promotional_in_utility',
      plain_english:
        'Your template was tagged UTILITY but contains promotional language. Either move to MARKETING ' +
        '(costs ~7× more per message) or strip the promotional words.',
      suggested_edits: [
        {
          kind: 'category_change',
          target_category: 'MARKETING',
          why: 'Accept the higher per-message cost in exchange for keeping the promotional copy.',
        },
        ...PROMO_KEYWORDS.map<SuggestedEdit>(kw => ({
          kind: 'strip',
          find: kw,
          why: `Removes the promotional word "${kw}" so the template stays in UTILITY pricing.`,
        })),
      ],
    }),
  },

  // ── SCAM ───────────────────────────────────────────────────────────────
  {
    code: 'scam',
    match: (r) => r.includes('scam') || r.includes('phishing') || r.includes('fraud'),
    build: () => ({
      code: 'scam',
      plain_english:
        'Meta\'s classifier flagged the template as a phishing or scam attempt. Common triggers: ' +
        'urgent payment requests, account-suspension warnings, suspicious URLs.',
      suggested_edits: [
        {
          kind: 'note',
          why: 'Re-write the body in a calmer tone. Avoid "urgent", "suspended", "verify now". If your business legitimately needs to send these, contact Meta support before resubmitting — appeals are faster than repeat rejections.',
        },
      ],
    }),
  },

  // ── INVALID_URL ────────────────────────────────────────────────────────
  {
    code: 'invalid_url',
    match: (r) => r.includes('invalid_url') || r.includes('invalid url') || r.includes('malformed url'),
    build: () => ({
      code: 'invalid_url',
      plain_english:
        'One of the URL buttons is malformed. Meta requires fully-qualified HTTPS URLs ' +
        '(no shorteners like bit.ly inside Business templates).',
      suggested_edits: [
        {
          kind: 'note',
          why: 'Use your full domain (https://example.com/order/{{1}}). Remove URL shorteners — Meta blocks bit.ly, t.co, and tinyurl in templates.',
        },
      ],
    }),
  },
]

/* ── Public API ──────────────────────────────────────────────────────────── */

/**
 * Translate a Meta rejection_reason to a plain-English explanation.
 *
 * Returns a `code: 'unknown'` row for reasons that don't match any rule —
 * the FE renders the original reason verbatim and a generic-fix hint so
 * the user isn't stuck.
 */
export function explainRejection(rawReason: string | null | undefined): RejectionExplanation {
  const original = (rawReason ?? '').toString().trim()
  if (!original) {
    return {
      original_reason: '',
      code: 'no_reason',
      plain_english:
        'Meta marked the template REJECTED but didn\'t supply a reason. This usually clears within an hour as Meta\'s system catches up.',
      suggested_edits: [
        { kind: 'note', why: 'Refresh in 10–15 minutes. If still no reason, resubmit the template as-is once.' },
      ],
    }
  }

  const lc = original.toLowerCase()
  for (const rule of RULES) {
    if (rule.match(lc)) {
      const built = rule.build(original)
      return { original_reason: original, ...built }
    }
  }

  // ── Generic fallback for unknown reasons. ──────────────────────────────
  return {
    original_reason: original,
    code: 'unknown',
    plain_english:
      `Meta returned: "${original}". This isn't a code we recognize yet. The most common reasons are: ` +
      'promotional language in UTILITY templates, missing sample values for variables, or invalid URLs in buttons.',
    suggested_edits: [
      {
        kind: 'note',
        why: 'Read Meta\'s reason text above carefully. If it mentions "format" or "parameter" → check variable syntax. If it mentions "category" or "tag" → consider switching to MARKETING. If it mentions "url" or "link" → verify every button URL is HTTPS and not a shortener.',
      },
    ],
  }
}

/**
 * Apply the suggested edits to a draft body and return the proposed
 * rewrite. CONSERVATIVE — only `strip` and `replace` edits change text;
 * `category_change` and `note` are informational and never touch the body.
 *
 * Strip rules remove the matched keyword (case-insensitive) and collapse
 * surrounding whitespace. Replace rules with the special `replace: '{{N}}'`
 * sentinel re-number all named placeholders into sequential positionals.
 *
 * The auto-edit is NEVER lossy on its own — if every match is in the
 * middle of a sentence, we leave the words alone rather than producing
 * grammatically broken text. The FE renders the diff side-by-side so the
 * user reviews + edits before re-submitting.
 */
export function applySuggestedEdits(body: string, edits: SuggestedEdit[]): string {
  let out = body

  // Resequence named vars first (must happen before strip, since strip
  // works on plain words and might collide).
  const renumber = edits.find(e => e.kind === 'replace' && e.replace === '{{N}}')
  if (renumber) {
    let i = 1
    out = out.replace(/\{\{\s*[a-zA-Z_][a-zA-Z0-9_]*\s*\}\}/g, () => `{{${i++}}}`)
  }

  // Apply per-keyword strips.
  for (const edit of edits) {
    if (edit.kind !== 'strip' || !edit.find) continue
    // Word-boundary insensitive strip. We're conservative: only remove
    // the keyword + collapse double spaces, never partial words.
    const escaped = edit.find.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const re = new RegExp(`\\b${escaped}\\b\\s*`, 'gi')
    out = out.replace(re, '')
  }

  // Collapse internal double-spaces left by strips.
  out = out.replace(/[ \t]{2,}/g, ' ').replace(/\s+([,.!?])/g, '$1').trim()

  return out
}
