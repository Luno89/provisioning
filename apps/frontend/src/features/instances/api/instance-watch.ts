import { isAxiosError } from 'axios'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../../../api/client'
import { instanceKeys, type MySetup } from './instances'

/**
 * ── DUPLICATED, KNOWINGLY ── `WatchView` in apps/backend/src/instances/services/InstanceService.ts and `Reach` in
 * apps/backend/src/instances/lib/instance-watch.ts are the authority.
 */
export interface Reach {
  reachable: boolean
  lastSeenAt?: string
  unreachableSince?: string
  toldDown?: boolean
}

export interface WatchView {
  notifyWhenUnreachable: boolean
  alwaysTold: boolean
  reach?: Reach
}

export const instanceWatchKeys = {
  mine: () => ['instance-watch'] as const,
}

const getInstanceWatch = (): Promise<WatchView | null> =>
  api.get<WatchView>('/instance-watch').then((r) => r.data).catch((err: unknown) => {
    if (isAxiosError(err) && err.response?.status === 404) return null
    throw err
  })

const setInstanceWatch = (notifyWhenUnreachable: boolean): Promise<WatchView> =>
  api.put<WatchView>('/instance-watch', { notifyWhenUnreachable }).then((r) => r.data)

const setMyWatch = (notifyWhenUnreachable: boolean): Promise<WatchView> =>
  api.put<WatchView>('/instances/mine/watch', { notifyWhenUnreachable }).then((r) => r.data)

export function useInstanceWatch() {
  return useQuery({ queryKey: instanceWatchKeys.mine(), queryFn: getInstanceWatch })
}

export function useSetInstanceWatch() {
  const client = useQueryClient()
  return useMutation({ mutationFn: setInstanceWatch, onSuccess: (view) => { client.setQueryData(instanceWatchKeys.mine(), view) } })
}

export function useSetMyWatch() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: setMyWatch,
    onSuccess: (watch) => { client.setQueryData(instanceKeys.mine(), (old: MySetup | null | undefined) => (old ? { ...old, watch } : old)) },
  })
}
