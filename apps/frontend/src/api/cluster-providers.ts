import { api } from './client'

export interface ClusterProviderSpec {
  value: string
  label: string
  hint?: string
  credentialKey?: string
  hasCatalog: boolean
  usesMesh: boolean
}

export const clusterProviderKeys = {
  all: ['cluster-providers'] as const,
  list: () => [...clusterProviderKeys.all, 'list'] as const,
}

export const listClusterProviders = (): Promise<ClusterProviderSpec[]> =>
  api.get<ClusterProviderSpec[]>('/cluster-providers').then((r) => r.data)
