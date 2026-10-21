import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from './client'

export type DependencyInstall =
  | { via: 'dnf' | 'apt' | 'pip' | 'npm'; packages: string[] }
  | { via: 'script'; run: string }

/**
 * ── DUPLICATED, KNOWINGLY ──
 * Authority: `WorkspaceDependency` in packages/agent-engine/src/environment/dependencies.ts, and
 * `DependencyView` in apps/backend/src/services/WorkspaceDependencyService.ts.
 */
export interface WorkspaceDependency {
  name: string
  summary: string
  provides: string[]
  libraries?: string[]
  needs?: string[]
  install: DependencyInstall[]
  onDebian?: DependencyInstall[]
  ownerId?: string
}

export interface DependencyView extends WorkspaceDependency {
  mine: boolean
  script: boolean
  usedBy: { tools: string[]; servers: string[]; dependencies: string[]; trees: string[] }
}

export const dependencyKeys = {
  all: ['workspace-dependencies'] as const,
}

export const listDependencies = (): Promise<DependencyView[]> =>
  api.get<{ dependencies: DependencyView[] }>('/workspace-dependencies').then((r) => r.data.dependencies)

export const saveDependency = (dependency: WorkspaceDependency): Promise<DependencyView> =>
  api.put<{ dependency: DependencyView }>(`/workspace-dependencies/${encodeURIComponent(dependency.name)}`, dependency).then((r) => r.data.dependency)

export const removeDependency = (name: string): Promise<void> =>
  api.delete(`/workspace-dependencies/${encodeURIComponent(name)}`).then(() => undefined)

export function useDependencies() {
  return useQuery({ queryKey: dependencyKeys.all, queryFn: listDependencies })
}

export function useSaveDependency(onSaved?: (dependency: DependencyView) => void) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: saveDependency,
    onSuccess: (dependency) => {
      void qc.invalidateQueries({ queryKey: dependencyKeys.all })
      onSaved?.(dependency)
    },
  })
}

export function useRemoveDependency(onRemoved?: () => void) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: removeDependency,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: dependencyKeys.all })
      onRemoved?.()
    },
  })
}
