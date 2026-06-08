/**
 * Branded email shell. Every Frequency template renders inside this:
 *   Figtree <Font> (Apple Mail only; everyone else falls back) → page bg →
 *   centered white card with a "Frequency" wordmark header, the template
 *   body, and a footer.
 *
 * Kept lean on purpose (no images / base64) so the whole email stays well
 * under Gmail's ~102KB clipping threshold, which matters most for invoices
 * that embed a full legal table.
 */

import {
  Body, Column, Container, Font, Head, Hr, Html, Img, Preview, Row, Section, Text,
} from '@react-email/components'
import type { ReactNode } from 'react'
import { color, figtreeWebFont, font, layout, LOGO_SIZE, LOGO_URL, radius, space, type as t } from '../theme'

/** Co-branding for partner-sent emails (e.g. agency invites): show the
 *  sender's brand alongside a "via Frequency" lockup. `logoUrl` is optional —
 *  agencies don't store logos yet (white-label logos deferred, migration 079),
 *  so we fall back to a coloured initial badge. */
export interface CoBrand {
  name: string
  logoUrl?: string | null
}

export interface LayoutProps {
  /** Preheader shown in the inbox list (hidden in the body). */
  preview: string
  children: ReactNode
  /** Footer content. Defaults to the company line. */
  footer?: ReactNode
  /** Card width — wider for invoices. */
  width?: number
  /** When set, render a co-branded header (partner brand + "via Frequency"). */
  coBrand?: CoBrand | null
}

/** Frequency logo mark + wordmark lockup. */
export function FrequencyMark({ compact }: { compact?: boolean }) {
  return (
    <table role="presentation" cellPadding={0} cellSpacing={0} style={{ borderCollapse: 'collapse' }}>
      <tbody>
        <tr>
          <td style={{ paddingRight: '8px', verticalAlign: 'middle' }}>
            <Img src={LOGO_URL} width={compact ? 20 : LOGO_SIZE} height={compact ? 20 : LOGO_SIZE} alt="Frequency" style={logoImg} />
          </td>
          <td style={{ verticalAlign: 'middle' }}>
            <span style={compact ? wordmarkSm : wordmark}>Frequency</span>
          </td>
        </tr>
      </tbody>
    </table>
  )
}

function PartnerMark({ coBrand }: { coBrand: CoBrand }) {
  const initial = (coBrand.name?.trim()?.[0] ?? 'A').toUpperCase()
  return (
    <table role="presentation" cellPadding={0} cellSpacing={0} style={{ borderCollapse: 'collapse' }}>
      <tbody>
        <tr>
          <td style={{ paddingRight: '8px', verticalAlign: 'middle' }}>
            {coBrand.logoUrl
              ? <Img src={coBrand.logoUrl} width={LOGO_SIZE} height={LOGO_SIZE} alt={coBrand.name} style={logoImg} />
              : <span style={initialBadge}>{initial}</span>}
          </td>
          <td style={{ verticalAlign: 'middle' }}>
            <span style={partnerName}>{coBrand.name}</span>
          </td>
        </tr>
      </tbody>
    </table>
  )
}

export function Layout({ preview, children, footer, width = layout.cardWidth, coBrand }: LayoutProps) {
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
      <Preview>{preview}</Preview>
      <Body style={main}>
        <Container style={{ ...outer, maxWidth: width }}>
          <Container style={{ ...card, maxWidth: width }}>
            <Section style={headerBand}>
              {coBrand ? (
                <Row>
                  <Column style={{ verticalAlign: 'middle' }}><PartnerMark coBrand={coBrand} /></Column>
                  <Column align="right" style={{ verticalAlign: 'middle' }}>
                    <table role="presentation" cellPadding={0} cellSpacing={0} style={{ borderCollapse: 'collapse', marginLeft: 'auto' }}>
                      <tbody><tr>
                        <td style={{ paddingRight: '6px', verticalAlign: 'middle' }}><span style={viaText}>via</span></td>
                        <td style={{ verticalAlign: 'middle' }}><FrequencyMark compact /></td>
                      </tr></tbody>
                    </table>
                  </Column>
                </Row>
              ) : (
                <FrequencyMark />
              )}
            </Section>
            <Section style={content}>{children}</Section>
            <Hr style={rule} />
            <Section style={footerPad}>
              {footer ?? <Text style={footerText}>You're receiving this from Frequency.</Text>}
            </Section>
          </Container>
          <Text style={legal}>
            © Frequency · Sent to keep your workspace running.
          </Text>
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

const outer = {
  width: '100%',
  padding: `${space.xxl} ${space.md}`,
} as const

const card = {
  width: '100%',
  backgroundColor: color.surface,
  border: `1px solid ${color.border}`,
  borderRadius: radius.card,
  overflow: 'hidden',
} as const

const headerBand = {
  padding: `${space.lg} ${space.lg} ${space.md}`,
  borderBottom: `1px solid ${color.borderFaint}`,
} as const

const wordmark = {
  fontFamily: font.sans,
  fontWeight: 700,
  fontSize: '18px',
  letterSpacing: '-0.01em',
  color: color.brand,
} as const

const wordmarkSm = { ...wordmark, fontSize: '14px' } as const

const logoImg = {
  display: 'block',
  borderRadius: '7px',
  border: `1px solid ${color.borderFaint}`,
} as const

const initialBadge = {
  display: 'inline-block',
  width: `${LOGO_SIZE}px`,
  height: `${LOGO_SIZE}px`,
  lineHeight: `${LOGO_SIZE}px`,
  textAlign: 'center' as const,
  borderRadius: '7px',
  backgroundColor: color.brandTint,
  color: color.brandDark,
  fontFamily: font.sans,
  fontWeight: 700,
  fontSize: '15px',
} as const

const partnerName = {
  fontFamily: font.sans,
  fontWeight: 700,
  fontSize: '16px',
  letterSpacing: '-0.01em',
  color: color.heading,
} as const

const viaText = {
  fontFamily: font.sans,
  fontSize: '12px',
  color: color.faint,
} as const

const content = {
  padding: space.lg,
} as const

const rule = {
  margin: 0,
  borderColor: color.borderFaint,
} as const

const footerPad = {
  padding: `${space.md} ${space.lg}`,
} as const

const footerText = {
  margin: 0,
  fontFamily: font.sans,
  fontSize: t.caption.fontSize,
  lineHeight: t.caption.lineHeight,
  color: color.faint,
} as const

const legal = {
  margin: `${space.md} 0 0`,
  textAlign: 'center' as const,
  fontFamily: font.sans,
  fontSize: '11px',
  lineHeight: '1.5',
  color: color.faint,
} as const
