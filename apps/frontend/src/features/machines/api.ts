import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { machineChoice } from '@koala/agent-engine/procedure'
import { MACHINE_JOINS_CHANGED, type MachineJoinView } from '@koala/engine-core/machine-join'
import { KOALA_INSTALL_CHANGED, type KoalaInstallView } from '@koala/engine-core/koala-install'
import { api } from '../../api/client'
import { machineChoiceLabel } from './lib/machine-rows'
import type { ReportedGpus } from '../../shared/lib/gpu-lines'
import { heardChange, useSocketEvent } from '../platform'

export type { KoalaInstallView, MachineJoinView }

export const localAgentKeys = {
  list: () => ['local-agent-devices'] as const,
  mine: () => ['my-machines'] as const,
}

export type MachineAgentState = 'checking' | 'ready' | 'needs-adapter' | 'not-answering'

export interface MachineAgent {
  id: string
  title: string
  state: MachineAgentState
  source: 'found' | 'by-hand'
  command?: string
  args?: string[]
  name?: string
  version?: string
  signIn?: string[]
  reason?: string
  adapter?: string
  models?: { id: string; name: string }[]
  model?: string
}

export interface ManualMachineAgent {
  id: string
  title?: string
  command: string
  args: string[]
}

export type AgentUpdateState = 'current' | 'behind' | 'waiting' | 'updating' | 'failed' | 'not-a-service' | 'too-old'

export interface AgentUpdateView {
  state: AgentUpdateState
  current: string
  running?: string
  reason?: string
  busyWith?: string[]
  at?: string
}

export interface LocalAgentDevice {
  id: string
  name: string
  rootDir: string
  os?: string
  createdAt: string
  lastSeenAt?: string
  online: boolean
  connectedAt?: string
  agents: MachineAgent[]
  agentsAt?: string
  agentsNotSetUp?: string
  manualAgents: ManualMachineAgent[]
  agentUpdate?: AgentUpdateView
  gpus?: NonNullable<ReportedGpus['gpus']>
  gpuProblems?: string[]
  gpusWithoutDriver?: NonNullable<ReportedGpus['gpusWithoutDriver']>
}

export interface MachineJoinCode {
  code: string
  command: string
  expiresAt: string
}

export interface AdapterInstall {
  ok: boolean
  output: string
}

export const listLocalAgentDevices = (): Promise<LocalAgentDevice[]> =>
  api.get<LocalAgentDevice[]>('/mesh/local-agents').then((r) => r.data)

export const createMachineJoinCode = (): Promise<MachineJoinCode> =>
  api.post<MachineJoinCode>('/mesh/local-agents/join-code', {}).then((r) => r.data)

export const setMachineAgents = (id: string, agents: ManualMachineAgent[]): Promise<LocalAgentDevice> =>
  api.put<LocalAgentDevice>(`/mesh/local-agents/${id}/agents`, { agents }).then((r) => r.data)

export const installMachineAdapter = (id: string, agentId: string): Promise<AdapterInstall> =>
  api.post<AdapterInstall>(`/mesh/local-agents/${id}/agents/${agentId}/install`, {}).then((r) => r.data)

export const deleteLocalAgentDevice = (id: string) =>
  api.delete<unknown>(`/mesh/local-agents/${id}`).then((r) => r.data)

export function useLocalAgentDevices(enabled = true) {
  return useQuery({ queryKey: localAgentKeys.list(), queryFn: listLocalAgentDevices, enabled })
}

export function useMachineChoiceLabel(id: string | null | undefined): string | undefined {
  const { data: devices = [] } = useLocalAgentDevices(Boolean(machineChoice(id)))
  return machineChoiceLabel(id, devices)
}

export function useMachineChoiceLabels(): (id: string) => string | undefined {
  const { data: devices = [] } = useLocalAgentDevices()
  return (id) => (machineChoice(id) ? machineChoiceLabel(id, devices) : undefined)
}

export interface AccountMachine {
  id: string
  name: string
  rootDir: string
  os?: string
  meshIp?: string
  createdAt: string
  lastSeenAt?: string
  online: boolean
  koalaWanted: boolean
  holdsKoala: boolean
  koalaRefused?: { reason: string; at: string }
  keyReplacement?: { reason: string; failedAt: string; stopsAt: string }
}

export interface MyMachinesView {
  machines: AccountMachine[]
  joins: MachineJoinView[]
  koala: { machineId?: string; status?: string; install?: KoalaInstallView } | null
}

export const listMyMachines = (): Promise<MyMachinesView> =>
  api.get<MyMachinesView>('/my-machines').then((r) => r.data)

export const createMyJoinCode = (koalaName?: string): Promise<MachineJoinCode> =>
  api.post<MachineJoinCode>('/my-machines/join-code', koalaName ? { koalaName } : {}).then((r) => r.data)

export const putKoalaOn = (machineId: string, name: string): Promise<{ placing: boolean }> =>
  api.post<{ placing: boolean }>(`/my-machines/${machineId}/koala`, { name }).then((r) => r.data)

export const dismissMachineJoin = (id: string): Promise<{ dismissed: true }> =>
  api.delete<{ dismissed: true }>(`/my-machines/joins/${id}`).then((r) => r.data)

export function useMyMachinesLive(): void {
  const queries = useQueryClient()
  const changed = () => { void heardChange(queries, { queryKey: localAgentKeys.mine() }) }
  useSocketEvent(MACHINE_JOINS_CHANGED, changed)
  useSocketEvent(KOALA_INSTALL_CHANGED, changed)
}

export function useDismissMachineJoin() {
  const queries = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => dismissMachineJoin(id),
    onSuccess: () => queries.invalidateQueries({ queryKey: localAgentKeys.mine() }),
  })
}

export function useMyMachines() {
  return useQuery({ queryKey: localAgentKeys.mine(), queryFn: listMyMachines })
}

export function useCreateMyJoinCode() {
  return useMutation({ mutationFn: (koalaName?: string) => createMyJoinCode(koalaName) })
}

export function usePutKoalaOn() {
  const queries = useQueryClient()
  return useMutation({
    mutationFn: ({ machineId, name }: { machineId: string; name: string }) => putKoalaOn(machineId, name),
    onSuccess: () => queries.invalidateQueries({ queryKey: localAgentKeys.mine() }),
  })
}
