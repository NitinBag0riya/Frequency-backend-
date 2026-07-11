/**
 * System notification email — replaces lib/email.ts `renderNotificationEmail`.
 * Used by routes/notifications.ts when an event type's default_channels
 * includes 'email'. Title + optional body + optional CTA.
 */

import { Text } from '@react-email/components'
import { Layout } from '../components/Layout'
import { CTAButton, Paragraph, Title } from '../components/ui'
import { APP_URL, color, font, type as t } from '../theme'
import { absoluteUrl } from '../url'

export interface NotificationEmailProps {
  title: string
  body?: string | null
  link?: string | null
  appUrl?: string
}

export function NotificationEmail({ title, body, link, appUrl = APP_URL }: NotificationEmailProps) {
  const prefsUrl = absoluteUrl('/settings/notifications', appUrl)
  return (
    <Layout
      preview={title}
      footer={
        <Text style={footerStyle}>
          You're receiving this because of your{' '}
          <a href={prefsUrl} style={{ color: color.faint }}>notification preferences</a>.
        </Text>
      }
    >
      <Title>{title}</Title>
      {body ? <Paragraph muted>{body}</Paragraph> : null}
      {link ? (
        <CTAButton href={link} appUrl={appUrl}>Open in Frequency →</CTAButton>
      ) : null}
    </Layout>
  )
}

const footerStyle = {
  margin: 0,
  fontFamily: font.sans,
  fontSize: t.caption.fontSize,
  lineHeight: t.caption.lineHeight,
  color: color.faint,
} as const

NotificationEmail.PreviewProps = {
  title: 'Your trial ends in 3 days',
  body: 'Add a payment method to keep your workflows running without interruption. Nothing changes until your trial ends.',
  link: '/settings/billing',
} satisfies NotificationEmailProps

export default NotificationEmail
