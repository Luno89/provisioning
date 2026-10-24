import { isAxiosError } from 'axios'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../../../api/client'

/**
 * ── DUPLICATED, KNOWINGLY ── `UpdatesView` in apps/backend/src/instances/lib/instance-updates.ts and `UpdatesAnswer` in
 * apps/backend/src/instances/services/InstanceUpdates.ts are the authority.
 */
export interface ReleaseRow {
  imageTag: string
  version: string
  servedAt: string
  notes?: string
  hotfix?: boolean
  running: boolean
  current: boolean
  choosable: boolean
}

export interface UpdatesView {
  auto: boolean
  picked?: string
  running?: string
  previous?: string
  current: string
  target: string
  releases: ReleaseRow[]
  checking?: string
}

export const instanceUpdateKeys = {
  mine: () => ['instance-updates'] as const,
}

export const getInstanceUpdates = (): Promise<UpdatesView | null> =>
  api.get<UpdatesView>('/instance-updates').then((r) => r.data).catch((err: unknown) => {
    if (isAxiosError(err) && err.response?.status === 404) return null
    throw err
  })

export const changeInstanceUpdates = (change: { auto: boolean } | { version: string }): Promise<UpdatesView> =>
  api.put<UpdatesView>('/instance-updates', change).then((r) => r.data)

export function useInstanceUpdates() {
  return useQuery({
    queryKey: instanceUpdateKeys.mine(),
    queryFn: getInstanceUpdates,
    refetchInterval: (query) => (query.state.data?.checking ? 5000 : false),
  })
}

export function useChangeInstanceUpdates() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: changeInstanceUpdates,
    onSuccess: (view) => { client.setQueryData(instanceUpdateKeys.mine(), view) },
  })
}
