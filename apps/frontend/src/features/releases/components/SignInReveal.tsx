import { SignInReveal as Reveal } from '../../../shared/components/SignInReveal'
import { getSignIn, releaseKeys } from '../api/releases.js'

export function SignInReveal({ projectId }: { projectId: string }) {
  return (
    <Reveal
      queryKey={releaseKeys.signIn(projectId)}
      load={() => getSignIn(projectId)}
      source="Sign-in, from the project's vault"
      reading="Reading the vault…"
      empty="No sign-in is in the project's vault yet."
    />
  )
}
