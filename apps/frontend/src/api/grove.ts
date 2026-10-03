import { api } from './client'
import type { Tree, Branch, Leaf, TreeType } from '../types/grove'

export const groveKeys = {
  trees: () => ['trees'] as const,
  branches: () => ['branches'] as const,
  leaves: () => ['leaves'] as const,
  treeTypes: () => ['tree-types'] as const,
  workspace: (id: string) => ['tree-workspace', id] as const,
  run: (id: string) => ['tree-run', id] as const,
}

export type TreeWorkspaceState = 'none' | 'parked' | 'running'

export const getTreeWorkspace = (id: string): Promise<{ state: TreeWorkspaceState }> =>
  api.get<{ state: TreeWorkspaceState }>(`/trees/${id}/workspace`).then((r) => r.data)
export const releaseTreeWorkspace = (id: string): Promise<{ state: TreeWorkspaceState }> =>
  api.delete<{ state: TreeWorkspaceState }>(`/trees/${id}/workspace`).then((r) => r.data)

export interface TreeRunResult {
  outcome: 'quiet' | 'stopped'
  awaitingReview: string[]
  awaitingApproval?: string[]
}

export type TreeRunStatus =
  | { state: 'none' | 'unavailable' }
  | { state: 'running'; startedAt: string }
  | { state: 'finished'; startedAt: string; closedAt?: string; result: TreeRunResult }
  | { state: 'failed'; startedAt: string; closedAt?: string; reason: string }

export const getTreeRun = (id: string): Promise<TreeRunStatus> =>
  api.get<TreeRunStatus>(`/trees/${id}/run`).then((r) => r.data)
export const runTree = (id: string): Promise<TreeRunStatus> =>
  api.post<TreeRunStatus>(`/trees/${id}/run`).then((r) => r.data)
export const stopTreeRun = (id: string): Promise<TreeRunStatus> =>
  api.post<TreeRunStatus>(`/trees/${id}/run/stop`).then((r) => r.data)

export const listTrees = (): Promise<Tree[]> => api.get<Tree[]>('/trees').then((r) => r.data)
export const createTree = <T,>(body: unknown): Promise<T> =>
  api.post<T>('/trees', body).then((r) => r.data)
export const deleteTree = (id: string) => api.delete(`/trees/${id}`).then((r) => r.data)
export const listBranches = (): Promise<Branch[]> =>
  api.get<Branch[]>('/branches').then((r) => r.data)

export const deleteBranch = (id: string) => api.delete(`/branches/${id}`).then((r) => r.data)

export const listLeaves = (): Promise<Leaf[]> => api.get<Leaf[]>('/leaves').then((r) => r.data)
export const deleteLeaf = (id: string) => api.delete(`/leaves/${id}`).then((r) => r.data)

export const cancelLeaf = (id: string) => api.post(`/leaves/${id}/cancel`, {}).then((r) => r.data)
export const settleLeaf = (id: string, verdict: 'verified' | 'failed', note?: string) =>
  api.post(`/leaves/${id}/settle`, { verdict, ...(note ? { note } : {}) }).then((r) => r.data)
export const retryLeaf = (id: string) =>
  api.post(`/leaves/${id}/retry`, {}).then((r) => r.data)

export const listTreeTypes = (): Promise<TreeType[]> =>
  api.get<TreeType[]>('/tree-types').then((r) => r.data)

export const updateTreeType = (id: string, body: Partial<TreeType>): Promise<TreeType> =>
  api.put<TreeType>(`/tree-types/${id}`, body).then((r) => r.data)
