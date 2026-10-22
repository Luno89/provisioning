import { useQuery } from '@tanstack/react-query'
import { actionKeys, getActionProgress } from '../api/actions'

export function useActionProgress(id: string, following: boolean) {
  return useQuery({
    queryKey: actionKeys.progress(id),
    queryFn: () => getActionProgress(id),
    enabled: following,
    refetchInterval: (query) => (query.state.data?.done ? false : 3_000),
    refetchIntervalInBackground: true,
  })
}
