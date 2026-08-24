import { api } from './client'

/**
 * The Headscale mesh a self-managed cluster joins.
 *
 * `config` answers `{ loginServer, configured }` — mesh join is opt-in via `MESH_LOGIN_SERVER`, and
 * unset it stays unset. Every screen here has to render the not-configured case rather than assume
 * a mesh exists, because a local dev box deliberately has none.
 */

export const meshKeys = {
  config: () => ['mesh-config'] as const,
  devices: () => ['mesh-devices'] as const,
}

export interface MeshConfig {
  /** The public Headscale URL, or null when mesh join is off. */
  loginServer: string | null
  configured: boolean
}

/** A node enrolled in the mesh. Moved here from `MeshDevices.tsx`, where it was private. */
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

/**
 * Mints a single-use enrolment key under the caller's Headscale user.
 *
 * The key is handed to the VM over SSH and never through cloud-init — `user_data` would persist a
 * live credential into Terraform state and the provider console.
 */
export interface PreauthKey { key: string }

export const createPreauthKey = (body: { reusable: boolean; expirySeconds: number }) =>
  api.post<PreauthKey>('/mesh/preauth-key', body).then((r) => r.data)

export const deleteMeshDevice = (nodeId: string) =>
  api.delete(`/mesh/devices/${nodeId}`).then((r) => r.data)
