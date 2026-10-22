import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../../../api/client'
import { identityKeys } from './identity'

export type InstanceStatus = 'waiting' | 'joined' | 'installing' | 'ready' | 'failed' | 'paused'

/**
 * ── DUPLICATED, KNOWINGLY ── `MoveView` in apps/backend/src/instances/services/InstanceService.ts is the authority.
 */
export interface MoveView {
  state: 'waiting' | 'joined' | 'copying' | 'switching' | 'failed'
  detail?: string
  machine?: string
  startedAt: string
}

export interface MySetup {
  id: string
  status: InstanceStatus
  detail?: string
  url: string
  name?: string
  trialEndsAt?: string
  move?: MoveView
}

export interface MoveCommand {
  command: string
  expiresAt: string
}

export interface PoolOffer {
  available: boolean
  reason?: string
  trialDays?: number
}

export interface PoolInstanceRow {
  id: string
  name: string
  owner: string
  status: InstanceStatus
  detail?: string
  startedAt: string
  trialEndsAt: string
  pausedAt?: string
}

export interface PoolAdmin {
  slots: number
  trialDays: number
  defaultTrialDays: number
  instances: PoolInstanceRow[]
}

export interface PoolStart {
  id: string
  name: string
  trialEndsAt: string
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
  pool: () => ['instances', 'pool'] as const,
  poolAdmin: () => ['instances', 'pool', 'admin'] as const,
  trial: () => ['instance-trial'] as const,
  move: () => ['instance-trial', 'move'] as const,
}

export const getInstanceMove = (): Promise<MoveView | null> =>
  api.get<{ move: MoveView | null }>('/instance-trial/move').then((r) => r.data.move)

export const startInstanceMove = (): Promise<MoveCommand> =>
  api.post<MoveCommand>('/instance-trial/move').then((r) => r.data)

export const stopInstanceMove = (): Promise<unknown> =>
  api.delete('/instance-trial/move').then((r) => r.data)

export const startMyMove = (): Promise<MoveCommand> =>
  api.post<MoveCommand>('/instances/move').then((r) => r.data)

export const stopMyMove = (): Promise<unknown> =>
  api.delete('/instances/move').then((r) => r.data)

export const moveUnderWay = (move: MoveView | null | undefined): boolean => Boolean(move) && move!.state !== 'failed'

export const getMySetup = (): Promise<MySetup | null> =>
  api.get<{ instance: MySetup | null }>('/instances/mine').then((r) => r.data.instance)

export const createJoinCommand = (name: string): Promise<JoinCommand> =>
  api.post<JoinCommand>('/instances/join-tokens', { name }).then((r) => r.data)

export const getPoolOffer = (): Promise<PoolOffer> =>
  api.get<PoolOffer>('/instances/pool').then((r) => r.data)

export const startPoolInstance = (name: string): Promise<PoolStart> =>
  api.post<PoolStart>('/instances/pool', { name }).then((r) => r.data)

export const getPoolAdmin = (): Promise<PoolAdmin> =>
  api.get<PoolAdmin>('/instances/pool/admin').then((r) => r.data)

export const setPoolTrialDays = (days: number): Promise<unknown> =>
  api.put('/instances/pool/admin/trial-days', { days }).then((r) => r.data)

export const setPoolTrialEnd = (id: string, trialEndsAt: string): Promise<PoolInstanceRow> =>
  api.put<PoolInstanceRow>(`/instances/pool/admin/instances/${encodeURIComponent(id)}/trial`, { trialEndsAt }).then((r) => r.data)

export const removePoolInstance = (id: string, confirm: string): Promise<unknown> =>
  api.delete(`/instances/pool/admin/instances/${encodeURIComponent(id)}`, { data: { confirm } }).then((r) => r.data)

export interface InstanceTrialView {
  trialEndsAt?: string
  daysLeft?: number
}

export const getInstanceTrial = (): Promise<InstanceTrialView> =>
  api.get<{ trialEndsAt?: string }>('/instance-trial').then((r) => (r.data.trialEndsAt
    ? { trialEndsAt: r.data.trialEndsAt, daysLeft: Math.max(0, Math.ceil((Date.parse(r.data.trialEndsAt) - Date.now()) / 86_400_000)) }
    : {}))

export const checkName = (name: string): Promise<NameCheck> =>
  api.get<NameCheck>('/instances/name-check', { params: { name } }).then((r) => r.data)

export function useNameCheck(name: string) {
  return useQuery({ queryKey: instanceKeys.name(name), queryFn: () => checkName(name), staleTime: 5000 })
}

export const poolInstalling = (setup: MySetup | null | undefined): boolean =>
  Boolean(setup?.trialEndsAt) && setup?.status !== 'ready' && setup?.status !== 'failed'

export function useInstanceMove(enabled: boolean) {
  return useQuery({
    queryKey: instanceKeys.move(),
    queryFn: getInstanceMove,
    enabled,
    retry: false,
    refetchInterval: (query) => (moveUnderWay(query.state.data) ? 4000 : false),
  })
}

export function useStartInstanceMove() {
  const client = useQueryClient()
  return useMutation({ mutationFn: startInstanceMove, onSuccess: () => { void client.invalidateQueries({ queryKey: instanceKeys.move() }) } })
}

export function useStopInstanceMove() {
  const client = useQueryClient()
  return useMutation({ mutationFn: stopInstanceMove, onSettled: () => { void client.invalidateQueries({ queryKey: instanceKeys.move() }) } })
}

export function useStartMyMove() {
  const client = useQueryClient()
  return useMutation({ mutationFn: startMyMove, onSuccess: () => { void client.invalidateQueries({ queryKey: instanceKeys.mine() }) } })
}

export function useStopMyMove() {
  const client = useQueryClient()
  return useMutation({ mutationFn: stopMyMove, onSettled: () => { void client.invalidateQueries({ queryKey: instanceKeys.mine() }) } })
}

export function useMySetup(watching: boolean) {
  return useQuery({
    queryKey: instanceKeys.mine(),
    queryFn: getMySetup,
    refetchInterval: (query) => (watching || poolInstalling(query.state.data) || moveUnderWay(query.state.data?.move) ? 3000 : false),
    refetchIntervalInBackground: true,
  })
}

export function useCreateJoinCommand() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: (name: string) => createJoinCommand(name),
    onSuccess: () => { void client.invalidateQueries({ queryKey: instanceKeys.mine() }) },
  })
}

export function usePoolOffer() {
  return useQuery({ queryKey: instanceKeys.pool(), queryFn: getPoolOffer })
}

export function useStartPoolInstance() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: (name: string) => startPoolInstance(name),
    onSuccess: () => { void client.invalidateQueries({ queryKey: instanceKeys.mine() }) },
  })
}

export function usePoolAdmin() {
  return useQuery({ queryKey: instanceKeys.poolAdmin(), queryFn: getPoolAdmin, refetchInterval: 10_000 })
}

export function useSetPoolTrialDays() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: (days: number) => setPoolTrialDays(days),
    onSuccess: () => { void client.invalidateQueries({ queryKey: instanceKeys.poolAdmin() }) },
  })
}

export function useSetPoolTrialEnd() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: ({ id, trialEndsAt }: { id: string; trialEndsAt: string }) => setPoolTrialEnd(id, trialEndsAt),
    onSuccess: () => { void client.invalidateQueries({ queryKey: instanceKeys.poolAdmin() }) },
  })
}

export function useRemovePoolInstance() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: ({ id, confirm }: { id: string; confirm: string }) => removePoolInstance(id, confirm),
    onSuccess: () => { void client.invalidateQueries({ queryKey: instanceKeys.poolAdmin() }) },
  })
}

export function useInstanceTrial() {
  return useQuery({ queryKey: instanceKeys.trial(), queryFn: getInstanceTrial, staleTime: 10 * 60_000, retry: false })
}

export function useInstanceReady() {
  const client = useQueryClient()
  return () => { void client.invalidateQueries({ queryKey: identityKeys.mine() }) }
}
