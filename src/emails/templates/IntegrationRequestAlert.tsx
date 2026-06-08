/**
 * Internal alert to the developer team when a user requests an integration.
 * Sent from routes/integration-requests.ts. Not customer-facing, but kept
 * on-brand for a consistent internal inbox.
 */

import { Section, Text } from '@react-email/components'
import { Layout } from '../components/Layout'
import { CTAButton, Eyebrow, InfoRow, Mono, Title } from '../components/ui'
import { color, font, radius, space, type as t } from '../theme'

export interface IntegrationRequestAlertProps {
  appName: string
  tenantLabel: string
  tenantId: string
  userEmail: string
  n8nType?: string | null
  reason?: string | null
  /** Arbitrary JSON context blob. */
  context?: unknown
  createdAt: string
  dashLink: string
}

export function IntegrationRequestAlert(props: IntegrationRequestAlertProps) {
  const { appName, tenantLabel, tenantId, userEmail, n8nType, reason, context, createdAt, dashLink } = props
  const contextJson = context != null ? safeJson(context) : null
  return (
    <Layout preview={`Integration request: ${appName}`} width={600}>
      <Eyebrow>Integration request</Eyebrow>
      <Title>{appName}</Title>

      <Section style={{ marginTop: space.md }}>
        <InfoRow label="Tenant">
          {tenantLabel} <Mono>({tenantId})</Mono>
        </InfoRow>
        <InfoRow label="Requested by">{userEmail}</InfoRow>
        {n8nType ? <InfoRow label="n8n type"><Mono>{n8nType}</Mono></InfoRow> : null}
        {reason ? <InfoRow label="Reason">{reason}</InfoRow> : null}
        <InfoRow label="Created">{createdAt}</InfoRow>
      </Section>

      {contextJson ? (
        <Section style={{ marginTop: space.md }}>
          <Text style={ctxLabel}>Context</Text>
          <pre style={pre}>{contextJson}</pre>
        </Section>
      ) : null}

      <CTAButton href={dashLink}>Open in super-admin →</CTAButton>
    </Layout>
  )
}

function safeJson(v: unknown): string {
  try { return JSON.stringify(v, null, 2) } catch { return String(v) }
}

const ctxLabel = {
  margin: `0 0 ${space.xs}`,
  fontFamily: font.sans,
  fontSize: t.bodySm.fontSize,
  fontWeight: 600,
  color: color.muted,
} as const

const pre = {
  margin: 0,
  padding: space.sm,
  backgroundColor: color.codeBg,
  border: `1px solid ${color.border}`,
  borderRadius: radius.chip,
  fontFamily: font.mono,
  fontSize: '12px',
  lineHeight: '1.5',
  color: color.heading,
  whiteSpace: 'pre-wrap' as const,
  wordBreak: 'break-word' as const,
} as const

IntegrationRequestAlert.PreviewProps = {
  appName: 'HubSpot',
  tenantLabel: 'Acme Retail Pvt Ltd',
  tenantId: '8f3a2c10-1b2c-4d5e-9f00-aabbccddeeff',
  userEmail: 'ops@acme.example',
  n8nType: 'n8n-nodes-base.hubspot',
  reason: 'Need two-way contact sync for our lifecycle campaigns.',
  context: { plan: 'growth', seats: 12, region: 'in' },
  createdAt: '2026-06-07T09:30:00.000Z',
  dashLink: 'https://app.getfrequency.app/super-admin/integration-requests/req_123',
} satisfies IntegrationRequestAlertProps

export default IntegrationRequestAlert
