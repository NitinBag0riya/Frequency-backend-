/**
 * Email UI primitives built on @react-email/components, styled from theme.ts.
 *
 * SECURITY: CTAButton + InlineLink run every href through absoluteUrl() so a
 * caller physically cannot pass a `javascript:`/`data:` link into the rendered
 * markup. Pass raw links freely; they're neutralized here.
 */

import { Button, Column, Hr, Heading as REHeading, Link, Row, Section, Text } from '@react-email/components'
import type { ReactNode } from 'react'
import { color, font, radius, space, type as t } from '../theme'
import { absoluteUrl } from '../url'

export function Title({ children }: { children: ReactNode }) {
  return <REHeading as="h1" style={titleStyle}>{children}</REHeading>
}

export function Subtitle({ children }: { children: ReactNode }) {
  return <REHeading as="h2" style={subtitleStyle}>{children}</REHeading>
}

export function Eyebrow({ children }: { children: ReactNode }) {
  return <Text style={eyebrowStyle}>{children}</Text>
}

export function Paragraph({ children, muted }: { children: ReactNode; muted?: boolean }) {
  return <Text style={muted ? mutedStyle : bodyStyle}>{children}</Text>
}

export function CTAButton({ href, appUrl, children }: { href: string; appUrl?: string; children: ReactNode }) {
  return (
    <Section style={{ paddingTop: space.lg, paddingBottom: space.xs }}>
      <Button href={absoluteUrl(href, appUrl)} style={buttonStyle}>{children}</Button>
    </Section>
  )
}

export function InlineLink({ href, appUrl, children }: { href: string; appUrl?: string; children: ReactNode }) {
  return <Link href={absoluteUrl(href, appUrl)} style={linkStyle}>{children}</Link>
}

export function Divider() {
  return <Hr style={dividerStyle} />
}

/**
 * Button/link for TRUSTED, already-safe hrefs that must pass through verbatim —
 * e.g. Supabase Go-template vars like `{{ .ConfirmationURL }}` that absoluteUrl
 * would otherwise mangle. Never use these with user-controlled input.
 */
export function RawButton({ href, children }: { href: string; children: ReactNode }) {
  return (
    <Section style={{ paddingTop: space.lg, paddingBottom: space.xs }}>
      <Button href={href} style={buttonStyle}>{children}</Button>
    </Section>
  )
}

export function RawLink({ href, children }: { href: string; children: ReactNode }) {
  return <Link href={href} style={linkStyle}>{children}</Link>
}

/** A 6-digit OTP / token, displayed prominently in mono. */
export function TokenBlock({ children }: { children: ReactNode }) {
  return (
    <Section style={tokenWrap}>
      <Text style={tokenText}>{children}</Text>
    </Section>
  )
}

/** Monospace identifier (FREQ-XXXX, ids, amounts) — JetBrains Mono. */
export function Mono({ children }: { children: ReactNode }) {
  return <span style={monoStyle}>{children}</span>
}

/** Label/value metadata grid (integration-request alert, invoice summary). */
export function InfoRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <Row style={infoRowStyle}>
      <Column style={infoLabelCol}><Text style={infoLabel}>{label}</Text></Column>
      <Column style={infoValueCol}><Text style={infoValue}>{children}</Text></Column>
    </Row>
  )
}

/** Tinted callout panel (e.g. "expires in 7 days", invoice totals). */
export function Panel({ children, tone = 'neutral' }: { children: ReactNode; tone?: 'neutral' | 'brand' }) {
  return <Section style={tone === 'brand' ? panelBrand : panelNeutral}>{children}</Section>
}

const titleStyle = {
  margin: `0 0 ${space.sm}`,
  fontFamily: font.sans,
  fontSize: t.h1.fontSize,
  lineHeight: t.h1.lineHeight,
  fontWeight: t.h1.fontWeight,
  letterSpacing: t.h1.letterSpacing,
  color: color.heading,
} as const

const subtitleStyle = {
  margin: `0 0 ${space.sm}`,
  fontFamily: font.sans,
  fontSize: t.h3.fontSize,
  lineHeight: t.h3.lineHeight,
  fontWeight: t.h3.fontWeight,
  color: color.heading,
} as const

const eyebrowStyle = {
  margin: `0 0 ${space.xs}`,
  fontFamily: font.sans,
  ...t.eyebrow,
  color: color.brand,
} as const

const bodyStyle = {
  margin: `0 0 ${space.sm}`,
  fontFamily: font.sans,
  fontSize: t.body.fontSize,
  lineHeight: t.body.lineHeight,
  color: color.text,
} as const

const mutedStyle = {
  ...bodyStyle,
  color: color.muted,
} as const

const buttonStyle = {
  display: 'inline-block',
  backgroundColor: color.brand,
  color: color.onBrand,
  fontFamily: font.sans,
  fontWeight: 600,
  fontSize: '14px',
  textDecoration: 'none',
  padding: '11px 22px',
  borderRadius: radius.button,
} as const

const linkStyle = {
  color: color.brand,
  fontFamily: font.sans,
  fontWeight: 600,
  textDecoration: 'underline',
} as const

const dividerStyle = {
  margin: `${space.lg} 0`,
  borderColor: color.borderFaint,
} as const

const monoStyle = {
  fontFamily: font.mono,
  fontSize: '13px',
  color: color.heading,
} as const

const infoRowStyle = {
  borderBottom: `1px solid ${color.borderFaint}`,
} as const

const infoLabelCol = { width: '38%', verticalAlign: 'top' as const, padding: `${space.xs} 0` } as const
const infoValueCol = { width: '62%', verticalAlign: 'top' as const, padding: `${space.xs} 0` } as const

const infoLabel = {
  margin: 0,
  fontFamily: font.sans,
  fontSize: t.bodySm.fontSize,
  fontWeight: 600,
  color: color.muted,
} as const

const infoValue = {
  margin: 0,
  fontFamily: font.sans,
  fontSize: t.bodySm.fontSize,
  lineHeight: t.bodySm.lineHeight,
  color: color.heading,
  wordBreak: 'break-word' as const,
} as const

const panelNeutral = {
  backgroundColor: color.pageBg,
  border: `1px solid ${color.border}`,
  borderRadius: radius.chip,
  padding: space.md,
  margin: `${space.md} 0`,
} as const

const panelBrand = {
  backgroundColor: color.brandTint,
  border: `1px solid ${color.brand}`,
  borderRadius: radius.chip,
  padding: space.md,
  margin: `${space.md} 0`,
} as const

const tokenWrap = {
  backgroundColor: color.pageBg,
  border: `1px solid ${color.border}`,
  borderRadius: radius.chip,
  padding: `${space.md} ${space.sm}`,
  margin: `${space.md} 0`,
  textAlign: 'center' as const,
} as const

const tokenText = {
  margin: 0,
  fontFamily: font.mono,
  fontSize: '26px',
  fontWeight: 700,
  letterSpacing: '0.18em',
  color: color.heading,
} as const
