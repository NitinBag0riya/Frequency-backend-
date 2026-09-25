/**
 * Pure birthday/anniversary sweep-selection logic (POS Upgrade Phase 6, 6.2).
 * Split out of workers/birthday-wish-sweep.ts so this file has ZERO
 * supabase/queue imports — the worker module creates a live Supabase client
 * at import time (matching every other daily-sweep worker in this repo), so
 * a selfcheck that imports the worker directly needs real env vars. This
 * module is safe to import from a plain `node:assert` self-check with no
 * network/env dependency at all — see birthday-wish-match.selfcheck.ts.
 *
 * See workers/birthday-wish-sweep.ts for the DPDPA/Meta-gate context this
 * logic serves.
 */

/** Today's 'MM-DD' in Asia/Kolkata — the sweep's civil-date reference. */
export function todayMonthDayIST(now: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata', month: '2-digit', day: '2-digit',
  }).formatToParts(now)
  const mm = parts.find(p => p.type === 'month')?.value ?? '01'
  const dd = parts.find(p => p.type === 'day')?.value ?? '01'
  return `${mm}-${dd}`
}

/** Pull 'MM-DD' out of a 'YYYY-MM-DD' or bare 'MM-DD' attribute value.
 *  Anything else (empty, malformed) → null, never matches. */
export function extractMonthDay(raw: unknown): string | null {
  const s = String(raw ?? '').trim()
  const m = s.match(/^(?:\d{4}-)?(\d{2})-(\d{2})$/)
  return m ? `${m[1]}-${m[2]}` : null
}

/** Which attribute (if any) on this contact matches today. birthday checked
 *  before anniversary — a contact with both landing on the same day still
 *  gets exactly one wish per tick. */
export function matchesToday(
  attributes: Record<string, any> | null | undefined,
  todayMD: string,
): 'birthday' | 'anniversary' | null {
  if (!attributes) return null
  if (extractMonthDay(attributes.birthday) === todayMD) return 'birthday'
  if (extractMonthDay(attributes.anniversary) === todayMD) return 'anniversary'
  return null
}

/** The MANDATORY consent gate as a pure predicate — same shape the sweep's
 *  SQL join filters, re-asserted in JS so the primary gate never depends on
 *  the join alone. */
export function isConsentedMarketingWhatsApp(
  consent: { channel?: string; purpose?: string; status?: string } | null | undefined,
): boolean {
  return !!consent && consent.channel === 'whatsapp' && consent.purpose === 'marketing' && consent.status === 'opted_in'
}

export interface SweepCandidate {
  id: string
  tenant_id: string
  phone: string | null
  name: string | null
  attributes: Record<string, any> | null
  contact_consent_state:
    | { channel: string; purpose: string; status: string }[]
    | { channel: string; purpose: string; status: string }
    | null
}

/** Reduce a raw joined row set down to the ones both (a) birthday/anniv match
 *  today and (b) carry opted-in marketing/whatsapp consent. */
export function selectSweepTargets(
  rows: SweepCandidate[],
  todayMD: string,
): Array<{ id: string; tenant_id: string; phone: string | null; name: string | null; kind: 'birthday' | 'anniversary' }> {
  const out: Array<{ id: string; tenant_id: string; phone: string | null; name: string | null; kind: 'birthday' | 'anniversary' }> = []
  for (const r of rows) {
    const kind = matchesToday(r.attributes, todayMD)
    if (!kind) continue
    const consentRow = Array.isArray(r.contact_consent_state) ? r.contact_consent_state[0] : r.contact_consent_state
    if (!isConsentedMarketingWhatsApp(consentRow)) continue
    out.push({ id: r.id, tenant_id: r.tenant_id, phone: r.phone, name: r.name, kind })
  }
  return out
}
