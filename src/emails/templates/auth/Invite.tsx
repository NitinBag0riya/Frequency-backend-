/**
 * Supabase Auth → "Invite user" template. Static HTML for the dashboard.
 * Also powers in-app team invites (routes/teams.ts inviteUserByEmail).
 */
import { AuthEmail } from '../../components/AuthEmail'

export function Invite() {
  return (
    <AuthEmail
      preview="You've been invited to Frequency"
      title="You've been invited to Frequency"
      intro="Someone invited you to collaborate on Frequency. Accept the invite to set up your account and join their workspace."
      buttonLabel="Accept invite →"
      note="This invite expires in 7 days."
    />
  )
}

Invite.PreviewProps = {}
export default Invite
