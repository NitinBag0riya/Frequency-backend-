/**
 * Invoice email composition.
 *
 * The GST/tax invoice itself is a LEGAL document produced by
 * lib/gst-invoice.ts `renderInvoiceHtml()` and must stay byte-for-byte
 * unchanged. We render a branded React Email shell (InvoiceEmail) that carries
 * a plain-text slot token, then splice the invoice's inner <body> markup into
 * that slot post-render. This keeps the legal table verbatim while giving the
 * email a Frequency header/summary/footer.
 *
 * Why a token, not dangerouslySetInnerHTML or tag-matching: an alphanumeric
 * token survives react-dom/server rendering untouched (no escaping, no
 * attribute reordering), so a single string replace is reliable.
 */

import { renderEmailHtml } from './render'
import { InvoiceEmail, type InvoiceEmailProps } from './templates/InvoiceEmail'

/** Sentinel placed by InvoiceEmail; replaced with the legal invoice body. */
export const INVOICE_SLOT_TOKEN = 'FREQ_INVOICE_BODY_SLOT_7f3a9c'

/** Extract everything between <body…> and </body> from a full HTML document.
 *  Falls back to the whole string if no <body> is present. */
export function innerBody(fullHtml: string): string {
  const m = fullHtml.match(/<body[^>]*>([\s\S]*?)<\/body>/i)
  return m ? m[1] : fullHtml
}

/**
 * Render the branded invoice email and splice the legal invoice HTML into it.
 * `invoiceFullHtml` is the unchanged output of renderInvoiceHtml().
 */
export async function renderInvoiceEmail(
  props: Omit<InvoiceEmailProps, 'slotToken'>,
  invoiceFullHtml: string,
): Promise<string> {
  const shell = await renderEmailHtml(InvoiceEmail, { ...props, slotToken: INVOICE_SLOT_TOKEN })
  return shell.replace(INVOICE_SLOT_TOKEN, innerBody(invoiceFullHtml))
}
