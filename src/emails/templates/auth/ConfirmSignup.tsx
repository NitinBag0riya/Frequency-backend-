/** Supabase Auth → "Confirm signup" template. Static HTML for the dashboard. */
import { AuthEmail } from '../../components/AuthEmail'

export function ConfirmSignup() {
  return (
    <AuthEmail
      preview="Confirm your email to finish setting up Frequency"
      title="Confirm your email"
      intro="Welcome to Frequency. Confirm your email address to activate your account and start building workflows."
      buttonLabel="Confirm email →"
      showToken
      note="This link expires in 24 hours."
    />
  )
}

ConfirmSignup.PreviewProps = {}
export default ConfirmSignup
