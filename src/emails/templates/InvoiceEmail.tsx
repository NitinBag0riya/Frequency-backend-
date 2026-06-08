/**
 * Branded shell for invoice emails (GST tax invoice + agency platform-fee
 * invoice). Renders a Frequency header, a summary card (number / amount /
 * date), an optional "view in browser" CTA, then a FULL-WIDTH slot where the
 * legal invoice table is spliced in (see emails/invoice.ts), and a footer.
 *
 * The invoice slot sits OUTSIDE the narrow summary card so Outlook's Word
 * engine doesn't clip the wide legal table.
 */

import { Body, Container, Font, Head, Hr, Html, Preview, Section, Text } from '@react-email/components'
import { FrequencyMark } from '../components/Layout'
import { CTAButton, Eyebrow, InfoRow } from '../components/ui'
import { color, figtreeWebFont, font, layout, radius, space, type as t } from '../theme'

export interface InvoiceEmailProps {
  /** "Tax invoice" | "Agency invoice" etc. */
  heading: string
  invoiceNumber: string
  /** Pre-formatted amount, e.g. "₹1,499". */
  amountLabel: string
  /** Pre-formatted issue date, e.g. "7 Jun 2026". */
  dateLabel: string
  buyerName: string
  description: string
  /** Optional "view invoice in browser" link. */
  viewUrl?: string | null
  appUrl?: string
  /** Replaced post-render with the legal invoice body. */
  slotToken: string
}

export function InvoiceEmail(props: InvoiceEmailProps) {
  const { heading, invoiceNumber, amountLabel, dateLabel, buyerName, description, viewUrl, appUrl, slotToken } = props
  return (
    <Html lang="en">
      <Head>
        <Font
          fontFamily="Figtree"
          fallbackFontFamily={['Helvetica', 'Arial', 'sans-serif']}
          webFont={figtreeWebFont}
          fontWeight={400}
          fontStyle="normal"
        />
      </Head>
      <Preview>{`${heading} ${invoiceNumber} — ${amountLabel}`}</Preview>
      <Body style={main}>
        <Container style={outer}>
          {/* Summary card */}
          <Container style={card}>
            <Section style={headerBand}>
              <FrequencyMark />
            </Section>
            <Section style={content}>
              <Eyebrow>{heading}</Eyebrow>
              <Text style={amount}>{amountLabel}</Text>
              <Text style={paid}>Paid · Thank you</Text>
              <Section style={{ marginTop: space.md }}>
                <InfoRow label="Invoice">{invoiceNumber}</InfoRow>
                <InfoRow label="Billed to">{buyerName}</InfoRow>
                <InfoRow label="Date">{dateLabel}</InfoRow>
                <InfoRow label="For">{description}</InfoRow>
              </Section>
              {viewUrl ? <CTAButton href={viewUrl} appUrl={appUrl}>View invoice in browser →</CTAButton> : null}
            </Section>
          </Container>

          {/* Full-width legal invoice (spliced in post-render) */}
          <Section style={invoiceWrap}>
            <Text style={legalLabel}>Tax invoice for your records</Text>
            {slotToken}
          </Section>

          <Hr style={rule} />
          <Text style={legal}>© Frequency · This is a system-generated invoice email.</Text>
        </Container>
      </Body>
    </Html>
  )
}

const main = {
  margin: 0,
  padding: 0,
  backgroundColor: color.pageBg,
  fontFamily: font.sans,
  color: color.text,
  WebkitFontSmoothing: 'antialiased',
} as const

const outer = { width: '100%', maxWidth: layout.invoiceWidth, padding: `${space.xxl} ${space.md}` } as const

const card = {
  width: '100%',
  backgroundColor: color.surface,
  border: `1px solid ${color.border}`,
  borderRadius: radius.card,
  overflow: 'hidden',
  marginBottom: space.lg,
} as const

const headerBand = { padding: `${space.lg} ${space.lg} ${space.md}`, borderBottom: `1px solid ${color.borderFaint}` } as const
const content = { padding: space.lg } as const

const amount = {
  margin: `${space.xs} 0 0`,
  fontFamily: font.sans,
  fontSize: '32px',
  lineHeight: '1.1',
  fontWeight: 700,
  letterSpacing: '-0.02em',
  color: color.heading,
} as const

const paid = { margin: `${space.xs} 0 0`, fontFamily: font.sans, fontSize: t.bodySm.fontSize, fontWeight: 600, color: color.brand } as const

const invoiceWrap = {
  backgroundColor: color.surface,
  border: `1px solid ${color.border}`,
  borderRadius: radius.card,
  padding: space.lg,
} as const

const legalLabel = { margin: `0 0 ${space.md}`, fontFamily: font.sans, ...t.eyebrow, color: color.faint } as const
const rule = { margin: `${space.lg} 0 ${space.md}`, borderColor: color.borderFaint } as const
const legal = { margin: 0, textAlign: 'center' as const, fontFamily: font.sans, fontSize: '11px', lineHeight: '1.5', color: color.faint } as const

InvoiceEmail.PreviewProps = {
  heading: 'Tax invoice',
  invoiceNumber: 'FREQ-2026-000123',
  amountLabel: '₹1,499',
  dateLabel: '7 Jun 2026',
  buyerName: 'Acme Retail Pvt Ltd',
  description: 'Frequency Growth Plan — subscription period ending Jun 2026',
  viewUrl: 'https://app.getfrequency.app/settings/billing/invoices/FREQ-2026-000123',
  slotToken: '[ legal invoice table renders here ]',
} satisfies InvoiceEmailProps

export default InvoiceEmail
