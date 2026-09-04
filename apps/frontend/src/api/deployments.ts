import { useQuery } from '@tanstack/react-query'
import { api } from './client'
import type { Deployment } from '../types/deployment'
import type { ClusterPod } from '../types/cluster'

export const deploymentKeys = {
  all: ['deployments'] as const,
  list: () => [...deploymentKeys.all, 'list'] as const,
  pods: (id?: string) => ['pods', id] as const,
  helm: (id?: string) => ['helm', id] as const,
  diagnostics: (id?: string) => ['diagnostics', id] as const,
  modules: (appType?: string) => ['modules', appType] as const,
  resourcePlan: (id?: string) => ['resource-plan', id] as const,
  logs: (type?: string, id?: string) => ['logs', type, id] as const,
  catalogue: () => [...deploymentKeys.all, 'catalogue'] as const,
}

export const listDeployments = (): Promise<Deployment[]> =>
  api.get<Deployment[]>('/deployments').then((r) => r.data)

/** A catalogue entry — a stored AppSpec (built-in or a user's own), the one source koala and the deploy wizard both read from. */
export interface CatalogueEntry {
  id: string
  label?: string
  is?: string
  provides?: string[]
}

export const listAppCatalogue = (): Promise<CatalogueEntry[]> =>
  api.get<CatalogueEntry[]>('/deployments/catalogue').then((r) => r.data)

export function useAppCatalogue() {
  return useQuery({ queryKey: deploymentKeys.catalogue(), queryFn: listAppCatalogue })
}

export interface PodsResponse {
  pods?: ClusterPod[]
  namespace?: string
}

export function useDeploymentPods(id: string | undefined, enabled: boolean) {
  const query = useQuery({
    queryKey: deploymentKeys.pods(id),
    queryFn: () => api.get<PodsResponse>(`/deployments/${id}/pods`).then((r) => r.data),
    enabled: enabled && !!id,
    refetchInterval: 3000,
  })
  return {
    pods: query.data?.pods ?? [],
    namespace: query.data?.namespace ?? 'odoo',
    checkedAt: query.dataUpdatedAt,
  }
}

export function useHelmStatus(id: string | undefined, enabled: boolean) {
  return useQuery({
    queryKey: deploymentKeys.helm(id),
    queryFn: () => api.get<{ content: string }>(`/deployments/${id}/helm`).then((r) => r.data),
    enabled: enabled && !!id,
  })
}

export function useDiagnostics(id: string | undefined, enabled: boolean) {
  return useQuery({
    queryKey: deploymentKeys.diagnostics(id),
    queryFn: () => api.get<{ content: string }>(`/deployments/${id}/diagnostics`).then((r) => r.data),
    enabled: enabled && !!id,
  })
}

export interface GitModule {
  id: string
  name?: string
  summary?: string
  author?: string
  version?: string
  description?: string
  repo?: string
}

export function useAvailableModules(appType: string | undefined, enabled: boolean) {
  return useQuery({
    queryKey: deploymentKeys.modules(appType),
    queryFn: () => api.get<GitModule[]>('/modules', { params: { appType: appType || 'odoo' } })
      .then((r) => r.data),
    enabled,
  })
}

export interface ResourcePlan {
  applicable: boolean
  memoryLimit?: string
  shmSize?: string
  cpuLimit?: string
  basis?: string
  refusal?: string
}

export function useResourcePlan(deployment: Deployment | null | undefined) {
  return useQuery({
    queryKey: deploymentKeys.resourcePlan(deployment?.id),
    queryFn: () => api.get<ResourcePlan>(`/deployments/${deployment?.id}/resource-plan`).then((r) => r.data),
    enabled: !!deployment && deployment.appType === 'tabbyapi',
    staleTime: 60_000,
  })
}

export function useInitialLogs(
  target: { type: 'cluster' | 'app'; id: string } | null,
  enabled: boolean,
) {
  return useQuery({
    queryKey: deploymentKeys.logs(target?.type, target?.id),
    queryFn: () => api.get<{ content: string }>(`/logs/${target?.type}/${target?.id}`).then((r) => r.data),
    enabled: enabled && !!target,
  })
}

export const deployApp = <T,>(body: unknown): Promise<T> =>
  api.post<T>('/deployments', body).then((r) => r.data)

export const destroyResource = (kind: 'cluster' | 'app', id: string): Promise<void> =>
  api.delete(`/${kind === 'cluster' ? 'clusters' : 'deployments'}/${id}`).then(() => undefined)
