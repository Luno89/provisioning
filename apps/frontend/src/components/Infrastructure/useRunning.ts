import { useQuery } from '@tanstack/react-query'
import { getRunning, runningKeys } from '../../api/running'

export const RUNNING_POLL_MS = 4_000

export function useRunning() {
  return useQuery({ queryKey: runningKeys.view(), queryFn: getRunning, refetchInterval: RUNNING_POLL_MS })
}
