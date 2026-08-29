import { api } from './client'

export const meshKeys = {
  config: () => ['mesh-config'] as const,
  devices: () => ['mesh-devices'] as const,
}

export interface MeshConfig {
  loginServer: string | null
  configured: boolean
}

export interface MeshDevice {
  id: string
  name: string
  ipAddresses: string[]
  online: boolean
  lastSeen?: string
}

export const getMeshConfig = (): Promise<MeshConfig> =>
  api.get<MeshConfig>('/mesh/config').then((r) => r.data)

export const listMeshDevices = (): Promise<MeshDevice[]> =>
  api.get<MeshDevice[]>('/mesh/devices').then((r) => r.data)

export interface PreauthKey { key: string }

export const createPreauthKey = (body: { reusable: boolean; expirySeconds: number }) =>
  api.post<PreauthKey>('/mesh/preauth-key', body).then((r) => r.data)

export const deleteMeshDevice = (nodeId: string) =>
  api.delete(`/mesh/devices/${nodeId}`).then((r) => r.data)
