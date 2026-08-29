import { useQuery } from '@tanstack/react-query'
import { getExperiment, experimentKeys } from '../api/harness'
import type { Experiment as ExperimentDetail } from '@koala/harness-types'

export function useExperimentDetail(id: string, enabled: boolean) {
  return useQuery<ExperimentDetail>({
    queryKey: experimentKeys.detail(id),
    queryFn: () => getExperiment(id),
    enabled,
    staleTime: 30_000,
    refetchInterval: (query) => {
      const d = query.state.data
      return d && (d.running || d.status === 'running') ? 5000 : false
    },
  })
}
