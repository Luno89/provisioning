import { useQuery } from '@tanstack/react-query'
import { api } from './client'
import type { Deployment } from '../types/deployment'
import type { ClusterPod } from '../types/cluster'

/**
 * Deployment reads, and the hooks the log/dashboard modal uses.
 *
 * All seven of these lived in `App.tsx`, keyed on `showLogModal?.id` and gated on inline
 * `!!showLogModal && logTab === 'x'` conditions — so App ran seven requests on behalf of a modal it
 * also rendered, and handed the results down. The `enabled` conditions are the interesting part:
 * each tab's data is fetched only while that tab is open, which is what keeps a modal with seven
 * tabs from making seven requests every time it opens.
 */

export const deploymentKeys = {
  all: ['deployments'] as const,
  list: () => [...deploymentKeys.all, 'list'] as const,
  pods: (id?: string) => ['pods', id] as const,
  helm: (id?: string) => ['helm', id] as const,
  diagnostics: (id?: string) => ['diagnostics', id] as const,
  modules: (appType?: string) => ['modules', appType] as const,
  resourcePlan: (id?: string) => ['resource-plan', id] as const,
  logs: (type?: string, id?: string) => ['logs', type, id] as const,
}

export const listDeployments = (): Promise<Deployment[]> =>
  api.get<Deployment[]>('/deployments').then((r) => r.data)

export interface PodsResponse {
  pods?: ClusterPod[]
  namespace?: string
}

/**
 * The pods behind a deployment, polled while the Pods tab is open.
 *
 * Three seconds, matching what App did: fast enough that a pod restarting is visible, slow enough
 * not to hammer the API server. `dataUpdatedAt` comes back too, because the tab shows when it last
 * checked — "no pods" and "have not looked recently" mean different things.
 */
export function useDeploymentPods(id: string | undefined, enabled: boolean) {
  const query = useQuery({
    queryKey: deploymentKeys.pods(id),
    queryFn: () => api.get<PodsResponse>(`/deployments/${id}/pods`).then((r) => r.data),
    enabled: enabled && !!id,
    refetchInterval: 3000,
  })
  return {
    pods: query.data?.pods ?? [],
    // `odoo` was the fallback in App. Kept, because changing it is a behaviour change disguised as
    // a refactor — a wrong namespace makes the pod tail silently tail nothing.
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

/** Which git modules can be added to this app type. Odoo is the only one that uses them today. */
export function useAvailableModules(appType: string | undefined, enabled: boolean) {
  return useQuery({
    queryKey: deploymentKeys.modules(appType),
    queryFn: () => api.get<unknown[]>('/modules', { params: { appType: appType || 'odoo' } })
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
  /** Why no plan could be produced — shown instead of silently offering nothing. */
  refusal?: string
}

/**
 * What the resource ceilings resolve to when left blank.
 *
 * Only for the app that is open, and only where the plan applies — the endpoint answers
 * `applicable: false` for anything that is not TabbyAPI rather than guessing.
 */
export function useResourcePlan(deployment: Deployment | null | undefined) {
  return useQuery({
    queryKey: deploymentKeys.resourcePlan(deployment?.id),
    queryFn: () => api.get<ResourcePlan>(`/deployments/${deployment?.id}/resource-plan`).then((r) => r.data),
    enabled: !!deployment && deployment.appType === 'tabbyapi',
    staleTime: 60_000,
  })
}

/**
 * Whatever log file the resource has on disk, fetched once when the tab opens.
 *
 * The socket stream appends to this rather than replacing it — see `useLogSocket`. Also fetched for
 * a FAILED app on the general tab, because that is where the reason lives and the user has no
 * reason to know it is under "provision".
 */
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
