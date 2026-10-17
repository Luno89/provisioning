import { useQuery } from '@tanstack/react-query'
import { api, API_BASE } from './client'
import type { Cluster, GpuStatus } from '../types/cluster'

export const clusterKeys = {
  all: ['clusters'] as const,
  list: () => [...clusterKeys.all, 'list'] as const,
  gpu: (id: string) => ['cluster-gpu', id] as const,
}

export const listClusters = (): Promise<Cluster[]> =>
  api.get<Cluster[]>('/clusters').then((r) => r.data)

export const destroyCluster = (id: string): Promise<void> =>
  api.delete(`/clusters/${id}`).then(() => undefined)

const GPU_REFETCH_MS = 10_000

export function useGpuStatus(id: string) {
  return useQuery({
    queryKey: clusterKeys.gpu(id),
    queryFn: () => api.get<GpuStatus>(`/clusters/${id}/gpu-status`).then((r) => r.data),
    refetchInterval: GPU_REFETCH_MS,
  })
}

export const clusterDashboardUrl = (clusterId: string, serviceName: string): string =>
  `${API_BASE}/clusters/${clusterId}/proxy/${serviceName}/`

export interface ClusterCreated {
  id: string
  status?: string
  publicKey?: string
}

export const startAwaitingCluster = <T,>(id: string): Promise<T> =>
  api.post<T>(`/clusters/${id}/start`, {}).then((r) => r.data)

export const provisionCluster = <T,>(body: unknown): Promise<T> =>
  api.post<T>('/clusters', body).then((r) => r.data)
