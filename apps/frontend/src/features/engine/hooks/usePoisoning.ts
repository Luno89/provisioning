import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { dismissSignal, listRunSignals, poisoningKeys, retireFromSignal } from '../api/poisoning'

export function useRunSignals(runId: string | undefined) {
  return useQuery({
    queryKey: poisoningKeys.run(runId ?? ''),
    queryFn: () => listRunSignals(runId!),
    enabled: Boolean(runId),
    refetchInterval: 15_000,
  })
}

export function useSignalActions(onChanged?: () => void) {
  const queries = useQueryClient()
  const settled = () => {
    void queries.invalidateQueries({ queryKey: poisoningKeys.all })
    onChanged?.()
  }
  return {
    dismiss: useMutation({ mutationFn: (id: string) => dismissSignal(id), onSuccess: settled }),
    retire: useMutation({ mutationFn: ({ id, scope }: { id: string; scope: 'run' | 'source' }) => retireFromSignal(id, scope), onSuccess: settled }),
  }
}
