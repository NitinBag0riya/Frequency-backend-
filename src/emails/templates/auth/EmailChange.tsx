/** Supabase Auth → "Change Email Address" template. Static HTML for the dashboard. */
import { AuthEmail } from '../../components/AuthEmail'

export function EmailChange() {
  return (
    <AuthEmail
      preview="Confirm your new email for Frequency"
      title="Confirm your new email"
      // {{ .NewEmail }} is a Supabase var rendered literally then substituted.
      intro="Confirm that you want to change your Frequency email to {{ .NewEmail }}. Until you confirm, your current email stays active."
      buttonLabel="Confirm new email →"
      showToken
      note="This link expires in 24 hours."
    />
  )
}

EmailChange.PreviewProps = {}
export default EmailChange
