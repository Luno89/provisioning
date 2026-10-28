import { useQuery } from '@tanstack/react-query'
import { machineChoice } from '@koala/agent-engine/procedure'
import { api } from '../../api/client'
import { machineChoiceLabel } from './lib/machine-rows'

export const localAgentKeys = {
  list: () => ['local-agent-devices'] as const,
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

export interface LocalAgentDevice {
  id: string
  name: string
  rootDir: string
  os?: string
  createdAt: string
  lastSeenAt?: string
  tokenExpired?: boolean
  online: boolean
  connectedAt?: string
  containerMode?: boolean
  agents: MachineAgent[]
  agentsAt?: string
  manualAgents: ManualMachineAgent[]
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
  api.delete(`/mesh/local-agents/${id}`).then((r) => r.data)

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
