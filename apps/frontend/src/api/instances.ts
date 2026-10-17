import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from './client'
import { identityKeys } from './identity'

export type InstanceStatus = 'waiting' | 'joined' | 'installing' | 'ready' | 'failed'

export interface MySetup {
  id: string
  status: InstanceStatus
  detail?: string
  url: string
  name?: string
}

export interface NameCheck {
  ok: boolean
  problem?: string
  suggestion?: string
  address?: string
}

export interface JoinCommand {
  token: string
  command: string
  expiresAt: string
}

export const instanceKeys = {
  mine: () => ['instances', 'mine'] as const,
  name: (name: string) => ['instances', 'name', name] as const,
}

export const getMySetup = (): Promise<MySetup | null> =>
  api.get<{ instance: MySetup | null }>('/instances/mine').then((r) => r.data.instance)

export const createJoinCommand = (name: string): Promise<JoinCommand> =>
  api.post<JoinCommand>('/instances/join-tokens', { name }).then((r) => r.data)

export const checkName = (name: string): Promise<NameCheck> =>
  api.get<NameCheck>('/instances/name-check', { params: { name } }).then((r) => r.data)

export function useNameCheck(name: string) {
  return useQuery({ queryKey: instanceKeys.name(name), queryFn: () => checkName(name), staleTime: 5000 })
}

export function useMySetup(watching: boolean) {
  return useQuery({ queryKey: instanceKeys.mine(), queryFn: getMySetup, refetchInterval: watching ? 3000 : false, refetchIntervalInBackground: watching })
}

export function useCreateJoinCommand() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: (name: string) => createJoinCommand(name),
    onSuccess: () => { void client.invalidateQueries({ queryKey: instanceKeys.mine() }) },
  })
}

export function useInstanceReady() {
  const client = useQueryClient()
  return () => { void client.invalidateQueries({ queryKey: identityKeys.mine() }) }
}
