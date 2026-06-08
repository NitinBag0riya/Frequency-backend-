/** Supabase Auth → "Magic Link" template. Static HTML for the dashboard. */
import { AuthEmail } from '../../components/AuthEmail'

export function MagicLink() {
  return (
    <AuthEmail
      preview="Your Frequency sign-in link"
      title="Sign in to Frequency"
      intro="Click below to sign in. This link works once and only for you."
      buttonLabel="Sign in →"
      showToken
      note="This link expires in 1 hour."
    />
  )
}

MagicLink.PreviewProps = {}
export default MagicLink
