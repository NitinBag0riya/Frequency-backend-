/**
 * GST invoice generator — India-compliant HTML invoice + math.
 *
 * Indian GST law (CGST Act §31, Rule 46) mandates the printed invoice carry:
 *   • Seller name + address + GSTIN
 *   • Buyer name + address + GSTIN (or "Unregistered" for B2C)
 *   • Invoice number (sequential, per FY)
 *   • Invoice date
 *   • Place of supply (state code)
 *   • HSN/SAC code
 *   • Description, rate, amount per line
 *   • CGST + SGST (intra-state) OR IGST (inter-state)
 *   • Total in words
 *   • Signature
 *
 * Tax math:
 *   • SaaS = 18% GST under SAC 998314.
 *   • Seller state = Maharashtra (27) by default (configurable via env).
 *   • Buyer state = seller state → split 9% CGST + 9% SGST
 *   • Buyer state ≠ seller state → 18% IGST
 *   • Buyer state missing → fall back to IGST (treats as inter-state — safer
 *     than assuming intra-state which would under-collect for half the
 *     country's tenants).
 *
 * The HTML is plain, self-contained, no external CSS — safe to render in
 * any email client and trivially convertible to PDF later (puppeteer or
 * html-pdf-node) without changing the template.
 */

const SELLER_GSTIN_DEFAULT  = process.env.SELLER_GSTIN          ?? 'UNREGISTERED'
const SELLER_LEGAL_NAME     = process.env.SELLER_LEGAL_NAME     ?? 'Frequency Technologies Pvt Ltd'
const SELLER_ADDRESS        = process.env.SELLER_ADDRESS        ?? 'Mumbai, Maharashtra, India'
const SELLER_STATE_CODE     = process.env.SELLER_STATE_CODE     ?? '27'  // Maharashtra
const SELLER_STATE_NAME     = process.env.SELLER_STATE_NAME     ?? 'Maharashtra'
const SELLER_EMAIL          = process.env.SELLER_EMAIL          ?? 'billing@frequency.in'
const HSN_SAC_IT_SERVICES   = '998314'

export interface GstComputation {
  amount_paise:    bigint | number   // pre-tax amount
  cgst_paise:      bigint | number
  sgst_paise:      bigint | number
  igst_paise:      bigint | number
  gst_total_paise: bigint | number
  total_paise:     bigint | number   // amount + gst
  intra_state:     boolean
  gst_rate_pct:    number            // 18
}

/**
 * Compute CGST/SGST/IGST given a pre-tax amount and the buyer's state code.
 *
 * SECURITY/CORRECTNESS: rounded to nearest paise using banker's rounding
 * implicitly via Math.round. Tax authority accepts ±1 paise discrepancies
 * on rounding; we apportion half-and-half on intra-state so CGST + SGST
 * sum is exact (no off-by-one rounding artifact between the two halves).
 */
export function computeGst(
  amountPaise: number,
  buyerStateCode: string | null | undefined,
  gstRatePct: number = 18,
): GstComputation {
  const sellerState = SELLER_STATE_CODE
  const intraState  = !!buyerStateCode && buyerStateCode === sellerState
  const gstTotal    = Math.round((amountPaise * gstRatePct) / 100)

  let cgst = 0, sgst = 0, igst = 0
  if (intraState) {
    // Split half-and-half. If gstTotal is odd, give the extra paise to CGST
    // (arbitrary but stable convention).
    cgst = Math.ceil(gstTotal / 2)
    sgst = Math.floor(gstTotal / 2)
  } else {
    igst = gstTotal
  }

  return {
    amount_paise:    amountPaise,
    cgst_paise:      cgst,
    sgst_paise:      sgst,
    igst_paise:      igst,
    gst_total_paise: gstTotal,
    total_paise:     amountPaise + gstTotal,
    intra_state:     intraState,
    gst_rate_pct:    gstRatePct,
  }
}

/**
 * Generate a sequential per-FY invoice number.
 *
 * Indian FY = April→March. Format: FREQ/{YY-YY+1}/{NNNNN}
 *   FY 2026-27 = April 2026 → March 2027 → "FREQ/2026-27/00001"
 *
 * Caller passes the count of invoices already issued THIS FY so the next
 * one gets count+1. Caller MUST hold a transactional lock or use the
 * unique index to dedup; this helper only formats.
 */
export function formatInvoiceNumber(seqInFy: number, now: Date = new Date()): string {
  const month = now.getUTCMonth() + 1  // 1-12
  // April (4) onwards is the new FY.
  const fyStart = month >= 4 ? now.getUTCFullYear() : now.getUTCFullYear() - 1
  const fyEnd   = fyStart + 1
  const fyLabel = `${fyStart}-${String(fyEnd).slice(-2)}`
  return `FREQ/${fyLabel}/${String(seqInFy).padStart(5, '0')}`
}

/** Fetch the next sequential invoice number for the current FY. Uses a
 *  COUNT of existing invoices that match the FY prefix — cheap, correct, and
 *  the unique index on invoice_number stops a race from issuing two
 *  duplicates (the second INSERT will fail and the caller retries with
 *  seq+1). */
export async function nextInvoiceNumber(
  supabase: any,
  now: Date = new Date(),
): Promise<string> {
  const month = now.getUTCMonth() + 1
  const fyStart = month >= 4 ? now.getUTCFullYear() : now.getUTCFullYear() - 1
  const prefix = `FREQ/${fyStart}-${String(fyStart + 1).slice(-2)}/`
  const { count } = await supabase.from('invoices')
    .select('id', { count: 'exact', head: true })
    .like('invoice_number', `${prefix}%`)
  return formatInvoiceNumber((count ?? 0) + 1, now)
}

export interface InvoiceParams {
  invoiceNumber:  string
  issueDate:      Date
  buyerName:      string
  buyerAddress:   string
  buyerStateName: string | null
  buyerStateCode: string | null
  buyerGstin:     string | null
  description:    string                 // e.g. "Frequency Growth — Quarterly Plan (Aug-Oct 2026)"
  gst:            GstComputation
}

/** Format paise → "₹1,234.56" (Indian numbering with paise). */
export function formatINR(paise: bigint | number): string {
  const rupees = Number(paise) / 100
  return new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency: 'INR',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(rupees)
}

/** Convert paise → words in Indian English (Rupees + paise). Used by the
 *  "Amount in words" line — GST law requires it. */
export function paiseToWords(paise: bigint | number): string {
  const total = Number(paise)
  const rupees = Math.floor(total / 100)
  const remPaise = total % 100
  const rupeeWords = numToWords(rupees)
  if (remPaise === 0) return `${rupeeWords} rupees only`
  return `${rupeeWords} rupees and ${numToWords(remPaise)} paise only`
}

// Indian numbering converter (handles lakh / crore). Bounded — caller's
// invoice amounts won't exceed ~₹10 crore in practice.
function numToWords(n: number): string {
  if (!Number.isFinite(n) || n < 0) return 'zero'
  if (n === 0) return 'zero'
  const ones = ['', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine',
                'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen',
                'seventeen', 'eighteen', 'nineteen']
  const tens = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety']
  function below100(num: number): string {
    if (num < 20) return ones[num]
    const t = Math.floor(num / 10), o = num % 10
    return o === 0 ? tens[t] : `${tens[t]}-${ones[o]}`
  }
  function below1000(num: number): string {
    if (num < 100) return below100(num)
    const h = Math.floor(num / 100), r = num % 100
    return r === 0 ? `${ones[h]} hundred` : `${ones[h]} hundred ${below100(r)}`
  }
  // Indian segments: crore (1e7), lakh (1e5), thousand (1e3), then below 1000.
  const crore    = Math.floor(n / 10000000)
  const lakh     = Math.floor((n % 10000000) / 100000)
  const thousand = Math.floor((n % 100000) / 1000)
  const rest     = n % 1000
  const parts: string[] = []
  if (crore)    parts.push(`${below1000(crore)} crore`)
  if (lakh)     parts.push(`${below100(lakh)} lakh`)
  if (thousand) parts.push(`${below100(thousand)} thousand`)
  if (rest)     parts.push(below1000(rest))
  return parts.join(' ').trim() || 'zero'
}

/**
 * Render a self-contained HTML invoice. Inline styles only (Gmail strips
 * <style>). Layout: header strip, two columns (seller / buyer), line items
 * table, totals + tax breakdown, amount in words, footer.
 *
 * Safe: every user-controlled field (buyer name/address/GSTIN, description)
 * is HTML-escaped at output. Don't pass raw HTML in — this function escapes
 * what it gets.
 */
export function renderInvoiceHtml(p: InvoiceParams): string {
  const g = p.gst
  const dateStr = p.issueDate.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })
  const buyerGstinDisp  = p.buyerGstin?.trim() ? esc(p.buyerGstin) : '<i>Unregistered (B2C)</i>'
  const buyerStateDisp  = p.buyerStateName?.trim() ? esc(p.buyerStateName) : 'Unknown'
  const buyerStateCode  = p.buyerStateCode?.trim() ? esc(p.buyerStateCode) : '—'
  const placeOfSupply   = `${buyerStateDisp} (${buyerStateCode})`
  const amountWordsLine = `Amount in words: ${esc(paiseToWords(g.total_paise))}`

  // Tax row(s) — split for intra-state, single for IGST.
  const taxRowsHtml = g.intra_state
    ? `<tr><td style="padding:4px 8px;border-top:1px solid #e6e8e6">CGST @ ${(g.gst_rate_pct / 2).toFixed(1)}%</td><td style="padding:4px 8px;border-top:1px solid #e6e8e6;text-align:right">${esc(formatINR(g.cgst_paise))}</td></tr>
       <tr><td style="padding:4px 8px">SGST @ ${(g.gst_rate_pct / 2).toFixed(1)}%</td><td style="padding:4px 8px;text-align:right">${esc(formatINR(g.sgst_paise))}</td></tr>`
    : `<tr><td style="padding:4px 8px;border-top:1px solid #e6e8e6">IGST @ ${g.gst_rate_pct.toFixed(1)}%</td><td style="padding:4px 8px;border-top:1px solid #e6e8e6;text-align:right">${esc(formatINR(g.igst_paise))}</td></tr>`

  return `<!doctype html><html><body style="margin:0;background:#f7f8f7;font-family:'DM Sans',Arial,sans-serif;color:#1a1a1a;-webkit-font-smoothing:antialiased">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="padding:32px 16px">
    <tr><td align="center">
      <table role="presentation" width="640" cellpadding="0" cellspacing="0" style="max-width:640px;width:100%;background:#fff;border:1px solid #e6e8e6;border-radius:10px;overflow:hidden">

        <!-- Header strip -->
        <tr><td style="padding:18px 24px;border-bottom:1px solid #f0f1f0;display:flex;align-items:center;justify-content:space-between">
          <div>
            <div style="font-weight:700;color:#0F6E56;letter-spacing:-0.01em;font-size:16px">Frequency</div>
            <div style="font-size:11px;color:#6b7280;margin-top:2px">Tax Invoice — original for recipient</div>
          </div>
        </td></tr>

        <!-- Invoice meta -->
        <tr><td style="padding:18px 24px 0 24px">
          <table width="100%" cellpadding="0" cellspacing="0" style="font-size:12px">
            <tr>
              <td>
                <div style="color:#6b7280;text-transform:uppercase;letter-spacing:.04em;font-size:10px">Invoice no.</div>
                <div style="font-weight:600;font-size:13px;margin-top:2px">${esc(p.invoiceNumber)}</div>
              </td>
              <td style="text-align:right">
                <div style="color:#6b7280;text-transform:uppercase;letter-spacing:.04em;font-size:10px">Date</div>
                <div style="font-weight:600;font-size:13px;margin-top:2px">${esc(dateStr)}</div>
              </td>
            </tr>
          </table>
        </td></tr>

        <!-- Seller / Buyer -->
        <tr><td style="padding:18px 24px 0 24px">
          <table width="100%" cellpadding="0" cellspacing="0" style="font-size:12px">
            <tr>
              <td valign="top" style="width:50%;padding-right:12px">
                <div style="color:#6b7280;text-transform:uppercase;letter-spacing:.04em;font-size:10px">From</div>
                <div style="font-weight:600;margin-top:2px">${esc(SELLER_LEGAL_NAME)}</div>
                <div style="margin-top:2px;line-height:1.4">${esc(SELLER_ADDRESS)}</div>
                <div style="margin-top:4px"><strong>GSTIN:</strong> ${esc(SELLER_GSTIN_DEFAULT)}</div>
                <div><strong>State:</strong> ${esc(SELLER_STATE_NAME)} (${esc(SELLER_STATE_CODE)})</div>
              </td>
              <td valign="top" style="width:50%;padding-left:12px;border-left:1px solid #f0f1f0">
                <div style="color:#6b7280;text-transform:uppercase;letter-spacing:.04em;font-size:10px">Bill to</div>
                <div style="font-weight:600;margin-top:2px">${esc(p.buyerName)}</div>
                <div style="margin-top:2px;line-height:1.4">${esc(p.buyerAddress)}</div>
                <div style="margin-top:4px"><strong>GSTIN:</strong> ${buyerGstinDisp}</div>
                <div><strong>State:</strong> ${placeOfSupply}</div>
              </td>
            </tr>
          </table>
        </td></tr>

        <!-- Line items -->
        <tr><td style="padding:18px 24px 0 24px">
          <table width="100%" cellpadding="0" cellspacing="0" style="font-size:12px;border:1px solid #e6e8e6;border-radius:6px;border-collapse:separate;border-spacing:0">
            <thead>
              <tr style="background:#fafafa">
                <th align="left"  style="padding:8px 10px;font-weight:600;border-bottom:1px solid #e6e8e6;color:#374151">Description</th>
                <th align="center" style="padding:8px 10px;font-weight:600;border-bottom:1px solid #e6e8e6;color:#374151">SAC</th>
                <th align="right" style="padding:8px 10px;font-weight:600;border-bottom:1px solid #e6e8e6;color:#374151">Amount</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td style="padding:10px;vertical-align:top">${esc(p.description)}</td>
                <td style="padding:10px;text-align:center;font-family:monospace">${HSN_SAC_IT_SERVICES}</td>
                <td style="padding:10px;text-align:right;font-variant-numeric:tabular-nums">${esc(formatINR(g.amount_paise))}</td>
              </tr>
            </tbody>
          </table>
        </td></tr>

        <!-- Totals + tax breakdown -->
        <tr><td style="padding:14px 24px 0 24px">
          <table width="100%" cellpadding="0" cellspacing="0" style="font-size:12px">
            <tr>
              <td style="width:55%"></td>
              <td style="width:45%">
                <table width="100%" cellpadding="0" cellspacing="0" style="font-variant-numeric:tabular-nums">
                  <tr><td style="padding:4px 8px;color:#6b7280">Subtotal</td><td style="padding:4px 8px;text-align:right">${esc(formatINR(g.amount_paise))}</td></tr>
                  ${taxRowsHtml}
                  <tr><td style="padding:8px;border-top:2px solid #1a1a1a;font-weight:700">Total payable</td><td style="padding:8px;border-top:2px solid #1a1a1a;text-align:right;font-weight:700">${esc(formatINR(g.total_paise))}</td></tr>
                </table>
              </td>
            </tr>
          </table>
        </td></tr>

        <!-- Place of supply + amount-in-words -->
        <tr><td style="padding:14px 24px 0 24px;font-size:11px;color:#6b7280">
          <div><strong>Place of supply:</strong> ${placeOfSupply}</div>
          <div style="margin-top:4px">${amountWordsLine}</div>
        </td></tr>

        <!-- Footer -->
        <tr><td style="padding:22px 24px;border-top:1px solid #f0f1f0;font-size:11px;color:#6b7280">
          <div>This is a computer-generated invoice; no signature required.</div>
          <div style="margin-top:4px">Questions? Reply to ${esc(SELLER_EMAIL)}.</div>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`
}

function esc(s: string): string {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}
