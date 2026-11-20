import { useQuery, useQueryClient } from '@tanstack/react-query'
import { KOALA_INSTALL_CHANGED } from '@koala/engine-core/koala-install'
import { api } from '../../../api/client'
import { useSocketEvent } from '../../platform'
import { identityKeys } from './identity'
import type { WatchView } from './instance-watch'

export type InstanceStatus = 'waiting' | 'joined' | 'installing' | 'ready' | 'failed'

export interface MySetup {
  id: string
  status: InstanceStatus
  detail?: string
  url: string
  name?: string
  watch?: WatchView
}

export interface NameCheck {
  ok: boolean
  problem?: string
  suggestion?: string
  address?: string
}

export const instanceKeys = {
  mine: () => ['instances', 'mine'] as const,
  name: (name: string) => ['instances', 'name', name] as const,
}

export const getMySetup = (): Promise<MySetup | null> =>
  api.get<{ instance: MySetup | null }>('/instances/mine').then((r) => r.data.instance)

export const checkName = (name: string): Promise<NameCheck> =>
  api.get<NameCheck>('/instances/name-check', { params: { name } }).then((r) => r.data)

export function useNameCheck(name: string) {
  return useQuery({ queryKey: instanceKeys.name(name), queryFn: () => checkName(name), staleTime: 5000 })
}

export function useMySetup(watchingReach: boolean) {
  const client = useQueryClient()
  useSocketEvent(KOALA_INSTALL_CHANGED, () => { void client.invalidateQueries({ queryKey: instanceKeys.mine() }) })
  return useQuery({
    queryKey: instanceKeys.mine(),
    queryFn: getMySetup,
    refetchInterval: watchingReach ? 3000 : false,
    refetchIntervalInBackground: true,
  })
}

export function useInstanceReady() {
  const client = useQueryClient()
  return () => { void client.invalidateQueries({ queryKey: identityKeys.mine() }) }
}
