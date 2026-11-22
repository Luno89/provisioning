import { useQueryClient } from '@tanstack/react-query'
import { GROVE_CHANGED, groveKeys } from '../api/grove'
import { projectKeys } from '../api/projects'
import { heardChange, useSocketEvent } from '../../platform'

export function useGroveChanges(): void {
  const client = useQueryClient()
  useSocketEvent(GROVE_CHANGED, () => Promise.all([groveKeys.trees(), groveKeys.branches(), groveKeys.leaves(), projectKeys.list()].map((queryKey) => heardChange(client, { queryKey }))))
}
