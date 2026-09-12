import { api } from './client'

export const localAgentKeys = {
  list: () => ['local-agent-devices'] as const,
}

export interface LocalAgentDevice {
  id: string
  name: string
  rootDir: string
  createdAt: string
  lastSeenAt?: string
  online: boolean
  connectedAt?: string
  containerMode?: boolean
}

export interface CreatedLocalAgentDevice {
  id: string
  name: string
  rootDir: string
  token: string
  projectId?: string
}

export const listLocalAgentDevices = (): Promise<LocalAgentDevice[]> =>
  api.get<LocalAgentDevice[]>('/mesh/local-agents').then((r) => r.data)

export const createLocalAgentDevice = (body: { name: string; rootDir: string }): Promise<CreatedLocalAgentDevice> =>
  api.post<CreatedLocalAgentDevice>('/mesh/local-agents', body).then((r) => r.data)

export const deleteLocalAgentDevice = (id: string) =>
  api.delete(`/mesh/local-agents/${id}`).then((r) => r.data)
