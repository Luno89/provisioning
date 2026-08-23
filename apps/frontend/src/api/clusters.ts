import { useQuery } from '@tanstack/react-query'
import { api } from './client'
import type { Cluster, ClusterPod, HelmRelease, GpuStatus } from '../types/cluster'

/**
 * Cluster reads, and the hooks the screen uses.
 *
 * The three detail queries lived in `App.tsx`, keyed on `expandedCluster` — which App also owned,
 * and passed down to `ClustersView` along with six `data`/`isLoading` values. So expanding a row
 * meant a child setting a parent's state to make the parent run a query whose result it was handed
 * back. The state and the queries belong to the screen that renders the row.
 */

export const clusterKeys = {
  all: ['clusters'] as const,
  list: () => [...clusterKeys.all, 'list'] as const,
  pods: (id: string | null) => ['cluster-pods', id] as const,
  helm: (id: string | null) => ['cluster-helm', id] as const,
  gpu: (id: string | null) => ['cluster-gpu', id] as const,
}

export const listClusters = (): Promise<Cluster[]> =>
  api.get<Cluster[]>('/clusters').then((r) => r.data)

export const destroyCluster = (id: string): Promise<void> =>
  api.delete(`/clusters/${id}`).then(() => undefined)

/**
 * Everything the expanded row shows, for one cluster.
 *
 * `enabled` on a null id rather than a separate call site: an unexpanded screen makes no requests,
 * and collapsing one stops the polling without anything having to remember to.
 *
 * Five seconds, matching what App did. These are `kubectl` calls behind the scenes, so this is a
 * deliberate trade — fast enough that a pod appearing feels live, slow enough not to hammer the
 * API server of a cluster that may be busy provisioning.
 */
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
    // `error`, not just a missing list: "cannot reach this cluster" and "this cluster has no pods"
    // look identical otherwise, and they lead to opposite conclusions.
    podError: pods.error,
    loadingPods: pods.isLoading,
    helmReleases: helm.data,
    loadingHelm: helm.isLoading,
    gpuStatus: gpu.data,
    loadingGpu: gpu.isLoading,
  }
}
