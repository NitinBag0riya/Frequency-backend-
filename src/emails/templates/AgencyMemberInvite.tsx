/**
 * Agency team-member invite. Sent from routes/agency.ts
 * (POST /api/agencies/:id/invite). 7-day expiry.
 */

import { Layout } from '../components/Layout'
import { CTAButton, Paragraph, Panel, Title } from '../components/ui'
import { color, font, space, type as t } from '../theme'

export interface AgencyMemberInviteProps {
  agencyName: string
  /** Raw role slug (e.g. "agency_admin"); rendered humanized. */
  role: string
  acceptUrl: string
  appUrl?: string
  /** Optional agency logo (absolute https PNG/JPG); usually null. */
  agencyLogoUrl?: string | null
}

export function AgencyMemberInvite({ agencyName, role, acceptUrl, appUrl, agencyLogoUrl }: AgencyMemberInviteProps) {
  const roleLabel = String(role).replace(/_/g, ' ')
  return (
    <Layout
      preview={`You're invited to ${agencyName} on Frequency`}
      coBrand={{ name: agencyName, logoUrl: agencyLogoUrl ?? null }}
    >
      <Title>You're invited to {agencyName}</Title>
      <Paragraph>
        You've been invited to join <strong>{agencyName}</strong> on Frequency as{' '}
        <strong style={{ textTransform: 'capitalize' }}>{roleLabel}</strong>.
      </Paragraph>
      <CTAButton href={acceptUrl} appUrl={appUrl}>Accept invite</CTAButton>
      <Panel>
        <span style={note}>This link expires in 7 days.</span>
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

AgencyMemberInvite.PreviewProps = {
  agencyName: 'Northstar Growth Co.',
  role: 'agency_admin',
  acceptUrl: 'https://app.getfrequency.app/agency-invite/accept?token=eyJhbGciOi',
} satisfies AgencyMemberInviteProps

export default AgencyMemberInvite
