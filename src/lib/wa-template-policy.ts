/**
 * wa-template-policy.ts — pre-submission Meta-policy check for WhatsApp
 *                         message templates.
 *
 * Powers POST /api/wa-templates/policy-check (P1 #15, Template Approval
 * Assistant). Runs in <50ms on every debounced keystroke from the create-
 * template modal so the user sees ERROR / WARNING / INFO chips inline
 * before they submit to Meta for approval (24-72h cycle).
 *
 * The rules below are RESEARCH-BACKED — they encode the most-cited Meta
 * rejection reasons from the public WA Cloud API docs + the rejection
 * histograms we observed in our pilot tenants (D2C + EdTech) during the
 * 2026-Q1 wedge. Every rule includes a `code`, a human `message`, and a
 * `suggestion` the FE can render directly under the banner.
 *
 * SEVERITY contract:
 *   • ERROR   — Meta will almost certainly reject. Blocks Submit unless
 *               the user toggles "Override checks" (with a confirm
 *               dialog). The BE still forwards to Meta — we never gate
 *               the submit silently.
 *   • WARNING — Meta MAY accept but with high cost / risk (e.g. utility
 *               → marketing reclassification at 7x rate). Yellow banner,
 *               does not block submit.
 *   • INFO    — Cosmetic / best-practice (e.g. INR currency formatting).
 *               Blue chip.
 *
 * The rule list is intentionally independent of any external service —
 * pure string operations. Add new rules at the bottom of `runRules()`
 * and the FE will render them automatically.
 */

import { META_RATES_INR } from './template-policy-rates'

/* ── Types ────────────────────────────────────────────────────────────────── */

export type PolicySeverity = 'ERROR' | 'WARNING' | 'INFO'

export interface PolicyCheck {
  /** Stable machine-readable rule key. Snake-case. FE branches on this. */
  code:        string
  severity:    PolicySeverity
  message:     string
  suggestion:  string
  /** Optional structured data — e.g. the matched substring or the cost delta. */
  meta?:       Record<string, unknown>
}

export type PolicyCategory = 'MARKETING' | 'UTILITY' | 'AUTHENTICATION'

export interface PolicyCheckInput {
  /** The BODY component text the user is about to submit. */
  body:        string
  /** Meta category — Same enum the create endpoint uses. */
  category:    PolicyCategory
  /** Optional — Defaults to 'en_US'. Currency rule keys off Indian languages. */
  language?:   string
  /** Optional — Meta-side button list. Used by the auth-template rule. */
  buttons?:    Array<{ type?: string; url?: string }>
  /** Optional — Whether a HEADER component is present (component types). */
  has_header?: boolean
  /** Optional — Whether a FOOTER component is present. */
  has_footer?: boolean
}

export interface PolicyCheckResult {
  checks:     PolicyCheck[]
  can_submit: boolean
  /** Counts split by severity — saved into wa_template_policy_checks for
   *  the rejection-rate-over-time chart in the admin dashboard. */
  errors_count:   number
  warnings_count: number
  infos_count:    number
}

/* ── Rule constants ───────────────────────────────────────────────────────── */

/** Meta documented hard cap. Source: developers.facebook.com/docs/whatsapp/
 *  business-management-api/message-templates (2026-Q1 cycle).               */
const MAX_VARIABLES_HARD = 10
/** Soft warning threshold — approaching the cap. */
const MAX_VARIABLES_SOFT = 8
/** Variable density (variables ÷ words) above which Meta treats the
 *  template as a "fill-in-the-blank" form and rejects. Empirical: 0.5. */
const MAX_DENSITY = 0.5
const SOFT_DENSITY = 0.4

/** Words / phrases Meta's classifier reads as PROMOTIONAL. Hitting any of
 *  these in a UTILITY template gets it reclassified to MARKETING (7x
 *  per-message cost: utility ₹0.115 → marketing ₹0.78 per India May 2026). */
const PROMO_KEYWORDS = [
  'offer', 'discount', 'sale', 'save', 'savings', 'limited time',
  'limited-time', 'exclusive', 'free shipping', 'buy now', 'shop now',
  'promo', 'promotion', 'deal', 'coupon', 'voucher', 'cashback',
  'flat off', 'flash sale', 'lowest price', '% off',
] as const

/** Greetings that classify a UTILITY template as MARKETING when followed
 *  by a variable (e.g. "Hi {{1}}"). Position-aware: must be at the
 *  start of the body. */
const GREETINGS = [
  'hi', 'hello', 'hey', 'greetings', 'dear', 'namaste', 'good morning',
  'good afternoon', 'good evening',
] as const

/** ISO codes Frequency tenants commonly target — used to decide whether
 *  to fire the INR currency-formatting INFO rule. */
const INDIAN_LANGS = new Set([
  'en_IN', 'hi', 'ta', 'te', 'mr', 'gu', 'pa', 'bn', 'kn', 'ml', 'or', 'as',
])

/* ── Helpers ──────────────────────────────────────────────────────────────── */

function extractPositionalVars(text: string): string[] {
  // Returns unique positional vars sorted by index — "{{1}}", "{{2}}", …
  const m = text.match(/\{\{\s*\d+\s*\}\}/g) ?? []
  return [...new Set(m.map(s => s.replace(/\s+/g, '')))]
}

function extractNamedVars(text: string): string[] {
  // Anything {{...}} that ISN'T a positive integer — Meta rejects these
  // (only positional are supported in BODY text).
  const all = text.match(/\{\{\s*([^}]+?)\s*\}\}/g) ?? []
  return all.filter(s => !/^\{\{\s*\d+\s*\}\}$/.test(s))
}

function countWords(text: string): number {
  // Treat each {{N}} as one token so density math is honest.
  return (text.match(/\S+/g) ?? []).length
}

function startsWithVar(text: string): boolean {
  return /^\s*\{\{\s*\d+\s*\}\}/.test(text)
}

function capRatio(text: string): number {
  const letters = text.replace(/[^A-Za-z]/g, '')
  if (!letters.length) return 0
  const caps = letters.replace(/[^A-Z]/g, '').length
  return caps / letters.length
}

function findFirst(text: string, needles: readonly string[]): string | null {
  const lc = text.toLowerCase()
  for (const n of needles) {
    if (lc.includes(n)) return n
  }
  return null
}

function findAll(text: string, needles: readonly string[]): string[] {
  const lc = text.toLowerCase()
  return needles.filter(n => lc.includes(n))
}

/** Phone-number-ish pattern. Liberal so we catch +91, 10-digit, dashed,
 *  spaced variants. Skips raw {{1}} placeholders because those are vars,
 *  not literal numbers. Strips placeholders first. */
function containsPhoneNumber(text: string): boolean {
  const stripped = text.replace(/\{\{\s*\d+\s*\}\}/g, ' ')
  // 7+ consecutive digits OR international form, with separators allowed.
  return /(?:\+?\d[\d\s\-()]{6,}\d)/.test(stripped)
}

/** "1499" → flag. "₹1,499" / "Rs.1499" / "INR 1499" → fine. Strips
 *  vars first so a bare "{{1}}" doesn't get flagged. */
function hasUnformattedINR(text: string): boolean {
  const stripped = text.replace(/\{\{\s*\d+\s*\}\}/g, ' ')
  // Numbers >= 3 digits that aren't preceded by ₹ / Rs / INR.
  const re = /(^|[^₹\w])(\d{3,})\b/g
  let m: RegExpExecArray | null
  while ((m = re.exec(stripped)) !== null) {
    // Look 6 chars back for a currency marker.
    const start = Math.max(0, m.index - 6)
    const ctx = stripped.slice(start, m.index + m[0].length).toLowerCase()
    if (/(₹|rs\.?|inr)\s*\d/.test(ctx)) continue
    return true
  }
  return false
}

/* ── Cost-delta helper (for utility→marketing reclassification warnings) ── */

function utilityToMarketingDeltaPerMsg(): { utility: number; marketing: number; delta: number } {
  const utility   = META_RATES_INR.utility
  const marketing = META_RATES_INR.marketing
  return { utility, marketing, delta: marketing - utility }
}

/* ── Rules ────────────────────────────────────────────────────────────────── */

/**
 * Run every rule and return the merged check list. Order matters for the
 * FE's render order: ERRORs first, then WARNINGs, then INFOs — but within
 * a severity bucket we keep insertion order so the first rule the user
 * "hits while typing" stays at the top.
 */
export function runPolicyChecks(input: PolicyCheckInput): PolicyCheckResult {
  const body     = (input.body ?? '').toString()
  const category = input.category
  const lang     = (input.language ?? 'en_US').toString()
  const buttons  = input.buttons ?? []

  const checks: PolicyCheck[] = []

  // ── Rule 10 (early) — footer/header only, no body. ERROR. ──────────────
  // We get the body as a string param so the "no body" case is a literal
  // empty string. The FE doesn't fire policy-check until the user types,
  // but the server still defends.
  if (!body.trim()) {
    checks.push({
      code: 'empty_body',
      severity: 'ERROR',
      message: 'Templates must include body text — header or footer alone is rejected.',
      suggestion: 'Add at least one line of message body. Meta requires a BODY component on every template.',
    })
    // Keep going so the FE still sees the other rules if the user has
    // typed e.g. only a footer (we treat body as the source of truth).
  }

  // ── Rule 9 — Named variables ({{first_name}}). ERROR. ──────────────────
  const named = extractNamedVars(body)
  if (named.length > 0) {
    checks.push({
      code: 'named_variables',
      severity: 'ERROR',
      message: `Meta only supports positional variables. Found: ${named.slice(0, 3).join(', ')}${named.length > 3 ? '…' : ''}`,
      suggestion: 'Replace named placeholders like {{first_name}} with positional {{1}}, {{2}}, etc.',
      meta: { matched: named },
    })
  }

  // ── Rule 2 — No content above the first variable. ERROR. ───────────────
  if (body.trim() && startsWithVar(body)) {
    checks.push({
      code: 'starts_with_variable',
      severity: 'ERROR',
      message: 'Template body starts with a variable. Meta rejects templates that have no fixed text before the first placeholder.',
      suggestion: 'Add a word or two of context before {{1}}. e.g. "Hi {{1}}" instead of just "{{1}}".',
    })
  }

  // ── Rule 1 — Variable count + density. ERROR (over caps), WARNING. ─────
  const positional = extractPositionalVars(body)
  const varCount   = positional.length
  if (varCount > MAX_VARIABLES_HARD) {
    checks.push({
      code: 'too_many_variables',
      severity: 'ERROR',
      message: `Template has ${varCount} variables — Meta's hard cap is ${MAX_VARIABLES_HARD}.`,
      suggestion: `Reduce to ${MAX_VARIABLES_HARD} or fewer placeholders. Consider hard-coding values that don't vary per recipient.`,
      meta: { var_count: varCount },
    })
  } else if (varCount >= MAX_VARIABLES_SOFT) {
    checks.push({
      code: 'high_variable_count',
      severity: 'WARNING',
      message: `Template has ${varCount} variables. Meta's cap is ${MAX_VARIABLES_HARD} — you're close.`,
      suggestion: 'Consider hard-coding values that don\'t vary per recipient. Fewer variables = faster Meta review.',
      meta: { var_count: varCount },
    })
  }

  const words   = countWords(body)
  const density = words > 0 ? varCount / words : 0
  if (density > MAX_DENSITY) {
    checks.push({
      code: 'variable_density',
      severity: 'ERROR',
      message: `${Math.round(density * 100)}% of your template is variables. Meta rejects templates above 50% — they look like fill-in-the-blank forms.`,
      suggestion: 'Add more fixed message text. Variables should accent the body, not BE the body.',
      meta: { density, var_count: varCount, words },
    })
  } else if (density >= SOFT_DENSITY) {
    checks.push({
      code: 'high_variable_density',
      severity: 'WARNING',
      message: `${Math.round(density * 100)}% of your template is variables — Meta starts rejecting above 50%.`,
      suggestion: 'Add more fixed text between variables to stay clear of the threshold.',
      meta: { density, var_count: varCount, words },
    })
  }

  // ── Rule 8 — Phone number in body. ERROR. ──────────────────────────────
  if (containsPhoneNumber(body)) {
    checks.push({
      code: 'phone_in_body',
      severity: 'ERROR',
      message: 'Phone numbers in template body trigger Meta\'s "external contact" rejection.',
      suggestion: 'Move the number to a CALL button (PHONE_NUMBER button type) — Meta accepts that pattern.',
    })
  }

  // ── Rule 3 — Greeting in UTILITY → reclassification. WARNING. ──────────
  if (category === 'UTILITY') {
    const startsWithGreeting = GREETINGS.some(g => {
      // "hi {{1}}", "hello {{1}}, ", "namaste {{1}}!" — greeting at the
      // start of the body followed by space/comma + a variable.
      const pat = new RegExp(`^\\s*${g.replace(/\s+/g, '\\s+')}\\b[\\s,!]*\\{\\{\\s*\\d+\\s*\\}\\}`, 'i')
      return pat.test(body)
    })
    if (startsWithGreeting) {
      const rates = utilityToMarketingDeltaPerMsg()
      checks.push({
        code: 'utility_greeting_reclassification',
        severity: 'WARNING',
        message:
          `Greetings like "Hi {{1}}" usually flip UTILITY → MARKETING on Meta's review. ` +
          `Per-message cost jumps ₹${rates.utility} → ₹${rates.marketing} (about ${Math.round(rates.marketing / Math.max(rates.utility, 0.01))}x).`,
        suggestion: 'Drop the greeting and start with the utility info — e.g. "Your order {{1}} is on the way" instead of "Hi {{1}}, your order is on the way".',
        meta: rates,
      })
    }
  }

  // ── Rule 4 — Promotional language in UTILITY → reclassification. WARNING. ─
  if (category === 'UTILITY') {
    const hits = findAll(body, PROMO_KEYWORDS)
    if (hits.length > 0) {
      const rates = utilityToMarketingDeltaPerMsg()
      checks.push({
        code: 'utility_promotional_language',
        severity: 'WARNING',
        message:
          `Promotional words in a UTILITY template trigger Meta's reclassification to MARKETING ` +
          `(${rates.utility} → ${rates.marketing} per message). Matched: ${hits.slice(0, 3).map(h => `"${h}"`).join(', ')}.`,
        suggestion: 'Either rewrite without promotional language, or switch the category to MARKETING upfront.',
        meta: { matched: hits, ...rates },
      })
    }
  }

  // ── Rule 5 — External URL / buttons in AUTH. ERROR. ────────────────────
  if (category === 'AUTHENTICATION') {
    // AUTH templates: no quick-reply (other than OTP), no URL, no marketing-style buttons.
    // Meta also disallows extra body content beyond the OTP/code line, but
    // body content checks are out of scope — we focus on the button rule.
    const offending = buttons.filter(b => {
      const t = (b.type ?? '').toUpperCase()
      return t === 'URL' || (t === 'QUICK_REPLY' && false) // QUICK_REPLY also disallowed but we keep narrow
    })
    if (offending.length > 0) {
      checks.push({
        code: 'auth_external_url',
        severity: 'ERROR',
        message: 'Authentication templates can\'t carry URL buttons or external links — Meta restricts AUTH to the OTP flow.',
        suggestion: 'Remove the URL buttons. AUTH templates support only the OTP / Copy-Code button pattern.',
      })
    }
    // Body-level URLs are equally fatal in AUTH.
    if (/https?:\/\/|www\./i.test(body)) {
      checks.push({
        code: 'auth_url_in_body',
        severity: 'ERROR',
        message: 'AUTHENTICATION templates can\'t contain URLs in the body. Meta restricts them to the OTP message pattern.',
        suggestion: 'Remove the URL from the body. AUTH templates should only describe the code and its expiry.',
      })
    }
  }

  // ── Rule 7 — All-caps spam markers. WARNING. ───────────────────────────
  if (body.trim()) {
    const ratio = capRatio(body)
    if (ratio > 0.30) {
      checks.push({
        code: 'all_caps_spam',
        severity: 'WARNING',
        message: `${Math.round(ratio * 100)}% of letters in the body are uppercase. Meta's spam classifier flags >30%.`,
        suggestion: 'Use sentence-case for the body. Reserve CAPS for proper nouns or product codes.',
        meta: { cap_ratio: ratio },
      })
    }
  }

  // ── Rule 6 — Plain numbers (INR formatting). INFO. ─────────────────────
  if (INDIAN_LANGS.has(lang) && hasUnformattedINR(body)) {
    checks.push({
      code: 'inr_currency_formatting',
      severity: 'INFO',
      message: 'Body contains plain numbers — Indian customers expect rupee formatting.',
      suggestion: 'Format amounts as ₹1,499 or Rs.1499. Helps readability and avoids confusion with order IDs.',
    })
  }

  // ── Sort by severity (ERROR first), preserving insertion order within. ──
  const order: Record<PolicySeverity, number> = { ERROR: 0, WARNING: 1, INFO: 2 }
  checks.sort((a, b) => order[a.severity] - order[b.severity])

  const errors_count   = checks.filter(c => c.severity === 'ERROR').length
  const warnings_count = checks.filter(c => c.severity === 'WARNING').length
  const infos_count    = checks.filter(c => c.severity === 'INFO').length

  return {
    checks,
    can_submit: errors_count === 0,
    errors_count,
    warnings_count,
    infos_count,
  }
}
