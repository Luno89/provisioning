import { useQuery } from '@tanstack/react-query'
import { api, API_BASE } from './client'
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
  services: (id: string | undefined) => ['cluster-services', id] as const,
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

/**
 * A platform service running inside a cluster — Traefik, Grafana, Prometheus and friends.
 *
 * Moved out of `ServicesPanel.tsx`, where it was private. `installed: false` is a real and common
 * state: the panel lists what COULD be there alongside what is, so the shape describes both.
 */
export interface ServiceInfo {
  name: string
  installed: boolean
  status: string
  chart: string | null
  appVersion: string | null
  namespace: string
  pods: { name: string; status: string; ip: string | null; ready: boolean }[]
}

/**
 * The services in one cluster.
 *
 * Unwraps `{ services }` here so the panel does not know the envelope.
 */
export const listClusterServices = (clusterId: string): Promise<ServiceInfo[]> =>
  api.get<{ services?: ServiceInfo[] }>(`/clusters/${clusterId}/services`)
    .then((r) => r.data.services ?? [])

/**
 * Where the browser navigates to reach a cluster-internal dashboard.
 *
 * A real URL rather than a fetch: this goes in an <a href>, and `ClusterProxyService` streams the
 * dashboard through it. It is the ONE place a component legitimately needs an absolute API URL,
 * which is why `API_BASE` is exported from `api/client` — building it inline was how a third copy
 * of that constant ended up in ServicesPanel.
 */
export const clusterDashboardUrl = (clusterId: string, serviceName: string): string =>
  `${API_BASE}/clusters/${clusterId}/proxy/${serviceName}/`

/**
 * Starts a cluster that was waiting on its key.
 *
 * A bring-your-own machine is recorded `awaiting-key` the moment it is created — the backend has
 * generated a keypair and is holding it until the user authorises the public half — so this is the
 * separate act of saying "it is authorised now, go".
 */
/**
 * What creating (or starting) a cluster answers with.
 *
 * `status: 'awaiting-key'` is the case that matters: a bring-your-own machine has NOT started
 * provisioning, the backend has minted a keypair and is holding it. Jumping to the provisioning
 * log there would show an empty log for a workflow that does not exist, so the shell shows the
 * public key for authorising instead.
 */
export interface ClusterCreated {
  id: string
  status?: string
  publicKey?: string
}

export const startAwaitingCluster = <T,>(id: string): Promise<T> =>
  api.post<T>(`/clusters/${id}/start`, {}).then((r) => r.data)

export const provisionCluster = <T,>(body: unknown): Promise<T> =>
  api.post<T>('/clusters', body).then((r) => r.data)
