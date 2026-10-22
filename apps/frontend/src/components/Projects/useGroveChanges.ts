import { useQueryClient } from '@tanstack/react-query'
import { GROVE_CHANGED, groveKeys } from '../../api/grove'
import { projectKeys } from '../../api/projects'
import { useSocketEvent } from '../../features/platform'

export function useGroveChanges(): void {
  const client = useQueryClient()
  useSocketEvent(GROVE_CHANGED, () => {
    for (const queryKey of [groveKeys.trees(), groveKeys.branches(), groveKeys.leaves(), projectKeys.list()]) void client.invalidateQueries({ queryKey })
  })
}
