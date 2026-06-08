/**
 * Shared chrome for Supabase Auth emails (confirm signup, magic link, invite,
 * reset password, change email).
 *
 * These are rendered to STATIC HTML and pasted into the Supabase dashboard, so
 * the dynamic bits are Supabase Go-template variables ({{ .ConfirmationURL }},
 * {{ .Token }}, {{ .Email }} …). They pass through React verbatim because they
 * contain no HTML-special characters, and they MUST bypass absoluteUrl() — so
 * we use RawButton / RawLink, never the absoluteUrl-wrapping CTAButton.
 */

import { Text } from '@react-email/components'
import type { ReactNode } from 'react'
import { Layout } from './Layout'
import { Paragraph, RawButton, RawLink, TokenBlock, Title } from './ui'
import { color, font, type as t } from '../theme'

export interface AuthEmailProps {
  preview: string
  title: string
  intro: ReactNode
  buttonLabel: string
  /** The action URL var — defaults to Supabase's {{ .ConfirmationURL }}. */
  actionUrl?: string
  /** When set, also show a copy-paste OTP block (Supabase {{ .Token }}). */
  showToken?: boolean
  /** OTP value — defaults to Supabase's {{ .Token }} var; override for previews. */
  tokenValue?: string
  /** Security / expiry footnote. */
  note?: ReactNode
}

const CONFIRMATION_URL = '{{ .ConfirmationURL }}'
const TOKEN = '{{ .Token }}'

export function AuthEmail({ preview, title, intro, buttonLabel, actionUrl = CONFIRMATION_URL, showToken, tokenValue = TOKEN, note }: AuthEmailProps) {
  return (
    <Layout
      preview={preview}
      footer={<Text style={footer}>If you didn't request this, you can safely ignore this email — no changes will be made.</Text>}
    >
      <Title>{title}</Title>
      <Paragraph muted>{intro}</Paragraph>
      <RawButton href={actionUrl}>{buttonLabel}</RawButton>

      {showToken ? (
        <>
          <Paragraph muted>Or enter this code:</Paragraph>
          <TokenBlock>{tokenValue}</TokenBlock>
        </>
      ) : null}

      <Text style={fallback}>
        Or paste this link into your browser:<br />
        <RawLink href={actionUrl}>{actionUrl}</RawLink>
      </Text>

      {note ? <Text style={noteStyle}>{note}</Text> : null}
    </Layout>
  )
}

const footer = {
  margin: 0,
  fontFamily: font.sans,
  fontSize: t.caption.fontSize,
  lineHeight: t.caption.lineHeight,
  color: color.faint,
} as const

const fallback = {
  margin: '20px 0 0',
  fontFamily: font.sans,
  fontSize: t.bodySm.fontSize,
  lineHeight: '1.6',
  color: color.muted,
  wordBreak: 'break-all' as const,
} as const

const noteStyle = {
  margin: '16px 0 0',
  fontFamily: font.sans,
  fontSize: t.caption.fontSize,
  lineHeight: t.caption.lineHeight,
  color: color.faint,
} as const
