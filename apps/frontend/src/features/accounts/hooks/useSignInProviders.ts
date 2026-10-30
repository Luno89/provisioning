import { useQuery } from '@tanstack/react-query'
import { signInKeys, signInPlace, type SignInProvider } from '../../platform'

export function useSignInProviders(): SignInProvider[] {
  const { data } = useQuery({ queryKey: signInKeys.place(), queryFn: signInPlace, staleTime: Infinity })
  return data?.providers ?? []
}
