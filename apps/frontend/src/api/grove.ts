import { api } from './client'
import type { Tree, Branch, Leaf, TreeType } from '../types/grove'

export const groveKeys = {
  trees: () => ['trees'] as const,
  branches: () => ['branches'] as const,
  leaves: () => ['leaves'] as const,
  treeTypes: () => ['tree-types'] as const,
  treeTypeDescription: (id: string) => ['tree-types', id, 'description'] as const,
  workspace: (id: string) => ['tree-workspace', id] as const,
  workspaceFile: (id: string) => ['tree-workspace-file', id] as const,
  run: (id: string) => ['tree-run', id] as const,
}

export type TreeWorkspaceState = 'none' | 'parked' | 'running'

export const getTreeWorkspace = (id: string): Promise<{ state: TreeWorkspaceState }> =>
  api.get<{ state: TreeWorkspaceState }>(`/trees/${id}/workspace`).then((r) => r.data)
export const releaseTreeWorkspace = (id: string): Promise<{ state: TreeWorkspaceState }> =>
  api.delete<{ state: TreeWorkspaceState }>(`/trees/${id}/workspace`).then((r) => r.data)

/**
 * ── DUPLICATED, KNOWINGLY ──
 * Authority: `WorkspaceFile` in apps/backend/src/lib/workspace-file.ts.
 */
export interface WorkspaceFile {
  packages?: Partial<Record<string, string[]>>
  script?: string
  languages?: string[]
  env?: { name: string; value: string }[]
}

/**
 * ── DUPLICATED, KNOWINGLY ──
 * Authority: `TreeWorkspaceView` in apps/backend/src/services/TreeWorkspaceService.ts.
 */
export interface TreeWorkspaceView {
  path: string
  file?: WorkspaceFile
  unreadable?: string
  composed?: { lines: WorkspaceLine[]; env: { name: string; value: string }[] }
  unbuildable?: string
  published?: { image: string; commit?: string; publishedAt: string; lines: WorkspaceLine[]; env: { name: string; value: string }[] }
  pending: string[]
  next?: { runId: string; stage: 'building' | 'waiting' | 'failed' | 'declined'; text: string; commit?: string; at: string }
  builds: { runId: string; outcome: string; reason?: string; finishedAt?: string; wallClockMs: number }[]
  can: { managers: string[]; languages: string[] }
}

export interface WorkspaceLine {
  what: string
  from: string
}

export type WorkspaceBuildStart = { started: true; runId: string } | { started: false; reason: 'running' | 'switched-off' }

export const getTreeWorkspaceFile = (id: string): Promise<TreeWorkspaceView> =>
  api.get<TreeWorkspaceView>(`/trees/${id}/workspace-file`).then((r) => r.data)
export const saveTreeWorkspaceFile = (id: string, file: WorkspaceFile, said?: string): Promise<TreeWorkspaceView & { committed: boolean; build?: WorkspaceBuildStart }> =>
  api.put<TreeWorkspaceView & { committed: boolean; build?: WorkspaceBuildStart }>(`/trees/${id}/workspace-file`, { file, ...(said ? { said } : {}) }).then((r) => r.data)

export interface TreeRunResult {
  outcome: 'quiet' | 'stopped'
  awaitingReview: string[]
  awaitingApproval?: string[]
}

export interface TreeAsk {
  runId: string
  callId: string
  tool: string
  message: string
  agent?: string
  leafId?: string
}

export type TreeRunStatus =
  | { state: 'none' | 'unavailable' }
  | { state: 'running'; startedAt: string; turnId?: string; asking?: TreeAsk[] }
  | { state: 'finished'; startedAt: string; closedAt?: string; result: TreeRunResult; turnId?: string }
  | { state: 'failed'; startedAt: string; closedAt?: string; reason: string; turnId?: string }

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

export const getTreeTypeDescription = (id: string): Promise<string> =>
  api.get<{ text: string }>(`/tree-types/${encodeURIComponent(id)}/description`).then((r) => r.data.text)

export const updateTreeType = (id: string, body: Partial<TreeType>): Promise<TreeType> =>
  api.put<TreeType>(`/tree-types/${id}`, body).then((r) => r.data)

export const orderStories = (branchId: string, leafIds: readonly string[]): Promise<void> =>
  api.put(`/branches/${branchId}/order`, { leafIds }).then(() => undefined)

export const orderFeatures = (treeId: string, branchIds: readonly string[]): Promise<void> =>
  api.put(`/trees/${treeId}/order`, { branchIds }).then(() => undefined)
