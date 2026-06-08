/** Supabase Auth → "Reset Password" template. Static HTML for the dashboard. */
import { AuthEmail } from '../../components/AuthEmail'

export function ResetPassword() {
  return (
    <AuthEmail
      preview="Reset your Frequency password"
      title="Reset your password"
      intro="We received a request to reset your Frequency password. Click below to choose a new one."
      buttonLabel="Reset password →"
      showToken
      note="This link expires in 1 hour. If you didn't request a reset, your password is unchanged."
    />
  )
}

ResetPassword.PreviewProps = {}
export default ResetPassword
