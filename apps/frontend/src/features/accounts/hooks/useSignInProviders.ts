import { useQuery } from '@tanstack/react-query'
import { signInKeys, signInPlace, type SignInProvider } from '../../platform'

export function useSignInProviders(): { providers: SignInProvider[]; unreadable: boolean } {
  const { data, isError } = useQuery({ queryKey: signInKeys.place(), queryFn: signInPlace, staleTime: Infinity })
  return { providers: data && 'providers' in data ? data.providers : [], unreadable: isError }
}
