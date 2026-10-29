import { useQuery } from '@tanstack/react-query'
import { engineKeys, listRunEndings } from '../api/engine'
import type { RunEnding } from '../lib/run-endings'

export function useRunEndings(runIds: readonly string[], read: (runIds: readonly string[]) => Promise<RunEnding[]> = listRunEndings) {
  return useQuery({
    queryKey: engineKeys.endings(runIds),
    queryFn: () => read(runIds),
    enabled: runIds.length > 0,
    refetchInterval: (query) => (runIds.every((runId) => query.state.data?.some((ending) => ending.runId === runId && ending.ended)) ? false : 5_000),
  })
}
