import { SignInReveal } from '../../../../shared/components/SignInReveal'
import { deploymentKeys, getAppSignIn } from '../../api/deployments'

export function AppSignInReveal({ deploymentId }: { deploymentId: string }) {
  return (
    <SignInReveal
      queryKey={deploymentKeys.signIn(deploymentId)}
      load={() => getAppSignIn(deploymentId)}
      source="Sign-in Koala made for this app"
      reading="Reading it…"
      empty="Koala made no sign-in for this app; deploy it again to have one made."
    />
  )
}
