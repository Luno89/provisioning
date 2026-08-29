import { useQuery } from '@tanstack/react-query'
import { api, API_BASE } from './client'
import type { Cluster, ClusterPod, HelmRelease, GpuStatus } from '../types/cluster'

export const clusterKeys = {
  all: ['clusters'] as const,
  list: () => [...clusterKeys.all, 'list'] as const,
  pods: (id: string | null) => ['cluster-pods', id] as const,
  helm: (id: string | null) => ['cluster-helm', id] as const,
  gpu: (id: string | null) => ['cluster-gpu', id] as const,
  services: (id: string | undefined) => ['cluster-services', id] as const,
}

export const listClusters = (): Promise<Cluster[]> =>
  api.get<Cluster[]>('/clusters').then((r) => r.data)

export const destroyCluster = (id: string): Promise<void> =>
  api.delete(`/clusters/${id}`).then(() => undefined)

const DETAIL_REFETCH_MS = 5000

export function useClusterDetail(id: string | null) {
  const pods = useQuery({
    queryKey: clusterKeys.pods(id),
    queryFn: () => api.get<ClusterPod[]>(`/clusters/${id}/all-pods`).then((r) => r.data),
    enabled: !!id,
    refetchInterval: DETAIL_REFETCH_MS,
  })

  const helm = useQuery({
    queryKey: clusterKeys.helm(id),
    queryFn: () => api.get<HelmRelease[]>(`/clusters/${id}/helm-releases`).then((r) => r.data),
    enabled: !!id,
    refetchInterval: DETAIL_REFETCH_MS,
  })

  const gpu = useQuery({
    queryKey: clusterKeys.gpu(id),
    queryFn: () => api.get<GpuStatus>(`/clusters/${id}/gpu-status`).then((r) => r.data),
    enabled: !!id,
    refetchInterval: DETAIL_REFETCH_MS,
  })

  return {
    pods: pods.data,
    podError: pods.error,
    loadingPods: pods.isLoading,
    helmReleases: helm.data,
    loadingHelm: helm.isLoading,
    gpuStatus: gpu.data,
    loadingGpu: gpu.isLoading,
  }
}

export interface ServiceInfo {
  name: string
  installed: boolean
  status: string
  chart: string | null
  appVersion: string | null
  namespace: string
  pods: { name: string; status: string; ip: string | null; ready: boolean }[]
}

export const listClusterServices = (clusterId: string): Promise<ServiceInfo[]> =>
  api.get<{ services?: ServiceInfo[] }>(`/clusters/${clusterId}/services`)
    .then((r) => r.data.services ?? [])

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
