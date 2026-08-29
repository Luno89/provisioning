import { api } from './client'
import type { Tree, Branch, Leaf, TreeType } from '../types/grove'

export const groveKeys = {
  trees: () => ['trees'] as const,
  branches: () => ['branches'] as const,
  leaves: () => ['leaves'] as const,
  treeTypes: () => ['tree-types'] as const,
  trace: (id: string) => ['leaf-trace', id] as const,
}

export const listTrees = (): Promise<Tree[]> => api.get<Tree[]>('/trees').then((r) => r.data)
export const createTree = <T,>(body: unknown): Promise<T> =>
  api.post<T>('/trees', body).then((r) => r.data)
export const deleteTree = (id: string) => api.delete(`/trees/${id}`).then((r) => r.data)

export const listBranches = (): Promise<Branch[]> =>
  api.get<Branch[]>('/branches').then((r) => r.data)
export const createBranch = <T,>(body: unknown): Promise<T> =>
  api.post<T>('/branches', body).then((r) => r.data)

export const patchBranch = (id: string, patch: Record<string, unknown>) =>
  api.patch(`/branches/${id}`, patch).then((r) => r.data)
export const deleteBranch = (id: string) => api.delete(`/branches/${id}`).then((r) => r.data)

export const listLeaves = (): Promise<Leaf[]> => api.get<Leaf[]>('/leaves').then((r) => r.data)
export const deleteLeaf = (id: string) => api.delete(`/leaves/${id}`).then((r) => r.data)

export const patchLeaf = (id: string, patch: Record<string, unknown>) =>
  api.patch(`/leaves/${id}`, patch).then((r) => r.data)

export const getLeafTrace = (id: string) => api.get(`/leaves/${id}/trace`).then((r) => r.data)

export const acceptLeaf = (id: string, body?: unknown) =>
  api.post(`/leaves/${id}/accept`, body ?? {}).then((r) => r.data)
export const cancelLeaf = (id: string) => api.post(`/leaves/${id}/cancel`, {}).then((r) => r.data)
export const retryLeaf = (id: string, body?: unknown) =>
  api.post(`/leaves/${id}/retry`, body ?? {}).then((r) => r.data)
export const recheckLeaf = (id: string): Promise<{ outcome: string; reason: string; changed?: boolean }> =>
  api.post<{ outcome: string; reason: string; changed?: boolean }>(`/leaves/${id}/recheck`, {})
    .then((r) => r.data)
export const reviewLeaf = (id: string): Promise<{ branchId: string; prompt: string }> =>
  api.post<{ branchId: string; prompt: string }>(`/leaves/${id}/review`, {}).then((r) => r.data)

export const listTreeTypes = (): Promise<TreeType[]> =>
  api.get<TreeType[]>('/tree-types').then((r) => r.data)
