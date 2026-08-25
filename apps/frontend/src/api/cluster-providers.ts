import { api } from './client'

/**
 * The cluster providers this installation can provision onto, as served by the backend.
 *
 * The list is data, not a frontend literal: adding a vendor is a row in the backend's
 * `clusterProviders` collection (seeded from built-ins on boot), and the wizard branches on the
 * capability flags (`hasCatalog`, `usesMesh`) rather than comparing names.
 */
export interface ClusterProviderSpec {
  value: string
  label: string
  hint?: string
  /** Credential provider key this provider needs stored, if any. */
  credentialKey?: string
  /** Serves a priced plan/location catalog (the hetzner-shaped flow). */
  hasCatalog: boolean
  /** Attaches machines from the Headscale mesh rather than creating them. */
  usesMesh: boolean
}

export const clusterProviderKeys = {
  all: ['cluster-providers'] as const,
  list: () => [...clusterProviderKeys.all, 'list'] as const,
}

export const listClusterProviders = (): Promise<ClusterProviderSpec[]> =>
  api.get<ClusterProviderSpec[]>('/cluster-providers').then((r) => r.data)
