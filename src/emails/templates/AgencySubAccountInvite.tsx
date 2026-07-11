/**
 * Agency → tenant "connect your workspace as a managed sub-account" invite.
 * Sent from routes/agency.ts (POST /api/agency-links/invite). 7-day expiry.
 */

import { Layout } from '../components/Layout'
import { CTAButton, Paragraph, Panel, Title } from '../components/ui'
import { color, font, type as t } from '../theme'

export interface AgencySubAccountInviteProps {
  agencyName: string
  acceptUrl: string
  appUrl?: string
  /** Optional agency logo (absolute https PNG/JPG) — agencies don't store one
   *  yet (white-label deferred), so this is usually null and we co-brand with
   *  the agency name. */
  agencyLogoUrl?: string | null
}

export function AgencySubAccountInvite({ agencyName, acceptUrl, appUrl, agencyLogoUrl }: AgencySubAccountInviteProps) {
  return (
    <Layout
      preview={`${agencyName} invited you to connect your workspace`}
      coBrand={{ name: agencyName, logoUrl: agencyLogoUrl ?? null }}
    >
      <Title>{agencyName} wants to manage your workspace</Title>
      <Paragraph>
        <strong>{agencyName}</strong> has invited you to connect your Frequency workspace as a
        managed sub-account. You keep full ownership of your account — they get a view of your
        workspace and can optionally take over billing.
      </Paragraph>
      <CTAButton href={acceptUrl} appUrl={appUrl}>Review &amp; accept</CTAButton>
      <Panel>
        <span style={note}>
          This link expires in 7 days. If you weren't expecting this, you can safely ignore this email.
        </span>
      </Panel>
    </Layout>
  )
}

const note = {
  fontFamily: font.sans,
  fontSize: t.bodySm.fontSize,
  lineHeight: t.bodySm.lineHeight,
  color: color.muted,
} as const

AgencySubAccountInvite.PreviewProps = {
  agencyName: 'Northstar Growth Co.',
  acceptUrl: 'https://app.getfrequency.app/agency-link/accept?token=eyJhbGciOi',
} satisfies AgencySubAccountInviteProps

export default AgencySubAccountInvite
