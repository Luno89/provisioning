import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../../../api/client'

/**
 * ── DUPLICATED, KNOWINGLY ── `DependencyFinding`, `DependencyCheck` and their parts in
 * apps/backend/src/instances/lib/dependency-findings.ts, and `WatchView` / `ReleaseFindings` in
 * apps/backend/src/instances/services/DependencyWatch.ts, are the authority.
 */
export type ComponentKind = 'npm' | 'binary' | 'image' | 'chart' | 'action' | 'unpinned'
export type FindingState = 'waiting' | 'due' | 'no-fix'
export type Severity = 'critical' | 'high' | 'moderate' | 'low'

export interface FindingComponent {
  name: string
  version: string
  kind: ComponentKind
  in?: string
  where?: string
}

export interface Advisory {
  id: string
  summary?: string
  severity?: Severity
}

export interface DependencyFinding {
  key: string
  component: FindingComponent
  advisory: Advisory
  fix?: string
  fixPublishedAt?: string
  takeOn?: string
  state: FindingState
  releases: string[]
  instances: string[]
  firstSeenAt: string
  devOnly?: true
}

export interface CheckedRelease {
  release: string
  label: string
  instances: string[]
  root: boolean
  components: number
  inventory: boolean
}

export interface ListedComponent {
  name: string
  version?: string
  kind: ComponentKind
  in?: string
  where?: string
  dev: boolean
  checked: boolean
  publishedAt?: string
}

export interface DependencyCheck {
  checkedAt: string
  releases: CheckedRelease[]
  components: ListedComponent[]
  problems: string[]
}

export interface WatchView {
  check?: DependencyCheck
  findings: DependencyFinding[]
}

export interface ReleaseFinding {
  component: FindingComponent
  advisory: Advisory
  state: FindingState
  fix?: string
  takeOn?: string
  fixedBy?: string
}

export interface ReleaseFindings {
  release?: string
  findings: ReleaseFinding[]
}

export const dependencyKeys = {
  root: () => ['dependencies'] as const,
}

export const getDependencies = (): Promise<WatchView> => api.get<WatchView>('/instances/dependencies').then((r) => r.data)

export const checkDependencies = (): Promise<WatchView> => api.post<WatchView>('/instances/dependencies/check', {}).then((r) => r.data)

export function useDependencies() {
  return useQuery({ queryKey: dependencyKeys.root(), queryFn: getDependencies })
}

export function useCheckDependencies() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: checkDependencies,
    onSuccess: (view) => { client.setQueryData(dependencyKeys.root(), view) },
  })
}
