/**
 * Send a batch of REAL preview emails to an inbox so you can eyeball them.
 *
 *   npx tsx src/emails/scripts/send-previews.ts [recipient]
 *
 * Defaults to nitin.naruto@gmail.com. Uses the real Resend config from .env.
 * These render the production templates with realistic sample data (sample
 * confirm URLs / OTPs / a real GST invoice), NOT the Supabase {{ .Token }}
 * placeholders, so the inbox preview looks like the real thing.
 */

import 'dotenv/config'
import { renderEmail } from '../render'
import { renderInvoiceEmail } from '../invoice'
import { AuthEmail } from '../components/AuthEmail'
import NotificationEmail from '../templates/NotificationEmail'
import AgencyMemberInvite from '../templates/AgencyMemberInvite'
import { computeGst, renderInvoiceHtml } from '../../lib/gst-invoice'

const TO = process.argv[2] || 'nitin.naruto@gmail.com'
const APP = process.env.FRONTEND_URL || 'https://getfrequency.app'

async function buildInvoiceHtml(): Promise<string> {
  // A real GST invoice (₹1,499 + 18% IGST, inter-state) via the legal renderer.
  const amountPaise = 149900
  const gst = computeGst(amountPaise, '29' /* Karnataka → inter-state IGST */, 18)
  const issueDate = new Date('2026-06-07T00:00:00Z')
  const legal = renderInvoiceHtml({
    invoiceNumber:  'FREQ/2026-27/00042',
    issueDate,
    buyerName:      'Acme Retail Pvt Ltd',
    buyerAddress:   '4th Floor, MG Road, Bengaluru, Karnataka 560001',
    buyerStateName: 'Karnataka',
    buyerStateCode: '29',
    buyerGstin:     '29ABCDE1234F1Z5',
    description:    'Frequency Growth Plan — subscription period ending Jun 2026',
    gst,
  })
  return renderInvoiceEmail({
    heading:       'Tax invoice',
    invoiceNumber: 'FREQ/2026-27/00042',
    amountLabel:   `₹${(Number(gst.total_paise) / 100).toLocaleString('en-IN')}`,
    dateLabel:     '7 Jun 2026',
    buyerName:     'Acme Retail Pvt Ltd',
    description:   'Frequency Growth Plan — subscription period ending Jun 2026',
    viewUrl:       '/settings/billing',
  }, legal)
}

async function main() {
  const { sendEmail } = await import('../../lib/email')

  const jobs: Array<{ label: string; subject: string; html: string; text: string }> = []

  // 1. Registration / confirm signup
  {
    const { html, text } = await renderEmail(AuthEmail, {
      preview: 'Confirm your email to finish setting up Frequency',
      title: 'Confirm your email',
      intro: 'Welcome to Frequency. Confirm your email address to activate your account and start building workflows.',
      buttonLabel: 'Confirm email →',
      actionUrl: `${APP}/auth/confirm?token=sample-confirm-token-abc123`,
      showToken: true,
      tokenValue: '048213',
      note: 'This link expires in 24 hours.',
    })
    jobs.push({ label: 'registration', subject: '[Preview] Confirm your email · Frequency', html, text })
  }

  // 2. Password reset
  {
    const { html, text } = await renderEmail(AuthEmail, {
      preview: 'Reset your Frequency password',
      title: 'Reset your password',
      intro: 'We received a request to reset your Frequency password. Click below to choose a new one.',
      buttonLabel: 'Reset password →',
      actionUrl: `${APP}/auth/reset?token=sample-reset-token-xyz789`,
      showToken: true,
      tokenValue: '739104',
      note: "This link expires in 1 hour. If you didn't request a reset, your password is unchanged.",
    })
    jobs.push({ label: 'password-reset', subject: '[Preview] Reset your Frequency password', html, text })
  }

  // 3. Onboarding / welcome
  {
    const { html, text } = await renderEmail(NotificationEmail, {
      title: 'Welcome to Frequency 🎉',
      body: 'Your workspace is ready. Connect a channel, import your contacts, and ship your first workflow in minutes.',
      link: '/onboarding',
      appUrl: APP,
    })
    jobs.push({ label: 'onboarding', subject: '[Preview] Welcome to Frequency', html, text })
  }

  // 4. Tax invoice (branded shell + real legal GST table)
  {
    const html = await buildInvoiceHtml()
    jobs.push({ label: 'invoice', subject: '[Preview] Tax Invoice FREQ/2026-27/00042 — ₹1,768.82', html, text: 'Tax invoice FREQ/2026-27/00042 attached. Open in a browser for the full invoice.' })
  }

  // 5. Agency invite (co-branded header)
  {
    const { html, text } = await renderEmail(AgencyMemberInvite, {
      agencyName: 'Northstar Growth Co.',
      role: 'agency_admin',
      acceptUrl: `${APP}/agency-invite/accept?token=sample-invite-token`,
      appUrl: APP,
    })
    jobs.push({ label: 'agency-invite', subject: "[Preview] You're invited to Northstar Growth Co. on Frequency", html, text })
  }

  console.log(`Sending ${jobs.length} preview emails to ${TO} …\n`)
  for (const j of jobs) {
    try {
      const res = await sendEmail({ to: TO, subject: j.subject, html: j.html, text: j.text })
      console.log(`✓ ${j.label.padEnd(16)} sent  (resend id: ${res.id || 'n/a'})`)
    } catch (e: any) {
      console.error(`✗ ${j.label.padEnd(16)} FAILED: ${e?.message ?? e}`)
    }
    await new Promise(r => setTimeout(r, 600)) // stay under Resend's rate limit
  }
  console.log('\nDone.')
}

main().catch((e) => { console.error(e); process.exit(1) })
