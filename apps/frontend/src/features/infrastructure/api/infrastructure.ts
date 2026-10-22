import { api } from '../../../api/client'
import type { Overview } from '../../../api/monitoring'
import type { RunningItem, RunningKind } from './running'

/**
 * ── DUPLICATED, KNOWINGLY ──
 * Authority: apps/backend/src/infrastructure/lib/cluster-workloads.ts (Workload and its parts),
 * apps/backend/src/infrastructure/lib/platform-services.ts (PlatformService, HelmReleaseJson),
 * apps/backend/src/infrastructure/lib/work-failures.ts (WorkFailure),
 * apps/backend/src/infrastructure/services/ClusterContentsService.ts (ClusterContents, ClusterNode, BrokenWorkload) and
 * apps/backend/src/infrastructure/services/InfrastructureViewService.ts (InfrastructureOverview).
 */
export type WorkloadState = 'ok' | 'starting' | 'warning' | 'down'
export type WorkloadKind = 'Deployment' | 'StatefulSet' | 'DaemonSet' | 'Job' | 'Pod'
export type WorkloadGroup = 'apps' | 'koala' | 'platform' | 'other'

export type WorkloadAbout =
  | { kind: 'app'; id: string; name: string; mine: boolean }
  | { kind: 'tree'; id: string; mine: boolean; check?: boolean }
  | { kind: 'run'; id: string; mine: boolean; check?: boolean }
  | { kind: 'project'; id: string; mine: boolean; check?: boolean }
  | { kind: 'builds' }
  | { kind: 'platform' }
  | { kind: 'other' }

export interface Workload {
  namespace: string
  kind: WorkloadKind
  name: string
  group: WorkloadGroup
  about: WorkloadAbout
  release?: string
  pods: { total: number; ready: number }
  state: WorkloadState
  reasons: string[]
  restarts: number
  memoryBytes?: number
  cpuCores?: number
  since?: string
}

export interface BrokenWorkload extends Workload {
  clusterId: string
  clusterName: string
}

export type ServiceKey = 'prometheus' | 'grafana' | 'alertmanager' | 'traefik' | 'gitea' | 'loki' | 'infisical'

export interface PlatformService {
  key: ServiceKey
  label: string
  does: string
  installed: boolean
  release?: { name: string; chart: string; version?: string; status: string }
  state: WorkloadState | 'absent'
  reasons: string[]
  pods: { total: number; ready: number }
  dashboard: boolean
  access: string
}

export interface HelmRelease {
  name: string
  namespace: string
  status: string
  chart: string
  app_version?: string
  updated?: string
}

export interface ClusterNode {
  name: string
  ready: boolean
  roles: string[]
  version?: string
  cpuCores?: number
  memoryBytes?: number
  gpus?: number
}

export interface ClusterContents {
  clusterId: string
  readAt: string
  reachable: boolean
  problem?: string
  ownsCluster: boolean
  workloads: Workload[]
  finishedJobs: number
  measured: boolean
  services?: PlatformService[]
  releases?: HelmRelease[]
  nodes?: ClusterNode[]
}

export interface WorkFailure {
  id: string
  workflowId: string
  kind: RunningKind
  title: string
  opens: RunningItem['opens']
  reason: string
  failedAt: string
}

export interface InfrastructureOverview {
  monitoring: Overview
  workloads: BrokenWorkload[]
  waiting: RunningItem[]
  running: number
  runningProblem?: string
  failures: WorkFailure[]
}

export const infrastructureKeys = {
  all: () => ['infrastructure'] as const,
  overview: () => ['infrastructure', 'overview'] as const,
  cluster: (id: string) => ['infrastructure', 'cluster', id] as const,
}

export async function getInfrastructure(): Promise<InfrastructureOverview> {
  return (await api.get<InfrastructureOverview>('/infrastructure')).data
}

export async function getClusterContents(id: string): Promise<ClusterContents> {
  return (await api.get<ClusterContents>(`/infrastructure/clusters/${encodeURIComponent(id)}`)).data
}

export async function clearFailures(ids?: string[]): Promise<number> {
  return (await api.post<{ cleared: number }>('/infrastructure/failures/clear', ids ? { ids } : {})).data.cleared
}
